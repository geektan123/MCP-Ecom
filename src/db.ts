import pg from 'pg';

const { Pool } = pg;

import fs from 'fs';
import path from 'path';

if (!process.env.DATABASE_URL) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/^DATABASE_URL=["']?([^"'\r\n]+)["']?/m);
      if (match && match[1]) {
        process.env.DATABASE_URL = match[1];
      }
    }
  } catch {
    // Ignore error reading .env
  }
}

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://localhost:5432/' +
    (process.env.NODE_ENV === 'test' ? 'fulfillment_mcp_test' : 'fulfillment_mcp');

const isRemoteDb = Boolean(
  process.env.DATABASE_URL &&
    (process.env.DATABASE_URL.includes('supabase') ||
      process.env.DATABASE_URL.includes('sslmode=') ||
      process.env.NODE_ENV === 'production')
);

export const pool = new Pool({
  connectionString,
  ...(isRemoteDb ? { ssl: { rejectUnauthorized: false } } : {}),
});

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(100) PRIMARY KEY,
        customer_id VARCHAR(100) NOT NULL,
        status VARCHAR(30) NOT NULL,
        total_amount INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(100) REFERENCES orders(id) ON DELETE CASCADE,
        product_id VARCHAR(100) NOT NULL,
        name VARCHAR(255) NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fulfillment_tasks (
        id VARCHAR(100) PRIMARY KEY,
        order_id VARCHAR(100) UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
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
        id VARCHAR(100) PRIMARY KEY,
        order_id VARCHAR(100) REFERENCES orders(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        performed_by VARCHAR(100) NOT NULL,
        details TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preview_tokens (
        token VARCHAR(100) PRIMARY KEY,
        order_id VARCHAR(100) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        proposed_action VARCHAR(50) NOT NULL,
        attempts INTEGER NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL
      );
    `);
  } finally {
    client.release();
  }
}
