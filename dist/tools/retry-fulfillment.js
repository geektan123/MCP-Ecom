import { z } from 'zod';
import { getOrder, getFulfillmentByOrderId, getAuditLog, upsertFulfillment, addAuditEntry, generateId, } from '../data-store.js';
export const retryFulfillmentSchema = {
    order_id: z
        .string()
        .describe('The order ID to retry fulfillment for (e.g. ORD-1042)'),
    confirm: z
        .boolean()
        .describe('Pass false for a dry-run preview of what would happen. ' +
        'Pass true to execute the retry. Always call with confirm=false first ' +
        'and show the result to the operator before confirming.'),
};
/** Rate-limit window for double-retry prevention (not idempotency). */
const RETRY_COOLDOWN_MINUTES = 10;
export async function retryFulfillmentHandler(args) {
    const { order_id, confirm } = args;
    // ── 1. Order must exist ───────────────────────────────────────────────────
    const order = await getOrder(order_id);
    if (!order) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ error: 'not_found', message: `Order ${order_id} not found.` }, null, 2),
                },
            ],
            isError: true,
        };
    }
    // ── 2. Order must be retryable ────────────────────────────────────────────
    const terminalStatuses = ['shipped', 'delivered', 'cancelled'];
    if (terminalStatuses.includes(order.status)) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        error: 'order_not_retryable',
                        message: `Order ${order_id} has status "${order.status}" and cannot be retried.`,
                        order_status: order.status,
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
    const existingFulfillment = (await getFulfillmentByOrderId(order_id)) ?? null;
    // ── 3. Reject if fulfillment is actively progressing ─────────────────────
    if (existingFulfillment) {
        const ACTIVE_THRESHOLD_HOURS = 24;
        const activityAgeMs = Date.now() - new Date(existingFulfillment.lastActivityAt).getTime();
        const isRecentlyActive = activityAgeMs < ACTIVE_THRESHOLD_HOURS * 60 * 60 * 1000;
        if (existingFulfillment.status === 'in_progress' && isRecentlyActive) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: 'fulfillment_active',
                            message: `Fulfillment ${existingFulfillment.id} is currently in_progress ` +
                                `with activity ${Math.round(activityAgeMs / 60000)} minutes ago. ` +
                                `Consider escalating instead of retrying.`,
                            fulfillment_status: existingFulfillment.status,
                            last_activity_at: existingFulfillment.lastActivityAt,
                        }, null, 2),
                    },
                ],
                isError: true,
            };
        }
    }
    // ── 4. Rate-limit: prevent double-retry within cooldown window ────────────
    const auditEntries = await getAuditLog(order_id);
    const cooldownMs = RETRY_COOLDOWN_MINUTES * 60 * 1000;
    const recentRetry = auditEntries.find((e) => {
        const isRetryAction = e.action === 'fulfillment_retry' || e.action === 'fulfillment_created';
        const entryAge = Date.now() - new Date(e.timestamp).getTime();
        return isRetryAction && entryAge < cooldownMs;
    });
    if (recentRetry) {
        const minutesAgo = Math.round((Date.now() - new Date(recentRetry.timestamp).getTime()) / 60000);
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        error: 'double_retry_prevented',
                        message: `A retry was already performed on order ${order_id} ${minutesAgo} minute(s) ago. ` +
                            `Wait ${RETRY_COOLDOWN_MINUTES - minutesAgo} more minute(s) before retrying again.`,
                        last_retry_at: recentRetry.timestamp,
                        cooldown_minutes: RETRY_COOLDOWN_MINUTES,
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
    // ── 5. Determine the action ───────────────────────────────────────────────
    const now = new Date().toISOString();
    const isCreate = existingFulfillment === null;
    const proposedAction = isCreate
        ? 'create_fulfillment_task'
        : 'reset_fulfillment_to_pending';
    const currentState = {
        fulfillment_exists: !isCreate,
        fulfillment_id: existingFulfillment?.id ?? null,
        fulfillment_status: existingFulfillment?.status ?? null,
        fulfillment_attempts: existingFulfillment?.attempts ?? 0,
        failure_reason: existingFulfillment?.failureReason ?? null,
    };
    const nextAttempts = (existingFulfillment?.attempts ?? 0) + 1;
    // ── 6. Dry run ────────────────────────────────────────────────────────────
    if (!confirm) {
        const dryRunMessage = isCreate
            ? `Will create a new fulfillment task for order ${order_id} in pending status.`
            : `Will reset fulfillment ${existingFulfillment.id} to pending (attempt #${nextAttempts}). ` +
                (existingFulfillment?.failureReason
                    ? `Clears failure reason: "${existingFulfillment.failureReason}".`
                    : '');
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        dry_run: true,
                        order_id,
                        current_state: currentState,
                        proposed_action: proposedAction,
                        proposed_result: {
                            fulfillment_status: 'pending',
                            attempts: nextAttempts,
                            failure_reason: null,
                        },
                        message: dryRunMessage +
                            ' Call again with confirm=true to execute.',
                    }, null, 2),
                },
            ],
        };
    }
    // ── 7. Execute ────────────────────────────────────────────────────────────
    let updatedFulfillment;
    let auditAction;
    if (isCreate) {
        // Create a brand-new fulfillment task
        updatedFulfillment = {
            id: generateId('FUL'),
            orderId: order_id,
            status: 'pending',
            attempts: 1,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
        };
        auditAction = 'fulfillment_created';
    }
    else {
        // Reset the existing failed/stalled task
        updatedFulfillment = {
            ...existingFulfillment,
            status: 'pending',
            attempts: nextAttempts,
            updatedAt: now,
            lastActivityAt: now,
            failureReason: undefined,
        };
        auditAction = 'fulfillment_retry';
    }
    await upsertFulfillment(updatedFulfillment);
    const auditEntry = {
        id: generateId('AUD'),
        orderId: order_id,
        action: auditAction,
        performedBy: 'mcp_ops_agent',
        details: isCreate
            ? `Fulfillment task ${updatedFulfillment.id} created and set to pending.`
            : `Fulfillment ${updatedFulfillment.id} reset to pending (attempt #${nextAttempts}). ` +
                (currentState.failure_reason
                    ? `Prior failure reason: "${currentState.failure_reason}".`
                    : 'No prior failure reason recorded.'),
        timestamp: now,
    };
    await addAuditEntry(auditEntry);
    const updatedOrder = (await getOrder(order_id));
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    action_taken: auditAction,
                    order: updatedOrder,
                    fulfillment: updatedFulfillment,
                    audit_entry: auditEntry,
                }, null, 2),
            },
        ],
    };
}
//# sourceMappingURL=retry-fulfillment.js.map