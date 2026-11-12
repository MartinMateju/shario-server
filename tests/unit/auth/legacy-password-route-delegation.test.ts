import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changePasswordAndRevokeSessions: vi.fn(),
  validatePasswordInput: vi.fn(),
}));

vi.mock("@/modules/account/account.service.js", () => ({
  changePasswordAndRevokeSessions: mocks.changePasswordAndRevokeSessions,
}));

vi.mock("@/modules/user/user.validators.js", () => ({
  assertValidCreateUserInput: vi.fn(),
  assertValidUpdateUserInput: vi.fn(),
  assertValidUpdatePasswordInput: mocks.validatePasswordInput,
}));

vi.mock("@/modules/user/user.repository.js", () => ({
  createUserRepository: vi.fn(),
}));

vi.mock("@/modules/user/user.utils.js", () => ({
  normalizeEmail: (value: unknown) =>
    String(value ?? "")
      .trim()
      .toLowerCase(),
}));

vi.mock("@/modules/user/user.constants.js", () => ({
  PLATFORM_ROLE: {
    NONE: "none",
  },
  TENANT_ROLE: {
    CUSTOMER: "customer",
  },
}));

vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: {
    exists: vi.fn(),
  },
}));

vi.mock("@/shared/http/httpErrors.js", () => ({
  badRequest: vi.fn(),
  conflict: vi.fn(),
  notFound: vi.fn(),
}));

import { updateUserPassword } from "@/modules/user/services/user.write.service.js";

describe("legacy password route compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.changePasswordAndRevokeSessions.mockResolvedValue(undefined);
  });

  it("delegates /users/pass to the authoritative revoke-all password operation", async () => {
    await expect(
      updateUserPassword({
        tenantId: "64b000000000000000000341",
        input: {
          id: "64b000000000000000000342",
          currentPass: "old-password",
          newPass: "new-password",
          newPassConfirm: "new-password",
        },
      }),
    ).resolves.toEqual({
      message: "Password was updated",
    });

    expect(mocks.validatePasswordInput).toHaveBeenCalledTimes(1);
    expect(mocks.changePasswordAndRevokeSessions).toHaveBeenCalledWith({
      tenantId: "64b000000000000000000341",
      userId: "64b000000000000000000342",
      currentPassword: "old-password",
      newPassword: "new-password",
    });
  });
});
