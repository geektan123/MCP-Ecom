# Plan: Safety & Concurrency Fixes for Stalled Fulfillment Recovery MCP

**Status:** Verified against current codebase (`src/`)  
**Date:** 2026-03-26  
**Scope:** Write-path correctness for `retry_fulfillment` and `escalate_order`

---

## Executive summary

All seven reported problems **exist** in the current implementation. They are not theoretical: each maps to concrete code paths in `retry-fulfillment.ts`, `escalate-order.ts`, and `data-store.ts`. Together they allow:

- Silent audit gaps after successful mutations
- Double retries under concurrent load
- Writes without operator preview
- Infinite retries of non-retryable data errors (e.g. ORD-1031)
- Escalation log spam
- Primary-key collisions after process restart / multi-instance deploy

This plan prioritizes fixes by risk, then outlines implementation, tests, and rollout.

---

## Verification matrix

| # | Area | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Write Safety — non-atomic audit commit | **Confirmed** | `upsertFulfillment` commits in its own transaction; `addAuditEntry` is a separate `pool.query`. Crash or failure between them leaves mutated fulfillment with no audit row. |
| 2 | Concurrency — race on simultaneous retries | **Confirmed** | No `SELECT … FOR UPDATE`, no advisory lock, no unique “retry-in-window” constraint. Two concurrent `confirm=true` calls can both pass the cooldown check. |
| 3 | Approval — `confirm=true` bypasses preview | **Confirmed** | Schema accepts bare `confirm: true`. No `preview_token`, no server-side proof that dry-run ran. README guidance is soft only. |
| 4 | Eligibility — retrying invalid address / postal (ORD-1031) | **Confirmed** | Seed has `label_generation_failed: Address validation failed for postal code`. Handler never classifies failure reasons; any non-terminal order is retryable. |
| 5 | Escalation — audit log spam | **Confirmed** | `escalateOrderHandler` always inserts; no cooldown or dedup on `action = 'escalated'`. |
| 6 | ID Generation — PK collision across restarts | **Confirmed** | `generateId` uses process-local `seq = Date.now() % 100000` then `++seq`. Restarts and multi-instance deploys can reuse IDs → PK violations or silent overwrite risk. |
| 7 | Rate Limit — in-memory / TOCTOU cooldown | **Confirmed** | Cooldown is `getAuditLog` + `Date.now()` in app code **before** any lock. Check is not inside the write transaction; races with #2. |

### Code anchors

```
src/tools/retry-fulfillment.ts
  L108–142  cooldown check (unlocked, app-side Date.now)
  L162–196  dry-run (optional; not enforced for confirm=true)
  L198–243  execute: upsertFulfillment then addAuditEntry (two steps)

src/data-store.ts
  L144–191  upsertFulfillment (own BEGIN/COMMIT)
  L194–201  addAuditEntry (separate insert)
  L205–209  generateId (Date.now() % 100000 counter)

src/tools/escalate-order.ts
  L41–52    always insert escalated audit entry

dist/seed-supabase.js
  ORD-1031  failureReason: address / postal validation (non-retryable data)
```

---

## Goals

1. **Atomicity:** Every successful fulfillment mutation has a matching audit row in the same DB transaction (or neither).
2. **Serializability of retries per order:** At most one retry execution path holds the order/fulfillment row at a time; cooldown is evaluated under that lock.
3. **Preview integrity:** Execution requires a short-lived, server-issued `preview_token` bound to order + proposed action.
4. **Eligibility:** Data-validation / permanent failures cannot be retried; must escalate.
5. **Escalation hygiene:** Duplicate escalations within a cooldown window are rejected or no-op with a clear error.
6. **Safe IDs:** Cryptographically unique (or DB-generated) IDs for FUL/AUD (and preferably ORD).

Non-goals for this plan: auth/multi-tenant ACL, real warehouse APIs, batch ops, payment tools.

---

## Proposed design

### 1. Single transactional write path for retry

Introduce `executeFulfillmentRetry(orderId, …)` in `data-store.ts` that, on one client connection:

```text
BEGIN
  SELECT * FROM fulfillment_tasks WHERE order_id = $1 FOR UPDATE
  -- if no row, lock parent order instead:
  SELECT * FROM orders WHERE id = $1 FOR UPDATE

  -- re-read order status, terminal checks
  -- re-evaluate cooldown from audit_log under same transaction
  -- re-evaluate eligibility (failure_reason class)

  UPSERT fulfillment_tasks …
  UPDATE orders SET status = … 
  INSERT INTO audit_log …

COMMIT
```

- Move cooldown (#7) and race control (#2) **inside** this transaction.
- Replace the split `upsertFulfillment` + `addAuditEntry` pair in the confirm path (#1).
- On any error after BEGIN, ROLLBACK so neither mutation nor audit persists.

**Optional hardening:** unique partial index or constraint is hard for time windows; row lock + transactional re-check is enough for this scale. If multi-region writers appear later, consider Redis/redlock or a `retry_locks` table with `expires_at`.

### 2. Pessimistic locking + transactional cooldown

```sql
-- Cooldown re-check inside the locked transaction
SELECT 1
FROM audit_log
WHERE order_id = $1
  AND action IN ('fulfillment_retry', 'fulfillment_created')
  AND timestamp > NOW() - ($2 || ' minutes')::interval
LIMIT 1;
```

- Prefer `NOW()` (DB clock) over `Date.now()` for consistency across instances.
- If a recent retry exists → raise `double_retry_prevented` and roll back (no writes).
- Keep `RETRY_COOLDOWN_MINUTES = 10` unless product changes it.

### 3. Server-generated `preview_token`

**Flow:**

1. `confirm=false` (or omit confirm / use `mode: "preview"`) runs all eligibility checks **without** locking for write (or with a short shared lock if desired), returns dry-run payload **plus**:

   ```json
   {
     "dry_run": true,
     "preview_token": "<opaque>",
     "preview_expires_at": "<ISO>",
     "proposed_action": "...",
     "proposed_fingerprint": "sha256(...)"
   }
   ```

2. `confirm=true` **requires** `preview_token`. Reject with `preview_required` if missing; `preview_invalid` / `preview_expired` / `preview_mismatch` if bad.

**Token design (recommended):**

- HMAC-signed payload (or store in DB / Redis):
  - `order_id`
  - `proposed_action` (`create_fulfillment_task` | `reset_fulfillment_to_pending`)
  - `fulfillment_id` (if any)
  - `attempts` / fingerprint of current state
  - `exp` (e.g. 10–15 minutes)
- Secret: `PREVIEW_TOKEN_SECRET` env var (or derived from existing config).
- On confirm: re-load current state under lock; if fingerprint ≠ token fingerprint → reject (`state_changed_since_preview`); operator must re-preview.

**Schema change:**

```ts
confirm: z.boolean(),
preview_token: z.string().optional(), // required when confirm === true
```

Enforce in handler: `if (confirm && !preview_token) → error`.

### 4. Block retries on non-retryable failure reasons

Define a classifier (shared constant module):

| Class | Examples (match substrings / codes) | Policy |
|-------|-------------------------------------|--------|
| `transient` | `warehouse_api_timeout`, `network_error`, `carrier_unavailable` | Allow retry |
| `data_validation` | `label_generation_failed`, `Address validation`, `postal code`, `invalid_address` | **Block** → suggest `escalate_order` |
| `permanent` | `sku_discontinued`, `fraud_hold` (if present) | **Block** |
| `unknown` | anything else | Default: **allow** with warning *or* block — **recommend allow + warn** for prototype, block for production-hardening |

For ORD-1031 specifically:

```text
failureReason includes "Address validation" / "postal code" / "label_generation_failed"
→ error: "not_retryable_data_error"
→ message: require escalate_order; do not reset to pending
```

Apply on both preview and execute paths (execute re-checks under lock).

### 5. Escalation deduplication

In `escalate_order` (and preferably inside a small transaction):

```sql
SELECT * FROM audit_log
WHERE order_id = $1 AND action = 'escalated'
  AND timestamp > NOW() - interval '30 minutes'  -- configurable
ORDER BY timestamp DESC
LIMIT 1;
```

- If recent escalation exists **and** reason is identical (or always, for simpler policy): return `escalation_already_recorded` with the prior entry; **do not** insert again.
- Policy choice (document in README):
  - **A (recommended):** Dedup any escalation within cooldown regardless of reason text (stops spam).
  - **B:** Dedup only when `details` matches exactly (allows new distinct reasons).

Also consider: still allow insert if reason is materially different under policy B.

### 6. Cryptographically safe ID generation

Replace:

```ts
let seq = Date.now() % 100000;
export function generateId(prefix: string): string {
  return `${prefix}-${++seq}`;
}
```

With one of:

| Option | Pros | Cons |
|--------|------|------|
| **A. `crypto.randomUUID()`** → `FUL-${uuid}` / `AUD-${uuid}` | Simple, collision-safe, no DB round-trip | Longer IDs; breaks “pretty” FUL-1031 style |
| **B. `gen_random_uuid()` in SQL** as DEFAULT | DB-owned | Requires schema change; app currently supplies IDs |
| **C. Keep human prefix + ULID/UUID** | Readable + safe | Slightly longer |

**Recommendation:** Option A (or ULID) for FUL and AUD immediately. Seeded demo IDs (`ORD-1031`, `FUL-1031`) remain fixed in seed script; only **generated** IDs change.

Widen `VARCHAR(50)` if needed (UUID string is 36 + prefix ≈ 40–44; 50 is tight for `FUL-` + uuid → use `VARCHAR(64)` or `TEXT`).

### 7. Cooldown inside locked SQL transaction

Covered by §1–2. Explicit acceptance criteria:

- Cooldown decision uses rows visible under the same transaction snapshot as the write.
- Two parallel retries: one succeeds, one gets `double_retry_prevented` (or serialization error mapped to that).
- No reliance on process-local memory for “last retry time.”

---

## Implementation plan (PR-sized steps)

### PR 1 — Safe IDs + schema headroom (Issue #6)

1. Replace `generateId` with UUID/ULID-based implementation.
2. Alter `fulfillment_tasks.id` and `audit_log.id` column width if required (`VARCHAR(64)`).
3. Update any tests that assume sequential IDs.
4. Smoke-test createOrder / retry / escalate.

**Risk:** Low. **Rollback:** easy.

### PR 2 — Atomic retry + row lock + transactional cooldown (Issues #1, #2, #7)

1. Add `retryFulfillmentInTransaction(orderId, buildTask, …)` in `data-store.ts`.
2. Refactor `retryFulfillmentHandler` confirm path to call it only.
3. Use `SELECT … FOR UPDATE` on fulfillment (or order if no task).
4. Re-check terminal status, active-in-progress, and cooldown inside TX.
5. Insert audit in same TX as upsert.
6. Tests:
   - Crash simulation: mock failure after upsert-before-commit is N/A if single TX; instead assert no partial rows via forced mid-TX error.
   - Concurrent double-retry (Promise.all) → exactly one success, one `double_retry_prevented`.
   - Existing rate-limit test still passes.

**Risk:** Medium (core write path). **Rollback:** revert PR.

### PR 3 — Non-retryable failure classification (Issue #4)

1. Add `classifyFailureReason(reason?: string)` helper.
2. Block data-validation class in preview + execute.
3. Seed/test ORD-1031-equivalent order; assert `not_retryable_data_error` and unchanged fulfillment.
4. Document failure classes in README.

**Risk:** Low–medium (product policy). Align with ops on “unknown” default.

### PR 4 — Preview token enforcement (Issue #3)

1. Implement HMAC (or DB-backed) preview tokens.
2. Extend tool schema; update tool description / `diagnose_stalled_orders` prompt.
3. Reject `confirm=true` without valid token.
4. Reject token when state fingerprint changed.
5. Tests: bypass attempt, expired token, mismatched state, happy path preview→confirm.

**Risk:** Medium (API contract change for MCP clients). Version tool description clearly.

### PR 5 — Escalation dedup (Issue #5)

1. Cooldown constant (e.g. 30 min).
2. Check + optional insert in one short transaction.
3. Tests: two rapid escalations → one row; after cooldown → second allowed.
4. README: document behavior.

**Risk:** Low.

---

## Suggested implementation order

```text
PR1 (IDs) → PR2 (atomic + lock + cooldown) → PR3 (eligibility) → PR5 (escalation dedup) → PR4 (preview token)
```

Rationale: PR2 is the highest integrity fix and unblocks correct cooldown. PR4 changes the external tool contract and should land after core safety is solid so clients adapt once.

---

## Test plan

| Case | Expected |
|------|----------|
| Dry-run does not write | Unchanged (existing test) |
| Confirm without preview_token | `preview_required` |
| Preview → confirm happy path | success + single audit row |
| Preview → state changes → confirm | `state_changed_since_preview` |
| Two concurrent confirms | one success, one rate-limit/conflict |
| Second retry within 10 min | `double_retry_prevented` |
| Forced error mid-TX | zero fulfillment change, zero audit |
| ORD-1031-style postal failure | `not_retryable_data_error`; escalate works |
| Double escalate within window | second rejected / returns existing |
| generateId × N + simulated “restart” | no PK collisions under load |
| Terminal orders | still rejected |

Add a focused concurrency test file if vitest + live Postgres can run parallel handlers safely.

---

## API / behavior changelog (for README)

- `retry_fulfillment(confirm=true)` **requires** `preview_token` from a prior dry-run.
- Dry-run response includes `preview_token` and `preview_expires_at`.
- New errors: `preview_required`, `preview_invalid`, `preview_expired`, `preview_mismatch`, `state_changed_since_preview`, `not_retryable_data_error`, `escalation_already_recorded`.
- Cooldown evaluated in DB transaction under row lock.
- Fulfillment + audit always commit together.
- IDs for new FUL/AUD are UUID-based.
- Data-validation failures must use `escalate_order`, not retry.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| MCP clients break on required `preview_token` | Clear tool descriptions; temporary soft-launch flag `REQUIRE_PREVIEW_TOKEN=true` (default on in prod) |
| `FOR UPDATE` deadlocks under load | Always lock in consistent order: order row then fulfillment; keep TX short |
| Clock skew with HMAC `exp` | Prefer short TTL + DB `NOW()` for cooldown; token exp uses signing time |
| Over-blocking “unknown” failures | Start with allow+warn for unknown; log metrics; tighten later |
| Longer UUID IDs in demos | Keep seed IDs human-readable; only runtime-generated IDs change |

---

## Success criteria

- [ ] All seven issues have code-level fixes merged
- [ ] Safety tests green against live PostgreSQL
- [ ] New concurrency + eligibility + preview-token tests green
- [ ] README Safety Details section updated
- [ ] No partial “fulfillment updated / audit missing” state possible on the confirm path
- [ ] ORD-1031-class failures cannot be retried

---

## Appendix: severity ranking

| Priority | Issue | Why |
|----------|-------|-----|
| P0 | #1 Non-atomic audit | Breaks audit integrity (core safety claim) |
| P0 | #2 / #7 Race + TOCTOU cooldown | Double warehouse retries under concurrent agents |
| P1 | #3 Preview bypass | Operator safety / dry-run contract |
| P1 | #4 Non-retryable data | Wrong automated action on bad address |
| P2 | #6 ID collisions | Operational failures on restart / scale-out |
| P2 | #5 Escalation spam | Noise, not incorrect mutation |

---

## Decision log (open)

1. **Unknown failure reasons:** allow-with-warn vs block?
2. **Escalation dedup:** any reason vs identical reason only?
3. **Preview token storage:** signed stateless HMAC vs server-side table?
4. **ID format:** `FUL-<uuid>` vs pure UUID column?

Defaults if no product input: **allow-with-warn**, **dedup any within window**, **HMAC**, **`FUL-<uuid>`**.
