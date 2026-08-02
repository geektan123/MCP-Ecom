import { z } from 'zod';
export declare const getFulfillmentSchema: {
    fulfillment_id: z.ZodString;
};
export declare function getFulfillmentHandler(args: z.infer<z.ZodObject<typeof getFulfillmentSchema>>): Promise<{
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
//# sourceMappingURL=get-fulfillment.d.ts.map