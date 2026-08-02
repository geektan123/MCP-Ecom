import { z } from 'zod';
import { getFulfillment } from '../data-store.js';
export const getFulfillmentSchema = {
    fulfillment_id: z
        .string()
        .describe('The fulfillment task ID to look up (e.g. FUL-1042)'),
};
export async function getFulfillmentHandler(args) {
    const fulfillment = await getFulfillment(args.fulfillment_id);
    if (!fulfillment) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        error: 'not_found',
                        message: `Fulfillment task ${args.fulfillment_id} not found.`,
                    }, null, 2),
                },
            ],
            isError: true,
        };
    }
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({ fulfillment }, null, 2),
            },
        ],
    };
}
//# sourceMappingURL=get-fulfillment.js.map