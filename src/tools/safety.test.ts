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
  addAuditEntry,
  generateId,
} from '../data-store.js';
import { pool } from '../db.js';
import type { AuditLogEntry } from '../types.js';

afterAll(async () => {
  await pool.end();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

const TEST_ITEMS = [{ productId: 'PROD-T1', name: 'Test Widget', quantity: 1, unitPrice: 1000 }];

// ─── 1. Dry-run does NOT mutate state ─────────────────────────────────────────

describe('retry_fulfillment — dry-run safety', () => {
  it('returns a preview without changing order or fulfillment state', async () => {
    // Create a failed fulfillment at runtime
    const { order, fulfillment } = await createOrder({
      customerId: 'CUST-DRY',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'warehouse_api_timeout',
    });

    // Dry-run
    const result = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.dry_run).toBe(true);
    expect(data.proposed_action).toBe('reset_fulfillment_to_pending');

    // Verify nothing changed in DB
    const orderAfter = await getOrder(order.id);
    const fulAfter = await getFulfillmentByOrderId(order.id);
    expect(orderAfter!.status).toBe(order.status);
    expect(fulAfter!.status).toBe(fulfillment!.status);
    expect(fulAfter!.failureReason).toBe('warehouse_api_timeout');

    // No audit entry created
    const logs = await getAuditLog(order.id);
    expect(logs).toHaveLength(0);
  });
});

// ─── 2. Rate-limit blocks double retry ────────────────────────────────────────

describe('retry_fulfillment — rate-limit', () => {
  it('prevents a second retry within the 10-minute cooldown window', async () => {
    const { order } = await createOrder({
      customerId: 'CUST-RATE',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'network_error',
    });

    // First retry — execute
    const first = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: true,
    });
    const firstData = JSON.parse(first.content[0].text);
    expect(firstData.success).toBe(true);

    // Second retry — should be blocked
    const second = await retryFulfillmentHandler({
      order_id: order.id,
      confirm: false,
    });
    const secondData = JSON.parse(second.content[0].text);
    expect(secondData.error).toBe('double_retry_prevented');
  });
});

// ─── 3. Terminal orders are rejected ──────────────────────────────────────────

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

// ─── 4. Escalation writes audit log only — no state mutation ──────────────────

describe('escalate_order — audit-only safety', () => {
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

    // Verify audit log has exactly one escalation entry with the verbatim reason
    const logs = await getAuditLog(order.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('escalated');
    expect(logs[0].details).toBe(reason);
    expect(logs[0].performedBy).toBe('mcp_ops_agent');
  });
});

// ─── 5. Stall detection classifies correctly ─────────────────────────────────

describe('list_stalled_orders — stall classification', () => {
  it('detects no_fulfillment_task, fulfillment_failed, and fulfillment_stalled', async () => {
    // Create an order with NO fulfillment task (stall type 1)
    const noFul = await createOrder({
      customerId: 'CUST-STALL1',
      items: TEST_ITEMS,
      fulfillmentStatus: 'none',
    });

    // Create an order with a FAILED fulfillment (stall type 2)
    const failedFul = await createOrder({
      customerId: 'CUST-STALL2',
      items: TEST_ITEMS,
      fulfillmentStatus: 'failed',
      failureReason: 'label_generation_failed',
    });

    // Create a stalled in_progress fulfillment (stall type 3)
    // We need to backdate the timestamps to make it appear stale
    const stalledFul = await createOrder({
      customerId: 'CUST-STALL3',
      items: TEST_ITEMS,
      fulfillmentStatus: 'in_progress',
    });

    // Backdate the orders and fulfillments to 3 days ago so they pass the threshold
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    await pool.query(
      'UPDATE orders SET created_at = $1, updated_at = $1 WHERE id = ANY($2)',
      [threeDaysAgo, [noFul.order.id, failedFul.order.id, stalledFul.order.id]]
    );
    await pool.query(
      'UPDATE fulfillment_tasks SET created_at = $1, updated_at = $1, last_activity_at = $1 WHERE order_id = ANY($2)',
      [threeDaysAgo, [failedFul.order.id, stalledFul.order.id]]
    );

    // Query stalled orders with a low threshold to catch our test data
    const result = await listStalledOrdersHandler({ threshold_hours: 1 });
    const data = JSON.parse(result.content[0].text);

    const stalledIds = data.stalled_orders.map((s: any) => s.order.id);
    const stalledReasons = new Map(
      data.stalled_orders.map((s: any) => [s.order.id, s.stall_reason])
    );

    // All three should appear
    expect(stalledIds).toContain(noFul.order.id);
    expect(stalledIds).toContain(failedFul.order.id);
    expect(stalledIds).toContain(stalledFul.order.id);

    // With correct classification
    expect(stalledReasons.get(noFul.order.id)).toBe('no_fulfillment_task');
    expect(stalledReasons.get(failedFul.order.id)).toBe('fulfillment_failed');
    expect(stalledReasons.get(stalledFul.order.id)).toBe('fulfillment_stalled');
  });
});
