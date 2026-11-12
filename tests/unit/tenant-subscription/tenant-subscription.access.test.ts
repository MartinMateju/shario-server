import { describe, expect, it } from "vitest";

import { TENANT_STATUS } from "@/modules/tenants/tenant.constants.js";
import { getSubscriptionAccess } from "@/modules/tenant-subscription/tenant-subscription.access.js";
import {
  SUBSCRIPTION_ACCESS_MODE,
  TENANT_SUBSCRIPTION_STATUS,
} from "@/modules/tenant-subscription/tenant-subscription.constants.js";
import type { TenantSubscriptionDocument } from "@/modules/tenant-subscription/tenant-subscription.types.js";

const now = new Date("2026-07-19T12:00:00.000Z");

const subscription = (
  overrides: Partial<TenantSubscriptionDocument>,
): TenantSubscriptionDocument =>
  ({
    status: TENANT_SUBSCRIPTION_STATUS.PENDING,
    cancelAtPeriodEnd: false,
    stripe: {},
    ...overrides,
  }) as TenantSubscriptionDocument;

describe("getSubscriptionAccess", () => {
  it("keeps pending workspaces inside onboarding", () => {
    const access = getSubscriptionAccess({
      tenantStatus: TENANT_STATUS.ACTIVE,
      subscription: subscription({}),
      now,
    });

    expect(access).toMatchObject({
      mode: SUBSCRIPTION_ACCESS_MODE.SETUP,
      canUseFeatures: false,
      reason: "onboarding",
    });
  });

  it("allows an active trial and reports whole remaining days", () => {
    const access = getSubscriptionAccess({
      tenantStatus: TENANT_STATUS.ACTIVE,
      subscription: subscription({
        status: TENANT_SUBSCRIPTION_STATUS.TRIALING,
        trialEndsAt: new Date("2026-07-21T11:00:00.000Z"),
      }),
      now,
    });

    expect(access).toMatchObject({
      mode: SUBSCRIPTION_ACCESS_MODE.FULL,
      canUseFeatures: true,
      remainingTrialDays: 2,
    });
  });

  it("restricts an elapsed trial", () => {
    const access = getSubscriptionAccess({
      tenantStatus: TENANT_STATUS.ACTIVE,
      subscription: subscription({
        status: TENANT_SUBSCRIPTION_STATUS.TRIALING,
        trialEndsAt: new Date("2026-07-19T11:59:59.000Z"),
      }),
      now,
    });

    expect(access).toMatchObject({
      mode: SUBSCRIPTION_ACCESS_MODE.RESTRICTED,
      canUseFeatures: false,
      reason: "trial_expired",
    });
  });

  it("allows past-due access only during the grace period", () => {
    const inGrace = getSubscriptionAccess({
      tenantStatus: TENANT_STATUS.ACTIVE,
      subscription: subscription({
        status: TENANT_SUBSCRIPTION_STATUS.PAST_DUE,
        graceEndsAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
      now,
    });
    const afterGrace = getSubscriptionAccess({
      tenantStatus: TENANT_STATUS.ACTIVE,
      subscription: subscription({
        status: TENANT_SUBSCRIPTION_STATUS.PAST_DUE,
        graceEndsAt: new Date("2026-07-19T11:00:00.000Z"),
      }),
      now,
    });

    expect(inGrace.mode).toBe(SUBSCRIPTION_ACCESS_MODE.GRACE);
    expect(inGrace.canUseFeatures).toBe(true);
    expect(afterGrace.mode).toBe(SUBSCRIPTION_ACCESS_MODE.RESTRICTED);
    expect(afterGrace.canUseFeatures).toBe(false);
  });

  it("blocks suspended tenants even with an active subscription", () => {
    const access = getSubscriptionAccess({
      tenantStatus: TENANT_STATUS.SUSPENDED,
      subscription: subscription({
        status: TENANT_SUBSCRIPTION_STATUS.ACTIVE,
      }),
      now,
    });

    expect(access.mode).toBe(SUBSCRIPTION_ACCESS_MODE.BLOCKED);
    expect(access.canUseFeatures).toBe(false);
  });
});
