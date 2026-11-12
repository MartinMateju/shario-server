import type { NextFunction, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantSubscriptionAccess: vi.fn(),
  requireTenantId: vi.fn(() => "507f1f77bcf86cd799439011"),
}));

vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: mocks.requireTenantId,
}));

vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);

import type { AuthenticatedRequest } from "@/modules/auth/auth.types.js";
import { requireTenantSubscriptionAccess } from "@/modules/tenant-subscription/middleware/requireTenantSubscriptionAccess.js";

describe("requireTenantSubscriptionAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates the checked tenant for downstream module guards", async () => {
    const tenant = {
      _id: "507f1f77bcf86cd799439011",
      slug: "studio-grohovka",
      modules: {
        payments: true,
        courses: true,
      },
    };
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce({
      tenant,
      subscription: {},
      access: { canUseFeatures: true },
    });

    const req = {} as AuthenticatedRequest;
    const next = vi.fn();

    await requireTenantSubscriptionAccess(
      req,
      {} as Response,
      next as NextFunction,
    );

    expect(mocks.getTenantSubscriptionAccess).toHaveBeenCalledWith(
      "507f1f77bcf86cd799439011",
    );
    expect(req.tenant).toBe(tenant);
    expect(next).toHaveBeenCalledWith();
  });

  it("does not hydrate or continue when feature access is restricted", async () => {
    const tenant = {
      _id: "507f1f77bcf86cd799439011",
      modules: { payments: true },
    };
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce({
      tenant,
      subscription: {},
      access: {
        canUseFeatures: false,
        reason: "past_due",
      },
    });

    const req = {} as AuthenticatedRequest;
    const next = vi.fn();

    await requireTenantSubscriptionAccess(
      req,
      {} as Response,
      next as NextFunction,
    );

    expect(req.tenant).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 403,
      code: "TENANT_SUBSCRIPTION_REQUIRED",
    });
  });
});
