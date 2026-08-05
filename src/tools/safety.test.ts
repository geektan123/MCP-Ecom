/**
 * Safety-critical behavior tests — run against live PostgreSQL.
 *
 * Every test creates its own data at runtime via createOrder().
 * No hardcoded IDs, no seed-data dependencies.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { retryFulfillmentHandler } from './retry-fulfillment.js';
import { escalateOrderHandler } from './escalate-order.js';
import { listStalledOrdersHandler } from './list-stalled-orders.js';
import {
  createOrder,
  getOrder,
  getFulfillmentByOrderId,
  getAuditLog,
} from '../data-store.js';
import { pool } from '../db.js';

afterAll(async () => {
  await pool.end();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

const TEST_ITEMS = [{ productId: 'PROD-T1', name: 'Test Widget', quantity: 1, unitPrice: 1000 }];

// ─── 1. Dry-run does NOT mutate state & returns preview_token ─────────────────

describe('retry_fulfillment — dry-run safety & preview token generation', () => {
  it('returns a preview token without changing order or fulfillment state', async () => {
    const { order, fulfillment } = await createOrder({
      customerId: 'CUST-DRY',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'warehouse_api_timeout',
    });

    // Dry-run call
    const result = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.dry_run).toBe(true);
    expect(data.preview_token).toBeDefined();
    expect(data.preview_token).toMatch(/^PRV-/);
    expect(data.proposed_action).toBe('reset_fulfillment_to_pending');

    // Verify DB state is untouched
    const orderAfter = await getOrder(order.id);
    const fulAfter = await getFulfillmentByOrderId(order.id);
    expect(orderAfter!.status).toBe(order.status);
    expect(fulAfter!.status).toBe(fulfillment!.status);
    expect(fulAfter!.failureReason).toBe('warehouse_api_timeout');

    // Audit log remains empty
    const logs = await getAuditLog(order.id);
    expect(logs).toHaveLength(0);
  });
});

// ─── 2. Server-Enforced Preview Validation ────────────────────────────────────

describe('retry_fulfillment — server-enforced preview requirements', () => {
  it('blocks direct execution when confirm=true is called without preview_token', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-DIRECT',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'network_timeout',
    });

    const directCall = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: true,
    });

    const data = JSON.parse(directCall.content[0].text);
    expect(data.error).toBe('preview_required');
    expect(data.message).toContain('Direct confirmation with confirm=true is blocked');

    // DB remains unchanged
    const ful = await getFulfillmentByOrderId(order.id);
    expect(ful!.status).toBe('failed');
  });

  it('executes successfully when valid preview_token is supplied', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-HAPPY',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'network_timeout',
    });

    // Step 1: Get preview
    const dryRun = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });
    const dryData = JSON.parse(dryRun.content[0].text);
    const token = dryData.preview_token;

    // Step 2: Confirm with preview_token
    const confirmRes = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: true,
      preview_token: token,
    });

    const confirmData = JSON.parse(confirmRes.content[0].text);
    expect(confirmData.success).toBe(true);

    // Verify atomic DB updates
    const fulAfter = await getFulfillmentByOrderId(order.id);
    expect(fulAfter!.status).toBe('pending');

    const logs = await getAuditLog(order.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('fulfillment_retry');
  });

  it('rejects reuse of an already consumed preview_token', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-REUSE',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'network_timeout',
    });

    const dryRun = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });
    const token = JSON.parse(dryRun.content[0].text).preview_token;

    // First use
    await retryFulfillmentHandler({
      order_id: order.id,
      confirm: true,
      preview_token: token,
    });

    // Second use attempt with same token
    const secondUse = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: true,
      preview_token: token,
    });

    const secondData = JSON.parse(secondUse.content[0].text);
    expect(secondData.error).toBe('preview_invalid');
    expect(secondData.message).toContain('already been used');
  });
});

// ─── 3. Data Validation / Postal Code Eligibility Rejection (ORD-1031) ───────

describe('retry_fulfillment — non-retryable failure eligibility', () => {
  it('blocks retry on postal code & address validation errors (ORD-1031 scenario)', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-ORD1031',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'Address validation failed for postal code 90210',
    });

    const result = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('not_retryable_data_error');
    expect(data.recommendation).toBe('escalate_order');
    expect(data.message).toContain('Automated retries cannot resolve input data errors');

    // DB remains unchanged
    const ful = await getFulfillmentByOrderId(order.id);
    expect(ful!.status).toBe('failed');
  });
});

// ─── 4. Concurrency Safety & Parallel Retry Race Condition Test ──────────────

describe('retry_fulfillment — atomic transaction & concurrency safety', () => {
  it('ensures exactly one request succeeds when concurrent retries execute simultaneously', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-RACE',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'carrier_timeout',
    });

    // Obtain 5 valid preview tokens
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const dry = await retryFulfillmentHandler({
        order_id: order.id,
        confirm: false,
      });
      tokens.push(JSON.parse(dry.content[0].text).preview_token);
    }

    // Launch all 5 retries concurrently
    const results = await Promise.all(
      tokens.map((token) =>
        retryFulfillmentHandler({
          order_id: order.id,
          confirm: true,
          preview_token: token,
        })
      )
    );

    const parsedResults = results.map((r) => JSON.parse(r.content[0].text));
    const successes = parsedResults.filter((p) => p.success === true);
    const blocked = parsedResults.filter(
      (p) => p.error === 'double_retry_prevented' || p.error === 'order_not_retryable'
    );

    expect(successes).toHaveLength(1);
    expect(blocked.length).toBeGreaterThanOrEqual(4);

    // Verify DB has exactly 1 retry audit entry
    const logs = await getAuditLog(order.id);
    expect(logs).toHaveLength(1);
  });
});

// ─── 5. Rate-limit blocks double retry ────────────────────────────────────────

describe('retry_fulfillment — rate-limit', () => {
  it('prevents a second retry within the 10-minute cooldown window', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-RATE',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'network_error',
    });

    const dryRun = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });
    const token = JSON.parse(dryRun.content[0].text).preview_token;

    // First retry — execute
    const first = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: true,
      preview_token: token,
    });
    const firstData = JSON.parse(first.content[0].text);
    expect(firstData.success).toBe(true);

    // Second retry — should be blocked at preview stage
    const second = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });
    const secondData = JSON.parse(second.content[0].text);
    expect(secondData.error).toBe('double_retry_prevented');
  });
});

// ─── 6. Terminal orders are rejected ──────────────────────────────────────────

describe('retry_fulfillment — terminal order rejection', () => {
  it('rejects retry on a shipped order', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-SHIP',
      items: TEST_ITEMS,
      fulfillmentStatus: 'shipped',
    });

    const result = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('order_not_retryable');
    expect(data.order_status).toBe('shipped');
  });

  it('rejects retry on a delivered order', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-DLVR',
      items: TEST_ITEMS,
      fulfillmentStatus: 'delivered',
    });

    const result = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('order_not_retryable');
    expect(data.order_status).toBe('delivered');
  });

  it('rejects retry on a cancelled order', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-CNCL',
      items: TEST_ITEMS,
      fulfillmentStatus: 'cancelled',
    });

    const result = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('order_not_retryable');
    expect(data.order_status).toBe('cancelled');
  });
});

// ─── 7. Escalation writes audit log & handles deduplication ───────────────────

describe('escalate_order — audit-only safety & deduplication', () => {
  it('writes an audit entry without changing order or fulfillment state', async () => {
    const { order, fulfillment } = await createOrder({
      customerId: 'CUST-ESC',
      items: TEST_ITEMS,
      fulfillmentStatus: 'in_progress',
    });

    const reason = 'Fulfillment appears active but operator suspects partial shipment — escalating for human review.';

    const result = await escalateOrderHandler({
      order_id: order.id,
      reason,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.escalated).toBe(true);
    expect(data.order_id).toBe(order.id);

    // Verify order & fulfillment are unchanged
    const orderAfter = await getOrder(order.id);
    const fulAfter = await getFulfillmentByOrderId(order.id);
    expect(orderAfter!.status).toBe(order.status);
    expect(fulAfter!.status).toBe(fulfillment!.status);

    // Verify audit log has exactly one escalation entry
    const logs = await getAuditLog(order.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('escalated');
    expect(logs[0].details).toBe(reason);
  });

  it('prevents rapid duplicate escalations on the same order', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-ESCDUP',
      items: TEST_ITEMS,
      fulfillmentStatus: 'in_progress',
    });

    const reason = 'Operator escalation reason for testing deduplication.';

    // First escalation
    await escalateOrderHandler({ order_id: order.id, reason });

    // Rapid second escalation
    const secondCall = await escalateOrderHandler({ order_id: order.id, reason });
    const secondData = JSON.parse(secondCall.content[0].text);

    expect(secondData.escalation_already_recorded).toBe(true);
    expect(secondData.message).toContain('already escalated recently');

    // Verify audit log has only 1 record
    const logs = await getAuditLog(order.id);
    expect(logs).toHaveLength(1);
  });
});

// ─── 8. Stall detection classifies correctly ─────────────────────────────────

describe('list_stalled_orders — stall classification', () => {
  it('detects no_fulfillment_task, fulfillment_failed, and fulfillment_stalled', async () => {
    const noFul = await createOrder({
      customerId: 'CUST-STALL1',
      items: TEST_ITEMS,
      fulfillmentStatus: 'none',
    });

    const failedFul = await createOrder({
      customerId: 'CUST-STALL2',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'carrier_system_outage',
    });

    const stalledFul = await createOrder({
      customerId: 'CUST-STALL3',
      items: TEST_ITEMS,
      fulfillmentStatus: 'in_progress',
    });

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    await pool.query(
      'UPDATE orders SET created_at = $1, updated_at = $1 WHERE id = ANY($2)',
      [threeDaysAgo, [noFul.order.id, failedFul.order.id, stalledFul.order.id]]
    );
    await pool.query(
      'UPDATE fulfillment_tasks SET created_at = $1, updated_at = $1, last_activity_at = $1 WHERE order_id = ANY($2)',
      [threeDaysAgo, [failedFul.order.id, stalledFul.order.id]]
    );

    const result = await listStalledOrdersHandler({ threshold_hours: 1 });
    const data = JSON.parse(result.content[0].text);

    const stalledIds = data.stalled_orders.map((s: any) => s.order.id);
    const stalledReasons = new Map(
      data.stalled_orders.map((s: any) => [s.order.id, s.stall_reason])
    );

    expect(stalledIds).toContain(noFul.order.id);
    expect(stalledIds).toContain(failedFul.order.id);
    expect(stalledIds).toContain(stalledFul.order.id);

    expect(stalledReasons.get(noFul.order.id)).toBe('no_fulfillment_task');
    expect(stalledReasons.get(failedFul.order.id)).toBe('fulfillment_failed');
    expect(stalledReasons.get(stalledFul.order.id)).toBe('fulfillment_stalled');
  });
});
