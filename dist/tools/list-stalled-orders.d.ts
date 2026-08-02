import { z } from 'zod';
export declare const listStalledOrdersSchema: {
    threshold_hours: z.ZodOptional<z.ZodNumber>;
};
export declare function listStalledOrdersHandler(args: z.infer<z.ZodObject<typeof listStalledOrdersSchema>>): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
//# sourceMappingURL=list-stalled-orders.d.ts.map