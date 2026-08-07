# Plan: Build Stalled Fulfillment Recovery MCP From Scratch

**Goal:** Recreate this entire codebase starting from an empty directory (zero files).  
**End state:** A production-ready MCP server that lets ops (via an AI assistant) diagnose and recover orders stuck in fulfillment — with safety-by-construction write tools, PostgreSQL persistence, tests, and deploy config.

**Coding guidelines:** Follow `.agents/AGENTS.md` / Karpathy guidelines throughout:
1. Think before coding — surface assumptions, don't hide confusion  
2. Simplicity first — minimum code that solves the problem  
3. Surgical changes — touch only what each phase requires  
4. Goal-driven execution — each step has a verifiable check  

---

## 0. Product Decisions (lock these first)

Do **not** start coding until these are fixed. They define the safety boundary.

| Decision | Choice |
|---|---|
| Problem | Ops cannot independently diagnose/fix stalled fulfillments |
| Scope | Single-order investigation of stalled fulfillment only |
| Stall patterns | (1) no fulfillment task, (2) failed task, (3) silently stalled task |
| Write tools | Only `retry_fulfillment` (mutates) and `escalate_order` (audit only) |
| Non-goals | Auth, multi-tenant ACL, payment mutations, real carrier APIs, batch ops, custom frontend |
| Client | MCP-connected AI (Claude Desktop / Cursor / Inspector) — no UI |
| Safety model | Domain boundary *is* safety boundary: no payment tools exist |

**Assumptions:**
- Writes are simulated (no real warehouse/carrier API)
- Safety controls (dry-run, rate-limit, escalation) are real
- PostgreSQL is the source of truth; tables auto-create on startup

**Success criteria for the whole project:**
- [ ] `GET /health` returns `{ status: "ok", ... }`
- [ ] MCP tools/resources/prompts work via `POST /mcp`
- [ ] `npm test` passes all safety tests against live PostgreSQL
- [ ] Dry-run never mutates; double-retry is blocked; terminal orders rejected

---

## 1. Scaffold project skeleton

### 1.1 Init package

```
mkdir stalled-fulfillment-recovery-mcp && cd stalled-fulfillment-recovery-mcp
npm init -y
```

### 1.2 Create `package.json`

| Field | Value |
|---|---|
| `name` | `stalled-fulfillment-recovery-mcp` |
| `version` | `1.0.0` |
| `type` | `module` (ESM required) |
| `main` | `dist/index.js` |

**Scripts:**
```json
{
  "build": "tsc",
  "postinstall": "tsc",
  "start": "node dist/index.js",
  "dev": "tsx src/index.ts",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

**Dependencies:**
| Package | Why |
|---|---|
| `@modelcontextprotocol/sdk` ^1.12 | MCP server + StreamableHTTP transport |
| `express` ^5 | HTTP app (`POST /mcp`, `GET /health`) |
| `pg` ^8 | PostgreSQL driver |
| `zod` ^3 | Tool arg validation |

**DevDependencies:**
| Package | Why |
|---|---|
| `typescript` ^5.8 | Compile |
| `@types/node`, `@types/express`, `@types/pg` | Types |
| `tsx` | Dev runner |
| `vitest` ^3 | Tests |

→ **verify:** `npm install` succeeds with no peer errors.

### 1.3 TypeScript config (`tsconfig.json`)

```
target: ES2022
module / moduleResolution: Node16
outDir: dist, rootDir: src
strict: true
declaration + sourceMap: true
exclude: node_modules, dist, **/*.test.ts
```

→ **verify:** empty `tsc` (or after first file) produces clean `dist/`.

### 1.4 Repo hygiene

Create:
- `.gitignore` — `node_modules/`, `dist/`, `.env`, coverage, OS junk
- `.env.example` — `DATABASE_URL=postgres://...`
- `vitest.config.ts` — `testTimeout: 15000` (live DB tests need headroom)

→ **verify:** `.env` is ignored; example documents the one required env var.

---

## 2. Domain types (`src/types.ts`)

Define the domain model **before** any DB or tools. No runtime logic — pure types.

### 2.1 Order
- `OrderStatus`: `paid | processing | shipped | delivered | cancelled`
- `OrderItem`: productId, name, quantity, unitPrice (cents)
- `Order`: id, customerId, status, items, totalAmount, createdAt, updatedAt (ISO)

### 2.2 FulfillmentTask (source of truth for shipment)
- `FulfillmentStatus`: `pending | in_progress | shipped | delivered | failed | cancelled`
- Fields: id, orderId, status, failureReason?, attempts, createdAt, updatedAt, lastActivityAt, shippedAt?, deliveredAt?, trackingInfo?

**Status derivation rule** (document in comments; implement in data-store later):
```
shipped    → order.shipped
delivered  → order.delivered
cancelled  → order.cancelled
pending | in_progress | failed | cancelled → order.processing
```

### 2.3 AuditLog
- `AuditAction`: `fulfillment_created | fulfillment_retry | escalated | escalation_declined`
- `AuditLogEntry`: id, orderId, action, performedBy, details, timestamp

### 2.4 Stall helpers
- `StallReason`: `no_fulfillment_task | fulfillment_failed | fulfillment_stalled`
- `StalledOrderEntry`: order, fulfillment | null, stall_reason, stalled_since

→ **verify:** file compiles; no circular imports; every tool response shape can be expressed from these types.

---

## 3. Database layer (`src/db.ts`)

### 3.1 Connection
1. Prefer `process.env.DATABASE_URL`
2. Fallback: load from `.env` file (simple regex parse — no dotenv dep required)
3. Default: `postgres://localhost:5432/fulfillment_mcp` (or `fulfillment_mcp_test` when `NODE_ENV=test`)
4. Enable SSL (`rejectUnauthorized: false`) when URL looks remote (supabase / sslmode / production)

### 3.2 Schema (`initDb()` — `CREATE TABLE IF NOT EXISTS`)

| Table | Key columns |
|---|---|
| `orders` | id PK, customer_id, status, total_amount, created_at, updated_at |
| `order_items` | serial id, order_id FK CASCADE, product_id, name, quantity, unit_price |
| `fulfillment_tasks` | id PK, order_id **UNIQUE** FK CASCADE, status, failure_reason, attempts, timestamps, tracking |
| `audit_log` | id PK, order_id FK CASCADE, action, performed_by, details, timestamp |

→ **verify:** start a local Postgres, call `initDb()`, `\dt` shows all four tables. Re-run is idempotent.

---

## 4. Data store (`src/data-store.ts`)

Thin repository over `pool`. All tools talk **only** through this module — never raw SQL in tools.

### 4.1 Mappers
- `mapOrder`, `mapFulfillment`, `mapAuditEntry` — convert snake_case rows → camelCase domain types, ISO dates

### 4.2 Reads
| Function | Behavior |
|---|---|
| `getOrder(id)` | order + items |
| `getAllOrders()` | all orders with items grouped |
| `getFulfillment(id)` | by fulfillment id |
| `getFulfillmentByOrderId(orderId)` | one task per order (UNIQUE) |
| `getAuditLog(orderId)` | chronological |
| `getStalledOrdersFromDb(thresholdHours)` | single LEFT JOIN with CASE stall_reason |

**Stall SQL logic (must match exactly):**
```
orders.status IN ('paid','processing')
AND order.created_at older than threshold
AND (
  no fulfillment row
  OR fulfillment.status = 'failed'
  OR status IN ('pending','in_progress') AND last_activity_at older than threshold
)
```

### 4.3 Writes
| Function | Behavior |
|---|---|
| `upsertFulfillment(task)` | INSERT … ON CONFLICT (order_id) DO UPDATE; **also** derive+update order.status in same transaction |
| `addAuditEntry(entry)` | insert audit row |
| `createOrder(input)` | transactional: order + items + optional fulfillment (for tests/seed) |
| `clearStore()` | TRUNCATE all tables CASCADE (tests) |

### 4.4 IDs
- `generateId(prefix)` → `${prefix}-${seq}` (ORD / FUL / AUD)

→ **verify:** manually `createOrder` → `getOrder` → `upsertFulfillment` → order status derives correctly → `getAuditLog` empty until write.

---

## 5. MCP tools (`src/tools/*.ts`)

Each tool exports: **schema** (Zod shape for MCP) + **handler** (returns MCP content blocks).  
Convention: handlers return `{ content: [{ type: 'text', text: JSON.stringify(...) }], isError?: true }`.

Build in this order (reads first, writes last):

### 5.1 `get_order` (read)
- Input: `order_id`
- Output: `{ order, fulfillment }` or `not_found` error

### 5.2 `get_fulfillment` (read)
- Input: `fulfillment_id`
- Output: `{ fulfillment }` or `not_found`

### 5.3 `list_stalled_orders` (read)
- Input: optional `threshold_hours` (default 24)
- Output: `{ stalled_orders, total_count, threshold_hours }`

### 5.4 `get_audit_log` (read)
- Input: `order_id`
- Output: `{ order_id, entries, total_count }` or `not_found`

### 5.5 `escalate_order` (write — audit only)
- Input: `order_id`, `reason` (min 10 chars)
- **Must not** change order/fulfillment state
- Writes `AuditLogEntry` with action `escalated`, `performedBy: "mcp_ops_agent"`

### 5.6 `retry_fulfillment` (write — only state mutator) ⚠️ safety-critical

Implement gates **in this order**:

| Step | Rule | Error code |
|---|---|---|
| 1 | Order exists | `not_found` |
| 2 | Status not terminal (`shipped`/`delivered`/`cancelled`) | `order_not_retryable` |
| 3 | If fulfillment `in_progress` **and** active within 24h | `fulfillment_active` |
| 4 | No retry/created audit entry within **10 minutes** | `double_retry_prevented` |
| 5 | Decide action: create task vs reset to pending | — |
| 6 | `confirm=false` → dry-run preview, **zero** DB writes | — |
| 7 | `confirm=true` → upsert + audit (`fulfillment_created` or `fulfillment_retry`) | — |

Dry-run payload must include: `dry_run: true`, `current_state`, `proposed_action`, `proposed_result`, message telling operator to re-call with `confirm=true`.

→ **verify:** each tool can be unit-called with a real order id and returns valid JSON text content.

---

## 6. MCP server + HTTP transport (`src/index.ts`)

### 6.1 McpServer
```
name: stalled-fulfillment-recovery
version: 1.0.0
```

### 6.2 Resources
| URI template | Returns |
|---|---|
| `order://{order_id}` | JSON `{ order, fulfillment }` |
| `fulfillment://{order_id}` | JSON fulfillment by order id |

### 6.3 Prompt
| Name | Behavior |
|---|---|
| `diagnose_stalled_orders` | Optional `threshold_hours`; returns user message instructing the AI through list → inspect → dry-run retry → confirm/escalate → summarize |

### 6.4 Register all six tools
Wire schema + handler for each; write clear tool descriptions so the model knows **when** to call each (especially dry-run-first for retry).

### 6.5 Express app
| Route | Behavior |
|---|---|
| `POST /mcp` | Stateless: new `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request; connect server; handleRequest; cleanup on `res.close` |
| `GET /mcp` | 405 — stateless HTTP only |
| `DELETE /mcp` | 405 — no sessions |
| `GET /health` | `{ status, server, version, timestamp }` |

### 6.6 Boot
```
await initDb()
app.listen(PORT from env, default 3000)
```

→ **verify:**
```bash
npm run build && npm start
curl http://localhost:3000/health
npx @modelcontextprotocol/inspector --url http://localhost:3000/mcp
```

---

## 7. Safety tests (`src/tools/safety.test.ts`)

Run against **live PostgreSQL**. Every test creates its own data via `createOrder()` — no fixtures, no seed file.

| # | Test | Assert |
|---|---|---|
| 1 | Dry-run safety | Preview returned; order/fulfillment/audit **unchanged** |
| 2 | Rate-limit | Second retry within 10 min → `double_retry_prevented` |
| 3 | Terminal rejection | shipped / delivered / cancelled → `order_not_retryable` |
| 4 | Escalate audit-only | Audit row written; order + fulfillment status **unchanged** |
| 5 | Stall classification | Backdate rows; detect all three `stall_reason` values |

Close pool in `afterAll`.

→ **verify:** `npm test` — all green. If red, fix product code, not the test (unless the test is wrong).

---

## 8. Docs & deploy

### 8.1 `README.md`
Document: product decisions, DB setup, quick start, tools/resources/prompts table, stall detection matrix, example ops workflow, safety details, test instructions, hosted URL pattern, Cursor `mcp.json` snippet, tech stack.

### 8.2 `render.yaml`
```yaml
services:
  - type: web
    name: MCP-Ecom
    runtime: node
    buildCommand: npm install && npm run build
    startCommand: node dist/index.js
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        sync: false
```

### 8.3 Agent guidelines (optional but present in this repo)
```
.agents/
  AGENTS.md
  skills/karpathy-guidelines/SKILL.md
```
Same behavioral rules used to write this plan — keep them so future agents stay surgical.

→ **verify:** README examples match actual tool names/args; deploy health check path is `/health`.

---

## 9. Final integration checklist

Run top-to-bottom after all phases:

```
[ ] npm install
[ ] DATABASE_URL set (or local Postgres + default DB name)
[ ] npm run build          → dist/ emitted, no TS errors
[ ] npm start              → listens, initDb creates tables
[ ] curl /health           → status ok
[ ] MCP Inspector tools    → all 6 listed
[ ] list_stalled_orders    → returns array (may be empty)
[ ] create test order via createOrder / SQL
[ ] retry confirm=false    → dry_run true, no mutation
[ ] retry confirm=true     → success + audit
[ ] retry again immediately → double_retry_prevented
[ ] escalate_order         → audit only
[ ] npm test               → all safety tests pass
[ ] Deploy (Render/etc) with DATABASE_URL + PORT
[ ] Production /health + Inspector against hosted /mcp
```

---

## 10. File tree (target)

```
.
├── .agents/
│   ├── AGENTS.md
│   └── skills/karpathy-guidelines/SKILL.md
├── .env.example
├── .gitignore
├── package.json
├── plan.md                 ← this file
├── README.md
├── render.yaml
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts            # MCP server + Express
    ├── types.ts            # Domain types
    ├── db.ts               # Pool + schema
    ├── data-store.ts       # Repository
    └── tools/
        ├── get-order.ts
        ├── get-fulfillment.ts
        ├── list-stalled-orders.ts
        ├── get-audit-log.ts
        ├── escalate-order.ts
        ├── retry-fulfillment.ts
        └── safety.test.ts
```

**Out of scope for source (generated / local only):** `node_modules/`, `dist/`, `.env`, `package-lock.json` (generated by install).

---

## 11. Implementation order (one-pass build)

| Phase | Deliverable | Exit check |
|---|---|---|
| 0 | Product decisions locked | Written down; non-goals explicit |
| 1 | Scaffold + configs | `npm install` works |
| 2 | `types.ts` | Compiles |
| 3 | `db.ts` | Tables exist on Postgres |
| 4 | `data-store.ts` | CRUD + stall query works |
| 5 | Six tools | Handlers return correct JSON |
| 6 | `index.ts` server | `/health` + Inspector |
| 7 | Safety tests | `npm test` green |
| 8 | README + render.yaml + .agents | Docs match code |
| 9 | Integration checklist | All boxes checked |

**Rule:** Do not start phase N+1 until phase N exit check passes. Prefer the smallest change that makes the next check green.

---

## 12. Explicit non-goals (do not build)

- Authentication / JWT / multi-tenant isolation  
- Refund, capture, or any payment mutation tools  
- Real carrier / warehouse API integrations  
- Batch retry or bulk admin UI  
- In-memory session MCP transport (this server is **stateless HTTP only**)  
- Seed scripts as a runtime dependency (tests create their own data)  
- Abstractions “for later” — no repository interfaces, no DI framework, no extra config layers  

If a future request needs one of these, treat it as a new product decision, not a silent expansion of this plan.
