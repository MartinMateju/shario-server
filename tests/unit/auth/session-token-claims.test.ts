import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildAccessToken,
  buildRefreshToken,
  hashRefreshTokenForStorage,
  verifyRefreshToken,
} from "@/modules/auth/auth.utils.js";

const USER_ID = "64b000000000000000000331";
const TENANT_ID = "64b000000000000000000332";

const user = {
  _id: USER_ID,
  tenant: TENANT_ID,
  email: "member@example.test",
  firstname: "Test",
  lastname: "Member",
  customId: "TEST-1",
  memberNumber: 234,
  tenantRole: "customer" as const,
  platformRole: "none" as const,
};

describe("session-aware authentication tokens", () => {
  beforeEach(() => {
    process.env.ACCESS_TOKEN_SECRET =
      "access-token-claim-test-secret-that-is-long-enough";
    process.env.REFRESH_TOKEN_SECRET =
      "refresh-token-claim-test-secret-that-is-long-enough";
  });

  it("issues generation-zero claims for existing users without a session version", () => {
    const accessToken = buildAccessToken(user);
    const refreshToken = buildRefreshToken(user);

    expect((jwt.decode(accessToken) as any).UserInfo.sessionVersion).toBe(0);
    expect((jwt.decode(accessToken) as any).UserInfo.memberNumber).toBe(234);
    expect(verifyRefreshToken(refreshToken).sessionVersion).toBe(0);
  });

  it("refuses to issue credentials for a user without an email", () => {
    const userWithoutEmail = {
      ...user,
      email: undefined,
    };

    expect(() => buildAccessToken(userWithoutEmail)).toThrow(
      "User email is required to create an authentication token.",
    );
    expect(() => buildRefreshToken(userWithoutEmail)).toThrow(
      "User email is required to create an authentication token.",
    );
  });

  it("carries the current generation in both access and refresh credentials", () => {
    const versionedUser = {
      ...user,
      sessionVersion: 7,
    };

    expect(
      (jwt.decode(buildAccessToken(versionedUser)) as any).UserInfo
        .sessionVersion,
    ).toBe(7);
    expect(
      verifyRefreshToken(buildRefreshToken(versionedUser)).sessionVersion,
    ).toBe(7);
  });

  it("stores a deterministic non-replayable digest instead of the bearer token", () => {
    const token = "signed-refresh-token";
    const stored = hashRefreshTokenForStorage(token);

    expect(stored).not.toBe(token);
    expect(stored).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashRefreshTokenForStorage(token)).toBe(stored);
  });
});
