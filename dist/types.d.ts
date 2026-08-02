export type OrderStatus = 'paid' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
export interface OrderItem {
    productId: string;
    name: string;
    quantity: number;
    unitPrice: number;
}
export interface Order {
    id: string;
    customerId: string;
    status: OrderStatus;
    items: OrderItem[];
    totalAmount: number;
    createdAt: string;
    updatedAt: string;
}
export type FulfillmentStatus = 'pending' | 'in_progress' | 'shipped' | 'delivered' | 'failed' | 'cancelled';
export interface FulfillmentTask {
    id: string;
    orderId: string;
    status: FulfillmentStatus;
    /** Populated when status === 'failed'. */
    failureReason?: string;
    /** How many times fulfillment has been attempted for this order. */
    attempts: number;
    createdAt: string;
    updatedAt: string;
    /**
     * Timestamp of the last meaningful state change (status flip, progress ping).
     * Used to detect tasks stuck in 'pending' or 'in_progress' with no activity.
     */
    lastActivityAt: string;
    shippedAt?: string;
    deliveredAt?: string;
    /** Human-readable carrier + tracking info, set when shipped. */
    trackingInfo?: string;
}
export type AuditAction = 'fulfillment_created' | 'fulfillment_retry' | 'escalated' | 'escalation_declined';
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
    timestamp: string;
}
export type StallReason = 'no_fulfillment_task' | 'fulfillment_failed' | 'fulfillment_stalled';
export interface StalledOrderEntry {
    order: Order;
    fulfillment: FulfillmentTask | null;
    stall_reason: StallReason;
    /** ISO 8601 timestamp of when stalling began (order.createdAt or task.lastActivityAt). */
    stalled_since: string;
}
//# sourceMappingURL=types.d.ts.map