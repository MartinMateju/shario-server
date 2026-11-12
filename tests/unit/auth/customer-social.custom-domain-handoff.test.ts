import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  finish: vi.fn(),
  providers: vi.fn(),
  requestContext: vi.fn(),
  requiresProxy: vi.fn(),
  handoffConfigured: vi.fn(),
  createHandoff: vi.fn(),
  cookieOptions: vi.fn(),
  cleanupOptions: vi.fn(),
}));

vi.mock("@/modules/auth/social/customer-social.service.js", () => ({
  beginCustomerSocialSignIn: mocks.begin,
  finishCustomerSocialSignIn: mocks.finish,
  getCustomerSocialProviders: mocks.providers,
}));

vi.mock("@/modules/auth/social/customer-social.validators.js", () => ({
  customerSocialProviderSchema: { parse: (value: unknown) => value },
  customerSocialProvidersQuerySchema: { parse: (value: unknown) => value },
  customerSocialStartQuerySchema: { parse: (value: unknown) => value },
  customerSocialCallbackSchema: { parse: (value: unknown) => value },
}));

vi.mock("@/modules/auth/auth-first-party-proxy.js", () => ({
  resolveAuthRequestContext: mocks.requestContext,
}));

vi.mock("@/modules/auth/auth-session-handoff.js", () => ({
  createSessionHandoff: mocks.createHandoff,
  isSessionHandoffConfigured: mocks.handoffConfigured,
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getRefreshCookieOptions: mocks.cookieOptions,
  getRefreshCookieCleanupOptions: mocks.cleanupOptions,
  requiresFirstPartyRefreshProxy: mocks.requiresProxy,
}));

import {
  completeCustomerSocialSignIn,
  startCustomerSocialSignIn,
} from "@/modules/auth/social/customer-social.controller.js";

const CUSTOM_ORIGIN = "https://studio.example";
const PLATFORM_ORIGIN = "https://studio.shario.io";
const REFRESH_TOKEN = `social.${"refresh".repeat(16)}`;

const createResponse = () => {
  const response = {
    setHeader: vi.fn(),
    clearCookie: vi.fn(),
    cookie: vi.fn(),
    redirect: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };

  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);

  return response;
};

const callbackRequest = (): Request =>
  ({
    params: { provider: "google" },
    query: { state: "state", code: "provider-code" },
    body: {},
    cookies: {},
  }) as unknown as Request;

const socialSession = {
  accessToken: "access-token",
  refreshToken: REFRESH_TOKEN,
  authContext: "customer" as const,
  user: {},
  tenant: {},
  workspaceAccess: null,
  migratedLegacyCustomerSession: false,
};

describe("custom-domain customer social completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestContext.mockReturnValue({
      origin: CUSTOM_ORIGIN,
      firstPartyProxy: false,
    });
    mocks.handoffConfigured.mockReturnValue(true);
    mocks.createHandoff.mockReturnValue("v1.sealed-handoff");
    mocks.cookieOptions.mockReturnValue({ sameSite: "lax" });
    mocks.cleanupOptions.mockReturnValue([{ sameSite: "none" }]);
    mocks.requiresProxy.mockImplementation(
      (origin: string) => origin === CUSTOM_ORIGIN,
    );
    mocks.begin.mockResolvedValue("https://accounts.example/authorize");
    mocks.finish.mockResolvedValue({
      redirectUrl: `${CUSTOM_ORIGIN}/en/login/complete?socialProvider=google`,
      session: socialSession,
    });
  });

  it("places an encrypted handoff only in the fragment and never sets an API cookie", async () => {
    const response = createResponse();
    const next = vi.fn();

    await completeCustomerSocialSignIn(
      callbackRequest(),
      response as unknown as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.createHandoff).toHaveBeenCalledWith({
      refreshToken: REFRESH_TOKEN,
      authContext: "customer",
      origin: CUSTOM_ORIGIN,
    });
    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledTimes(1);

    const [status, location] = response.redirect.mock.calls[0];
    const redirect = new URL(location);

    expect(status).toBe(303);
    expect(redirect.searchParams.has("sessionHandoff")).toBe(false);
    expect(
      new URLSearchParams(redirect.hash.slice(1)).get("sessionHandoff"),
    ).toBe("v1.sealed-handoff");
  });

  it("keeps the existing same-site cookie path for a shario.io tenant subdomain", async () => {
    mocks.finish.mockResolvedValue({
      redirectUrl: `${PLATFORM_ORIGIN}/en/login/complete`,
      session: socialSession,
    });
    const response = createResponse();
    const next = vi.fn();

    await completeCustomerSocialSignIn(
      callbackRequest(),
      response as unknown as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.cookie).toHaveBeenCalledWith(
      "customer_jwt",
      REFRESH_TOKEN,
      { sameSite: "lax" },
    );
    expect(mocks.createHandoff).not.toHaveBeenCalled();
  });

  it("fails closed rather than setting a third-party cookie when handoff encryption is unavailable", async () => {
    mocks.handoffConfigured.mockReturnValue(false);
    const response = createResponse();
    const next = vi.fn();

    await completeCustomerSocialSignIn(
      callbackRequest(),
      response as unknown as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        code: "AUTH_SESSION_HANDOFF_NOT_CONFIGURED",
      }),
    );
    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.redirect).not.toHaveBeenCalled();
  });

  it("preflights custom-domain social start before redirecting to the provider", async () => {
    mocks.handoffConfigured.mockReturnValue(false);
    const response = createResponse();
    const next = vi.fn();
    const request = {
      params: { provider: "google" },
      query: {
        tenantSlug: "studio",
        locale: "en",
        next: "/portal",
      },
    } as unknown as Request;

    await startCustomerSocialSignIn(
      request,
      response as unknown as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        code: "AUTH_SESSION_HANDOFF_NOT_CONFIGURED",
      }),
    );
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(response.redirect).not.toHaveBeenCalled();
  });
});
