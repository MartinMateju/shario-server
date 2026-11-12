import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  select: vi.fn(),
  lean: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: mocks.findOne,
  },
}));

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";

const TENANT_ID = "64b000000000000000000311";
const USER_ID = "64b000000000000000000312";
const ACCESS_SECRET = "access-session-version-test-secret-that-is-long-enough";

const buildToken = (sessionVersion?: number): string => {
  const UserInfo: Record<string, unknown> = {
    id: USER_ID,
    email: "member@example.test",
    tenant: TENANT_ID,
  };

  if (sessionVersion !== undefined) {
    UserInfo.sessionVersion = sessionVersion;
  }

  return jwt.sign({ UserInfo }, ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: "5m",
  });
};

const createRequest = (token: string) => ({
  headers: {
    authorization: `Bearer ${token}`,
  },
});

describe("access-token session generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ACCESS_TOKEN_SECRET = ACCESS_SECRET;
    mocks.findOne.mockReturnValue({
      select: mocks.select,
    });
    mocks.select.mockReturnValue({
      lean: mocks.lean,
    });
    mocks.lean.mockReturnValue({
      exec: mocks.exec,
    });
  });

  it("accepts a matching current session generation", async () => {
    mocks.exec.mockResolvedValue({
      sessionVersion: 3,
      isAccessGranted: true,
    });
    const req = createRequest(buildToken(3));
    const next = vi.fn();

    await verifyJWT(req as never, {} as never, next);

    expect(mocks.findOne).toHaveBeenCalledWith({
      _id: USER_ID,
      tenant: TENANT_ID,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req).toHaveProperty("userInfo.sessionVersion", 3);
  });

  it("keeps versionless tokens compatible with unmigrated generation-zero users", async () => {
    mocks.exec.mockResolvedValue({
      isAccessGranted: true,
    });
    const next = vi.fn();

    await verifyJWT(createRequest(buildToken()) as never, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects a token issued before a password security event", async () => {
    mocks.exec.mockResolvedValue({
      sessionVersion: 4,
      isAccessGranted: true,
    });
    const next = vi.fn();

    await expect(
      verifyJWT(createRequest(buildToken(3)) as never, {} as never, next),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: "Access session is no longer valid.",
    });

    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a validly signed token when the tenant-scoped user no longer exists", async () => {
    mocks.exec.mockResolvedValue(null);
    const next = vi.fn();

    await expect(
      verifyJWT(createRequest(buildToken(0)) as never, {} as never, next),
    ).rejects.toMatchObject({
      statusCode: 401,
    });

    expect(next).not.toHaveBeenCalled();
  });
});
