import { z } from 'zod';
export declare const retryFulfillmentSchema: {
    order_id: z.ZodString;
    confirm: z.ZodBoolean;
};
export declare function retryFulfillmentHandler(args: z.infer<z.ZodObject<typeof retryFulfillmentSchema>>): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
} | {
    content: {
        type: "text";
        text: string;
    }[];
    isError?: undefined;
}>;
//# sourceMappingURL=retry-fulfillment.d.ts.map