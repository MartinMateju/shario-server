import type { Request, Response } from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const log = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({ logger: log }));

let AppError: typeof import("@/shared/http/AppError.js").AppError;
let errorHandler: typeof import("@/shared/http/errorHandler.js").errorHandler;

const marker = "workspace_cookie_customer_probe" as const;
const mismatchMessage = "A customer session is required.";
const expectedLogMessage =
  "No customer session; the workspace cookie was ignored during the legacy-session check.";
const querySecret = "query-token-must-not-be-logged";
const workspaceSecret = "workspace-cookie-must-not-be-logged";
const customerSecret = "customer-cookie-must-not-be-logged";
const authorizationSecret = "authorization-must-not-be-logged";
const cookieHeader = `jwt=${workspaceSecret}; customer_jwt=${customerSecret}`;

type RequestOptions = {
  method?: string;
  originalUrl?: string;
  cookies?: Record<string, string>;
};

const handle = (error: unknown, options: RequestOptions = {}) => {
  const cookies = options.cookies ?? { jwt: workspaceSecret };
  const req = {
    method: options.method ?? "POST",
    originalUrl:
      options.originalUrl ?? `/auth/customer/refresh?token=${querySecret}`,
    params: {},
    query: { token: querySecret },
    body: {},
    cookies,
    headers: {
      cookie: Object.entries(cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join("; "),
      authorization: `Bearer ${authorizationSecret}`,
    },
    ip: "127.0.0.1",
    deviceInfo: { device: "desktop", browser: "test-browser", os: "test-os" },
    get: (name: string) =>
      name === "user-agent"
        ? `audit-test token=${querySecret}; Cookie: ${cookieHeader}`
        : undefined,
  };
  const res = {
    headersSent: false,
    statusCode: 200,
    status: vi.fn((statusCode: number) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: vi.fn(),
  };
  const next = vi.fn();
  errorHandler(
    error,
    req as unknown as Request,
    res as unknown as Response,
    next,
  );
  expect(next).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledOnce();
  return { res, body: res.json.mock.calls[0][0] };
};

const expectOnlyLevel = (level: keyof typeof log) => {
  for (const [name, logger] of Object.entries(log)) {
    if (name === level) expect(logger).toHaveBeenCalledOnce();
    else expect(logger).not.toHaveBeenCalled();
  }
};

const expectNoLogSecrets = () => {
  const serialized = JSON.stringify(
    Object.values(log).flatMap((logger) => logger.mock.calls),
  );
  for (const secret of [
    querySecret,
    workspaceSecret,
    customerSecret,
    authorizationSecret,
  ]) {
    expect(serialized).not.toContain(secret);
  }
};

describe("authentication logging at the HTTP error boundary", () => {
  beforeAll(async () => {
    // errorHandler captures isProduction at import time. Import both modules
    // after resetting the cache so instanceof AppError uses the same class.
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    ({ AppError } = await import("@/shared/http/AppError.js"));
    ({ errorHandler } = await import("@/shared/http/errorHandler.js"));
  });

  afterAll(() => vi.unstubAllEnvs());
  beforeEach(() => vi.clearAllMocks());

  it.each([
    "/auth/customer/refresh",
    "/auth/customer/refresh/",
    `/api/auth/customer/refresh?token=${querySecret}`,
    `/api/auth/customer/refresh/?token=${querySecret}`,
  ])(
    "logs only the explicitly marked missing customer session as info at %s",
    (originalUrl) => {
      const error = new AppError({
        message: mismatchMessage,
        statusCode: 401,
        code: "AUTH_CONTEXT_MISMATCH",
        isOperational: true,
        logReason: marker,
      });
      error.stack = `Error: ${mismatchMessage}\nCookie: ${cookieHeader}\n?token=${querySecret}`;

      const { res, body } = handle(error, { originalUrl });

      expectOnlyLevel("info");
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          env: "production",
          statusCode: 401,
          status: "fail",
          errorCode: "AUTH_CONTEXT_MISMATCH",
          isOperational: true,
          method: "POST",
          path: originalUrl.split("?")[0],
          ip: "127.0.0.1",
          device: "desktop",
          browser: "test-browser",
          os: "test-os",
          event: "auth.customer_session_absent",
          expectedAuthState: true,
        }),
        expectedLogMessage,
      );
      const context = log.info.mock.calls[0][0];
      expect(context).not.toHaveProperty("err");
      expect(context).not.toHaveProperty("stack");
      expectNoLogSecrets();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(body).toEqual({
        message: mismatchMessage,
        statusCode: 401,
        status: "fail",
        code: "AUTH_CONTEXT_MISMATCH",
      });
      expect(body).not.toHaveProperty("logReason");
    },
  );

  it.each([
    { label: "no cookies", cookies: {} },
    { label: "workspace cookie", cookies: { jwt: workspaceSecret } },
    {
      label: "customer cookie",
      cookies: { customer_jwt: customerSecret },
    },
    {
      label: "both cookie contexts",
      cookies: { jwt: workspaceSecret, customer_jwt: customerSecret },
    },
  ])(
    "keeps an unmarked context mismatch with $label visible as a warning",
    ({ cookies }) => {
      const error = new AppError({
        message: mismatchMessage,
        statusCode: 401,
        code: "AUTH_CONTEXT_MISMATCH",
      });
      const { body } = handle(error, { cookies });
      expectOnlyLevel("warn");
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: "AUTH_CONTEXT_MISMATCH",
          err: expect.objectContaining({
            type: "AppError",
            message: mismatchMessage,
            stack: expect.any(String),
          }),
        }),
        "Request rejected.",
      );
      expect(log.warn.mock.calls[0][0]).not.toHaveProperty("expectedAuthState");
      expect(body.code).toBe("AUTH_CONTEXT_MISMATCH");
      expectNoLogSecrets();
    },
  );

  it("does not trust a marker copied onto an arbitrary Error", () => {
    const error = Object.assign(new Error(mismatchMessage), {
      statusCode: 401,
      code: "AUTH_CONTEXT_MISMATCH",
      isOperational: true,
      logReason: marker,
    });
    const { body } = handle(error);
    expectOnlyLevel("warn");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "AUTH_CONTEXT_MISMATCH",
        err: expect.objectContaining({ message: mismatchMessage }),
      }),
      "Request rejected.",
    );
    expect(body).toEqual({
      message: mismatchMessage,
      statusCode: 401,
      status: "fail",
      code: "AUTH_CONTEXT_MISMATCH",
    });
    expectNoLogSecrets();
  });

  it.each([
    {
      label: "invalid token",
      message: "Invalid refresh token.",
      statusCode: 401,
      code: "UNAUTHORIZED",
    },
    {
      label: "expired token",
      message: "Refresh token has expired.",
      statusCode: 401,
      code: "UNAUTHORIZED",
    },
    {
      label: "forbidden origin",
      message: "Origin is not allowed.",
      statusCode: 403,
      code: "FORBIDDEN",
    },
  ])(
    "does not downgrade $label and sanitizes its error details",
    ({ message, statusCode, code }) => {
      const error = new AppError({
        message,
        statusCode,
        code,
        isOperational: true,
      });
      error.stack = `Error: ${message}\n at /auth/customer/refresh?token=${querySecret}\nCookie: ${cookieHeader}\nBearer ${authorizationSecret}`;
      const { body } = handle(error, {
        cookies: { jwt: workspaceSecret, customer_jwt: customerSecret },
      });
      expectOnlyLevel("warn");
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode,
          errorCode: code,
          path: "/auth/customer/refresh",
          err: expect.objectContaining({
            message,
            stack: expect.stringContaining("[REDACTED]"),
          }),
        }),
        "Request rejected.",
      );
      expectNoLogSecrets();
      expect(body).toEqual({ message, statusCode, status: "fail", code });
    },
  );

  it.each([
    { label: "another route", originalUrl: "/auth/refresh" },
    { label: "a route suffix", originalUrl: "/auth/customer/refresh-extra" },
    { label: "another method", method: "GET" },
    { label: "another status", statusCode: 403 },
    { label: "another error code", code: "UNAUTHORIZED" },
  ])("does not trust the marker with $label", (scenario) => {
    const error = new AppError({
      message: mismatchMessage,
      statusCode: scenario.statusCode ?? 401,
      code: scenario.code ?? "AUTH_CONTEXT_MISMATCH",
      isOperational: true,
      logReason: marker,
    });
    const { body } = handle(error, scenario);
    expectOnlyLevel("warn");
    expect(log.warn.mock.calls[0][0]).toHaveProperty("err");
    expect(log.warn.mock.calls[0][0]).not.toHaveProperty("expectedAuthState");
    expect(body).not.toHaveProperty("logReason");
    expectNoLogSecrets();
  });

  it.each([
    { label: "a nonoperational 401", statusCode: 401, isOperational: false },
    { label: "a server failure", statusCode: 500, isOperational: true },
  ])(
    "keeps $label at error level even with the marker",
    ({ statusCode, isOperational }) => {
      const error = new AppError({
        message: mismatchMessage,
        statusCode,
        isOperational,
        code: "AUTH_CONTEXT_MISMATCH",
        logReason: marker,
      });
      const { body } = handle(error);
      expectOnlyLevel("error");
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode,
          isOperational,
          err: expect.objectContaining({ message: mismatchMessage }),
        }),
        "Request failed.",
      );
      expect(body).not.toHaveProperty("logReason");
      expect(body.statusCode).toBe(statusCode);
      expectNoLogSecrets();
    },
  );

  it("keeps unexpected exceptions at error level with a sanitized stack and production-safe response", () => {
    const error = new Error("Unexpected authentication failure.");
    error.stack = `Error: unexpected\nCookie: ${cookieHeader}\nBearer ${authorizationSecret}\n?token=${querySecret}`;
    const { res, body } = handle(error);
    expectOnlyLevel("error");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        isOperational: false,
        err: expect.objectContaining({
          type: "Error",
          stack: expect.stringContaining("[REDACTED]"),
        }),
      }),
      "Request failed.",
    );
    expectNoLogSecrets();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(body.message).toBe(
      "An unexpected error occurred. Please try again later.",
    );
    expect(body).not.toHaveProperty("stack");
  });
});
