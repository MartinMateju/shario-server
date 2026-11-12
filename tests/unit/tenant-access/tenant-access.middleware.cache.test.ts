import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceAccessForUser: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock(
  "../../../src/modules/tenant-access/services/authorization.service.js",
  () => ({
    resolveWorkspaceAccessForUser: mocks.resolveWorkspaceAccessForUser,
    hasWorkspacePermission: (
      access: { permissions: string[] },
      permission: string,
    ) => Boolean(access?.permissions?.includes(permission)),
    canAccessWorkspaceLocation: () => true,
  }),
);

vi.mock("@/infrastructure/redis/redis.js", () => ({
  redisConnection: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

import { requireWorkspaceAccess } from "../../../src/modules/tenant-access/tenant-access.middleware.js";
import {
  TENANT_MEMBERSHIP_STATUS,
  workspaceAccessCacheKey,
} from "../../../src/modules/tenant-access/tenant-access.constants.js";
import { AUTH_CONTEXT } from "../../../src/modules/auth/auth.constants.js";
import type { WorkspaceAccessRequest } from "../../../src/modules/tenant-access/tenant-access.types.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

const access = {
  membershipId: "507f1f77bcf86cd799439013",
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  role: "staff",
  permissions: [],
};

const buildRequest = (): WorkspaceAccessRequest =>
  ({
    userInfo: {
      id: USER_ID,
      tenant: TENANT_ID,
      authContext: AUTH_CONTEXT.WORKSPACE,
    },
  }) as unknown as WorkspaceAccessRequest;

describe("workspace access resolution caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceAccessForUser.mockResolvedValue(access);
  });

  it("hits the database on the first request and caches the result", async () => {
    mocks.redisGet.mockResolvedValueOnce(null);
    mocks.redisSet.mockResolvedValueOnce("OK");
    const next = vi.fn();

    await requireWorkspaceAccess(buildRequest(), {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(mocks.resolveWorkspaceAccessForUser).toHaveBeenCalledOnce();
    expect(mocks.redisSet).toHaveBeenCalledWith(
      workspaceAccessCacheKey(TENANT_ID, USER_ID),
      JSON.stringify(access),
      "EX",
      expect.any(Number),
    );
  });

  it("serves the second request from cache without re-resolving from the database", async () => {
    mocks.redisGet.mockResolvedValueOnce(JSON.stringify(access));
    const next = vi.fn();

    await requireWorkspaceAccess(buildRequest(), {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(mocks.resolveWorkspaceAccessForUser).not.toHaveBeenCalled();
  });

  it("still resolves correctly (fail-open) when redis is unavailable", async () => {
    mocks.redisGet.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    mocks.redisSet.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const next = vi.fn();

    await requireWorkspaceAccess(buildRequest(), {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(mocks.resolveWorkspaceAccessForUser).toHaveBeenCalledOnce();
  });
});
