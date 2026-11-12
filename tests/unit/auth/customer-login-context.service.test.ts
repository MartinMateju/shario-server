import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  comparePassword: vi.fn(),
  findByEmail: vi.fn(),
  rotateRefreshToken: vi.fn(),
  removeRefreshToken: vi.fn(),
  ensureWorkspaceAccess: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  buildAccessToken: vi.fn(),
  buildRefreshToken: vi.fn(),
  verifyRefreshToken: vi.fn(),
  ensureMemberNumber: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: mocks.comparePassword,
  },
}));

vi.mock("@/modules/auth/auth.repository.js", () => ({
  createAuthRepository: () => ({
    findByEmailWithSecrets: mocks.findByEmail,
    rotateRefreshToken: mocks.rotateRefreshToken,
    removeRefreshTokenFromUser: mocks.removeRefreshToken,
  }),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  normalizeEmail: (value: unknown) =>
    String(value ?? "").trim().toLowerCase(),
  buildAccessToken: mocks.buildAccessToken,
  buildRefreshToken: mocks.buildRefreshToken,
  verifyRefreshToken: mocks.verifyRefreshToken,
  getRefreshTokenAuthContext: vi.fn(
    (payload: { authContext?: string }) =>
      payload.authContext ?? "workspace",
  ),
}));

vi.mock("@/modules/tenant-access/index.js", () => ({
  ensureLegacyWorkspaceMembershipForUser:
    mocks.ensureWorkspaceAccess,
  resolveWorkspaceAccessForUser:
    mocks.resolveWorkspaceAccess,
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: vi.fn(),
}));

vi.mock("@/modules/tenants/tenant.repository.js", () => ({
  findTenantById: vi.fn(),
}));

vi.mock("@/modules/auth/auth-origin.js", () => ({
  assertTenantAuthOrigin: vi.fn(),
}));

vi.mock("@/modules/auth/services/register.service.js", () => ({
  registerTenant: vi.fn(),
}));

vi.mock("@/modules/user/user-member-number.assignment.service.js", () => ({
  ensureUserMemberNumber: mocks.ensureMemberNumber,
}));

import {
  loginCustomerUser,
  loginUser,
  logoutUser,
} from "@/modules/auth/services/auth.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const tenant = {
  _id: TENANT_ID,
  slug: "studio-alpha",
};

const owner = {
  _id: USER_ID,
  id: USER_ID,
  tenant: TENANT_ID,
  email: "owner@example.test",
  password: "hash",
  firstname: "Olivia",
  lastname: "Owner",
  customId: "U-1",
  tenantRole: "owner",
  platformRole: "none",
  isAccessGranted: true,
};

const workspaceAccess = {
  membershipId: "507f1f77bcf86cd799439013",
  role: "owner",
  status: "active",
  accessVersion: 1,
};

describe("password login authentication contexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.comparePassword.mockResolvedValue(true);
    mocks.findByEmail.mockResolvedValue(owner);
    mocks.rotateRefreshToken.mockResolvedValue(undefined);
    mocks.removeRefreshToken.mockResolvedValue(undefined);
    mocks.buildAccessToken.mockReturnValue("access");
    mocks.buildRefreshToken.mockReturnValue("refresh");
    mocks.ensureWorkspaceAccess.mockResolvedValue(workspaceAccess);
    mocks.ensureMemberNumber.mockResolvedValue(234);
  });

  it("lazily assigns and returns a member number during password login", async () => {
    const customer = {
      ...owner,
      tenantRole: "customer",
      memberNumber: undefined,
    };
    mocks.findByEmail.mockResolvedValue(customer);
    mocks.ensureWorkspaceAccess.mockResolvedValue(null);

    const result = await loginUser({
      input: { email: customer.email, password: "secret" },
      tenant,
    });

    expect(mocks.ensureMemberNumber).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
    });
    expect(result.user.memberNumber).toBe(234);
    expect(mocks.buildAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ memberNumber: 234 }),
      tenant,
      null,
      "customer",
    );
  });

  it("keeps generic owner login in workspace context", async () => {
    const result = await loginUser({
      input: {
        email: owner.email,
        password: "secret",
      },
      tenant,
      oldRefreshToken: "workspace-old",
      oldCustomerRefreshToken: "customer-old",
    });

    expect(result).toMatchObject({
      authContext: "workspace",
      workspaceAccess,
    });
    expect(mocks.buildAccessToken).toHaveBeenCalledWith(
      owner,
      tenant,
      workspaceAccess,
      "workspace",
    );
    expect(mocks.rotateRefreshToken).toHaveBeenCalledWith({
      userId: USER_ID,
      oldRefreshToken: "workspace-old",
      newRefreshToken: "refresh",
    });
  });

  it("routes a pure customer through the generic customer session", async () => {
    const customer = {
      ...owner,
      tenantRole: "customer",
    };
    mocks.findByEmail.mockResolvedValue(customer);
    mocks.ensureWorkspaceAccess.mockResolvedValue(null);

    const result = await loginUser({
      input: {
        email: customer.email,
        password: "secret",
      },
      tenant,
      oldCustomerRefreshToken: "customer-old",
    });

    expect(result).toMatchObject({
      authContext: "customer",
      workspaceAccess: null,
    });
    expect(mocks.buildAccessToken).toHaveBeenCalledWith(
      customer,
      tenant,
      null,
      "customer",
    );
    expect(mocks.rotateRefreshToken).toHaveBeenCalledWith({
      userId: USER_ID,
      oldRefreshToken: "customer-old",
      newRefreshToken: "refresh",
    });
  });

  it("forces an owner into a privilege-free customer session when explicitly requested", async () => {
    const result = await loginCustomerUser({
      input: {
        email: owner.email,
        password: "secret",
      },
      tenant,
      oldRefreshToken: "customer-old",
    });

    expect(result).toMatchObject({
      authContext: "customer",
      workspaceAccess: null,
    });
    expect(mocks.ensureWorkspaceAccess).not.toHaveBeenCalled();
    expect(mocks.buildAccessToken).toHaveBeenCalledWith(
      owner,
      tenant,
      null,
      "customer",
    );
    expect(mocks.buildRefreshToken).toHaveBeenCalledWith(
      owner,
      tenant,
      "customer",
    );
  });


  it("does not revoke a workspace token through the customer logout boundary", async () => {
    mocks.verifyRefreshToken.mockReturnValue({
      id: USER_ID,
      tenant: TENANT_ID,
      email: owner.email,
      jti: "session-1",
      authContext: "workspace",
    });

    await logoutUser("workspace-token-in-customer-cookie", "customer");

    expect(mocks.removeRefreshToken).not.toHaveBeenCalled();

    mocks.verifyRefreshToken.mockReturnValue({
      id: USER_ID,
      tenant: TENANT_ID,
      email: owner.email,
      jti: "session-2",
      authContext: "customer",
    });

    await logoutUser("customer-token", "customer");

    expect(mocks.removeRefreshToken).toHaveBeenCalledWith(
      "customer-token",
    );
  });

  it("DB-authoritatively rejects platform identities from customer mode", async () => {
    mocks.findByEmail.mockResolvedValue({
      ...owner,
      platformRole: "admin",
    });

    await expect(
      loginCustomerUser({
        input: {
          email: owner.email,
          password: "secret",
        },
        tenant,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "CUSTOMER_CONTEXT_PLATFORM_ACCOUNT_FORBIDDEN",
    });

    expect(mocks.buildAccessToken).not.toHaveBeenCalled();
    expect(mocks.rotateRefreshToken).not.toHaveBeenCalled();
  });
});
