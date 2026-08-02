import type { Order, FulfillmentTask, FulfillmentStatus, AuditLogEntry, StalledOrderEntry } from './types.js';
export declare function clearStore(): Promise<void>;
export declare function getOrder(id: string): Promise<Order | undefined>;
export declare function getAllOrders(): Promise<Order[]>;
export declare function getFulfillment(id: string): Promise<FulfillmentTask | undefined>;
export declare function getFulfillmentByOrderId(orderId: string): Promise<FulfillmentTask | undefined>;
export declare function getAuditLog(orderId: string): Promise<AuditLogEntry[]>;
export declare function upsertFulfillment(task: FulfillmentTask): Promise<void>;
export declare function addAuditEntry(entry: AuditLogEntry): Promise<void>;
export declare function generateId(prefix: string): string;
export interface CreateOrderInput {
    customerId: string;
    items: Array<{
        productId: string;
        name: string;
        quantity: number;
        unitPrice: number;
    }>;
    fulfillmentStatus?: FulfillmentStatus | 'none';
    failureReason?: string;
}
export declare function createOrder(input: CreateOrderInput): Promise<{
    order: Order;
    fulfillment?: FulfillmentTask;
}>;
export declare function getStalledOrdersFromDb(thresholdHours: number): Promise<StalledOrderEntry[]>;
//# sourceMappingURL=data-store.d.ts.map