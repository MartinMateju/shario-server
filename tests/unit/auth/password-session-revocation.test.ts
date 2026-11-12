import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  comparePassword: vi.fn(),
  findOne: vi.fn(),
  select: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: mocks.comparePassword,
  },
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: mocks.findOne,
  },
}));

import {
  changePasswordAndRevokeSessions,
  updateCurrentAccountPassword,
} from "@/modules/account/account.service.js";

const TENANT_ID = "64b000000000000000000301";
const USER_ID = "64b000000000000000000302";

const createUser = ({
  sessionVersion = 4,
  omitSessionVersion = false,
}: {
  sessionVersion?: number;
  omitSessionVersion?: boolean;
} = {}) => {
  const user: Record<string, any> = {
    password: "stored-password-hash",
    refreshToken: ["session-a", "session-b"],
    save: vi.fn().mockResolvedValue(undefined),
  };

  if (!omitSessionVersion) {
    user.sessionVersion = sessionVersion;
  }

  return user;
};

describe("password session revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOne.mockReturnValue({
      select: mocks.select,
    });
    mocks.select.mockReturnValue({
      exec: mocks.exec,
    });
    mocks.comparePassword.mockResolvedValue(true);
  });

  it("changes the password, revokes every refresh session and increments the session generation", async () => {
    const user = createUser();
    mocks.exec.mockResolvedValue(user);

    await changePasswordAndRevokeSessions({
      tenantId: TENANT_ID,
      userId: USER_ID,
      currentPassword: "old-password",
      newPassword: "new-password",
    });

    expect(mocks.findOne).toHaveBeenCalledWith({
      _id: USER_ID,
      tenant: TENANT_ID,
    });
    expect(mocks.select).toHaveBeenCalledWith(
      "+password +refreshToken +sessionVersion",
    );
    expect(mocks.comparePassword).toHaveBeenCalledWith(
      "old-password",
      "stored-password-hash",
    );
    expect(user.password).toBe("new-password");
    expect(user.refreshToken).toEqual([]);
    expect(user.sessionVersion).toBe(5);
    expect(user.save).toHaveBeenCalledTimes(1);
  });

  it("migrates an account without a stored session version from generation zero", async () => {
    const user = createUser({
      omitSessionVersion: true,
    });
    mocks.exec.mockResolvedValue(user);

    await changePasswordAndRevokeSessions({
      tenantId: TENANT_ID,
      userId: USER_ID,
      currentPassword: "old-password",
      newPassword: "new-password",
    });

    expect(user.sessionVersion).toBe(1);
    expect(user.refreshToken).toEqual([]);
    expect(user.save).toHaveBeenCalledTimes(1);
  });

  it("does not mutate credentials or sessions when the current password is wrong", async () => {
    const user = createUser();
    mocks.exec.mockResolvedValue(user);
    mocks.comparePassword.mockResolvedValue(false);

    await expect(
      changePasswordAndRevokeSessions({
        tenantId: TENANT_ID,
        userId: USER_ID,
        currentPassword: "wrong-password",
        newPassword: "new-password",
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
    });

    expect(user.password).toBe("stored-password-hash");
    expect(user.refreshToken).toEqual(["session-a", "session-b"]);
    expect(user.sessionVersion).toBe(4);
    expect(user.save).not.toHaveBeenCalled();
  });

  it("uses the same authoritative operation for the account password endpoint", async () => {
    const user = createUser();
    mocks.exec.mockResolvedValue(user);

    await updateCurrentAccountPassword({
      tenantId: TENANT_ID,
      userId: USER_ID,
      input: {
        currentPassword: "old-password",
        newPassword: "new-password",
        confirmPassword: "new-password",
      },
    });

    expect(user.refreshToken).toEqual([]);
    expect(user.sessionVersion).toBe(5);
    expect(user.save).toHaveBeenCalledTimes(1);
  });
});
