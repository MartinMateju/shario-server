import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const hostOnlyOptions = {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: false,
  };
  const domainOptions = {
    ...hostOnlyOptions,
    domain: ".shario.localhost",
  };

  return {
    assertRefreshTokenOrigin: vi.fn(),
    logoutUser: vi.fn(),
    hostOnlyOptions,
    domainOptions,
    cleanupOptions: vi.fn(() => [hostOnlyOptions, domainOptions]),
  };
});

const HOST_ONLY_OPTIONS = mocks.hostOnlyOptions;
const DOMAIN_OPTIONS = mocks.domainOptions;

vi.mock("@/modules/auth/services/auth.service.js", () => ({
  assertRefreshTokenOrigin: mocks.assertRefreshTokenOrigin,
  loginUser: vi.fn(),
  loginCustomerUser: vi.fn(),
  logoutUser: mocks.logoutUser,
  refreshAccessToken: vi.fn(),
  refreshCustomerAccessToken: vi.fn(),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getRefreshCookieCleanupOptions: mocks.cleanupOptions,
  getRefreshCookieOptions: vi.fn(),
  requiresFirstPartyRefreshProxy: vi.fn(() => false),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: vi.fn(),
}));

vi.mock("@/modules/tenant-access/index.js", () => ({
  serializeWorkspaceAccess: vi.fn(),
}));

vi.mock(
  "@/modules/tenants/public-site/tenant-public-site.serializers.js",
  () => ({
    serializeTenantPublicSite: vi.fn(),
  }),
);

vi.mock("@/config/logger.js", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import {
  AUTH_CONTEXT,
  CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
} from "@/modules/auth/auth.constants.js";
import {
  logout,
  logoutCustomer,
} from "@/modules/auth/controllers/auth.controller.js";

const ORIGIN = "http://studio-olivie.shario.localhost:3000";
const WORKSPACE_TOKEN = "workspace-refresh-token";
const CUSTOMER_TOKEN = "customer-refresh-token";

type LogoutSurface = {
  label: string;
  handler: typeof logout;
  cookieName: string;
  token: string;
  expectedLogoutArguments: unknown[];
};

const surfaces: LogoutSurface[] = [
  {
    label: "workspace",
    handler: logout,
    cookieName: REFRESH_TOKEN_COOKIE_NAME,
    token: WORKSPACE_TOKEN,
    expectedLogoutArguments: [WORKSPACE_TOKEN],
  },
  {
    label: "customer",
    handler: logoutCustomer,
    cookieName: CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
    token: CUSTOMER_TOKEN,
    expectedLogoutArguments: [CUSTOMER_TOKEN, AUTH_CONTEXT.CUSTOMER],
  },
];

const createRequest = (): Request =>
  ({
    cookies: {
      [REFRESH_TOKEN_COOKIE_NAME]: WORKSPACE_TOKEN,
      [CUSTOMER_REFRESH_TOKEN_COOKIE_NAME]: CUSTOMER_TOKEN,
    },
    get: vi.fn((header: string) => (header === "origin" ? ORIGIN : undefined)),
  }) as unknown as Request;

const createResponse = () => {
  const res = {
    clearCookie: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };

  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);

  return res;
};

const expectTargetCookieCleared = (
  res: ReturnType<typeof createResponse>,
  cookieName: string,
): void => {
  expect(res.clearCookie).toHaveBeenCalledTimes(2);
  expect(res.clearCookie).toHaveBeenCalledWith(cookieName, HOST_ONLY_OPTIONS);
  expect(res.clearCookie).toHaveBeenCalledWith(cookieName, DOMAIN_OPTIONS);
  expect(
    res.clearCookie.mock.calls.every(
      ([actualCookieName]) => actualCookieName === cookieName,
    ),
  ).toBe(true);
};

describe("dual-context logout refresh-cookie cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertRefreshTokenOrigin.mockResolvedValue(undefined);
    mocks.logoutUser.mockResolvedValue(undefined);
  });

  it.each(surfaces)(
    "revokes and clears only the $label refresh credential",
    async ({ handler, cookieName, token, expectedLogoutArguments }) => {
      const res = createResponse();
      const next = vi.fn();

      await handler(createRequest(), res as unknown as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(mocks.assertRefreshTokenOrigin).toHaveBeenCalledWith(
        token,
        ORIGIN,
      );
      expect(mocks.logoutUser).toHaveBeenCalledWith(...expectedLogoutArguments);
      expect(mocks.cleanupOptions).toHaveBeenCalledWith(ORIGIN, {
        firstPartyProxy: false,
      });
      expectTargetCookieCleared(res, cookieName);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Logged out successfully",
      });
    },
  );

  it.each(surfaces)(
    "clears the $label cookie and reports refresh-token storage failure",
    async ({ handler, cookieName, expectedLogoutArguments }) => {
      const storageError = new Error("MongoDB unavailable");
      mocks.logoutUser.mockRejectedValueOnce(storageError);
      const res = createResponse();
      const next = vi.fn();

      await handler(createRequest(), res as unknown as Response, next);

      expect(mocks.logoutUser).toHaveBeenCalledWith(...expectedLogoutArguments);
      expectTargetCookieCleared(res, cookieName);
      expect(next).toHaveBeenCalledWith(storageError);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    },
  );

  const originFailures = [
    {
      label: "confirmed origin mismatch",
      error: Object.assign(new Error("Origin mismatch"), {
        statusCode: 403,
        code: "AUTH_ORIGIN_TENANT_MISMATCH",
      }),
    },
    {
      label: "tenant lookup failure",
      error: new Error("Tenant lookup failed"),
    },
  ];

  it.each(
    surfaces.flatMap((surface) =>
      originFailures.map((failure) => ({
        ...surface,
        failureLabel: failure.label,
        failure: failure.error,
      })),
    ),
  )(
    "clears the $label cookie on $failureLabel",
    async ({ handler, cookieName, failure }) => {
      mocks.assertRefreshTokenOrigin.mockRejectedValueOnce(failure);
      const res = createResponse();
      const next = vi.fn();

      await handler(createRequest(), res as unknown as Response, next);

      expect(mocks.logoutUser).not.toHaveBeenCalled();
      expectTargetCookieCleared(res, cookieName);
      expect(next).toHaveBeenCalledWith(failure);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    },
  );
});
