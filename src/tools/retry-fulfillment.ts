import { z } from 'zod';
import {
  getOrder,
  getFulfillmentByOrderId,
  getAuditLog,
  executeFulfillmentRetryTransaction,
  createPreviewToken,
  generateId,
} from '../data-store.js';
import type { FulfillmentTask, AuditLogEntry } from '../types.js';

export const retryFulfillmentSchema = {
  order_id: z
    .string()
    .min(1)
    .describe('The order ID to retry fulfillment for (e.g. ORD-1042)'),
  confirm: z
    .boolean()
    .describe(
      'Pass false for a dry-run preview of what would happen. ' +
        'Pass true to execute the retry. Always call with confirm=false first ' +
        'and show the result to the operator before confirming.'
    ),
  preview_token: z
    .string()
    .optional()
    .describe(
      'Required when confirm=true. The server-generated preview token obtained from a prior confirm=false dry-run.'
    ),
};

/** Rate-limit window for double-retry prevention. */
const RETRY_COOLDOWN_MINUTES = 10;

export function isNonRetryableFailureReason(reason?: string): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  const ineligibleSubstrings = [
    'address validation',
    'postal code',
    'zip code',
    'label_generation_failed',
    'invalid_address',
    'invalid address',
    'invalid_customer_data',
    'malformed_payload',
    'out_of_stock',
    'fraud',
  ];
  return ineligibleSubstrings.some((sub) => lower.includes(sub));
}

export async function retryFulfillmentHandler(
  args: z.infer<z.ZodObject<typeof retryFulfillmentSchema>>
) {
  const { order_id, confirm, preview_token } = args;

  // ── 1. Order must exist ───────────────────────────────────────────────────
  const order = await getOrder(order_id);
  if (!order) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { error: 'not_found', message: `Order ${order_id} not found.` },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // ── 2. Order must be retryable ────────────────────────────────────────────
  const terminalStatuses = ['shipped', 'delivered', 'cancelled'] as const;
  if (terminalStatuses.includes(order.status as typeof terminalStatuses[number])) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: 'order_not_retryable',
              message: `Order ${order_id} has status "${order.status}" and cannot be retried.`,
              order_status: order.status,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const existingFulfillment = (await getFulfillmentByOrderId(order_id)) ?? null;

  // ── 3. Check failure reason eligibility (e.g. ORD-1031 postal code failure) ────
  if (existingFulfillment && isNonRetryableFailureReason(existingFulfillment.failureReason)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: 'not_retryable_data_error',
              message:
                `Fulfillment for order ${order_id} failed due to data validation/eligibility error ` +
                `("${existingFulfillment.failureReason}"). Automated retries cannot resolve input data errors. ` +
                `Use escalate_order to flag for human review.`,
              failure_reason: existingFulfillment.failureReason,
              recommendation: 'escalate_order',
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // ── 4. Reject if fulfillment is actively progressing ─────────────────────
  if (existingFulfillment) {
    const ACTIVE_THRESHOLD_HOURS = 24;
    const activityAgeMs =
      Date.now() - new Date(existingFulfillment.lastActivityAt).getTime();
    const isRecentlyActive =
      activityAgeMs < ACTIVE_THRESHOLD_HOURS * 60 * 60 * 1000;

    if (existingFulfillment.status === 'in_progress' && isRecentlyActive) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'fulfillment_active',
                message:
                  `Fulfillment ${existingFulfillment.id} is currently in_progress ` +
                  `with activity ${Math.round(activityAgeMs / 60000)} minutes ago. ` +
                  `Consider escalating instead of retrying.`,
                fulfillment_status: existingFulfillment.status,
                last_activity_at: existingFulfillment.lastActivityAt,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  // ── 5. Rate-limit check (read-side quick check during preview) ───────────
  if (!confirm) {
    const auditEntries = await getAuditLog(order_id);
    const cooldownMs = RETRY_COOLDOWN_MINUTES * 60 * 1000;
    const recentRetry = auditEntries.find((e) => {
      const isRetryAction =
        e.action === 'fulfillment_retry' || e.action === 'fulfillment_created';
      const entryAge = Date.now() - new Date(e.timestamp).getTime();
      return isRetryAction && entryAge < cooldownMs;
    });

    if (recentRetry) {
      const minutesAgo = Math.round(
        (Date.now() - new Date(recentRetry.timestamp).getTime()) / 60000
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'double_retry_prevented',
                message:
                  `A retry was already performed on order ${order_id} ${minutesAgo} minute(s) ago. ` +
                  `Wait ${RETRY_COOLDOWN_MINUTES - minutesAgo} more minute(s) before retrying again.`,
                last_retry_at: recentRetry.timestamp,
                cooldown_minutes: RETRY_COOLDOWN_MINUTES,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  // ── 6. Determine action details ───────────────────────────────────────────
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

  // ── 7. Dry-run Preview (confirm = false) ──────────────────────────────────
  if (!confirm) {
    const previewInfo = await createPreviewToken(order_id, proposedAction, nextAttempts);

    const dryRunMessage = isCreate
      ? `Will create a new fulfillment task for order ${order_id} in pending status.`
      : `Will reset fulfillment ${existingFulfillment!.id} to pending (attempt #${nextAttempts}). ` +
        (existingFulfillment?.failureReason
          ? `Clears failure reason: "${existingFulfillment.failureReason}".`
          : '');

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              dry_run: true,
              order_id,
              preview_token: previewInfo.token,
              preview_expires_at: previewInfo.expiresAt,
              current_state: currentState,
              proposed_action: proposedAction,
              proposed_result: {
                fulfillment_status: 'pending',
                attempts: nextAttempts,
                failure_reason: null,
              },
              message:
                dryRunMessage +
                ' Pass confirm=true and preview_token to execute.',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // ── 8. Execute Retry (confirm = true) ──────────────────────────────────────
  if (!preview_token) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: 'preview_required',
              message:
                `Direct confirmation with confirm=true is blocked without a server-verified prior preview. ` +
                `Call with confirm=false first to obtain a valid preview_token.`,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  let updatedFulfillment: FulfillmentTask;
  let auditAction: AuditLogEntry['action'];

  if (isCreate) {
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
  } else {
    updatedFulfillment = {
      ...existingFulfillment!,
      status: 'pending',
      attempts: nextAttempts,
      updatedAt: now,
      lastActivityAt: now,
      failureReason: undefined,
    };
    auditAction = 'fulfillment_retry';
  }

  const auditEntry: AuditLogEntry = {
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

  try {
    const result = await executeFulfillmentRetryTransaction({
      orderId: order_id,
      task: updatedFulfillment,
      auditEntry,
      previewToken: preview_token,
      cooldownMinutes: RETRY_COOLDOWN_MINUTES,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              action_taken: auditAction,
              order: result.order,
              fulfillment: result.fulfillment,
              audit_entry: result.auditEntry,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes('DOUBLE_RETRY_PREVENTED')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { error: 'double_retry_prevented', message: msg },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    if (
      msg.includes('PREVIEW_INVALID') ||
      msg.includes('PREVIEW_EXPIRED') ||
      msg.includes('PREVIEW_MISMATCH')
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { error: 'preview_invalid', message: msg },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    if (msg.includes('ORDER_NOT_RETRYABLE')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { error: 'order_not_retryable', message: msg },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    throw err;
  }
}
