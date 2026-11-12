import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  membershipFindOneAndUpdate: vi.fn(),
  membershipFind: vi.fn(),
  cacheDelete: vi.fn(),
  cacheDeleteKeys: vi.fn(),
}));

vi.mock(
  "../../../src/modules/tenant-access/tenant-membership.model.js",
  () => ({
    default: {
      findOneAndUpdate: mocks.membershipFindOneAndUpdate,
      find: mocks.membershipFind,
    },
  }),
);

vi.mock(
  "../../../src/modules/tenant-access/tenant-custom-role.model.js",
  () => ({
    default: {},
  }),
);

vi.mock("@/infrastructure/redis/cache.js", () => ({
  deleteCache: mocks.cacheDelete,
  deleteCacheKeys: mocks.cacheDeleteKeys,
}));

import {
  tenantAccessRepository,
  type TenantAccessRepositoryOptions,
} from "../../../src/modules/tenant-access/tenant-access.repository.js";
import { workspaceAccessCacheKey } from "../../../src/modules/tenant-access/tenant-access.constants.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const ROLE_ID = "507f1f77bcf86cd799439013";

const query = (result: unknown) => ({
  session: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(result),
});

const leanQuery = (result: unknown) => ({
  select: vi.fn().mockReturnThis(),
  session: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(result),
});

describe("tenant-access repository cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates the affected member's cache after a successful preference update", async () => {
    mocks.membershipFindOneAndUpdate.mockReturnValue(
      query({ tenant: TENANT_ID, user: USER_ID }),
    );

    await tenantAccessRepository.updateActiveMembershipPreferencePaths(
      TENANT_ID,
      USER_ID,
      { "preferences.language": "en" },
    );

    expect(mocks.cacheDelete).toHaveBeenCalledWith(
      workspaceAccessCacheKey(TENANT_ID, USER_ID),
    );
  });

  it("does not invalidate anything when the update matches no active membership", async () => {
    mocks.membershipFindOneAndUpdate.mockReturnValue(query(null));

    await tenantAccessRepository.updateActiveMembershipPreferencePaths(
      TENANT_ID,
      USER_ID,
      { "preferences.language": "en" },
    );

    expect(mocks.cacheDelete).not.toHaveBeenCalled();
  });

  it("invalidates every member's cache when a custom role definition changes", async () => {
    mocks.membershipFind.mockReturnValue(
      leanQuery([{ user: "user-a" }, { user: "user-b" }]),
    );
    const role = {
      tenant: TENANT_ID,
      _id: ROLE_ID,
      save: vi.fn().mockResolvedValue(undefined),
    };
    role.save.mockResolvedValue(role);

    await tenantAccessRepository.saveCustomRole(
      role as unknown as Parameters<
        typeof tenantAccessRepository.saveCustomRole
      >[0],
    );

    expect(mocks.membershipFind).toHaveBeenCalled();
    expect(mocks.cacheDeleteKeys).toHaveBeenCalledWith([
      workspaceAccessCacheKey(TENANT_ID, "user-a"),
      workspaceAccessCacheKey(TENANT_ID, "user-b"),
    ]);
  });

  it("invalidates every affected member before deleting a custom role", async () => {
    mocks.membershipFind.mockReturnValue(leanQuery([{ user: "user-a" }]));

    const options: TenantAccessRepositoryOptions = {};
    // deleteCustomRole issues its own applySession(TenantCustomRoleModel...)
    // call; the mocked model export ({}) has no deleteOne, so this test only
    // needs the invalidation call to happen before that would throw.
    await expect(
      tenantAccessRepository.deleteCustomRole(TENANT_ID, ROLE_ID, options),
    ).rejects.toThrow();

    expect(mocks.cacheDeleteKeys).toHaveBeenCalledWith([
      workspaceAccessCacheKey(TENANT_ID, "user-a"),
    ]);
  });
});
