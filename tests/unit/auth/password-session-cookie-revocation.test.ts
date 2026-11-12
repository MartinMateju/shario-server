import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  getRefreshCookieCleanupOptions: vi.fn(),
  requireTenantId: vi.fn(),
  updateCurrentAccountPassword: vi.fn(),
  updateLegacyUserPassword: vi.fn(),
  accountPasswordParse: vi.fn(),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
  getRefreshCookieCleanupOptions: mocks.getRefreshCookieCleanupOptions,
}));

vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: mocks.requireTenantId,
}));

vi.mock("@/modules/account/account.service.js", () => ({
  getCurrentAccount: vi.fn(),
  updateCurrentAccountPassword: mocks.updateCurrentAccountPassword,
  updateCurrentAccountProfile: vi.fn(),
}));

vi.mock("@/modules/account/account.validators.js", () => ({
  accountPasswordSchema: {
    parse: mocks.accountPasswordParse,
  },
  accountProfileSchema: {
    parse: vi.fn(),
  },
}));

vi.mock("@/modules/user/services/user.write.service.js", () => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  updateUserPassword: mocks.updateLegacyUserPassword,
}));

import {
  CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
} from "@/modules/auth/auth.constants.js";
import { updateAccountPassword } from "@/modules/account/account.controller.js";
import { updateUserPassword as updateLegacyUserPassword } from "@/modules/user/controllers/user.write.controller.js";

const TENANT_ID = "64b000000000000000000301";
const USER_ID = "64b000000000000000000302";
const ORIGIN = "http://studio-alpha.shario.localhost:3000";
const HOST_ONLY_OPTIONS = {
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure: false,
};
const DOMAIN_OPTIONS = {
  ...HOST_ONLY_OPTIONS,
  domain: ".shario.localhost",
};
const PASSWORD_BODY = {
  currentPassword: "old-password",
  newPassword: "new-password-which-is-long-enough",
  confirmPassword: "new-password-which-is-long-enough",
};

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

const expectBothAuthCookiesCleared = (
  clearCookie: ReturnType<typeof vi.fn>,
): void => {
  expect(clearCookie).toHaveBeenCalledTimes(4);

  for (const options of [HOST_ONLY_OPTIONS, DOMAIN_OPTIONS]) {
    expect(clearCookie).toHaveBeenCalledWith(
      REFRESH_TOKEN_COOKIE_NAME,
      options,
    );
    expect(clearCookie).toHaveBeenCalledWith(
      CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
      options,
    );
  }
};

describe("password security-event cookie cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserId.mockReturnValue(USER_ID);
    mocks.requireTenantId.mockReturnValue(TENANT_ID);
    mocks.getRefreshCookieCleanupOptions.mockReturnValue([
      HOST_ONLY_OPTIONS,
      DOMAIN_OPTIONS,
    ]);
    mocks.accountPasswordParse.mockImplementation((input) => input);
    mocks.updateCurrentAccountPassword.mockResolvedValue(undefined);
    mocks.updateLegacyUserPassword.mockResolvedValue({
      message: "Password was updated",
    });
  });

  it("revokes every session through /account/password and clears both browser contexts", async () => {
    const req = {
      body: PASSWORD_BODY,
      cookies: {
        [REFRESH_TOKEN_COOKIE_NAME]: "workspace-current",
        [CUSTOMER_REFRESH_TOKEN_COOKIE_NAME]: "customer-current",
      },
      get: vi.fn((header: string) =>
        header === "origin" ? ORIGIN : undefined,
      ),
    };
    const res = createResponse();
    const next = vi.fn();

    await updateAccountPassword(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocks.updateCurrentAccountPassword).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      input: PASSWORD_BODY,
    });
    expect(
      mocks.updateCurrentAccountPassword.mock.calls[0]?.[0],
    ).not.toHaveProperty("currentRefreshToken");
    expectBothAuthCookiesCleared(res.clearCookie);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: "Password updated. Please sign in again.",
    });
  });

  it("keeps legacy /users/pass self-scoped and clears both browser contexts", async () => {
    const req = {
      body: {
        id: "64b000000000000000000399",
        currentPass: "old-password",
        newPass: "new-password-which-is-long-enough",
        newPassConfirm: "new-password-which-is-long-enough",
      },
      get: vi.fn((header: string) =>
        header === "origin" ? ORIGIN : undefined,
      ),
    };
    const res = createResponse();
    const next = vi.fn();

    await updateLegacyUserPassword(req as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocks.updateLegacyUserPassword).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      input: {
        ...req.body,
        id: USER_ID,
      },
    });
    expectBothAuthCookiesCleared(res.clearCookie);
    expect(res.json).toHaveBeenCalledWith({
      message: "Password was updated",
    });
  });
});
