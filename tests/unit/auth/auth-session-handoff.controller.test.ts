import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestContext: vi.fn(),
  refreshCustomer: vi.fn(),
  refreshWorkspace: vi.fn(),
  cookieOptions: {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 604_800_000,
  },
  cleanupOptions: {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
  },
}));

vi.mock("@/modules/auth/auth-first-party-proxy.js", () => ({
  resolveAuthRequestContext: mocks.requestContext,
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getRefreshCookieOptions: vi.fn(() => mocks.cookieOptions),
  getRefreshCookieCleanupOptions: vi.fn(() => [mocks.cleanupOptions]),
  requiresFirstPartyRefreshProxy: vi.fn(() => false),
}));

vi.mock("@/modules/auth/services/auth.service.js", () => ({
  assertRefreshTokenOrigin: vi.fn(),
  loginCustomerUser: vi.fn(),
  loginUser: vi.fn(),
  logoutUser: vi.fn(),
  refreshAccessToken: mocks.refreshWorkspace,
  refreshCustomerAccessToken: mocks.refreshCustomer,
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: vi.fn(),
}));

vi.mock("@/modules/tenant-subscription/tenant-subscription.repository.js", () => ({
  findSubscriptionByTenant: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/modules/tenant-access/index.js", () => ({
  serializeWorkspaceAccess: vi.fn((value) => value),
}));

vi.mock(
  "@/modules/tenants/public-site/tenant-public-site.serializers.js",
  () => ({
    serializeTenantPublicSite: vi.fn(() => ({})),
  }),
);

import {
  exchangeCustomerSessionHandoff,
  exchangeWorkspaceSessionHandoff,
} from "@/modules/auth/controllers/auth.controller.js";
import { createSessionHandoff } from "@/modules/auth/auth-session-handoff.js";
import { AppError } from "@/shared/http/httpErrors.js";

const ORIGIN = "https://studio.example";
const OTHER_ORIGIN = "https://other.example";
const OLD_REFRESH = `old.${"refresh".repeat(16)}`;
const NEW_REFRESH = `new.${"refresh".repeat(16)}`;

const sessionResult = (authContext: "customer" | "workspace") => ({
  accessToken: "access-token",
  refreshToken: NEW_REFRESH,
  authContext,
  user: {
    _id: "64b000000000000000000401",
    tenant: "64b000000000000000000402",
    firstname: "Alex",
    lastname: "Customer",
    email: "alex@example.com",
    customId: "A-1",
    tenantRole: authContext === "customer" ? "customer" : "owner",
    platformRole: "none",
    isEmailVerified: true,
  },
  tenant: {
    _id: "64b000000000000000000402",
    name: "Studio",
    slug: "studio",
  },
  workspaceAccess:
    authContext === "workspace" ? { role: "owner", status: "active" } : null,
});

const createResponse = () => {
  const response = {
    clearCookie: vi.fn(),
    cookie: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };

  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);

  return response;
};

const invoke = async (
  handler: typeof exchangeCustomerSessionHandoff,
  handoff: string,
) => {
  const response = createResponse();
  const next = vi.fn();
  const request = {
    body: { sessionHandoff: handoff },
  } as unknown as Request;

  await handler(request, response as unknown as Response, next);

  return { response, next };
};

describe("first-party session handoff exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "production";
    process.env.AUTH_SESSION_HANDOFF_SECRET =
      "handoff-secret-with-at-least-thirty-two-bytes";
    mocks.requestContext.mockReturnValue({
      origin: ORIGIN,
      firstPartyProxy: true,
    });
    mocks.refreshCustomer.mockResolvedValue(sessionResult("customer"));
    mocks.refreshWorkspace.mockResolvedValue(sessionResult("workspace"));
  });

  afterEach(() => {
    delete process.env.AUTH_SESSION_HANDOFF_SECRET;
  });

  const makeHandoff = (
    authContext: "customer" | "workspace" = "customer",
    origin = ORIGIN,
    now = Date.now(),
  ) =>
    createSessionHandoff({
      refreshToken: OLD_REFRESH,
      authContext,
      origin,
      now,
    });

  it("rotates the sealed customer credential and issues only a first-party cookie", async () => {
    const { response, next } = await invoke(
      exchangeCustomerSessionHandoff,
      makeHandoff(),
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.refreshCustomer).toHaveBeenCalledWith(OLD_REFRESH, ORIGIN);
    expect(response.cookie).toHaveBeenCalledWith(
      "customer_jwt",
      NEW_REFRESH,
      mocks.cookieOptions,
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "access-token",
        authContext: "customer",
        refreshSession: { mode: "first-party-cookie" },
      }),
    );
  });

  it("rejects a direct browser exchange before decrypting or rotating", async () => {
    mocks.requestContext.mockReturnValue({
      origin: ORIGIN,
      firstPartyProxy: false,
    });

    const { response, next } = await invoke(
      exchangeCustomerSessionHandoff,
      makeHandoff(),
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        code: "AUTH_SESSION_HANDOFF_PROXY_REQUIRED",
      }),
    );
    expect(mocks.refreshCustomer).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it("rejects a handoff replayed through another custom-domain origin", async () => {
    mocks.requestContext.mockReturnValue({
      origin: OTHER_ORIGIN,
      firstPartyProxy: true,
    });

    const { response, next } = await invoke(
      exchangeCustomerSessionHandoff,
      makeHandoff(),
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        code: "AUTH_SESSION_HANDOFF_ORIGIN_MISMATCH",
      }),
    );
    expect(mocks.refreshCustomer).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it("binds the handoff to its customer/workspace authentication context", async () => {
    const { response, next } = await invoke(
      exchangeWorkspaceSessionHandoff,
      makeHandoff("customer"),
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 401,
        code: "AUTH_SESSION_HANDOFF_CONTEXT_MISMATCH",
      }),
    );
    expect(mocks.refreshCustomer).not.toHaveBeenCalled();
    expect(mocks.refreshWorkspace).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it("rejects an expired handoff before attempting refresh rotation", async () => {
    const { response, next } = await invoke(
      exchangeCustomerSessionHandoff,
      makeHandoff("customer", ORIGIN, Date.now() - 120_001),
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 401,
        code: "AUTH_SESSION_HANDOFF_INVALID",
      }),
    );
    expect(mocks.refreshCustomer).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it("allows only one winner when the same handoff is consumed concurrently", async () => {
    let claimed = false;

    mocks.refreshCustomer.mockImplementation(async () => {
      if (claimed) {
        throw new AppError({
          statusCode: 401,
          message: "Invalid refresh token.",
          code: "UNAUTHORIZED",
        });
      }

      claimed = true;
      await Promise.resolve();
      return sessionResult("customer");
    });

    const handoff = makeHandoff();
    const [first, second] = await Promise.all([
      invoke(exchangeCustomerSessionHandoff, handoff),
      invoke(exchangeCustomerSessionHandoff, handoff),
    ]);
    const responses = [first, second];

    expect(
      responses.filter(
        ({ response }) => response.cookie.mock.calls.length === 1,
      ),
    ).toHaveLength(1);
    expect(
      responses.filter(({ next }) =>
        next.mock.calls.some(([error]) => error?.statusCode === 401),
      ),
    ).toHaveLength(1);
    expect(mocks.refreshCustomer).toHaveBeenCalledTimes(2);
  });
});
