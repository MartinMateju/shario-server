import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSubscription: vi.fn(),
  getTenantBySlug: vi.fn(),
  loginUser: vi.fn(),
  loginCustomerUser: vi.fn(),
  refreshAccessToken: vi.fn(),
  refreshCustomerAccessToken: vi.fn(),
}));

vi.mock(
  "@/modules/tenant-subscription/tenant-subscription.repository.js",
  () => ({
    findSubscriptionByTenant: mocks.findSubscription,
  }),
);
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
}));
vi.mock("@/modules/auth/services/auth.service.js", () => ({
  ...mocks,
  logoutUser: vi.fn(),
  assertRefreshTokenOrigin: vi.fn(),
}));
vi.mock("@/modules/auth/auth-first-party-proxy.js", () => ({
  resolveAuthRequestContext: vi.fn(() => ({
    origin: "http://studio.shario.localhost:3000",
    firstPartyProxy: true,
  })),
}));
vi.mock("@/modules/auth/auth.utils.js", () => ({
  getRefreshCookieOptions: vi.fn(() => ({})),
  getRefreshCookieCleanupOptions: vi.fn(() => []),
  requiresFirstPartyRefreshProxy: vi.fn(() => false),
}));
vi.mock("@/modules/auth/auth-origin.js", () => ({
  assertTenantAuthOrigin: vi.fn(),
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  serializeWorkspaceAccess: vi.fn((value) => value),
}));

import {
  login,
  loginCustomer,
  refresh,
  refreshCustomer,
  serializeAuthSessionTenant,
} from "@/modules/auth/controllers/auth.controller.js";

const tenant = {
  _id: "64b000000000000000000501",
  name: "Studio",
  slug: "studio",
  settings: { currency: "PLN" },
};
const session = (authContext: "workspace" | "customer") => ({
  accessToken: "access",
  refreshToken: "refresh",
  authContext,
  tenant,
  user: {
    _id: "64b000000000000000000502",
    tenant: tenant._id,
    firstname: "Alex",
    lastname: "Owner",
    tenantRole: "owner",
    email: "alex@example.com",
    customId: "A1",
  },
  workspaceAccess: authContext === "workspace" ? { role: "owner" } : null,
});

const invoke = async (handler: typeof login) => {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
    clearCookie: vi.fn(),
    cookie: vi.fn(),
  };
  response.status.mockReturnValue(response);
  const next = vi.fn();
  await handler(
    {
      body: {
        tenantSlug: "studio",
        email: "alex@example.com",
        password: "secret-password",
      },
      cookies: { jwt: "workspace-refresh", customer_jwt: "customer-refresh" },
    } as unknown as Request,
    response as unknown as Response,
    next,
  );
  expect(next).not.toHaveBeenCalled();
  expect(response.status).toHaveBeenCalledWith(200);
  return response.json.mock.calls[0][0];
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTenantBySlug.mockResolvedValue(tenant);
  mocks.loginUser.mockResolvedValue(session("workspace"));
  mocks.loginCustomerUser.mockResolvedValue(session("customer"));
  mocks.refreshAccessToken.mockResolvedValue(session("workspace"));
  mocks.refreshCustomerAccessToken.mockResolvedValue(session("customer"));
  mocks.findSubscription.mockResolvedValue({
    billingCurrency: "CHF",
    stripe: { subscriptionId: "sub_private" },
    unitAmount: 10000,
  });
});

describe("workspace auth billing currency snapshot", () => {
  it("includes canonical workspace capabilities without replacing stored quota overrides", async () => {
    const source = {
      ...tenant,
      plan: "professional",
      planVersion: 3,
      limits: { locations: 2, aiCredits: 2345 },
      modules: { ai: false },
    };
    const response = await serializeAuthSessionTenant(source, "workspace");
    expect(response).toMatchObject({
      capabilities: {
        booking: { openStudio: true },
        ai: { firingInsights: false, commandCenter: false },
      },
      limits: { locations: 2, aiCredits: 2345 },
      modules: { ai: false },
    });
    expect(source).not.toHaveProperty("capabilities");
    const customer = await serializeAuthSessionTenant(source, "customer");
    expect(customer).not.toHaveProperty("capabilities");
  });

  it.each([
    ["login", login],
    ["refresh", refresh],
  ])(
    "includes only the saved SaaS currency during %s",
    async (_label, handler) => {
      const response = await invoke(handler);
      expect(mocks.findSubscription).toHaveBeenCalledWith(tenant._id);
      expect(response.tenant).toMatchObject({
        billingCurrency: "CHF",
        settings: { currency: "PLN" },
      });
      expect(response.tenant).not.toHaveProperty("stripe");
      expect(response.tenant).not.toHaveProperty("subscription");
      expect(response.tenant).not.toHaveProperty("unitAmount");
      expect(tenant).not.toHaveProperty("billingCurrency");
    },
  );

  it.each([
    ["customer login", loginCustomer],
    ["customer refresh", refreshCustomer],
  ])(
    "does not query or expose SaaS billing during %s",
    async (_label, handler) => {
      const response = await invoke(handler);
      expect(mocks.findSubscription).not.toHaveBeenCalled();
      expect(response.tenant).not.toHaveProperty("billingCurrency");
    },
  );

  it.each([null, {}, { billingCurrency: "JPY" }])(
    "does not invent a saved billing currency for %j",
    async (subscription) => {
      mocks.findSubscription.mockResolvedValue(subscription);
      const response = await serializeAuthSessionTenant(tenant, "workspace");
      expect(response).not.toHaveProperty("billingCurrency");
      expect(response.settings.currency).toBe("PLN");
    },
  );
});
