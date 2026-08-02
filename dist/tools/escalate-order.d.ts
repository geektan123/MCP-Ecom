import { z } from 'zod';
export declare const escalateOrderSchema: {
    order_id: z.ZodString;
    reason: z.ZodString;
};
export declare function escalateOrderHandler(args: z.infer<z.ZodObject<typeof escalateOrderSchema>>): Promise<{
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
//# sourceMappingURL=escalate-order.d.ts.map