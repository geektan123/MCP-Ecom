import { pool, initDb } from './db.js';
// ─── Status derivation ────────────────────────────────────────────────────────
function deriveOrderStatus(fulfillmentStatus) {
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
function mapOrder(row, items) {
    return {
        id: row.id,
        customerId: row.customer_id,
        status: row.status,
        items,
        totalAmount: Number(row.total_amount),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
    };
}
function mapFulfillment(row) {
    return {
        id: row.id,
        orderId: row.order_id,
        status: row.status,
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
function mapAuditEntry(row) {
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
export async function clearStore() {
    await initDb();
    const client = await pool.connect();
    try {
        await client.query('TRUNCATE TABLE audit_log, fulfillment_tasks, order_items, orders CASCADE;');
    }
    finally {
        client.release();
    }
}
// ─── Read operations ─────────────────────────────────────────────────────────
export async function getOrder(id) {
    await initDb();
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) {
        return undefined;
    }
    const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [id]);
    const items = itemsRes.rows.map((r) => ({
        productId: r.product_id,
        name: r.name,
        quantity: Number(r.quantity),
        unitPrice: Number(r.unit_price),
    }));
    return mapOrder(orderRes.rows[0], items);
}
export async function getAllOrders() {
    await initDb();
    const ordersRes = await pool.query('SELECT * FROM orders ORDER BY created_at ASC');
    const itemsRes = await pool.query('SELECT * FROM order_items ORDER BY id ASC');
    const itemsByOrder = new Map();
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
export async function getFulfillment(id) {
    await initDb();
    const res = await pool.query('SELECT * FROM fulfillment_tasks WHERE id = $1', [id]);
    if (res.rows.length === 0) {
        return undefined;
    }
    return mapFulfillment(res.rows[0]);
}
export async function getFulfillmentByOrderId(orderId) {
    await initDb();
    const res = await pool.query('SELECT * FROM fulfillment_tasks WHERE order_id = $1', [orderId]);
    if (res.rows.length === 0) {
        return undefined;
    }
    return mapFulfillment(res.rows[0]);
}
export async function getAuditLog(orderId) {
    await initDb();
    const res = await pool.query('SELECT * FROM audit_log WHERE order_id = $1 ORDER BY timestamp ASC', [orderId]);
    return res.rows.map(mapAuditEntry);
}
// ─── Write operations ─────────────────────────────────────────────────────────
export async function upsertFulfillment(task) {
    await initDb();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO fulfillment_tasks
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
         tracking_info = EXCLUDED.tracking_info`, [
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
        ]);
        const derivedStatus = deriveOrderStatus(task.status);
        const now = new Date().toISOString();
        await client.query(`UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3`, [derivedStatus, now, task.orderId]);
        await client.query('COMMIT');
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
}
export async function addAuditEntry(entry) {
    await initDb();
    await pool.query(`INSERT INTO audit_log (id, order_id, action, performed_by, details, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)`, [entry.id, entry.orderId, entry.action, entry.performedBy, entry.details, entry.timestamp]);
}
// ─── ID generation ───────────────────────────────────────────────────────────
let seq = Date.now() % 100000;
export function generateId(prefix) {
    return `${prefix}-${++seq}`;
}
export async function createOrder(input) {
    await initDb();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const orderId = generateId('ORD');
        const now = new Date().toISOString();
        const totalAmount = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
        const initialOrderStatus = input.fulfillmentStatus === 'shipped' ? 'shipped' :
            input.fulfillmentStatus === 'delivered' ? 'delivered' :
                input.fulfillmentStatus === 'cancelled' ? 'cancelled' : 'processing';
        const orderRes = await client.query(`INSERT INTO orders (id, customer_id, status, total_amount, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`, [orderId, input.customerId, initialOrderStatus, totalAmount, now, now]);
        const items = [];
        for (const item of input.items) {
            await client.query(`INSERT INTO order_items (order_id, product_id, name, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`, [orderId, item.productId, item.name, item.quantity, item.unitPrice]);
            items.push({
                productId: item.productId,
                name: item.name,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
            });
        }
        let fulfillment = undefined;
        if (input.fulfillmentStatus && input.fulfillmentStatus !== 'none') {
            const fulId = generateId('FUL');
            const fulRes = await client.query(`INSERT INTO fulfillment_tasks
         (id, order_id, status, failure_reason, attempts, created_at, updated_at, last_activity_at)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
         RETURNING *`, [fulId, orderId, input.fulfillmentStatus, input.failureReason || null, now, now, now]);
            fulfillment = mapFulfillment(fulRes.rows[0]);
        }
        await client.query('COMMIT');
        const order = mapOrder(orderRes.rows[0], items);
        return { order, fulfillment };
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
}
export async function getStalledOrdersFromDb(thresholdHours) {
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
    const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY id', [orderIds]);
    const itemsByOrder = new Map();
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
        const order = {
            id: r.order_id,
            customerId: r.customer_id,
            status: r.order_status,
            items: orderItems,
            totalAmount: Number(r.total_amount),
            createdAt: new Date(r.order_created_at).toISOString(),
            updatedAt: new Date(r.order_updated_at).toISOString(),
        };
        const fulfillment = r.fulfillment_id
            ? {
                id: r.fulfillment_id,
                orderId: r.order_id,
                status: r.fulfillment_status,
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
            stall_reason: r.stall_reason,
            stalled_since: stalledSince,
        };
    });
}
//# sourceMappingURL=data-store.js.map