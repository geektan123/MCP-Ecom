import { z } from 'zod';
import { getOrder, getFulfillmentByOrderId } from '../data-store.js';

export const getOrderSchema = {
  order_id: z.string().describe('The order ID to look up (e.g. ORD-1042)'),
};

export async function getOrderHandler(
  args: z.infer<z.ZodObject<typeof getOrderSchema>>
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

  const fulfillment = (await getFulfillmentByOrderId(args.order_id)) ?? null;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ order, fulfillment }, null, 2),
      },
    ],
  };
}
