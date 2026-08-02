import { z } from 'zod';
export declare const getOrderSchema: {
    order_id: z.ZodString;
};
export declare function getOrderHandler(args: z.infer<z.ZodObject<typeof getOrderSchema>>): Promise<{
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
//# sourceMappingURL=get-order.d.ts.map