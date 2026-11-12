import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyRefreshToken: vi.fn(),
  removeRefreshToken: vi.fn(),
  createAuthRepository: vi.fn(),
  findTenantById: vi.fn(),
  assertTenantAuthOrigin: vi.fn(),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  normalizeEmail: (value: unknown) =>
    String(value ?? "")
      .trim()
      .toLowerCase(),
  verifyRefreshToken: mocks.verifyRefreshToken,
  getRefreshTokenAuthContext: vi.fn(() => "workspace"),
  buildAccessToken: vi.fn(),
  buildRefreshToken: vi.fn(),
}));

vi.mock("@/modules/auth/auth.repository.js", () => ({
  createAuthRepository: (input: unknown) => {
    mocks.createAuthRepository(input);
    return {
      removeRefreshTokenFromUser: mocks.removeRefreshToken,
    };
  },
}));

vi.mock("@/modules/tenants/tenant.repository.js", () => ({
  findTenantById: mocks.findTenantById,
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: vi.fn(),
}));

vi.mock("@/modules/auth/auth-origin.js", () => ({
  assertTenantAuthOrigin: mocks.assertTenantAuthOrigin,
}));

vi.mock("@/modules/tenant-access/index.js", () => ({
  ensureLegacyWorkspaceMembershipForUser: vi.fn(),
}));

vi.mock("@/modules/auth/services/register.service.js", () => ({
  registerTenant: vi.fn(),
}));

import {
  assertRefreshTokenOrigin,
  logoutUser,
} from "@/modules/auth/services/auth.service.js";

const TENANT_ID = "64b000000000000000000351";
const REFRESH_TOKEN = "signed-refresh-token";

describe("logout service failure semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyRefreshToken.mockReturnValue({
      id: "64b000000000000000000352",
      tenant: TENANT_ID,
      email: "member@example.test",
      jti: "session-id",
    });
    mocks.removeRefreshToken.mockResolvedValue(undefined);
    mocks.findTenantById.mockResolvedValue({
      _id: TENANT_ID,
      slug: "studio-alpha",
    });
  });

  it("keeps invalid and expired credentials idempotent", async () => {
    mocks.verifyRefreshToken.mockImplementation(() => {
      throw new Error("expired");
    });

    await expect(logoutUser(REFRESH_TOKEN)).resolves.toBeUndefined();

    expect(mocks.createAuthRepository).not.toHaveBeenCalled();
  });

  it("propagates refresh-token storage failures to the controller", async () => {
    const storageError = new Error("MongoDB unavailable");
    mocks.removeRefreshToken.mockRejectedValue(storageError);

    await expect(logoutUser(REFRESH_TOKEN)).rejects.toBe(storageError);

    expect(mocks.createAuthRepository).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
    });
  });

  it("treats a deleted tenant as an unusable credential", async () => {
    mocks.findTenantById.mockResolvedValue(null);

    await expect(
      assertRefreshTokenOrigin(REFRESH_TOKEN, "https://studio-alpha.example"),
    ).resolves.toBeUndefined();

    expect(mocks.assertTenantAuthOrigin).not.toHaveBeenCalled();
  });

  it("propagates tenant lookup failures instead of misclassifying them as an invalid credential", async () => {
    const lookupError = new Error("Tenant lookup failed");
    mocks.findTenantById.mockRejectedValue(lookupError);

    await expect(
      assertRefreshTokenOrigin(REFRESH_TOKEN, "https://studio-alpha.example"),
    ).rejects.toBe(lookupError);
  });

  it("preserves rejection of a confirmed origin mismatch", async () => {
    const mismatch = Object.assign(new Error("Origin mismatch"), {
      statusCode: 403,
      code: "AUTH_ORIGIN_TENANT_MISMATCH",
    });
    mocks.assertTenantAuthOrigin.mockImplementation(() => {
      throw mismatch;
    });

    await expect(
      assertRefreshTokenOrigin(REFRESH_TOKEN, "https://wrong-tenant.example"),
    ).rejects.toBe(mismatch);

    expect(mocks.assertTenantAuthOrigin).toHaveBeenCalledTimes(1);
  });
});
