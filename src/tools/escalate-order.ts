import { z } from 'zod';
import { getOrder, addAuditEntryWithDedup, generateId } from '../data-store.js';
import type { AuditLogEntry } from '../types.js';

export const escalateOrderSchema = {
  order_id: z
    .string()
    .min(1)
    .describe('The order ID to escalate (e.g. ORD-1042)'),
  reason: z
    .string()
    .min(10)
    .describe(
      'A clear explanation of why this case is being escalated to human review ' +
        'instead of being auto-resolved. Be specific — this text is written to the ' +
        'permanent audit log and will be read by the ops team.'
    ),
};

export async function escalateOrderHandler(
  args: z.infer<z.ZodObject<typeof escalateOrderSchema>>
) {
  const { order_id, reason } = args;

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

  const now = new Date().toISOString();

  const auditEntry: AuditLogEntry = {
    id: generateId('AUD'),
    orderId: order_id,
    action: 'escalated',
    performedBy: 'mcp_ops_agent',
    details: reason,
    timestamp: now,
  };

  const { added, existingEntry } = await addAuditEntryWithDedup(auditEntry, 30);

  if (!added && existingEntry) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              escalation_already_recorded: true,
              order_id,
              existing_audit_entry: existingEntry,
              message: `Order ${order_id} was already escalated recently (${existingEntry.timestamp}). Duplicate escalation skipped.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            escalated: true,
            order_id,
            audit_entry: auditEntry,
            message: `Order ${order_id} has been flagged for human review. No automated action was taken.`,
          },
          null,
          2
        ),
      },
    ],
  };
}
