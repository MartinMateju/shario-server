import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  findSubscriptionByTenant: vi.fn(),
  createPendingSubscription: vi.fn(),
  expireElapsedTrials: vi.fn(),
}));
vi.mock("@/modules/tenant-subscription/tenant-subscription.repository.js", () => repository);
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({ getTenantOrThrow: vi.fn() }));
vi.mock("@/modules/tenants/tenant.model.js", () => ({ default: {} }));
vi.mock("@/modules/tenant-subscription/tenant-subscription.schema.js", () => ({ default: {} }));

import { ensureTenantSubscription } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";

const tenantId = "100000000000000000000001";
const subscription = { _id: "500000000000000000000001", tenant: tenantId };

describe("lazy tenant subscription creation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    repository.findSubscriptionByTenant.mockResolvedValue(null);
  });

  it("returns an existing tenant subscription without creating another", async () => {
    repository.findSubscriptionByTenant.mockResolvedValue(subscription);
    expect(await ensureTenantSubscription(tenantId)).toBe(subscription);
    expect(repository.createPendingSubscription).not.toHaveBeenCalled();
  });

  it("creates the subscription when none exists", async () => {
    repository.createPendingSubscription.mockResolvedValue(subscription);
    expect(await ensureTenantSubscription(tenantId)).toBe(subscription);
    expect(repository.createPendingSubscription).toHaveBeenCalledExactlyOnceWith(tenantId, {});
  });

  it.each([
    ["Mongoose's own driver", new mongoose.mongo.MongoServerError({ code: 11000, message: "duplicate tenant" })],
    ["another driver error object", { name: "MongoServerError", code: 11000 }],
  ])("returns the concurrent winner after a duplicate from %s", async (_label, error) => {
    repository.findSubscriptionByTenant.mockResolvedValueOnce(null).mockResolvedValueOnce(subscription);
    repository.createPendingSubscription.mockRejectedValueOnce(error);

    expect(await ensureTenantSubscription(tenantId)).toBe(subscription);
    expect(repository.findSubscriptionByTenant).toHaveBeenNthCalledWith(2, tenantId, {});
    expect(repository.createPendingSubscription).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("connection unavailable"),
    { code: 11001 },
    { code: "11000" },
    null,
  ])("preserves unrelated creation errors: %j", async (error) => {
    repository.createPendingSubscription.mockRejectedValueOnce(error);
    await expect(ensureTenantSubscription(tenantId)).rejects.toBe(error);
    expect(repository.findSubscriptionByTenant).toHaveBeenCalledOnce();
  });

  it("preserves the duplicate error if no tenant-scoped winner can be found", async () => {
    const error = new mongoose.mongo.MongoServerError({ code: 11000, message: "other unique key" });
    repository.createPendingSubscription.mockRejectedValueOnce(error);
    await expect(ensureTenantSubscription(tenantId)).rejects.toBe(error);
    expect(repository.findSubscriptionByTenant).toHaveBeenCalledTimes(2);
  });
});
