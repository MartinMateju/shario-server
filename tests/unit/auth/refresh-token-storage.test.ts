import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  updateOne: vi.fn(),
  select: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  hashRefreshTokenForStorage: (token: string) => `digest:${token}`,
  getRefreshTokenStorageCandidates: (token: string) => [
    `digest:${token}`,
    token,
  ],
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: mocks.findOne,
    updateOne: mocks.updateOne,
  },
}));

import { createAuthRepository } from "@/modules/auth/auth.repository.js";

const TENANT_ID = "64b000000000000000000321";
const USER_ID = "64b000000000000000000322";

describe("refresh-token storage hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exec.mockResolvedValue({
      modifiedCount: 1,
    });
    mocks.findOne.mockReturnValue({
      select: mocks.select,
    });
    mocks.select.mockReturnValue({
      exec: mocks.exec,
    });
    mocks.updateOne.mockReturnValue({
      exec: mocks.exec,
    });
  });

  it("finds both migrated digests and legacy raw records during the rolling migration", async () => {
    const repository = createAuthRepository({
      tenantId: TENANT_ID,
    });

    await repository.findByRefreshTokenWithSecrets("raw-refresh-token");

    expect(mocks.findOne).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      refreshToken: {
        $in: ["digest:raw-refresh-token", "raw-refresh-token"],
      },
    });
    expect(mocks.select).toHaveBeenCalledWith(
      expect.stringContaining("+sessionVersion"),
    );
  });

  it("stores only the digest and bounds the retained session array", async () => {
    const repository = createAuthRepository({
      tenantId: TENANT_ID,
    });

    await repository.addRefreshTokenToUser({
      userId: USER_ID,
      refreshToken: "new-refresh-token",
    });

    const [filter, pipeline, options] = mocks.updateOne.mock.calls[0];
    const slice = pipeline[0].$set.refreshToken.$slice;

    expect(filter).toEqual({
      _id: USER_ID,
      tenant: TENANT_ID,
    });
    expect(slice[0].$concatArrays[1]).toEqual(["digest:new-refresh-token"]);
    expect(slice[1]).toBe(-10);
    expect(options).toEqual({
      updatePipeline: true,
    });
  });

  it("atomically consumes either a legacy raw token or its digest and writes a digest successor", async () => {
    const repository = createAuthRepository({
      tenantId: TENANT_ID,
    });

    await expect(
      repository.compareAndSwapRefreshToken({
        userId: USER_ID,
        oldRefreshToken: "old-token",
        newRefreshToken: "new-token",
      }),
    ).resolves.toBe(true);

    const [filter, pipeline] = mocks.updateOne.mock.calls[0];

    expect(filter).toEqual({
      _id: USER_ID,
      tenant: TENANT_ID,
      refreshToken: {
        $in: ["digest:old-token", "old-token"],
      },
    });
    expect(pipeline[0].$set.refreshToken.$slice[0].$concatArrays[1]).toEqual([
      "digest:new-token",
    ]);
  });

  it("removes both storage representations during logout", async () => {
    const repository = createAuthRepository({
      tenantId: TENANT_ID,
    });

    await repository.removeRefreshTokenFromUser("refresh-token");

    expect(mocks.updateOne).toHaveBeenCalledWith(
      {
        tenant: TENANT_ID,
        refreshToken: {
          $in: ["digest:refresh-token", "refresh-token"],
        },
      },
      {
        $pull: {
          refreshToken: {
            $in: ["digest:refresh-token", "refresh-token"],
          },
        },
      },
    );
  });
});
