import type { Request, Response } from "express";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/config/logger.js", () => ({ logger: log }));

import { AppError } from "@/shared/http/AppError.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const handle = (error: Error) => {
  const req = {
    method: "GET",
    originalUrl: "/tenant-payments/connect",
    headers: {},
    get: () => "vitest",
  };
  const res = {
    headersSent: false,
    statusCode: 200,
    status: vi.fn((status: number) => {
      res.statusCode = status;
      return res;
    }),
    json: vi.fn(),
  };
  errorHandler(
    error,
    req as unknown as Request,
    res as unknown as Response,
    vi.fn(),
  );
  return { status: res.statusCode, body: res.json.mock.calls[0][0] };
};

describe("Stripe credentials at the application HTTP boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [Stripe.errors.StripeAuthenticationError, 401],
    [Stripe.errors.StripePermissionError, 403],
  ] as const)(
    "reports upstream %s as a server failure without requesting user reauthentication",
    (ErrorType, statusCode) => {
      const result = handle(
        new ErrorType({
          type: "invalid_request_error",
          message: "provider credential detail must not reach the client",
          statusCode,
          requestId: "req_provider_diagnostic",
        }),
      );

      expect(result).toMatchObject({
        status: 502,
        body: {
          statusCode: 502,
          status: "error",
          code: "PAYMENT_PROVIDER_AUTH_FAILED",
        },
      });
      expect(JSON.stringify(result.body)).not.toContain("credential detail");
      expect(JSON.stringify(result.body)).not.toContain(
        "req_provider_diagnostic",
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 502,
          errorCode: "PAYMENT_PROVIDER_AUTH_FAILED",
        }),
        "Request failed.",
      );
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])(
    "preserves genuine application authentication/authorization status %s",
    (statusCode) => {
      const result = handle(
        new AppError({
          message: "A customer session is required.",
          statusCode,
          code: "AUTH_CONTEXT_MISMATCH",
        }),
      );
      expect(result).toMatchObject({
        status: statusCode,
        body: { statusCode, code: "AUTH_CONTEXT_MISMATCH" },
      });
      expect(log.warn).toHaveBeenCalledOnce();
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it("does not reinterpret a declined card as a provider credential failure", () => {
    const result = handle(
      new Stripe.errors.StripeCardError({
        type: "card_error",
        message: "Your card was declined.",
        statusCode: 402,
        code: "card_declined",
      }),
    );
    expect(result).toMatchObject({
      status: 402,
      body: { code: "card_declined" },
    });
  });
});
