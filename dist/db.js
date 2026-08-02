import pg from 'pg';
const { Pool } = pg;
const connectionString = process.env.DATABASE_URL ||
    'postgres://localhost:5432/' +
        (process.env.NODE_ENV === 'test' ? 'fulfillment_mcp_test' : 'fulfillment_mcp');
export const pool = new Pool({
    connectionString,
});
export async function initDb() {
    const client = await pool.connect();
    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        customer_id VARCHAR(50) NOT NULL,
        status VARCHAR(30) NOT NULL,
        total_amount INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(50) REFERENCES orders(id) ON DELETE CASCADE,
        product_id VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fulfillment_tasks (
        id VARCHAR(50) PRIMARY KEY,
        order_id VARCHAR(50) UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        status VARCHAR(30) NOT NULL,
        failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_activity_at TIMESTAMPTZ NOT NULL,
        shipped_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        tracking_info TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id VARCHAR(50) PRIMARY KEY,
        order_id VARCHAR(50) REFERENCES orders(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        performed_by VARCHAR(100) NOT NULL,
        details TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL
      );
    `);
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=db.js.map