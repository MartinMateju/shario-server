import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: {
    debug: mocks.debug,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import {
  errorHandler,
  notFound,
} from "@/shared/http/errorHandler.js";

describe("global request validation error normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts a controller ZodError into an operational 400 response", () => {
    const schema = z.object({
      email: z.string().email("Enter a valid email address."),
      count: z.number().int().positive(),
    }).strict();
    let validationError: unknown;
    try {
      schema.parse({ email: "not-an-email", count: 0 });
    } catch (error) {
      validationError = error;
    }

    const req = {
      method: "POST",
      originalUrl: "/ai/assistant/conversations",
      ip: "127.0.0.1",
      get: vi.fn(() => "vitest"),
    };
    const responseBody = vi.fn();
    const res: Record<string, any> = {
      headersSent: false,
      statusCode: 200,
      status: vi.fn((statusCode: number) => {
        res.statusCode = statusCode;
        return res;
      }),
      json: responseBody,
    };
    const next = vi.fn();

    errorHandler(validationError, req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(responseBody).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Invalid request.",
        statusCode: 400,
        status: "fail",
        code: "VALIDATION_ERROR",
        details: expect.objectContaining({
          fieldErrors: expect.objectContaining({
            email: ["Enter a valid email address."],
            count: expect.any(Array),
          }),
        }),
      }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        errorCode: "VALIDATION_ERROR",
        isOperational: true,
      }),
      "Request rejected.",
    );
    expect(mocks.error).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(JSON.stringify(responseBody.mock.calls[0][0])).not.toContain(
      "not-an-email",
    );
  });

  it.each([
    {
      name: "OAuth callback",
      originalUrl:
        "/auth/customer/social/google/callback?code=provider-code-sensitive&state=oauth-state-sensitive",
      params: { provider: "google" },
      query: {
        code: "provider-code-sensitive",
        state: "oauth-state-sensitive",
      },
      expectedPath: "/auth/customer/social/:provider/callback",
      secrets: ["provider-code-sensitive", "oauth-state-sensitive"],
    },
    {
      name: "webhook verification",
      originalUrl:
        "/webhooks/communications/instagram?hub.mode=subscribe&hub.verify_token=verify-token-sensitive&hub.challenge=challenge-sensitive",
      params: {},
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-token-sensitive",
        "hub.challenge": "challenge-sensitive",
      },
      expectedPath: "/webhooks/communications/instagram",
      secrets: ["verify-token-sensitive", "challenge-sensitive"],
    },
    {
      name: "satisfaction bearer path",
      originalUrl:
        "/communications/satisfaction/8npXFLiqU9fWQ0cQ_OxWntJL3B3DdCrWP0NlTFM0Sww",
      params: {
        token: "8npXFLiqU9fWQ0cQ_OxWntJL3B3DdCrWP0NlTFM0Sww",
      },
      query: {},
      expectedPath: "/communications/satisfaction/:token",
      secrets: ["8npXFLiqU9fWQ0cQ_OxWntJL3B3DdCrWP0NlTFM0Sww"],
    },
  ])("never writes $name credentials to the global error log", (scenario) => {
    const thrown = Object.assign(
      new Error(`Rejected URL ${scenario.originalUrl}`),
      {
        statusCode: 400,
        code: "REQUEST_REJECTED",
        isOperational: true,
      },
    );
    const req = {
      method: "GET",
      originalUrl: scenario.originalUrl,
      params: scenario.params,
      query: scenario.query,
      body: {},
      headers: {
        authorization: "Bearer request-authorization-sensitive",
        cookie: "customerRefreshToken=request-cookie-sensitive",
      },
      ip: "127.0.0.1",
      get: vi.fn((name: string) =>
        name === "user-agent" ? "vitest" : undefined,
      ),
    };
    const res: Record<string, any> = {
      headersSent: false,
      statusCode: 200,
      status: vi.fn(() => res),
      json: vi.fn(),
    };

    errorHandler(thrown, req as any, res as any, vi.fn());

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        path: scenario.expectedPath,
        errorCode: "REQUEST_REJECTED",
      }),
      "Request rejected.",
    );
    const serializedLog = JSON.stringify(mocks.warn.mock.calls[0]);
    for (const secret of [
      ...scenario.secrets,
      "request-authorization-sensitive",
      "request-cookie-sensitive",
    ]) {
      expect(serializedLog).not.toContain(secret);
    }
  });

  it("builds a query-free not-found error before it reaches the logger", () => {
    const next = vi.fn();
    const token = "8npXFLiqU9fWQ0cQ_OxWntJL3B3DdCrWP0NlTFM0Sww";

    notFound(
      {
        originalUrl: `/communications/satisfaction/${token}?code=oauth-secret`,
        url: `/communications/satisfaction/${token}?code=oauth-secret`,
        path: `/communications/satisfaction/${token}`,
        method: "GET",
        params: {},
        query: { code: "oauth-secret" },
      } as any,
      {} as any,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]?.message).toBe("Route not found.");
    expect(JSON.stringify(next.mock.calls[0]?.[0])).not.toContain(token);
    expect(JSON.stringify(next.mock.calls[0]?.[0])).not.toContain(
      "oauth-secret",
    );
  });

  it("uses an opaque log path for every unmatched route, including short bearer values", () => {
    const req = {
      method: "GET",
      originalUrl: "/magic-link/short-secret?code=oauth-secret",
      params: {},
      query: { code: "oauth-secret" },
      body: {},
      headers: {},
      ip: "127.0.0.1",
      get: vi.fn(() => "vitest"),
    };
    const res: Record<string, any> = {
      headersSent: false,
      statusCode: 200,
      status: vi.fn(() => res),
      json: vi.fn(),
    };
    const next = vi.fn();

    notFound(req as any, res as any, next);
    errorHandler(next.mock.calls[0][0], req as any, res as any, vi.fn());

    const serializedLog = JSON.stringify(mocks.warn.mock.calls.at(-1));
    const serializedResponse = JSON.stringify(res.json.mock.calls.at(-1));
    expect(serializedLog).toContain("[unmatched-route]");
    expect(serializedLog).not.toContain("short-secret");
    expect(serializedLog).not.toContain("oauth-secret");
    expect(serializedResponse).not.toContain("short-secret");
    expect(serializedResponse).not.toContain("oauth-secret");
  });
});
