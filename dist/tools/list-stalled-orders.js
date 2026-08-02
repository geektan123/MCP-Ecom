import { z } from 'zod';
import { getStalledOrdersFromDb } from '../data-store.js';
export const listStalledOrdersSchema = {
    threshold_hours: z
        .number()
        .positive()
        .optional()
        .describe('Minimum age of the order in hours before it is considered stalled. ' +
        'Prevents flagging brand-new orders still being processed. Default: 24.'),
};
const DEFAULT_THRESHOLD_HOURS = 24;
export async function listStalledOrdersHandler(args) {
    const thresholdHours = args.threshold_hours ?? DEFAULT_THRESHOLD_HOURS;
    const stalled = await getStalledOrdersFromDb(thresholdHours);
    const result = {
        stalled_orders: stalled,
        total_count: stalled.length,
        threshold_hours: thresholdHours,
    };
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(result, null, 2),
            },
        ],
    };
}
//# sourceMappingURL=list-stalled-orders.js.map