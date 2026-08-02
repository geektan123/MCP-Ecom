# Stalled Fulfillment Recovery — MCP Server

An MCP server that lets ops (via an AI assistant) diagnose and recover orders stuck in "processing" due to missing or failed fulfillment tasks.

**Safety by construction:** the only write tools are `retry_fulfillment` (resets a fulfillment task) and `escalate_order` (writes an audit entry). There are no payment mutation tools — the domain boundary *is* the safety boundary.

## Product Decisions & Assumptions

**Problem:** Operations teams can't independently diagnose or fix stalled fulfillment issues — they lack cross-system visibility and safe write access, so even routine cases get escalated to engineers.

**Scope:** Single-order investigation of stalled fulfillment. We handle three known stall patterns (no fulfillment task, failed task, silently stalled task). Genuinely novel or ambiguous failures escalate to humans via `escalate_order`.

**Assumptions:**
- User interacts via an MCP-connected AI client (e.g. Claude Desktop) — no custom frontend
- Writes are simulated (no real warehouse/carrier API) but safety boundaries (dry-run, rate-limit, escalation) are real
- Single-order investigation, not batch operations

**Exclusions:** Authentication, multi-tenant access control, payment mutations, real carrier integrations, batch operations, frontend.

## Database Setup (PostgreSQL)

This server uses PostgreSQL for persistent data storage. Tables are auto-created on startup.

```bash
# Environment Variable (optional, defaults to postgres://localhost:5432/fulfillment_mcp)
export DATABASE_URL="postgres://username:password@localhost:5432/fulfillment_mcp"
```

## Quick Start

```bash
npm install
npm run build && npm start   # production on :3000
# or
npm run dev                  # dev server on :3000
```

**Health check:**
```bash
curl http://localhost:3000/health
```

**MCP Inspector:**
```bash
npx @modelcontextprotocol/inspector --url http://localhost:3000/mcp
```

## MCP Capabilities

### Tools

| Tool | Type | Description |
|---|---|---|
| `get_order` | Read | Fetches an order + its fulfillment task in one call |
| `get_fulfillment` | Read | Fetches a fulfillment task by ID with full failure detail |
| `list_stalled_orders` | Read | Surfaces all orders stuck in processing (3 stall types) via optimized SQL JOIN |
| `retry_fulfillment` | **Write** | Resets a stalled fulfillment to `pending`. Always dry-run first |
| `escalate_order` | Write (audit only) | Flags an order for human review without mutating state |
| `get_audit_log` | Read | Returns the full action history for an order |

### Resources

| Resource URI | Description |
|---|---|
| `order://{order_id}` | Direct JSON access to an order and its fulfillment task |
| `fulfillment://{order_id}` | Direct JSON access to a fulfillment task by order ID |

### Prompts

| Prompt | Description |
|---|---|
| `diagnose_stalled_orders` | Guided workflow that instructs the AI to discover stalled orders, inspect each, decide retry vs escalate, and summarize actions. Accepts optional `threshold_hours` parameter. |

## Stall Detection

`list_stalled_orders` detects three types of stall for any `paid`/`processing` order older than `threshold_hours` (default: 24h), using a single optimized SQL `LEFT JOIN` query:

| `stall_reason` | Condition |
|---|---|
| `no_fulfillment_task` | No FulfillmentTask row was ever created |
| `fulfillment_failed` | FulfillmentTask.status === `"failed"` |
| `fulfillment_stalled` | Task is `pending`/`in_progress` but `lastActivityAt` is older than the threshold |

## Example Workflow

```
Ops: "Show me all stuck orders"

AI: → list_stalled_orders(threshold_hours: 24)
    ← 3 stalled orders found

AI: → get_order("ORD-1042")
    ← Order: processing, Fulfillment: failed (warehouse_api_timeout, 2 attempts)

AI: → retry_fulfillment("ORD-1042", confirm=false)
    ← dry_run: will reset FUL-1042 to pending (attempt 3)

Ops: "Looks good, go ahead."

AI: → retry_fulfillment("ORD-1042", confirm=true)
    ← success: fulfillment reset, audit entry created

AI: → get_audit_log("ORD-1042")
    ← [fulfillment_retry @ 2026-08-01T04:15:00Z]
```

## Safety Details

- **Dry-run required:** `retry_fulfillment` returns a preview when `confirm=false` without mutating anything. Show this to the operator before confirming.
- **Rate-limit:** A second retry on the same order within 10 minutes is rejected with `double_retry_prevented`. This is a rate-limit (time window), not true idempotency — a second retry after the cooldown is permitted, because the first may itself have failed.
- **Escalation path:** When an order doesn't match the standard stall pattern, use `escalate_order` to write a permanent audit entry recording *why* the AI declined to act automatically.
- **No payment tools:** There is no refund or payment write tool in this MCP. The scope boundary enforces the safety boundary.

## Development & Testing

```bash
npm run build         # TypeScript compile
npm run test          # Vitest safety tests against live PostgreSQL
npm run test:watch    # Watch mode
```

Tests run against live PostgreSQL and create their own data at runtime — no hardcoded fixtures or seed data dependencies.

## Live Hosted Deployment

The MCP server is live and hosted on Render:

- **Base URL:** `https://mcp-ecom.onrender.com`
- **MCP Endpoint:** `https://mcp-ecom.onrender.com/mcp`
- **Health Check:** `https://mcp-ecom.onrender.com/health`

### Connecting in Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "stalled-fulfillment-recovery": {
      "url": "https://mcp-ecom.onrender.com/mcp"
    }
  }
}
```

## Deployment

The server listens on `process.env.PORT` (default: 3000). Deploy anywhere that runs Node.js and has PostgreSQL access:

- **Railway / Render / Fly.io / Heroku:** push the repo, set `DATABASE_URL` and `PORT`
- **Docker:** `node dist/index.js`
- The MCP endpoint is `POST /mcp` (stateless HTTP, no sessions)

After deploying:
```bash
curl https://mcp-ecom.onrender.com/health
npx @modelcontextprotocol/inspector --url https://mcp-ecom.onrender.com/mcp
```

## Tech Stack

- **Database:** PostgreSQL (`pg` driver)
- **MCP SDK:** `@modelcontextprotocol/sdk` ^1.12 (stable)
- **Transport:** `StreamableHTTPServerTransport` (stateless, HTTP)
- **Framework:** Express 5
- **Validation:** Zod 3
- **Tests:** Vitest — focused safety verification against live PostgreSQL
- **Language:** TypeScript (ESM, strict)
