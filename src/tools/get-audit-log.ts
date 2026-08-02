import { z } from 'zod';
import { getOrder, getAuditLog } from '../data-store.js';

export const getAuditLogSchema = {
  order_id: z
    .string()
    .describe('The order ID whose audit history to retrieve (e.g. ORD-1042)'),
};

export async function getAuditLogHandler(
  args: z.infer<z.ZodObject<typeof getAuditLogSchema>>
) {
  const order = await getOrder(args.order_id);

  if (!order) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { error: 'not_found', message: `Order ${args.order_id} not found.` },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const entries = await getAuditLog(args.order_id);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            order_id: args.order_id,
            entries,
            total_count: entries.length,
          },
          null,
          2
        ),
      },
    ],
  };
}
