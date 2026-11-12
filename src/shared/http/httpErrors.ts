import { AppError, type AppErrorCode, type AppErrorDetails } from "./AppError.js";

type HttpErrorInput = {
  message?: string;
  code?: AppErrorCode;
  details?: AppErrorDetails;
};

const createHttpError = ({
  statusCode,
  defaultMessage,
  defaultCode,
  input,
}: {
  statusCode: number;
  defaultMessage: string;
  defaultCode: AppErrorCode;
  input?: string | HttpErrorInput;
}): never => {
  if (typeof input === "string") {
    throw new AppError({
      statusCode,
      message: input,
      code: defaultCode,
    });
  }

  throw new AppError({
    statusCode,
    message: input?.message ?? defaultMessage,
    code: input?.code ?? defaultCode,
    details: input?.details,
  });
};

export const badRequest = (input?: string | HttpErrorInput): never =>
  createHttpError({
    statusCode: 400,
    defaultMessage: "Bad request",
    defaultCode: "BAD_REQUEST",
    input,
  });

export const unauthorized = (input?: string | HttpErrorInput): never =>
  createHttpError({
    statusCode: 401,
    defaultMessage: "Unauthorized",
    defaultCode: "UNAUTHORIZED",
    input,
  });

export const forbidden = (input?: string | HttpErrorInput): never =>
  createHttpError({
    statusCode: 403,
    defaultMessage: "Forbidden",
    defaultCode: "FORBIDDEN",
    input,
  });

export const notFound = (input?: string | HttpErrorInput): never =>
  createHttpError({
    statusCode: 404,
    defaultMessage: "Not found",
    defaultCode: "NOT_FOUND",
    input,
  });

export const conflict = (input?: string | HttpErrorInput): never =>
  createHttpError({
    statusCode: 409,
    defaultMessage: "Conflict",
    defaultCode: "CONFLICT",
    input,
  });

export const unprocessableEntity = (input?: string | HttpErrorInput): never =>
  createHttpError({
    statusCode: 422,
    defaultMessage: "Unprocessable entity",
    defaultCode: "UNPROCESSABLE_ENTITY",
    input,
  });

export const tooManyRequests = (input?: string | HttpErrorInput): never =>
  createHttpError({
    statusCode: 429,
    defaultMessage: "Too many requests",
    defaultCode: "TOO_MANY_REQUESTS",
    input,
  });

export const internalServerError = (input?: string | HttpErrorInput): never =>
  createHttpError({
    statusCode: 500,
    defaultMessage: "Internal server error",
    defaultCode: "INTERNAL_SERVER_ERROR",
    input,
  });

export { AppError };
export type { AppErrorCode, AppErrorDetails };