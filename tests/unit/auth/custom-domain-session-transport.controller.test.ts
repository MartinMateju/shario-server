import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  requiresProxy: vi.fn(),
  handoffConfigured: vi.fn(),
  createHandoff: vi.fn(),
  getTenantBySlug: vi.fn(),
  loginCustomer: vi.fn(),
  refreshCustomer: vi.fn(),
  assertRefreshOrigin: vi.fn(),
  logout: vi.fn(),
  cookieOptions: vi.fn(),
  cleanupOptions: vi.fn(),
}));

vi.mock("@/modules/auth/auth-first-party-proxy.js", () => ({
  resolveAuthRequestContext: mocks.context,
}));

vi.mock("@/modules/auth/auth-session-handoff.js", () => ({
  consumeSessionHandoff: vi.fn(),
  createSessionHandoff: mocks.createHandoff,
  isSessionHandoffConfigured: mocks.handoffConfigured,
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getRefreshCookieOptions: mocks.cookieOptions,
  getRefreshCookieCleanupOptions: mocks.cleanupOptions,
  requiresFirstPartyRefreshProxy: mocks.requiresProxy,
}));

vi.mock("@/modules/auth/services/auth.service.js", () => ({
  assertRefreshTokenOrigin: mocks.assertRefreshOrigin,
  loginCustomerUser: mocks.loginCustomer,
  loginUser: vi.fn(),
  logoutUser: mocks.logout,
  refreshAccessToken: vi.fn(),
  refreshCustomerAccessToken: mocks.refreshCustomer,
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
}));

vi.mock("@/modules/auth/auth-origin.js", () => ({
  assertTenantAuthOrigin: vi.fn(),
}));

vi.mock("@/modules/tenant-access/index.js", () => ({
  serializeWorkspaceAccess: vi.fn((value) => value),
}));

vi.mock(
  "@/modules/tenants/public-site/tenant-public-site.serializers.js",
  () => ({ serializeTenantPublicSite: vi.fn(() => ({})) }),
);

import {
  loginCustomer,
  logoutCustomer,
  refreshCustomer,
} from "@/modules/auth/controllers/auth.controller.js";

const ORIGIN = "https://studio.example";
const tenant = {
  _id: "64b000000000000000000501",
  name: "Studio",
  slug: "studio",
};
const session = {
  accessToken: "access-token",
  refreshToken: `refresh.${"secret".repeat(16)}`,
  authContext: "customer" as const,
  user: {
    _id: "64b000000000000000000502",
    tenant: tenant._id,
    firstname: "Alex",
    lastname: "Customer",
    email: "alex@example.com",
    customId: "A-1",
    tenantRole: "customer",
    platformRole: "none",
  },
  tenant,
  workspaceAccess: null,
};

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
  handler: typeof loginCustomer,
  request: Partial<Request>,
) => {
  const response = createResponse();
  const next = vi.fn();

  await handler(request as Request, response as unknown as Response, next);
  return { response, next };
};

describe("custom-domain refresh-session transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockReturnValue({
      origin: ORIGIN,
      firstPartyProxy: false,
    });
    mocks.requiresProxy.mockReturnValue(true);
    mocks.handoffConfigured.mockReturnValue(true);
    mocks.createHandoff.mockReturnValue("v1.sealed");
    mocks.getTenantBySlug.mockResolvedValue(tenant);
    mocks.loginCustomer.mockResolvedValue(session);
    mocks.refreshCustomer.mockResolvedValue({
      ...session,
      migratedLegacyCustomerSession: false,
    });
    mocks.cleanupOptions.mockReturnValue([{ sameSite: "lax" }]);
    mocks.cookieOptions.mockReturnValue({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("returns a one-time handoff instead of setting a third-party login cookie", async () => {
    const { response, next } = await invoke(loginCustomer, {
      body: {
        tenantSlug: "studio",
        email: "alex@example.com",
        password: "secret-password",
      },
      cookies: {},
    });

    expect(next).not.toHaveBeenCalled();
    expect(mocks.createHandoff).toHaveBeenCalledWith({
      refreshToken: session.refreshToken,
      authContext: "customer",
      origin: ORIGIN,
    });
    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshSession: {
          mode: "first-party-handoff",
          handoff: "v1.sealed",
        },
      }),
    );
  });

  it("fails before authenticating when the handoff key is not configured", async () => {
    mocks.handoffConfigured.mockReturnValue(false);

    const { response, next } = await invoke(loginCustomer, {
      body: {
        tenantSlug: "studio",
        email: "alex@example.com",
        password: "secret-password",
      },
      cookies: {},
    });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        code: "AUTH_FIRST_PARTY_PROXY_NOT_CONFIGURED",
      }),
    );
    expect(mocks.loginCustomer).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it.each([
    ["refresh", refreshCustomer],
    ["logout", logoutCustomer],
  ] as const)(
    "rejects direct custom-domain %s calls",
    async (_label, handler) => {
      const { response, next } = await invoke(handler, {
        body: {},
        cookies: { customer_jwt: "existing-refresh" },
      });

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 403,
          code: "AUTH_FIRST_PARTY_PROXY_REQUIRED",
        }),
      );
      expect(mocks.refreshCustomer).not.toHaveBeenCalled();
      expect(mocks.logout).not.toHaveBeenCalled();
      expect(response.cookie).not.toHaveBeenCalled();
    },
  );

  it("issues a host-only first-party cookie when refresh arrives through the BFF", async () => {
    mocks.context.mockReturnValue({
      origin: ORIGIN,
      firstPartyProxy: true,
    });

    const { response, next } = await invoke(refreshCustomer, {
      body: {},
      cookies: { customer_jwt: "existing-refresh" },
    });

    expect(next).not.toHaveBeenCalled();
    expect(mocks.refreshCustomer).toHaveBeenCalledWith(
      "existing-refresh",
      ORIGIN,
      { allowLegacyCustomer: false },
    );
    expect(mocks.cookieOptions).toHaveBeenCalledWith(ORIGIN, {
      firstPartyProxy: true,
    });
    expect(response.cookie).toHaveBeenCalledWith(
      "customer_jwt",
      session.refreshToken,
      expect.objectContaining({ sameSite: "lax", httpOnly: true }),
    );
  });
});
