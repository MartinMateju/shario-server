import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantBySlug: vi.fn(),
  loginCustomerUser: vi.fn(),
  refreshCustomerAccessToken: vi.fn(),
  assertRefreshTokenOrigin: vi.fn(),
  logoutUser: vi.fn(),
  updateCurrentAccountPassword: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { info: mocks.info, warn: mocks.warn },
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
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

vi.mock("@/modules/auth/auth-origin.js", () => ({
  assertTenantAuthOrigin: vi.fn(),
}));

vi.mock("@/modules/auth/services/auth.service.js", () => ({
  loginUser: vi.fn(),
  loginCustomerUser: mocks.loginCustomerUser,
  logoutUser: mocks.logoutUser,
  assertRefreshTokenOrigin: mocks.assertRefreshTokenOrigin,
  refreshAccessToken: vi.fn(),
  refreshCustomerAccessToken: mocks.refreshCustomerAccessToken,
}));

vi.mock("@/modules/account/account.service.js", () => ({
  getCurrentAccount: vi.fn(),
  updateCurrentAccountProfile: vi.fn(),
  updateCurrentAccountPassword: mocks.updateCurrentAccountPassword,
  updateCurrentCustomerPreferences: vi.fn(),
}));

import {
  loginCustomer,
  logoutCustomer,
  refreshCustomer,
} from "@/modules/auth/controllers/auth.controller.js";
import {
  updateAccountPassword,
} from "@/modules/account/account.controller.js";
import { errorHandler } from "@/shared/http/errorHandler.js";
import { AppError } from "@/shared/http/AppError.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const tenant = {
  _id: TENANT_ID,
  name: "Studio Alpha",
  slug: "studio-alpha",
  settings: {},
  modules: {},
  limits: {},
};

const customerSession = {
  accessToken: "customer-access",
  refreshToken: "customer-refresh-new",
  authContext: "customer",
  workspaceAccess: null,
  tenant,
  user: {
    _id: USER_ID,
    tenant: TENANT_ID,
    email: "owner@example.test",
    firstname: "Olivia",
    lastname: "Owner",
    customId: "U-1",
    tenantRole: "owner",
    platformRole: "none",
    isEmailVerified: true,
  },
};

const parseCookies = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const entries = String(req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return [
        part.slice(0, index),
        decodeURIComponent(part.slice(index + 1)),
      ];
    });

  (req as Request & { cookies: Record<string, string> }).cookies =
    Object.fromEntries(entries);
  next();
};

const app = express();
app.use(express.json(), parseCookies);
app.post("/customer/login", loginCustomer);
app.post("/customer/logout", logoutCustomer);
app.post("/customer/refresh", refreshCustomer);
app.post("/auth/customer/refresh", refreshCustomer);
app.use(errorHandler);

const passwordApp = express();
passwordApp.use(express.json(), parseCookies);
passwordApp.use((req, _res, next) => {
  const authContext =
    req.get("x-auth-context") === "customer"
      ? "customer"
      : "workspace";
  (req as Request & { userInfo: Record<string, unknown> }).userInfo = {
    id: USER_ID,
    tenant: TENANT_ID,
    authContext,
  };
  next();
});
passwordApp.patch("/password", updateAccountPassword);
passwordApp.use(errorHandler);

const cookieHeaders = (
  response: { headers: Record<string, string | string[] | undefined> },
): string[] => {
  const value = response.headers["set-cookie"];
  return Array.isArray(value) ? value : value ? [value] : [];
};

describe("customer refresh-cookie isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    mocks.getTenantBySlug.mockResolvedValue(tenant);
    mocks.loginCustomerUser.mockResolvedValue(customerSession);
    mocks.refreshCustomerAccessToken.mockResolvedValue({
      ...customerSession,
      migratedLegacyCustomerSession: false,
    });
  });

  it("sets only customer_jwt for explicit customer password login", async () => {
    const response = await request(app)
      .post("/customer/login")
      .set("Origin", "http://studio-alpha.shario.localhost:3000")
      .send({
        tenantSlug: "studio-alpha",
        email: "owner@example.test",
        password: "secret-password",
      })
      .expect(200);

    expect(response.body).toMatchObject({
      authContext: "customer",
      workspaceAccess: null,
      user: {
        tenantRole: "customer",
        platformRole: "none",
        customerDefaultLanguage: null,
      },
    });
    const cookies = cookieHeaders(response);
    expect(cookies.some((value) =>
      value.startsWith("customer_jwt=customer-refresh-new"),
    )).toBe(true);
    expect(cookies.some((value) => value.startsWith("jwt="))).toBe(false);
  });

  it.each(["login", "refresh"])(
    "returns the saved customer language from %s sessions",
    async (operation) => {
      const sessionWithLanguage = {
        ...customerSession,
        user: { ...customerSession.user, customerDefaultLanguage: "CZ" },
      };
      mocks.loginCustomerUser.mockResolvedValue(sessionWithLanguage);
      mocks.refreshCustomerAccessToken.mockResolvedValue(sessionWithLanguage);
      const call = request(app)
        .post(`/customer/${operation}`)
        .set("Origin", "http://studio-alpha.shario.localhost:3000");
      const response = operation === "login"
        ? await call.send({
            tenantSlug: "studio-alpha",
            email: "owner@example.test",
            password: "secret-password",
          }).expect(200)
        : await call.set("Cookie", "customer_jwt=customer-old").expect(200);

      expect(response.body.user.customerDefaultLanguage).toBe("cs");
      expect(response.body.workspaceAccess).toBeNull();
    },
  );

  it("customer logout removes only customer_jwt", async () => {
    const response = await request(app)
      .post("/customer/logout")
      .set("Origin", "http://studio-alpha.shario.localhost:3000")
      .set("Cookie", [
        "customer_jwt=customer-old",
        "jwt=workspace-old",
      ])
      .expect(200);

    expect(mocks.assertRefreshTokenOrigin).toHaveBeenCalledWith(
      "customer-old",
      "http://studio-alpha.shario.localhost:3000",
    );
    expect(mocks.logoutUser).toHaveBeenCalledWith(
      "customer-old",
      "customer",
    );
    const cookies = cookieHeaders(response);
    expect(cookies.some((value) =>
      value.startsWith("customer_jwt="),
    )).toBe(true);
    expect(cookies.some((value) => value.startsWith("jwt="))).toBe(false);
  });

  it("prefers customer_jwt and migrates only a confirmed legacy result", async () => {
    await request(app)
      .post("/customer/refresh")
      .set("Origin", "http://studio-alpha.shario.localhost:3000")
      .set("Cookie", [
        "customer_jwt=customer-old",
        "jwt=workspace-old",
      ])
      .expect(200);

    expect(mocks.refreshCustomerAccessToken).toHaveBeenCalledWith(
      "customer-old",
      "http://studio-alpha.shario.localhost:3000",
      { allowLegacyCustomer: false },
    );

    mocks.refreshCustomerAccessToken.mockResolvedValueOnce({
      ...customerSession,
      migratedLegacyCustomerSession: true,
    });
    const migrated = await request(app)
      .post("/customer/refresh")
      .set("Origin", "http://studio-alpha.shario.localhost:3000")
      .set("Cookie", "jwt=legacy-customer")
      .expect(200);

    expect(mocks.refreshCustomerAccessToken).toHaveBeenLastCalledWith(
      "legacy-customer",
      "http://studio-alpha.shario.localhost:3000",
      { allowLegacyCustomer: true },
    );
    expect(cookieHeaders(migrated).some((value) =>
      value.startsWith("jwt="),
    )).toBe(true);
  });

  it("preserves the staff cookie and the 401 response for an expected customer probe", async () => {
    mocks.refreshCustomerAccessToken.mockRejectedValueOnce(new AppError({
      statusCode: 401,
      code: "AUTH_CONTEXT_MISMATCH",
      message: "The refresh token belongs to a different authentication context.",
      logReason: "workspace_cookie_customer_probe",
    }));

    const response = await request(app)
      .post("/auth/customer/refresh")
      .set("Origin", "http://studio-alpha.shario.localhost:3000")
      .set("Cookie", "jwt=workspace-existing")
      .expect(401);

    expect(mocks.refreshCustomerAccessToken).toHaveBeenCalledWith(
      "workspace-existing",
      "http://studio-alpha.shario.localhost:3000",
      { allowLegacyCustomer: true },
    );
    expect(response.body).toMatchObject({
      statusCode: 401,
      code: "AUTH_CONTEXT_MISMATCH",
      message: "The refresh token belongs to a different authentication context.",
    });
    expect(response.body).not.toHaveProperty("logReason");
    expect(cookieHeaders(response)).toEqual([]);
    expect(mocks.logoutUser).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not allow request fields to enable legacy fallback for a customer cookie", async () => {
    await request(app)
      .post("/auth/customer/refresh")
      .set("Origin", "http://studio-alpha.shario.localhost:3000")
      .set("Cookie", ["customer_jwt=customer-existing", "jwt=workspace-existing"])
      .set("x-expected-auth-state", "true")
      .send({ allowLegacyCustomer: true, logReason: "workspace_cookie_customer_probe" })
      .expect(200);

    expect(mocks.refreshCustomerAccessToken).toHaveBeenCalledWith(
      "customer-existing",
      "http://studio-alpha.shario.localhost:3000",
      { allowLegacyCustomer: false },
    );
  });
});

describe("password-change session revocation", () => {
  const body = {
    currentPassword: "old-password",
    newPassword: "new-password-very-long",
    confirmPassword: "new-password-very-long",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateCurrentAccountPassword.mockResolvedValue(undefined);
  });

  it.each(["customer", "workspace"])(
    "revokes all sessions and clears both cookie audiences from %s mode",
    async (authContext) => {
      const response = await request(passwordApp)
        .patch("/password")
        .set("Origin", "http://studio-alpha.shario.localhost:3000")
        .set("x-auth-context", authContext)
        .set("Cookie", [
          "customer_jwt=customer-current",
          "jwt=workspace-current",
        ])
        .send(body)
        .expect(200, {
          message: "Password updated. Please sign in again.",
        });

      expect(mocks.updateCurrentAccountPassword).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        userId: USER_ID,
        input: body,
      });

      const cookies = cookieHeaders(response);
      expect(
        cookies.some((value) => value.startsWith("customer_jwt=")),
      ).toBe(true);
      expect(
        cookies.some((value) => value.startsWith("jwt=")),
      ).toBe(true);
    },
  );
});
