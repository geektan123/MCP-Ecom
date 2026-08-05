import crypto from 'node:crypto';
import { pool, initDb } from './db.js';
import type {
  Order,
  OrderItem,
  OrderStatus,
  FulfillmentTask,
  FulfillmentStatus,
  AuditLogEntry,
  StalledOrderEntry,
  StallReason,
} from './types.js';

// ─── Status derivation ────────────────────────────────────────────────────────

function deriveOrderStatus(fulfillmentStatus: FulfillmentStatus): OrderStatus {
  switch (fulfillmentStatus) {
    case 'shipped':
      return 'shipped';
    case 'delivered':
      return 'delivered';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'processing';
  }
}

// ─── Helper Row Mappers ───────────────────────────────────────────────────────

function mapOrder(row: any, items: OrderItem[]): Order {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status as OrderStatus,
    items,
    totalAmount: Number(row.total_amount),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapFulfillment(row: any): FulfillmentTask {
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status as FulfillmentStatus,
    failureReason: row.failure_reason || undefined,
    attempts: Number(row.attempts),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastActivityAt: new Date(row.last_activity_at).toISOString(),
    shippedAt: row.shipped_at ? new Date(row.shipped_at).toISOString() : undefined,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : undefined,
    trackingInfo: row.tracking_info || undefined,
  };
}

function mapAuditEntry(row: any): AuditLogEntry {
  return {
    id: row.id,
    orderId: row.order_id,
    action: row.action,
    performedBy: row.performed_by,
    details: row.details,
    timestamp: new Date(row.timestamp).toISOString(),
  };
}

// ─── Store Reset ──────────────────────────────────────────────────────────────

export async function clearStore(): Promise<void> {
  await initDb();
  const client = await pool.connect();
  try {
    await client.query('TRUNCATE TABLE preview_tokens, audit_log, fulfillment_tasks, order_items, orders CASCADE;');
  } finally {
    client.release();
  }
}

// ─── Read operations ─────────────────────────────────────────────────────────

export async function getOrder(id: string): Promise<Order | undefined> {
  await initDb();
  const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (orderRes.rows.length === 0) {
    return undefined;
  }
  const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [id]);
  const items: OrderItem[] = itemsRes.rows.map((r) => ({
    productId: r.product_id,
    name: r.name,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price),
  }));
  return mapOrder(orderRes.rows[0], items);
}

export async function getAllOrders(): Promise<Order[]> {
  await initDb();
  const ordersRes = await pool.query('SELECT * FROM orders ORDER BY created_at ASC');
  const itemsRes = await pool.query('SELECT * FROM order_items ORDER BY id ASC');

  const itemsByOrder = new Map<string, OrderItem[]>();
  for (const r of itemsRes.rows) {
    const list = itemsByOrder.get(r.order_id) || [];
    list.push({
      productId: r.product_id,
      name: r.name,
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
    });
    itemsByOrder.set(r.order_id, list);
  }

  return ordersRes.rows.map((row) => mapOrder(row, itemsByOrder.get(row.id) || []));
}

export async function getFulfillment(id: string): Promise<FulfillmentTask | undefined> {
  await initDb();
  const res = await pool.query('SELECT * FROM fulfillment_tasks WHERE id = $1', [id]);
  if (res.rows.length === 0) {
    return undefined;
  }
  return mapFulfillment(res.rows[0]);
}

export async function getFulfillmentByOrderId(orderId: string): Promise<FulfillmentTask | undefined> {
  await initDb();
  const res = await pool.query('SELECT * FROM fulfillment_tasks WHERE order_id = $1', [orderId]);
  if (res.rows.length === 0) {
    return undefined;
  }
  return mapFulfillment(res.rows[0]);
}

export async function getAuditLog(orderId: string): Promise<AuditLogEntry[]> {
  await initDb();
  const res = await pool.query('SELECT * FROM audit_log WHERE order_id = $1 ORDER BY timestamp ASC', [orderId]);
  return res.rows.map(mapAuditEntry);
}

// ─── Write operations ─────────────────────────────────────────────────────────

export async function upsertFulfillment(task: FulfillmentTask): Promise<void> {
  await initDb();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO fulfillment_tasks
       (id, order_id, status, failure_reason, attempts, created_at, updated_at, last_activity_at, shipped_at, delivered_at, tracking_info)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (order_id) DO UPDATE SET
         status = EXCLUDED.status,
         failure_reason = EXCLUDED.failure_reason,
         attempts = EXCLUDED.attempts,
         updated_at = EXCLUDED.updated_at,
         last_activity_at = EXCLUDED.last_activity_at,
         shipped_at = EXCLUDED.shipped_at,
         delivered_at = EXCLUDED.delivered_at,
         tracking_info = EXCLUDED.tracking_info`,
      [
        task.id,
        task.orderId,
        task.status,
        task.failureReason || null,
        task.attempts,
        task.createdAt,
        task.updatedAt,
        task.lastActivityAt,
        task.shippedAt || null,
        task.deliveredAt || null,
        task.trackingInfo || null,
      ]
    );

    const derivedStatus = deriveOrderStatus(task.status);
    const now = new Date().toISOString();
    await client.query(
      `UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3`,
      [derivedStatus, now, task.orderId]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function addAuditEntry(entry: AuditLogEntry): Promise<void> {
  await initDb();
  await pool.query(
    `INSERT INTO audit_log (id, order_id, action, performed_by, details, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.id, entry.orderId, entry.action, entry.performedBy, entry.details, entry.timestamp]
  );
}

// ─── ID generation ───────────────────────────────────────────────────────────

export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export interface CreateOrderInput {
  customerId: string;
  items: Array<{ productId: string; name: string; quantity: number; unitPrice: number }>;
  fulfillmentStatus?: FulfillmentStatus | 'none';
  failureReason?: string;
}

export async function createOrder(input: CreateOrderInput): Promise<{ order: Order; fulfillment?: FulfillmentTask }> {
  await initDb();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderId = generateId('ORD');
    const now = new Date().toISOString();

    const totalAmount = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

    const initialOrderStatus: OrderStatus =
      input.fulfillmentStatus === 'shipped' ? 'shipped' :
      input.fulfillmentStatus === 'delivered' ? 'delivered' :
      input.fulfillmentStatus === 'cancelled' ? 'cancelled' : 'processing';

    const orderRes = await client.query(
      `INSERT INTO orders (id, customer_id, status, total_amount, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [orderId, input.customerId, initialOrderStatus, totalAmount, now, now]
    );

    const items: OrderItem[] = [];
    for (const item of input.items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.productId, item.name, item.quantity, item.unitPrice]
      );
      items.push({
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      });
    }

    let fulfillment: FulfillmentTask | undefined = undefined;

    if (input.fulfillmentStatus && input.fulfillmentStatus !== 'none') {
      const fulId = generateId('FUL');
      const fulRes = await client.query(
        `INSERT INTO fulfillment_tasks
         (id, order_id, status, failure_reason, attempts, created_at, updated_at, last_activity_at)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
         RETURNING *`,
        [fulId, orderId, input.fulfillmentStatus, input.failureReason || null, now, now, now]
      );
      fulfillment = mapFulfillment(fulRes.rows[0]);
    }

    await client.query('COMMIT');

    const order = mapOrder(orderRes.rows[0], items);
    return { order, fulfillment };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getStalledOrdersFromDb(thresholdHours: number): Promise<StalledOrderEntry[]> {
  await initDb();
  const query = `
    SELECT 
      o.id as order_id,
      o.customer_id,
      o.status as order_status,
      o.total_amount,
      o.created_at as order_created_at,
      o.updated_at as order_updated_at,
      f.id as fulfillment_id,
      f.status as fulfillment_status,
      f.failure_reason,
      f.attempts,
      f.created_at as fulfillment_created_at,
      f.updated_at as fulfillment_updated_at,
      f.last_activity_at,
      f.shipped_at,
      f.delivered_at,
      f.tracking_info,
      CASE
        WHEN f.id IS NULL THEN 'no_fulfillment_task'
        WHEN f.status = 'failed' THEN 'fulfillment_failed'
        WHEN f.status IN ('pending', 'in_progress') AND f.last_activity_at < (NOW() - ($1 || ' hours')::INTERVAL) THEN 'fulfillment_stalled'
      END as stall_reason
    FROM orders o
    LEFT JOIN fulfillment_tasks f ON o.id = f.order_id
    WHERE o.status IN ('paid', 'processing')
      AND o.created_at < (NOW() - ($1 || ' hours')::INTERVAL)
      AND (
        f.id IS NULL
        OR f.status = 'failed'
        OR (f.status IN ('pending', 'in_progress') AND f.last_activity_at < (NOW() - ($1 || ' hours')::INTERVAL))
      )
    ORDER BY COALESCE(f.last_activity_at, o.created_at) ASC;
  `;

  const res = await pool.query(query, [thresholdHours]);
  if (res.rows.length === 0) {
    return [];
  }

  const orderIds = res.rows.map((r) => r.order_id);
  const itemsRes = await pool.query(
    'SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY id',
    [orderIds]
  );

  const itemsByOrder = new Map<string, OrderItem[]>();
  for (const r of itemsRes.rows) {
    const list = itemsByOrder.get(r.order_id) || [];
    list.push({
      productId: r.product_id,
      name: r.name,
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
    });
    itemsByOrder.set(r.order_id, list);
  }

  return res.rows.map((r) => {
    const orderItems = itemsByOrder.get(r.order_id) || [];
    const order: Order = {
      id: r.order_id,
      customerId: r.customer_id,
      status: r.order_status as OrderStatus,
      items: orderItems,
      totalAmount: Number(r.total_amount),
      createdAt: new Date(r.order_created_at).toISOString(),
      updatedAt: new Date(r.order_updated_at).toISOString(),
    };

    const fulfillment: FulfillmentTask | null = r.fulfillment_id
      ? {
          id: r.fulfillment_id,
          orderId: r.order_id,
          status: r.fulfillment_status as FulfillmentStatus,
          failureReason: r.failure_reason || undefined,
          attempts: Number(r.attempts),
          createdAt: new Date(r.fulfillment_created_at).toISOString(),
          updatedAt: new Date(r.fulfillment_updated_at).toISOString(),
          lastActivityAt: new Date(r.last_activity_at).toISOString(),
          shippedAt: r.shipped_at ? new Date(r.shipped_at).toISOString() : undefined,
          deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : undefined,
          trackingInfo: r.tracking_info || undefined,
        }
      : null;

    const stalledSince = fulfillment ? fulfillment.lastActivityAt : order.createdAt;

    return {
      order,
      fulfillment,
      stall_reason: r.stall_reason as StallReason,
      stalled_since: stalledSince,
    };
  });
}

// ─── Preview Token Operations ──────────────────────────────────────────────────

export async function createPreviewToken(
  orderId: string,
  proposedAction: string,
  attempts: number
): Promise<{ token: string; expiresAt: string }> {
  await initDb();
  const token = `PRV-${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAtDate = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes TTL
  const expiresAt = expiresAtDate.toISOString();
  const createdAt = now.toISOString();

  await pool.query(
    `INSERT INTO preview_tokens (token, order_id, proposed_action, attempts, expires_at, used, created_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, $6)`,
    [token, orderId, proposedAction, attempts, expiresAt, createdAt]
  );

  return { token, expiresAt };
}

export async function validateAndConsumePreviewToken(
  client: any,
  token: string,
  orderId: string,
  proposedAction: string
): Promise<void> {
  const res = await client.query(
    `SELECT * FROM preview_tokens WHERE token = $1 FOR UPDATE`,
    [token]
  );

  if (res.rows.length === 0) {
    throw new Error('PREVIEW_INVALID: The provided preview_token does not exist or is invalid.');
  }

  const row = res.rows[0];
  if (row.order_id !== orderId) {
    throw new Error(`PREVIEW_MISMATCH: preview_token is bound to order ${row.order_id}, not ${orderId}.`);
  }

  if (row.proposed_action !== proposedAction) {
    throw new Error(`PREVIEW_MISMATCH: preview_token proposed action (${row.proposed_action}) does not match current action (${proposedAction}).`);
  }

  if (row.used) {
    throw new Error('PREVIEW_EXPIRED: The provided preview_token has already been used.');
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new Error('PREVIEW_EXPIRED: The provided preview_token has expired. Please run a dry-run again to obtain a new token.');
  }

  await client.query(
    `UPDATE preview_tokens SET used = TRUE WHERE token = $1`,
    [token]
  );
}

// ─── Atomic Fulfillment Retry Transaction ─────────────────────────────────────

export async function executeFulfillmentRetryTransaction(params: {
  orderId: string;
  task: FulfillmentTask;
  auditEntry: AuditLogEntry;
  previewToken?: string;
  cooldownMinutes?: number;
}): Promise<{ order: Order; fulfillment: FulfillmentTask; auditEntry: AuditLogEntry }> {
  await initDb();
  const client = await pool.connect();
  const cooldownMinutes = params.cooldownMinutes ?? 10;

  try {
    await client.query('BEGIN');

    // 1. Pessimistic lock on parent order row to ensure single-threaded execution per order
    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [params.orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new Error(`NOT_FOUND: Order ${params.orderId} not found.`);
    }

    const orderRow = orderRes.rows[0];
    const terminalStatuses = ['shipped', 'delivered', 'cancelled'];
    if (terminalStatuses.includes(orderRow.status)) {
      throw new Error(`ORDER_NOT_RETRYABLE: Order ${params.orderId} has status "${orderRow.status}" and cannot be retried.`);
    }

    // Lock fulfillment row if it exists
    await client.query(
      `SELECT * FROM fulfillment_tasks WHERE order_id = $1 FOR UPDATE`,
      [params.orderId]
    );

    // 2. Validate and consume preview token if provided
    if (params.previewToken) {
      const proposedAction = params.task.attempts === 1 ? 'create_fulfillment_task' : 'reset_fulfillment_to_pending';
      await validateAndConsumePreviewToken(client, params.previewToken, params.orderId, proposedAction);
    }

    // 3. Evaluate cooldown inside the transaction under the lock
    const cooldownRes = await client.query(
      `SELECT timestamp FROM audit_log
       WHERE order_id = $1
         AND action IN ('fulfillment_retry', 'fulfillment_created')
         AND timestamp > (NOW() - ($2 || ' minutes')::INTERVAL)
       ORDER BY timestamp DESC
       LIMIT 1`,
      [params.orderId, cooldownMinutes]
    );

    if (cooldownRes.rows.length > 0) {
      const recentTimestamp = cooldownRes.rows[0].timestamp;
      const minutesAgo = Math.round((Date.now() - new Date(recentTimestamp).getTime()) / 60000);
      throw new Error(`DOUBLE_RETRY_PREVENTED: A retry was already performed on order ${params.orderId} ${minutesAgo} minute(s) ago.`);
    }

    // 4. Upsert fulfillment task
    await client.query(
      `INSERT INTO fulfillment_tasks
       (id, order_id, status, failure_reason, attempts, created_at, updated_at, last_activity_at, shipped_at, delivered_at, tracking_info)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (order_id) DO UPDATE SET
         status = EXCLUDED.status,
         failure_reason = EXCLUDED.failure_reason,
         attempts = EXCLUDED.attempts,
         updated_at = EXCLUDED.updated_at,
         last_activity_at = EXCLUDED.last_activity_at,
         shipped_at = EXCLUDED.shipped_at,
         delivered_at = EXCLUDED.delivered_at,
         tracking_info = EXCLUDED.tracking_info`,
      [
        params.task.id,
        params.task.orderId,
        params.task.status,
        params.task.failureReason || null,
        params.task.attempts,
        params.task.createdAt,
        params.task.updatedAt,
        params.task.lastActivityAt,
        params.task.shippedAt || null,
        params.task.deliveredAt || null,
        params.task.trackingInfo || null,
      ]
    );

    // 5. Derive and update order status
    const derivedStatus = deriveOrderStatus(params.task.status);
    const now = new Date().toISOString();
    await client.query(
      `UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3`,
      [derivedStatus, now, params.orderId]
    );

    // 6. Insert audit log entry
    await client.query(
      `INSERT INTO audit_log (id, order_id, action, performed_by, details, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.auditEntry.id,
        params.auditEntry.orderId,
        params.auditEntry.action,
        params.auditEntry.performedBy,
        params.auditEntry.details,
        params.auditEntry.timestamp,
      ]
    );

    await client.query('COMMIT');

    // Fetch updated order items & construct domain object
    const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [params.orderId]);
    const items: OrderItem[] = itemsRes.rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
    }));

    const finalOrderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [params.orderId]);
    const finalOrder = mapOrder(finalOrderRes.rows[0], items);

    return {
      order: finalOrder,
      fulfillment: params.task,
      auditEntry: params.auditEntry,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Escalation Deduplication ────────────────────────────────────────────────

export async function addAuditEntryWithDedup(
  entry: AuditLogEntry,
  cooldownMinutes = 30
): Promise<{ added: boolean; existingEntry?: AuditLogEntry }> {
  await initDb();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (entry.action === 'escalated') {
      const existingRes = await client.query(
        `SELECT * FROM audit_log
         WHERE order_id = $1
           AND action = 'escalated'
           AND timestamp > (NOW() - ($2 || ' minutes')::INTERVAL)
         ORDER BY timestamp DESC
         LIMIT 1`,
        [entry.orderId, cooldownMinutes]
      );

      if (existingRes.rows.length > 0) {
        await client.query('COMMIT');
        return {
          added: false,
          existingEntry: mapAuditEntry(existingRes.rows[0]),
        };
      }
    }

    await client.query(
      `INSERT INTO audit_log (id, order_id, action, performed_by, details, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.id, entry.orderId, entry.action, entry.performedBy, entry.details, entry.timestamp]
    );

    await client.query('COMMIT');
    return { added: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}



