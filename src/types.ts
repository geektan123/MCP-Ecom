// ─── Order ──────────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'paid'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number; // cents
}

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  totalAmount: number; // cents
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ─── FulfillmentTask ─────────────────────────────────────────────────────────
//
// FulfillmentTask is the source of truth for shipment state.
// Order.status is derived from FulfillmentTask.status by the data store:
//   fulfillment.status === 'shipped'    →  order.status = 'shipped'
//   fulfillment.status === 'delivered'  →  order.status = 'delivered'
//   fulfillment.status === 'pending'
//     | 'in_progress'
//     | 'failed'
//     | 'cancelled'                     →  order.status = 'processing'

export type FulfillmentStatus =
  | 'pending'
  | 'in_progress'
  | 'shipped'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface FulfillmentTask {
  id: string;
  orderId: string;
  status: FulfillmentStatus;
  /** Populated when status === 'failed'. */
  failureReason?: string;
  /** How many times fulfillment has been attempted for this order. */
  attempts: number;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  /**
   * Timestamp of the last meaningful state change (status flip, progress ping).
   * Used to detect tasks stuck in 'pending' or 'in_progress' with no activity.
   */
  lastActivityAt: string; // ISO 8601
  shippedAt?: string;
  deliveredAt?: string;
  /** Human-readable carrier + tracking info, set when shipped. */
  trackingInfo?: string;
}

// ─── AuditLog ────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'fulfillment_created'  // retry_fulfillment created a new task
  | 'fulfillment_retry'    // retry_fulfillment reset an existing failed/stalled task
  | 'escalated'            // escalate_order: AI flagged for human review
  | 'escalation_declined'; // (reserved for future use if the AI explains why it won't escalate)

export interface AuditLogEntry {
  id: string;
  orderId: string;
  action: AuditAction;
  /**
   * Who performed the action. Hardcoded to "mcp_ops_agent" in this prototype —
   * there is no auth layer. A future version would populate this from the
   * session/JWT of the calling ops user.
   */
  performedBy: string;
  details: string;
  timestamp: string; // ISO 8601
}

// ─── Tool response helpers ───────────────────────────────────────────────────

export type StallReason =
  | 'no_fulfillment_task'   // no FulfillmentTask row exists
  | 'fulfillment_failed'    // FulfillmentTask.status === 'failed'
  | 'fulfillment_stalled';  // FulfillmentTask is pending/in_progress but lastActivityAt is stale

export interface StalledOrderEntry {
  order: Order;
  fulfillment: FulfillmentTask | null;
  stall_reason: StallReason;
  /** ISO 8601 timestamp of when stalling began (order.createdAt or task.lastActivityAt). */
  stalled_since: string;
}
