import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Only the DB-touching boundary is mocked (tenant lookup + subscription
 * lookup) and Redis itself. TenantModel/TenantSubscriptionModel are the
 * real Mongoose models — hydrate() and toObject() don't need a live
 * connection, and using them for real is what makes this test able to
 * catch a serialization bug (see the Date-field test below), not just a
 * mock that always agrees with itself.
 */

const mocks = vi.hoisted(() => ({
  getTenantOrThrow: vi.fn(),
  findSubscriptionByTenant: vi.fn(),
  createPendingSubscription: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));

vi.mock(
  "../../../src/modules/tenant-subscription/tenant-subscription.repository.js",
  () => ({
    findSubscriptionByTenant: mocks.findSubscriptionByTenant,
    createPendingSubscription: mocks.createPendingSubscription,
    expireElapsedTrials: vi.fn(),
  }),
);

vi.mock("@/infrastructure/redis/redis.js", () => ({
  redisConnection: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  getTenantSubscriptionAccess,
  tenantSubscriptionAccessCacheKey,
} from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import TenantSubscriptionModel from "@/modules/tenant-subscription/tenant-subscription.schema.js";

const TENANT_ID = "507f1f77bcf86cd799439011";

const buildTenant = () =>
  new TenantModel({
    _id: TENANT_ID,
    name: "Studio Grohovka",
    slug: "studio-grohovka",
    status: "active",
  });

const buildSubscription = (overrides: Record<string, unknown> = {}) =>
  new TenantSubscriptionModel({
    tenant: TENANT_ID,
    status: "trialing",
    trialStartedAt: new Date("2099-01-01T00:00:00.000Z"),
    trialEndsAt: new Date("2099-01-15T00:00:00.000Z"),
    ...overrides,
  });

describe("getTenantSubscriptionAccess caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantOrThrow.mockResolvedValue(buildTenant());
    mocks.findSubscriptionByTenant.mockResolvedValue(buildSubscription());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves from the database on a cache miss and stores the result", async () => {
    mocks.redisGet.mockResolvedValueOnce(null);
    mocks.redisSet.mockResolvedValueOnce("OK");

    const result = await getTenantSubscriptionAccess(TENANT_ID);

    expect(result.access.mode).toBe("full");
    expect(result.access.canUseFeatures).toBe(true);
    expect(mocks.getTenantOrThrow).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.redisSet).toHaveBeenCalledWith(
      tenantSubscriptionAccessCacheKey(TENANT_ID),
      expect.any(String),
      "EX",
      expect.any(Number),
    );
  });

  it("serves a cache hit without touching the database", async () => {
    const cachedPayload = JSON.stringify({
      tenant: buildTenant().toObject(),
      subscription: buildSubscription().toObject(),
      access: {
        mode: "full",
        canUseFeatures: true,
        reason: "trialing",
        remainingTrialDays: 5,
      },
    });
    mocks.redisGet.mockResolvedValueOnce(cachedPayload);

    const result = await getTenantSubscriptionAccess(TENANT_ID);

    expect(result.access.remainingTrialDays).toBe(5);
    expect(mocks.getTenantOrThrow).not.toHaveBeenCalled();
    expect(mocks.findSubscriptionByTenant).not.toHaveBeenCalled();
  });

  it("rehydrates subscription period fields as real Date instances after a cache hit, not ISO strings", async () => {
    // Regression test: an earlier version of this cache only rehydrated the
    // tenant document, leaving `subscription` as the plain object produced
    // by the JSON round trip. Several callers (ai-usage.service.ts,
    // communication-email-allowance.service.ts) call .getTime()/.toISOString()
    // directly on subscription.trialEndsAt/currentPeriodStart, which throws
    // on a plain ISO string.
    const cachedPayload = JSON.stringify({
      tenant: buildTenant().toObject(),
      subscription: buildSubscription().toObject(),
      access: {
        mode: "full",
        canUseFeatures: true,
        reason: "trialing",
        remainingTrialDays: 5,
      },
    });
    mocks.redisGet.mockResolvedValueOnce(cachedPayload);

    const result = await getTenantSubscriptionAccess(TENANT_ID);

    expect(result.subscription.trialEndsAt).toBeInstanceOf(Date);
    expect(result.subscription.trialStartedAt).toBeInstanceOf(Date);
    // Would throw synchronously if trialEndsAt were still a string.
    expect(() => result.subscription.trialEndsAt.getTime()).not.toThrow();
    expect(result.tenant).toBeInstanceOf(TenantModel);
  });

  it("falls back to the database when the cached payload is malformed", async () => {
    mocks.redisGet.mockResolvedValueOnce("{not-json");
    mocks.redisSet.mockResolvedValueOnce("OK");

    const result = await getTenantSubscriptionAccess(TENANT_ID);

    expect(mocks.getTenantOrThrow).toHaveBeenCalledOnce();
    expect(result.access.mode).toBe("full");
  });
});
