/**
 * Stalled Fulfillment Recovery — MCP Server
 *
 * Transport: Express + StreamableHTTPServerTransport (stateless)
 * SDK:       @modelcontextprotocol/sdk (stable, ^1.12)
 *
 * Endpoint:  POST /mcp   — JSON-RPC 2.0 MCP requests
 * Health:    GET  /health — deployment verification
 */

import express from 'express';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { getOrderSchema, getOrderHandler } from './tools/get-order.js';
import { getFulfillmentSchema, getFulfillmentHandler } from './tools/get-fulfillment.js';
import {
  listStalledOrdersSchema,
  listStalledOrdersHandler,
} from './tools/list-stalled-orders.js';
import {
  retryFulfillmentSchema,
  retryFulfillmentHandler,
} from './tools/retry-fulfillment.js';
import { escalateOrderSchema, escalateOrderHandler } from './tools/escalate-order.js';
import { getAuditLogSchema, getAuditLogHandler } from './tools/get-audit-log.js';
import { getOrder, getFulfillmentByOrderId } from './data-store.js';

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'stalled-fulfillment-recovery',
  version: '1.0.0',
});

// ─── Resources ────────────────────────────────────────────────────────────────

server.registerResource(
  'order_details',
  new ResourceTemplate('order://{order_id}', { list: undefined }),
  {
    title: 'Order Details',
    description: 'Direct resource access to an order and its associated fulfillment task.',
    mimeType: 'application/json',
  },
  async (uri, { order_id }) => {
    const id = Array.isArray(order_id) ? order_id[0] : order_id;
    const order = await getOrder(id);
    if (!order) {
      throw new Error(`Order ${id} not found.`);
    }
    const fulfillment = (await getFulfillmentByOrderId(id)) ?? null;
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({ order, fulfillment }, null, 2),
        },
      ],
    };
  }
);

server.registerResource(
  'fulfillment_details',
  new ResourceTemplate('fulfillment://{order_id}', { list: undefined }),
  {
    title: 'Fulfillment Task Details',
    description: 'Direct resource access to the fulfillment task for a given order ID.',
    mimeType: 'application/json',
  },
  async (uri, { order_id }) => {
    const id = Array.isArray(order_id) ? order_id[0] : order_id;
    const fulfillment = await getFulfillmentByOrderId(id);
    if (!fulfillment) {
      throw new Error(`Fulfillment task for order ${id} not found.`);
    }
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(fulfillment, null, 2),
        },
      ],
    };
  }
);

// ─── Prompts ──────────────────────────────────────────────────────────────────

server.registerPrompt(
  'diagnose_stalled_orders',
  {
    title: 'Diagnose & Recover Stalled Orders',
    description:
      'Guided investigation workflow for discovering stalled processing orders, inspecting fulfillment failure details, and executing safe retries or human escalations.',
    argsSchema: {
      threshold_hours: z.string().optional().describe('Filter threshold in hours (default: 24)'),
    },
  },
  async ({ threshold_hours }) => {
    const hours = threshold_hours ?? '24';
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Please systematically investigate all stalled fulfillment orders using threshold_hours=${hours}.\n\n` +
              `Follow this operational workflow:\n` +
              `1. Call tool list_stalled_orders(threshold_hours: ${hours}) to discover stuck orders.\n` +
              `2. For each stalled order:\n` +
              `   a. Inspect order history via get_order(order_id) or resource order://<order_id>.\n` +
              `   b. If the stall reason is a temporary failure (e.g. timeout) or missing task, call retry_fulfillment(order_id, confirm: false) to inspect the dry-run preview.\n` +
              `   c. If the preview is valid, confirm execution with retry_fulfillment(order_id, confirm: true).\n` +
              `   d. If the order has complex issues (fraud suspicion, active fulfillment, partial items), call escalate_order(order_id, reason).\n` +
              `3. Summarize all actions taken and audit logs generated.`,
          },
        },
      ],
    };
  }
);

// ─── Tool registrations ───────────────────────────────────────────────────────

server.tool(
  'get_order',
  'Retrieve an order and its associated fulfillment task in a single call. ' +
    'Use this first to diagnose why an order is stuck. Returns null for fulfillment ' +
    'if no task was ever created.',
  getOrderSchema,
  getOrderHandler
);

server.tool(
  'get_fulfillment',
  'Retrieve a fulfillment task by ID, including its full status history, ' +
    'attempt count, and failure reason (if any). Use when you need to drill into ' +
    'why a specific task failed.',
  getFulfillmentSchema,
  getFulfillmentHandler
);

server.tool(
  'list_stalled_orders',
  'List all orders that are paid/processing but have no fulfillment activity. ' +
    'Detects three stall types: (1) no fulfillment task created, (2) fulfillment task failed, ' +
    '(3) fulfillment task stuck in pending/in_progress with no recent activity. ' +
    'Use threshold_hours to adjust sensitivity (default: 24 hours).',
  listStalledOrdersSchema,
  listStalledOrdersHandler
);

server.tool(
  'retry_fulfillment',
  'Retry fulfillment for a stalled order. ALWAYS call with confirm=false first to ' +
    'see a dry-run preview, then call with confirm=true to execute. ' +
    'This is the only write tool that affects order/fulfillment state. ' +
    'Includes rate-limiting (10-minute cooldown) to prevent double-retries.',
  retryFulfillmentSchema,
  retryFulfillmentHandler
);

server.tool(
  'escalate_order',
  'Flag an order for human review by writing an audit log entry. ' +
    'Use this when the situation does not match the standard stall/retry pattern — ' +
    'for example, partial shipments, suspected fraud, or active fulfillment that ' +
    'just appears stalled. This does NOT change order or fulfillment state. ' +
    'The reason is written permanently to the audit log.',
  escalateOrderSchema,
  escalateOrderHandler
);

server.tool(
  'get_audit_log',
  'Retrieve the complete audit history for an order, sorted chronologically. ' +
    'Shows all retries, escalations, and their timestamps and reasons.',
  getAuditLogSchema,
  getAuditLogHandler
);

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/**
 * POST /mcp — stateless MCP endpoint.
 *
 * Each request gets a fresh transport instance (sessionIdGenerator: undefined).
 * This makes the server horizontally scalable and avoids in-memory session leaks.
 */
app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  // Ensure transport cleanup when the connection closes
  res.on('close', () => {
    transport.close().catch((err) =>
      console.error('Error closing transport:', err)
    );
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// GET /mcp — not needed for stateless HTTP (no SSE session required)
app.get('/mcp', (_req, res) => {
  res.status(405).json({
    error: 'method_not_allowed',
    message: 'This MCP server uses stateless HTTP. Only POST /mcp is supported.',
  });
});

// DELETE /mcp — no sessions to terminate
app.delete('/mcp', (_req, res) => {
  res.status(405).json({
    error: 'method_not_allowed',
    message: 'This MCP server is stateless and does not maintain sessions.',
  });
});

// Health check — for deployment verification
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'stalled-fulfillment-recovery',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

import { initDb } from './db.js';

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function startServer() {
  await initDb();

  app.listen(PORT, () => {
    console.error(`✓ Stalled Fulfillment Recovery MCP server listening on port ${PORT}`);
    console.error(`  POST /mcp   — MCP endpoint`);
    console.error(`  GET  /health — health check`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

