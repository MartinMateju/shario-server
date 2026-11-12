import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";
import { ZodError } from "zod";
import Stripe from "stripe";

import { logger } from "@/config/logger.js";
import {
  getRequestLogPath,
  serializeErrorForLog,
  sanitizeLogText,
} from "@/shared/logging/request-log-sanitization.js";

import { AppError } from "./AppError.js";

type RequestWithMeta = Request & {
  deviceInfo?: {
    device?: string;
    browser?: string;
    os?: string;
  };
  userAgent?: string;
};

type ErrorWithMetadata = Error & {
  statusCode?: unknown;
  code?: unknown;
  details?: unknown;
  isOperational?: unknown;
};

const isProduction =
  process.env.NODE_ENV === "production";

const isHttpStatusCode = (
  value: unknown,
): value is number => {
  return (
    typeof value === "number" &&
    value >= 400 &&
    value <= 599
  );
};

const getFallbackStatusCode = (
  res: Response,
): number => {
  return isHttpStatusCode(res.statusCode)
    ? res.statusCode
    : 500;
};

/*
|--------------------------------------------------------------------------
| Error normalization
|--------------------------------------------------------------------------
*/

const toAppError = (
  err: unknown,
  fallbackStatusCode: number,
): AppError => {
  if (err instanceof AppError) {
    return err;
  }

  // Stripe authenticates the server, not this application's signed-in user.
  // Forwarding its 401/403 causes clients to rotate a valid user session.
  if (
    err instanceof Stripe.errors.StripeAuthenticationError ||
    err instanceof Stripe.errors.StripePermissionError
  ) {
    return new AppError({
      message: "The payment provider connection needs attention. Please try again later.",
      statusCode: 502,
      code: "PAYMENT_PROVIDER_AUTH_FAILED",
      isOperational: false,
    });
  }

  // Controllers throughout the application use Zod's `.parse()` directly.
  // Invalid client input is an operational 400 response, never a server fault.
  if (err instanceof ZodError) {
    return new AppError({
      message: "Invalid request.",
      statusCode: 400,
      code: "VALIDATION_ERROR",
      details: err.flatten(),
      isOperational: true,
    });
  }

  if (err instanceof Error) {
    const errorWithMetadata =
      err as ErrorWithMetadata;

    const statusCode =
      isHttpStatusCode(
        errorWithMetadata.statusCode,
      )
        ? errorWithMetadata.statusCode
        : fallbackStatusCode;

    const appError = new AppError({
      message:
        err.message || "Server error",

      statusCode,

      code:
        typeof errorWithMetadata.code ===
          "string"
          ? errorWithMetadata.code
          : undefined,

      details:
        errorWithMetadata.details,

      isOperational:
        errorWithMetadata.isOperational ===
        true,
    });

    /*
     * Preserve the original stack instead of showing
     * only the stack from the normalization function.
     */
    if (err.stack) {
      appError.stack = err.stack;
    }

    return appError;
  }

  return new AppError({
    message: "Unknown server error",
    statusCode: fallbackStatusCode,
    isOperational: false,
  });
};

/*
|--------------------------------------------------------------------------
| Client-safe error message
|--------------------------------------------------------------------------
*/

const getClientMessage = (
  error: AppError,
): string => {
  if (
    error.statusCode >= 500 &&
    isProduction
  ) {
    return "An unexpected error occurred. Please try again later.";
  }

  return error.message || "Server error";
};

/*
|--------------------------------------------------------------------------
| Expected authentication states
|--------------------------------------------------------------------------
*/

const isExpectedMissingRefreshSession = (
  req: Request,
  error: AppError,
): boolean => {
  const path = getRequestLogPath(req)
    .replace(/\/+$/, "");

  return (
    error.statusCode === 401 &&
    error.code === "UNAUTHORIZED" &&
    error.message ===
    "Refresh token is required." &&
    req.method === "POST" &&
    (
      path === "/auth/refresh" ||
      path.endsWith("/auth/refresh")
    )
  );
};

const isExpectedWorkspaceCookieCustomerProbe = (
  req: Request,
  error: AppError,
): boolean => {
  const path = getRequestLogPath(req).replace(/\/+$/, "");

  return (
    error.logReason === "workspace_cookie_customer_probe" &&
    error.isOperational &&
    error.statusCode === 401 &&
    error.code === "AUTH_CONTEXT_MISMATCH" &&
    req.method === "POST" &&
    path.endsWith("/auth/customer/refresh")
  );
};

/*
|--------------------------------------------------------------------------
| Not found
|--------------------------------------------------------------------------
*/

export const notFound = (
  _req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(
    new AppError({
      // Do not reflect an unmatched URL. Unlike a matched Express route, an
      // unknown path has no trustworthy template and may itself contain an
      // OAuth code, magic-link token or other bearer credential.
      message: "Route not found.",
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
    }),
  );
};

/*
|--------------------------------------------------------------------------
| Global error handler
|--------------------------------------------------------------------------
*/

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: RequestWithMeta,
  res: Response,
  next: NextFunction,
): void => {
  /*
   * Let Express finish handling an error if the
   * response has already started.
   */
  if (res.headersSent) {
    next(err);
    return;
  }

  const fallbackStatusCode =
    getFallbackStatusCode(res);

  const error = toAppError(
    err,
    fallbackStatusCode,
  );

  const deviceInfo =
    req.deviceInfo ?? {
      device: "unknown",
      browser: "unknown",
      os: "unknown",
    };

  const logContext = {
    env:
      process.env.NODE_ENV ||
      "development",

    statusCode:
      error.statusCode,

    status:
      error.status,

    errorCode:
      error.code,

    method:
      req.method,

    path:
      error.code === "ROUTE_NOT_FOUND"
        ? "[unmatched-route]"
        : getRequestLogPath(req),

    ip:
      req.ip,

    device:
      deviceInfo.device,

    browser:
      deviceInfo.browser,

    os:
      deviceInfo.os,

    userAgent:
      sanitizeLogText(
        req.get("user-agent") ||
        req.userAgent,
        req,
      ),

    isOperational:
      error.isOperational,
  };

  /*
   * No refresh cookie during application startup is
   * an expected unauthenticated state.
   */
  if (
    isExpectedMissingRefreshSession(
      req,
      error,
    )
  ) {
    logger.debug(
      logContext,
      "No existing refresh-token session.",
    );
  } else if (isExpectedWorkspaceCookieCustomerProbe(req, error)) {
    logger.info(
      {
        ...logContext,
        event: "auth.customer_session_absent",
        expectedAuthState: true,
      },
      "No customer session; the workspace cookie was ignored during the legacy-session check.",
    );
  } else if (
    error.statusCode >= 500 ||
    !error.isOperational
  ) {
    /*
     * Unexpected exceptions and server failures.
     */
    logger.error(
      {
        err: serializeErrorForLog(err, req),
        ...logContext,
      },
      "Request failed.",
    );
  } else {
    /*
     * Expected operational 4xx responses, including
     * invalid credentials and forbidden access.
     */
    logger.warn(
      {
        err: serializeErrorForLog(error, req),
        ...logContext,
      },
      "Request rejected.",
    );
  }

  res.status(error.statusCode).json({
    message:
      getClientMessage(error),

    statusCode:
      error.statusCode,

    status:
      error.status,

    ...(error.code
      ? {
        code: error.code,
      }
      : {}),

    ...(error.details !== undefined
      ? {
        details: error.details,
      }
      : {}),

    ...(!isProduction
      ? {
        error:
          error.message,

        stack:
          error.stack,
      }
      : {}),
  });
};
