import { z } from 'zod';
export declare const getAuditLogSchema: {
    order_id: z.ZodString;
};
export declare function getAuditLogHandler(args: z.infer<z.ZodObject<typeof getAuditLogSchema>>): Promise<{
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
//# sourceMappingURL=get-audit-log.d.ts.map