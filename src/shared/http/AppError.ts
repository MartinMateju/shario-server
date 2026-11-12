export type AppErrorCode = string;

export type AppErrorDetails =
    | string
    | string[]
    | Record<string, unknown>
    | unknown;

export class AppError extends Error {
    readonly statusCode: number;
    readonly status: "fail" | "error";
    readonly code?: AppErrorCode;
    readonly details?: AppErrorDetails;
    readonly isOperational: boolean;
    // Internal classification set after authentication checks, never from input.
    readonly logReason?: "workspace_cookie_customer_probe";

    constructor({
        message,
        statusCode = 500,
        code,
        details,
        isOperational = true,
        logReason,
    }: {
        message: string;
        statusCode?: number;
        code?: AppErrorCode;
        details?: AppErrorDetails;
        isOperational?: boolean;
        logReason?: "workspace_cookie_customer_probe";
    }) {
        super(message);

        this.name = "AppError";
        this.statusCode = statusCode;
        this.status = statusCode < 500 ? "fail" : "error";
        this.code = code;
        this.details = details;
        this.isOperational = isOperational;
        this.logReason = logReason;

        Object.setPrototypeOf(this, new.target.prototype);
        Error.captureStackTrace?.(this, this.constructor);
    }
}
