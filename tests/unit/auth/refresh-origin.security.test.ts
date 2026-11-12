import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyRefreshToken: vi.fn(),
  buildAccessToken: vi.fn(),
  buildRefreshToken: vi.fn(),
  findByRefreshToken: vi.fn(),
  compareAndSwapRefreshToken: vi.fn(),
  getTenantOrThrow: vi.fn(),
  findTenantById: vi.fn(),
  ensureWorkspaceAccess: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  getRefreshTokenAuthContext: vi.fn(),
  ensureUserMemberNumber: vi.fn(),
}));

vi.mock(
  "@/modules/auth/auth.utils.js",
  () => ({
    normalizeEmail: (value: unknown) =>
      String(value ?? "")
        .trim()
        .toLowerCase(),
    verifyRefreshToken:
      mocks.verifyRefreshToken,
    getRefreshTokenAuthContext:
      mocks.getRefreshTokenAuthContext,
    buildAccessToken:
      mocks.buildAccessToken,
    buildRefreshToken:
      mocks.buildRefreshToken,
  }),
);

vi.mock("@/modules/auth/auth.repository.js", () => ({
  createAuthRepository: vi.fn(() => ({
    findByRefreshTokenWithSecrets: mocks.findByRefreshToken,
    compareAndSwapRefreshToken: mocks.compareAndSwapRefreshToken,
  })),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));

vi.mock("@/modules/tenants/tenant.repository.js", () => ({
  findTenantById: mocks.findTenantById,
}));

vi.mock("@/modules/tenant-access/index.js", () => ({
  ensureLegacyWorkspaceMembershipForUser: mocks.ensureWorkspaceAccess,
  resolveWorkspaceAccessForUser: mocks.resolveWorkspaceAccess,
}));

vi.mock("@/modules/auth/services/register.service.js", () => ({
  registerTenant: vi.fn(),
}));

vi.mock("@/modules/user/user-member-number.assignment.service.js", () => ({
  ensureUserMemberNumber: mocks.ensureUserMemberNumber,
}));

import { assertTenantAuthOrigin } from "@/modules/auth/auth-origin.js";
import {
  assertRefreshTokenOrigin,
  refreshAccessToken,
  refreshCustomerAccessToken,
} from "@/modules/auth/services/auth.service.js";

const TENANT_A = "64b000000000000000000201";
const TENANT_B = "64b000000000000000000202";
const USER_A = "64b000000000000000000203";
const REFRESH_TOKEN_A = "tenant-a-refresh-token";

const tenantA = {
  _id: TENANT_A,
  slug: "studio-alpha",
  domains: [
    {
      hostname: "alpha-pottery.example",
      status: "active",
    },
  ],
};

const tenantB = {
  _id: TENANT_B,
  slug: "studio-beta",
  domains: [
    {
      hostname: "beta-pottery.example",
      status: "active",
    },
  ],
};

const userA = {
  _id: USER_A,
  id: USER_A,
  tenant: TENANT_A,
  email: "customer@studio-alpha.test",
  firstname: "Alex",
  lastname: "Customer",
  customId: "A-100",
  tenantRole: "customer",
  platformRole: "none",
  isAccessGranted: true,
};

describe("tenant-bound refresh origins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    process.env.DEVELOPMENT_ROOT_DOMAIN =
      "shario.localhost";
    process.env.CLIENT_URL =
      "http://shario.localhost:3000";

    mocks.verifyRefreshToken.mockReturnValue(
      {
        tenant: TENANT_A,
        id: USER_A,
        email: userA.email,
        jti: "refresh-a",
      },
    );
    mocks.getRefreshTokenAuthContext.mockReturnValue("workspace");
    mocks.getTenantOrThrow.mockResolvedValue(
      tenantA,
    );
    mocks.findTenantById.mockResolvedValue(
      tenantA,
    );
    mocks.findByRefreshToken.mockResolvedValue(
      userA,
    );
    mocks.ensureUserMemberNumber.mockResolvedValue(234);
    mocks.ensureWorkspaceAccess.mockResolvedValue(
      {
        membershipId:
          "64b000000000000000000204",
        role: "owner",
        status: "active",
      },
    );
    mocks.resolveWorkspaceAccess.mockResolvedValue(
      null,
    );
    mocks.buildAccessToken.mockReturnValue(
      "access-token",
    );
    mocks.buildRefreshToken.mockReturnValue(
      "rotated-refresh-token",
    );
    mocks.compareAndSwapRefreshToken.mockResolvedValue(
      true,
    );
  });

  it.each([
    ["the tenant subdomain", "http://studio-alpha.shario.localhost:3000"],
    ["the tenant active custom domain", "https://alpha-pottery.example"],
  ])("rotates tenant A's session from %s", async (_label, origin) => {
    await expect(
      refreshAccessToken(REFRESH_TOKEN_A, origin),
    ).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "rotated-refresh-token",
      tenant: tenantA,
    });

    expect(mocks.findByRefreshToken).toHaveBeenCalledWith(REFRESH_TOKEN_A);
    expect(mocks.ensureUserMemberNumber).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      userId: USER_A,
    });
    expect(mocks.compareAndSwapRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("accepts the shario.localhost tenant origin when CLIENT_URL is plain localhost and no development root is configured", async () => {
    delete process.env.DEVELOPMENT_ROOT_DOMAIN;
    process.env.CLIENT_URL = "http://localhost:3000";

    expect(() =>
      assertTenantAuthOrigin({
        origin: "http://studio-alpha.shario.localhost:3000",
        tenant: tenantA,
      }),
    ).not.toThrow();

    await expect(
      refreshAccessToken(
        REFRESH_TOKEN_A,
        "http://studio-alpha.shario.localhost:3000",
      ),
    ).resolves.toMatchObject({
      accessToken: "access-token",
      tenant: tenantA,
    });
  });

  it("accepts the legacy flat-localhost tenant origin without weakening tenant isolation", () => {
    delete process.env.DEVELOPMENT_ROOT_DOMAIN;
    process.env.CLIENT_URL = "http://localhost:3000";

    expect(() =>
      assertTenantAuthOrigin({
        origin: "http://studio-alpha.localhost:3000",
        tenant: tenantA,
      }),
    ).not.toThrow();

    expect(() =>
      assertTenantAuthOrigin({
        origin: "http://studio-beta.shario.localhost:3000",
        tenant: tenantA,
      }),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        code: "AUTH_ORIGIN_TENANT_MISMATCH",
      }),
    );
  });

  it("rejects tenant A's session from tenant B's active custom domain before reading or rotating it", async () => {
    expect(() =>
      assertTenantAuthOrigin({
        origin: "https://beta-pottery.example",
        tenant: tenantB,
      }),
    ).not.toThrow();

    await expect(
      refreshAccessToken(REFRESH_TOKEN_A, "https://beta-pottery.example"),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AUTH_ORIGIN_TENANT_MISMATCH",
    });

    expect(mocks.findByRefreshToken).not.toHaveBeenCalled();
    expect(mocks.compareAndSwapRefreshToken).not.toHaveBeenCalled();
  });

  it("rejects a refresh credential issued before the user's session generation changed", async () => {
    mocks.verifyRefreshToken.mockReturnValue({
      tenant: TENANT_A,
      id: USER_A,
      email: userA.email,
      jti: "refresh-a",
      sessionVersion: 2,
    });
    mocks.findByRefreshToken.mockResolvedValue({
      ...userA,
      sessionVersion: 3,
    });

    await expect(
      refreshAccessToken(
        REFRESH_TOKEN_A,
        "http://studio-alpha.shario.localhost:3000",
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Invalid refresh token.",
    });

    expect(mocks.buildAccessToken).not.toHaveBeenCalled();
    expect(mocks.compareAndSwapRefreshToken).not.toHaveBeenCalled();
  });

  it("rejects a customer refresh credential at the workspace endpoint", async () => {
    mocks.verifyRefreshToken.mockReturnValue({
      tenant: TENANT_A,
      id: USER_A,
      email: userA.email,
      jti: "customer-refresh",
      authContext: "customer",
    });
    mocks.getRefreshTokenAuthContext.mockReturnValue("customer");

    await expect(
      refreshAccessToken(
        REFRESH_TOKEN_A,
        "http://studio-alpha.shario.localhost:3000",
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_CONTEXT_MISMATCH",
    });

    expect(mocks.getTenantOrThrow).not.toHaveBeenCalled();
    expect(mocks.findByRefreshToken).not.toHaveBeenCalled();
  });

  it("rotates an explicit customer credential without resolving workspace access", async () => {
    mocks.verifyRefreshToken.mockReturnValue({
      tenant: TENANT_A,
      id: USER_A,
      email: userA.email,
      jti: "customer-refresh",
      authContext: "customer",
    });
    mocks.getRefreshTokenAuthContext.mockReturnValue("customer");

    await expect(
      refreshCustomerAccessToken(
        REFRESH_TOKEN_A,
        "http://studio-alpha.shario.localhost:3000",
      ),
    ).resolves.toMatchObject({
      authContext: "customer",
      workspaceAccess: null,
      migratedLegacyCustomerSession: false,
    });

    expect(mocks.ensureWorkspaceAccess).not.toHaveBeenCalled();
    expect(mocks.resolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(mocks.buildRefreshToken).toHaveBeenCalledWith(
      userA,
      tenantA,
      "customer",
    );
  });

  it("rejects a workspace credential at the customer endpoint", async () => {
    mocks.verifyRefreshToken.mockReturnValue({
      tenant: TENANT_A,
      id: USER_A,
      email: userA.email,
      jti: "workspace-refresh",
      authContext: "workspace",
    });
    mocks.getRefreshTokenAuthContext.mockReturnValue("workspace");

    await expect(
      refreshCustomerAccessToken(
        REFRESH_TOKEN_A,
        "http://studio-alpha.shario.localhost:3000",
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_CONTEXT_MISMATCH",
    });

    expect(mocks.getTenantOrThrow).not.toHaveBeenCalled();
    expect(mocks.findByRefreshToken).not.toHaveBeenCalled();
  });

  it("rejects a customer credential after its session generation changes", async () => {
    mocks.verifyRefreshToken.mockReturnValue({
      tenant: TENANT_A,
      id: USER_A,
      email: userA.email,
      jti: "customer-refresh",
      authContext: "customer",
      sessionVersion: 2,
    });
    mocks.getRefreshTokenAuthContext.mockReturnValue("customer");
    mocks.findByRefreshToken.mockResolvedValue({
      ...userA,
      sessionVersion: 3,
    });

    await expect(
      refreshCustomerAccessToken(
        REFRESH_TOKEN_A,
        "http://studio-alpha.shario.localhost:3000",
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Invalid refresh token.",
    });

    expect(mocks.buildAccessToken).not.toHaveBeenCalled();
    expect(mocks.compareAndSwapRefreshToken).not.toHaveBeenCalled();
  });

  describe("workspace-cookie customer-session probes", () => {
    beforeEach(() => {
      mocks.verifyRefreshToken.mockReturnValue({
        tenant: TENANT_A,
        id: USER_A,
        email: userA.email,
        jti: "workspace-refresh",
        authContext: "workspace",
        sessionVersion: 0,
      });
      mocks.findByRefreshToken.mockResolvedValue({ ...userA, tenantRole: "owner" });
    });

    const probe = (origin = "http://studio-alpha.shario.localhost:3000") =>
      refreshCustomerAccessToken(REFRESH_TOKEN_A, origin, { allowLegacyCustomer: true });

    const expectNoSessionWrites = () => {
      expect(mocks.ensureUserMemberNumber).not.toHaveBeenCalled();
      expect(mocks.ensureWorkspaceAccess).not.toHaveBeenCalled();
      expect(mocks.buildAccessToken).not.toHaveBeenCalled();
      expect(mocks.buildRefreshToken).not.toHaveBeenCalled();
      expect(mocks.compareAndSwapRefreshToken).not.toHaveBeenCalled();
    };

    it("marks only a validated legacy-cookie fallback and still rejects it without session writes", async () => {
      await expect(probe()).rejects.toMatchObject({
        statusCode: 401,
        code: "AUTH_CONTEXT_MISMATCH",
        message: "The refresh token belongs to a different authentication context.",
        logReason: "workspace_cookie_customer_probe",
      });
      expect(mocks.getTenantOrThrow).toHaveBeenCalledWith(TENANT_A);
      expect(mocks.findByRefreshToken).toHaveBeenCalledWith(REFRESH_TOKEN_A);
      expectNoSessionWrites();
    });

    it("does not mark a workspace token supplied as the customer credential", async () => {
      const error = await refreshCustomerAccessToken(REFRESH_TOKEN_A).catch((error) => error);
      expect(error).toMatchObject({ statusCode: 401, code: "AUTH_CONTEXT_MISMATCH" });
      expect(error.logReason).toBeUndefined();
      expect(mocks.findByRefreshToken).not.toHaveBeenCalled();
      expectNoSessionWrites();
    });

    it.each(["invalid signature", "expired token"])("does not mark an %s", async (reason) => {
      mocks.verifyRefreshToken.mockImplementationOnce(() => { throw new Error(reason); });
      const error = await probe().catch((error) => error);
      expect(error).toMatchObject({ statusCode: 401, message: "Invalid refresh token." });
      expect(error.logReason).toBeUndefined();
      expect(mocks.findByRefreshToken).not.toHaveBeenCalled();
      expectNoSessionWrites();
    });

    it.each([
      { reason: "revoked token", user: null, statusCode: 401 },
      { reason: "different user", user: { ...userA, _id: TENANT_B }, statusCode: 401 },
      { reason: "revoked session version", user: { ...userA, sessionVersion: 1 }, statusCode: 401 },
      { reason: "disabled account", user: { ...userA, isAccessGranted: false }, statusCode: 403 },
    ])("does not mark a $reason as expected", async ({ user, statusCode }) => {
      mocks.findByRefreshToken.mockResolvedValueOnce(user);
      const error = await probe().catch((error) => error);
      expect(error).toMatchObject({ statusCode });
      expect(error.logReason).toBeUndefined();
      expectNoSessionWrites();
    });

    it("keeps cross-tenant origins visible before reading the stored token", async () => {
      const error = await probe("https://beta-pottery.example").catch((error) => error);
      expect(error).toMatchObject({ statusCode: 403, code: "AUTH_ORIGIN_TENANT_MISMATCH" });
      expect(error.logReason).toBeUndefined();
      expect(mocks.findByRefreshToken).not.toHaveBeenCalled();
      expectNoSessionWrites();
    });

    it("propagates unexpected session-store failures", async () => {
      const failure = new Error("Session store unavailable");
      mocks.findByRefreshToken.mockRejectedValueOnce(failure);
      await expect(probe()).rejects.toBe(failure);
      expectNoSessionWrites();
    });
  });

  it("migrates only a pure legacy customer credential", async () => {
    mocks.getRefreshTokenAuthContext.mockReturnValue("workspace");
    mocks.resolveWorkspaceAccess.mockResolvedValue(null);

    await expect(
      refreshCustomerAccessToken(
        REFRESH_TOKEN_A,
        "http://studio-alpha.shario.localhost:3000",
        { allowLegacyCustomer: true },
      ),
    ).resolves.toMatchObject({
      authContext: "customer",
      migratedLegacyCustomerSession: true,
    });

    mocks.findByRefreshToken.mockResolvedValue({
      ...userA,
      tenantRole: "owner",
    });
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      membershipId: "64b000000000000000000204",
      role: "owner",
      status: "active",
    });

    await expect(
      refreshCustomerAccessToken(
        REFRESH_TOKEN_A,
        "http://studio-alpha.shario.localhost:3000",
        { allowLegacyCustomer: true },
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_CONTEXT_MISMATCH",
    });
  });

  it("rejects cross-tenant logout origin validation before session cleanup", async () => {
    await expect(
      assertRefreshTokenOrigin(REFRESH_TOKEN_A, "https://beta-pottery.example"),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AUTH_ORIGIN_TENANT_MISMATCH",
    });
  });

  it("treats a valid token for a deleted tenant as already unusable", async () => {
    mocks.findTenantById.mockResolvedValueOnce(null);

    await expect(
      assertRefreshTokenOrigin(
        REFRESH_TOKEN_A,
        "https://studio-alpha.example",
      ),
    ).resolves.toBeUndefined();
  });

  it("propagates an unexpected tenant lookup failure", async () => {
    const lookupError = new Error("Tenant lookup failed");
    mocks.findTenantById.mockRejectedValueOnce(lookupError);

    await expect(
      assertRefreshTokenOrigin(
        REFRESH_TOKEN_A,
        "https://studio-alpha.example",
      ),
    ).rejects.toBe(lookupError);
  });
});


