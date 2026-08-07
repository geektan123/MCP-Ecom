# Plan 2: Write-Safety Hardening (Post–Base Codebase)

**Prerequisite:** Base codebase is complete (commit `67e98b5cc2d4c379f98b1b3b2942d0cd2fa86485`) — the Stalled Fulfillment Recovery MCP server exists with six tools, PostgreSQL, dry-run retry, 10-minute app-side cooldown, and basic safety tests.

**Goal:** Harden the write path so mutations cannot silently skip audits, race under concurrent agents, bypass operator preview, or auto-retry permanent data errors.

**Source of truth for this plan:** Commit `e46c858` (*Deploy write-safety fixes: server-enforced preview tokens, atomic transactions, and validation failure safeguards*) applied on top of base commit `67e98b5cc2d4c379f98b1b3b2942d0cd2fa86485`.

**End state:**
- `confirm=true` is impossible without a server-issued, one-time `preview_token`
- Fulfillment mutation + order status + audit + token consumption commit in **one** transaction under `SELECT … FOR UPDATE`
- Cooldown re-checked inside that lock using DB time (`NOW()`)
- Non-retryable failure reasons (postal/address/fraud/etc.) are blocked → ops must escalate
- Escalation is deduped within 30 minutes
- Runtime IDs are UUID-safe across restarts / multi-instance deploys
- Expanded safety tests all green against live PostgreSQL

**Coding guidelines:** Same as Plan 1 (`.agents/AGENTS.md` / Karpathy):
1. Think before coding — surface assumptions  
2. Simplicity first — minimum code that fixes the hole  
3. Surgical changes — only write-path files unless schema forces more  
4. Goal-driven execution — each phase has a verifiable exit check  

---

## 0. Problem inventory (why Plan 2 exists)

Base codebase safety was **soft** (README + handler checks). Under real concurrent MCP agents and restarts, seven concrete gaps remain:

| # | Gap | Base codebase behavior | Risk |
|---|-----|-----------------|------|
| 1 | Non-atomic audit | `upsertFulfillment` then separate `addAuditEntry` | Mutation without audit trail |
| 2 | Concurrent double-retry | No row lock; cooldown is pre-write TOCTOU | Two agents both succeed |
| 3 | Preview bypass | `confirm=true` alone executes | Operator never saw dry-run |
| 4 | Bad data retries | Any non-terminal failed task is retryable | Infinite loop on postal/address (ORD-1031 class) |
| 5 | Escalation spam | Every `escalate_order` inserts | Audit noise |
| 6 | ID collisions | `Date.now() % 100000` process counter | PK failures after restart / scale-out |
| 7 | App-side cooldown | `getAuditLog` + `Date.now()` outside TX | Same race as #2 |

**Non-goals (still):** auth, multi-tenant ACL, real carrier APIs, payment tools, batch ops, frontend.

**Product decisions locked for Plan 2:**

| Decision | Choice |
|---|---|
| Preview storage | DB table `preview_tokens` (opaque `PRV-<uuid>`, 10 min TTL, one-time use) |
| Preview enforcement | Hard require on `confirm=true` → `preview_required` if missing |
| Failure classifier | Substring match; **block** data/fraud/stock; unknown remains retryable |
| Escalation dedup | Any `escalated` within **30 minutes** (reason text ignored) |
| ID format | `${prefix}-${crypto.randomUUID()}` |
| Column width | Widen IDs to `VARCHAR(100)` for UUID headroom |
| Cooldown | Still **10 minutes**; evaluated **inside** locked TX with `NOW()` |

**Success criteria for Plan 2:**
- [ ] `confirm=true` without token → `preview_required`
- [ ] Dry-run returns `preview_token` + `preview_expires_at`; no mutation
- [ ] Preview → confirm happy path: fulfillment pending + **exactly one** audit row
- [ ] Consumed token reuse → `preview_invalid`
- [ ] 5 parallel confirms → **exactly one** success; rest blocked
- [ ] Address/postal failure → `not_retryable_data_error` + recommend escalate
- [ ] Double escalate within 30 min → `escalation_already_recorded`, one audit row
- [ ] `npm test` green on live Postgres
- [ ] Deployable (same Render/`DATABASE_URL` path as Plan 1)

---

## 1. Schema headroom + preview_tokens (`src/db.ts`)

### 1.1 Widen ID columns

Base codebase used `VARCHAR(50)`. UUID strings need more room:

| Table | Columns → `VARCHAR(100)` |
|---|---|
| `orders` | `id`, `customer_id` |
| `order_items` | `order_id`, `product_id` |
| `fulfillment_tasks` | `id`, `order_id` |
| `audit_log` | `id`, `order_id` |

> **Note:** `CREATE TABLE IF NOT EXISTS` does **not** alter existing narrow columns. On a fresh DB this is enough. On an already-deployed base DB, run a one-time `ALTER TABLE … TYPE VARCHAR(100)` (or recreate) before relying on UUID IDs in production.

### 1.2 New table: `preview_tokens`

```sql
CREATE TABLE IF NOT EXISTS preview_tokens (
  token           VARCHAR(100) PRIMARY KEY,
  order_id        VARCHAR(100) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  proposed_action VARCHAR(50)  NOT NULL,   -- create_fulfillment_task | reset_fulfillment_to_pending
  attempts        INTEGER      NOT NULL,
  expires_at      TIMESTAMPTZ  NOT NULL,
  used            BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL
);
```

→ **verify:** `initDb()` creates table; `\d preview_tokens` shows columns; re-run is idempotent.

---

## 2. Collision-safe IDs (`src/data-store.ts`)

### 2.1 Replace process counter

**Before (Base codebase at commit `67e98b5`):**
```ts
let seq = Date.now() % 100000;
export function generateId(prefix: string): string {
  return `${prefix}-${++seq}`;
}
```

**After:**
```ts
import crypto from 'node:crypto';

export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
```

Used for `FUL-…`, `AUD-…`, and (via same helper) preview tokens use `PRV-${crypto.randomUUID()}` in `createPreviewToken`.

### 2.2 clearStore includes new table

```sql
TRUNCATE TABLE preview_tokens, audit_log, fulfillment_tasks, order_items, orders CASCADE;
```

→ **verify:** generate 1000 IDs; all unique. Restart process; still unique. No dependency on process uptime.

---

## 3. Preview token store (`src/data-store.ts`)

### 3.1 `createPreviewToken(orderId, proposedAction, attempts)`

| Step | Behavior |
|---|---|
| 1 | `token = PRV-<uuid>` |
| 2 | `expiresAt = now + 10 minutes` |
| 3 | `INSERT` row with `used = FALSE` |
| 4 | Return `{ token, expiresAt }` (ISO strings) |

Called **only** from dry-run path (`confirm=false`) after eligibility checks pass.

### 3.2 `validateAndConsumePreviewToken(client, token, orderId, proposedAction)`

Runs **inside** an open transaction on the provided `client` (not a free pool query):

| Check | Failure prefix |
|---|---|
| Token row exists (`SELECT … FOR UPDATE`) | `PREVIEW_INVALID` |
| `order_id` matches | `PREVIEW_MISMATCH` |
| `proposed_action` matches current plan | `PREVIEW_MISMATCH` |
| `used === true` | `PREVIEW_EXPIRED` (message: already used) |
| `expires_at < now` | `PREVIEW_EXPIRED` |
| Success | `UPDATE … SET used = TRUE` |

→ **verify:** insert token → consume once OK → second consume throws; wrong order_id throws mismatch.

---

## 4. Atomic retry transaction (`src/data-store.ts`)

### 4.1 New: `executeFulfillmentRetryTransaction(params)`

**Params:** `{ orderId, task, auditEntry, previewToken?, cooldownMinutes? }`  
**Returns:** `{ order, fulfillment, auditEntry }` after commit  
**Default cooldown:** 10 minutes

**Single connection, one transaction:**

```text
BEGIN
  1. SELECT * FROM orders WHERE id = $orderId FOR UPDATE
     - missing → NOT_FOUND
     - status in (shipped, delivered, cancelled) → ORDER_NOT_RETRYABLE
  2. SELECT * FROM fulfillment_tasks WHERE order_id = $orderId FOR UPDATE
  3. If previewToken: validateAndConsumePreviewToken(...)
  4. Cooldown under lock:
       SELECT timestamp FROM audit_log
       WHERE order_id = $1
         AND action IN ('fulfillment_retry', 'fulfillment_created')
         AND timestamp > (NOW() - ($minutes || ' minutes')::INTERVAL)
       LIMIT 1
     - row exists → DOUBLE_RETRY_PREVENTED
  5. UPSERT fulfillment_tasks (same shape as Plan 1 upsert)
  6. UPDATE orders SET status = derive(task.status), updated_at = now
  7. INSERT audit_log
COMMIT
→ map + return final order/fulfillment/audit
ON error: ROLLBACK, rethrow
```

**Invariants this enforces:**
- No fulfillment write without audit (same COMMIT)
- No audit without fulfillment write
- At most one concurrent writer per order (row lock)
- Cooldown cannot TOCTOU across two confirms
- Token is single-use under the same lock as the write

**Keep** Plan 1 `upsertFulfillment` / `addAuditEntry` if other paths need them, but **retry confirm path must not call them**.

→ **verify:** call transaction once → fulfillment pending + one audit. Force throw after upsert (unit/manual) → both rolled back. Two parallel calls → one wins.

---

## 5. Escalation dedup (`src/data-store.ts` + `escalate-order.ts`)

### 5.1 `addAuditEntryWithDedup(entry, cooldownMinutes = 30)`

```text
BEGIN
  if action === 'escalated':
    SELECT recent escalated for order_id within cooldown (DB NOW())
    if found → COMMIT, return { added: false, existingEntry }
  INSERT audit row
COMMIT
return { added: true }
```

### 5.2 Wire `escalateOrderHandler`

- Switch import from `addAuditEntry` → `addAuditEntryWithDedup`
- Add `.min(1)` on `order_id`
- If `!added && existingEntry` return JSON (not necessarily `isError`):

```json
{
  "escalation_already_recorded": true,
  "order_id": "...",
  "existing_audit_entry": { ... },
  "message": "… already escalated recently … Duplicate escalation skipped."
}
```

- Else same success shape as Plan 1 (`escalated: true`, audit entry, no state mutation)

→ **verify:** two rapid escalations → one audit row; second response has `escalation_already_recorded: true`.

---

## 6. Retry handler rewrite (`src/tools/retry-fulfillment.ts`)

This is the external contract change. Do it carefully; update tool description text so MCP clients know about `preview_token`.

### 6.1 Schema

```ts
order_id: z.string().min(1)
confirm: z.boolean()  // false = dry-run, true = execute
preview_token: z.string().optional()  // REQUIRED when confirm === true
```

### 6.2 Classifier: `isNonRetryableFailureReason(reason?)`

Export for tests. Case-insensitive substring match against at least:

| Substring |
|---|
| `address validation` |
| `postal code` |
| `zip code` |
| `label_generation_failed` |
| `invalid_address` / `invalid address` |
| `invalid_customer_data` |
| `malformed_payload` |
| `out_of_stock` |
| `fraud` |

Empty/unknown reason → **retryable** (allow).

### 6.3 Handler gate order (must match)

| Step | When | Rule | Error |
|---|---|---|---|
| 1 | always | Order exists | `not_found` |
| 2 | always | Not terminal status | `order_not_retryable` |
| 3 | if fulfillment | Non-retryable failure reason | `not_retryable_data_error` (+ `recommendation: "escalate_order"`) |
| 4 | if fulfillment | `in_progress` + activity &lt; 24h | `fulfillment_active` |
| 5 | **preview only** (`!confirm`) | App-side cooldown quick reject | `double_retry_prevented` |
| 6 | always | Compute `proposedAction`, `nextAttempts`, current state | — |
| 7 | `!confirm` | `createPreviewToken` → return dry-run **with** `preview_token`, `preview_expires_at` | — (no mutation) |
| 8 | `confirm` | Missing token → stop | `preview_required` |
| 9 | `confirm` | Build task + audit entry; `executeFulfillmentRetryTransaction(...)` | Map TX errors (below) |

### 6.4 Dry-run response additions

```json
{
  "dry_run": true,
  "order_id": "...",
  "preview_token": "PRV-...",
  "preview_expires_at": "...",
  "current_state": { ... },
  "proposed_action": "reset_fulfillment_to_pending | create_fulfillment_task",
  "proposed_result": { "fulfillment_status": "pending", "attempts": N, "failure_reason": null },
  "message": "... Pass confirm=true and preview_token to execute."
}
```

### 6.5 Transaction error mapping

| Thrown message contains | Tool `error` |
|---|---|
| `DOUBLE_RETRY_PREVENTED` | `double_retry_prevented` |
| `PREVIEW_INVALID` / `PREVIEW_EXPIRED` / `PREVIEW_MISMATCH` | `preview_invalid` |
| `ORDER_NOT_RETRYABLE` | `order_not_retryable` |
| other | rethrow (500 path) |

→ **verify:**  
- dry-run returns token, DB unchanged  
- confirm without token → `preview_required`  
- confirm with token → success + audit  
- reuse token → `preview_invalid`  
- postal failure dry-run → `not_retryable_data_error`

---

## 7. Safety test expansion (`src/tools/safety.test.ts`)

Keep Plan 1 tests; **adapt** any that called `confirm=true` without a token. Add the new cases. Still: live Postgres, runtime `createOrder()`, no fixtures, `pool.end()` in `afterAll`.

| # | Suite | Assert |
|---|---|---|
| 1 | Dry-run safety | `dry_run` + **`preview_token` present**; order/fulfillment/audit unchanged |
| 2 | Direct confirm block | bare `confirm=true` → `preview_required` |
| 3 | Preview → execute | dry-run token → confirm success; fulfillment `pending`; **one** audit `fulfillment_retry` |
| 4 | Token reuse | second confirm same token → `preview_invalid` (already used) |
| 5 | Non-retryable eligibility | failureReason like `Address validation failed for postal code …` → `not_retryable_data_error`, recommend escalate, status still `failed` |
| 6 | Concurrency | 5 dry-run tokens → `Promise.all` 5 confirms → **exactly 1** `success`; ≥4 blocked (`double_retry_prevented` or equivalent); **one** audit row |
| 7 | Rate-limit | preview+confirm once; second dry-run → `double_retry_prevented` |
| 8 | Terminal | shipped / delivered / cancelled → `order_not_retryable` |
| 9 | Escalate + dedup | first writes audit; rapid second → `escalation_already_recorded`; one row |
| 10 | Stall classification | three stall types still detected (use a **retryable** failure reason like `carrier_system_outage`, not `label_generation_failed`, so this suite stays independent of eligibility) |

→ **verify:** `npm test` — all green. If concurrency flakes, confirm isolation level / that `FOR UPDATE` is actually hit (not a test bug).

---

## 8. Docs & deploy notes (surgical)

Plan 1 README Safety section must be updated so operators/agents match reality:

### 8.1 README changelog bullets

- `retry_fulfillment(confirm=true)` **requires** `preview_token` from a prior `confirm=false`
- Dry-run returns `preview_token` + `preview_expires_at` (10 min, single use)
- New errors: `preview_required`, `preview_invalid`, `not_retryable_data_error`, `escalation_already_recorded`
- Cooldown is transactional under row lock (not just app memory)
- Fulfillment + audit always commit together
- Data-validation failures must use `escalate_order`
- New FUL/AUD IDs are UUID-based

### 8.2 Optional prompt tweak (`diagnose_stalled_orders` in `index.ts`)

Update step text: dry-run obtains token → confirm passes `preview_token`. (If left stale, models may call confirm bare and hit `preview_required` — fixable but noisy.)

### 8.3 Deploy (same style as Plan 1)

| Step | Action |
|---|---|
| 1 | Merge / push branch with Plan 2 code |
| 2 | Ensure hosted Postgres `DATABASE_URL` reachable (Supabase/Render) |
| 3 | On **existing** DBs: alter ID columns to `VARCHAR(100)` if still 50; let `initDb` create `preview_tokens` |
| 4 | `npm install && npm run build` (or Render `buildCommand`) |
| 5 | Restart web service; `curl …/health` |
| 6 | Smoke via MCP Inspector: dry-run → confirm with token |
| 7 | Run `npm test` against a **test** database (not prod) |

No new env vars required for the DB-backed preview design (unlike HMAC secret designs).

→ **verify:** production `/health` ok; one real dry-run+confirm cycle on a non-prod order; tests green on CI/local test DB.

---

## 9. Files touched (target diff surface)

```
src/db.ts                      # VARCHAR(100) + preview_tokens table
src/data-store.ts              # UUID ids, preview token ops, atomic TX, escalation dedup, clearStore
src/tools/retry-fulfillment.ts # schema, classifier, preview gates, TX execute + error map
src/tools/escalate-order.ts    # dedup path, order_id.min(1)
src/tools/safety.test.ts       # expanded matrix; token-aware flows
README.md                      # safety + API changelog (recommended)
src/index.ts                   # prompt text only if updating diagnose workflow
```

**Do not touch for Plan 2:** read tools (`get_order`, `get_fulfillment`, `list_stalled_orders`, `get_audit_log`) except if shared imports break; package deps (no new packages — use `node:crypto`); Express transport.

---

## 10. Implementation order (one-pass)

| Phase | Deliverable | Exit check |
|---|---|---|
| 0 | Decisions locked (table above) | Written; non-goals explicit |
| 1 | `db.ts` schema | `preview_tokens` exists; IDs wide enough |
| 2 | `generateId` + `clearStore` | UUID format; truncate includes tokens |
| 3 | Preview token create/consume | One-time use works under client TX |
| 4 | `executeFulfillmentRetryTransaction` | Atomic write + lock + SQL cooldown |
| 5 | Escalation dedup helper + handler | Second escalate no-ops cleanly |
| 6 | `retry-fulfillment` full gate rewrite | All error codes observable via handler |
| 7 | Safety tests expanded | `npm test` green |
| 8 | README (+ optional prompt) + deploy smoke | Hosted health + one tokenized retry |

**Rule:** Do not start phase N+1 until phase N exit check passes. Prefer the smallest change that makes the next check green.

**Suggested internal PR slicing** (if splitting deploys):

```text
PR-A  schema + UUID ids
PR-B  atomic TX + FOR UPDATE + SQL cooldown     ← highest integrity
PR-C  non-retryable classifier
PR-D  escalation dedup
PR-E  preview_tokens + confirm enforcement + tests + README
```

Or ship as **one deploy** (as `e46c858` did) once all exit checks pass locally.

---

## 11. Explicit non-goals / do not build

- HMAC-signed stateless tokens (this plan uses **DB-backed** tokens)
- Fingerprint / `state_changed_since_preview` (nice-to-have; not in `e46c858` — token binds order + proposed_action only)
- Redis / redlock multi-region locks
- Changing the 10-minute retry cooldown product value
- Blocking **unknown** failure reasons by default
- Auth, payments, real warehouse APIs
- New MCP tools

If a future request needs fingerprinting or HMAC, treat it as **Plan 3**, not a silent expansion of this plan.

---

## 12. Final integration checklist

```
[ ] Base codebase baseline (commit 67e98b5) still boots (npm run build && npm start)
[ ] initDb creates preview_tokens; ID columns hold UUIDs
[ ] generateId uses crypto.randomUUID
[ ] Dry-run → preview_token issued; no DB mutation of fulfillment/audit
[ ] confirm=true without token → preview_required
[ ] confirm=true with token → success; fulfillment + audit atomic
[ ] Token reuse → preview_invalid
[ ] Parallel confirms → exactly one success
[ ] Postal/address failure → not_retryable_data_error
[ ] Double escalate → escalation_already_recorded
[ ] Terminal + rate-limit + stall tests still pass
[ ] npm test green
[ ] README Safety Details matches new contract
[ ] Deployed: /health ok; Inspector dry-run→confirm works on hosted /mcp
```

---

## 13. Severity ranking (implement high risk first if time-boxed)

| Priority | Issue | Phase |
|---|---|---|
| P0 | Non-atomic audit (#1) | 4 |
| P0 | Race + TOCTOU cooldown (#2, #7) | 4 |
| P1 | Preview bypass (#3) | 3 + 6 |
| P1 | Non-retryable data (#4) | 6 |
| P2 | ID collisions (#6) | 2 |
| P2 | Escalation spam (#5) | 5 |
