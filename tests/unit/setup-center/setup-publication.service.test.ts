import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantBySlug: vi.fn(),
  stateExists: vi.fn(),
  stateFindOne: vi.fn(),
  // Bypasses the cache entirely so these tests exercise the resolution
  // logic itself; cache-hit/miss/invalidation behavior is covered in
  // infrastructure/redis/cache.test.ts.
  cacheGetOrSet: vi.fn((_key: string, _ttl: number, fetcher: () => unknown) =>
    fetcher(),
  ),
  tenantHydrate: vi.fn((doc: unknown) => doc),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
}));

vi.mock("@/modules/setup-center/setup-center.model.js", () => ({
  SetupCenterStateModel: {
    exists: mocks.stateExists,
    findOne: mocks.stateFindOne,
  },
}));

vi.mock("@/infrastructure/redis/cache.js", () => ({
  getOrSetCache: mocks.cacheGetOrSet,
}));

vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { hydrate: mocks.tenantHydrate },
}));

import {
  findPublishedTenantBySlug,
  getTenantPublicationState,
  isTenantPublished,
  requirePublishedTenantBySlug,
  requirePublishedTenantId,
} from "@/modules/setup-center/setup-publication.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";

const tenant = (overrides: Record<string, unknown> = {}) => {
  const fields = {
    _id: TENANT_ID,
    name: "Studio Grohovka",
    slug: "studio-grohovka",
    status: "active",
    ...overrides,
  };
  // A real Mongoose document; findPublishedTenantBySlug calls .toObject()
  // on it before caching the result.
  return { ...fields, toObject: () => fields };
};

describe("Setup Center public publication lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stateFindOne.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve(null),
      }),
    });
  });

  it("returns an active tenant only when its Setup Center state is live", async () => {
    const liveTenant = tenant();
    mocks.getTenantBySlug.mockResolvedValueOnce(liveTenant);
    mocks.stateExists.mockResolvedValueOnce({ _id: "state-id" });

    // The cached/rehydrated result is a reconstruction (see the
    // hydrate/toObject round trip in the source), not the original document
    // reference, so this asserts field equality rather than identity.
    await expect(
      findPublishedTenantBySlug("  STUDIO-GROHOVKA  "),
    ).resolves.toEqual(liveTenant.toObject());

    expect(mocks.getTenantBySlug).toHaveBeenCalledWith("studio-grohovka");
    expect(mocks.stateExists).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      "publication.status": "live",
    });
  });

  it("denies missing, inactive, and draft tenants without revealing which state failed", async () => {
    mocks.getTenantBySlug.mockResolvedValueOnce(null);
    await expect(findPublishedTenantBySlug("missing")).resolves.toBeNull();
    expect(mocks.stateExists).not.toHaveBeenCalled();

    mocks.getTenantBySlug.mockResolvedValueOnce(
      tenant({ status: "suspended" }),
    );
    await expect(findPublishedTenantBySlug("suspended")).resolves.toBeNull();
    expect(mocks.stateExists).not.toHaveBeenCalled();

    mocks.getTenantBySlug.mockResolvedValueOnce(tenant());
    mocks.stateExists.mockResolvedValueOnce(null);
    await expect(
      findPublishedTenantBySlug("studio-grohovka"),
    ).resolves.toBeNull();
  });

  it("uses the same public 404 for an unpublished slug or tenant id", async () => {
    mocks.getTenantBySlug.mockResolvedValueOnce(tenant());
    mocks.stateExists.mockResolvedValue(null);

    await expect(
      requirePublishedTenantBySlug("studio-grohovka"),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
      message: "Workspace not found.",
    });

    await expect(requirePublishedTenantId(TENANT_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
      message: "Workspace not found.",
    });
  });

  it("treats an absent tenant id as unpublished without querying MongoDB", async () => {
    await expect(isTenantPublished(undefined)).resolves.toBe(false);
    expect(mocks.stateExists).not.toHaveBeenCalled();
  });

  it("reports missing legacy state as draft only to authenticated diagnostics", async () => {
    await expect(getTenantPublicationState(TENANT_ID)).resolves.toEqual({
      status: "draft",
      hasExplicitState: false,
    });
    expect(mocks.stateFindOne).toHaveBeenCalledWith({
      tenant: TENANT_ID,
    });
  });

  it.each([
    ["draft", "draft"],
    ["live", "live"],
    ["corrupt", "draft"],
  ] as const)(
    "normalizes an explicit %s publication state to %s",
    async (storedStatus, expectedStatus) => {
      mocks.stateFindOne.mockReturnValueOnce({
        select: () => ({
          lean: () =>
            Promise.resolve({
              publication: { status: storedStatus },
            }),
        }),
      });

      await expect(getTenantPublicationState(TENANT_ID)).resolves.toEqual({
        status: expectedStatus,
        hasExplicitState: true,
      });
    },
  );
});
