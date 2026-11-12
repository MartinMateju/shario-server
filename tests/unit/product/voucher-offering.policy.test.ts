import { describe, expect, it, vi } from "vitest";
import { createProductSchema, voucherSettingsSchema } from "@/modules/product/product.validators.js";
import {
  assertVoucherOfferingDeletable,
  decideVoucherOfferingDeletion,
  getVoucherOfferingDeletionPolicy,
  resolveVoucherOfferingLimit,
  VOUCHER_DELETE_CONFIRMATION,
} from "@/modules/product/voucher-offering.policy.js";
import { getCurrentPlanVersion, getPlanConfig } from "@/modules/tenants/tenant.plan.js";

const deletionModels = vi.hoisted(() => ({
  couponCount: vi.fn((_filter: unknown) => ({ exec: async () => 0 })),
  orderCount: vi.fn((_filter: unknown) => ({ exec: async () => 0 })),
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: { countDocuments: deletionModels.couponCount },
  CouponOrder: { countDocuments: deletionModels.orderCount },
}));

const value = (validity: unknown) => ({ version: 1, type: "value", validity });

describe("voucher offering validity input", () => {
  it.each([3, 6, 8, 12, 17, 120])("accepts %i calendar months", (months) => {
    expect(voucherSettingsSchema.parse(value({ mode: "months", months })).validity).toEqual({ mode: "months", months });
  });
  it.each([0, -1, 1.5, 121])("rejects invalid month duration %i", (months) => {
    expect(voucherSettingsSchema.safeParse(value({ mode: "months", months })).success).toBe(false);
  });
  it("validates real dates, including leap years, and rejects ambiguous mixed policies", () => {
    expect(voucherSettingsSchema.safeParse(value({ mode: "date", date: "2028-02-29" })).success).toBe(true);
    expect(voucherSettingsSchema.safeParse(value({ mode: "date", date: "2027-02-29" })).success).toBe(false);
    expect(voucherSettingsSchema.safeParse(value({ mode: "date", date: "2027-11-31" })).success).toBe(false);
    expect(voucherSettingsSchema.safeParse(value({ mode: "months", months: 12, date: "2030-01-01" })).success).toBe(false);
  });
  it("allows explicit no-expiry and safely parses multipart JSON", () => {
    expect(voucherSettingsSchema.parse(JSON.stringify(value({ mode: "none" }))).validity).toEqual({ mode: "none" });
    expect(voucherSettingsSchema.safeParse("{oops").success).toBe(false);
  });
  it("requires an experience entitlement and rejects mixed money/experience rules", () => {
    const experience = { version: 1, type: "experience", validity: { mode: "months", months: 12 }, experienceProductId: "507f1f77bcf86cd799439020", experienceQuantity: 1 };
    expect(voucherSettingsSchema.safeParse(experience).success).toBe(true);
    expect(voucherSettingsSchema.safeParse({ ...experience, experienceQuantity: undefined }).success).toBe(false);
    expect(voucherSettingsSchema.safeParse({ ...experience, type: "value" }).success).toBe(false);
    expect(voucherSettingsSchema.safeParse({ ...experience, eligibleProductIds: [experience.experienceProductId] }).success).toBe(false);
  });
  it("retains voucher settings in create requests", () => {
    const result = createProductSchema.parse({ name: "Gift", kind: "voucher", label: "Gift", price: 500, voucherSettings: value({ mode: "months", months: 8 }) });
    expect(result.voucherSettings?.validity).toEqual({ mode: "months", months: 8 });
  });
  it("keeps postal delivery opt-in and accepts a free or paid once-per-order fee", () => {
    expect(voucherSettingsSchema.parse(value({ mode: "none" })).physicalDelivery).toBeUndefined();
    for (const postageFeeMinor of [0, 12500]) {
      const physicalDelivery = { enabled: true, postageFeeMinor };
      const parsed = createProductSchema.parse({
        name: "Gift", kind: "voucher", label: "Gift", price: 500,
        voucherSettings: { ...value({ mode: "none" }), physicalDelivery },
      });
      expect(parsed.voucherSettings?.physicalDelivery).toEqual(physicalDelivery);
    }
  });
  it.each([
    { enabled: true }, { enabled: "false", postageFeeMinor: 0 },
    { enabled: true, postageFeeMinor: -1 }, { enabled: true, postageFeeMinor: 1.5 },
    { enabled: true, postageFeeMinor: 100_000_001 },
  ])("rejects invalid postal pricing %j", (physicalDelivery) => {
    expect(voucherSettingsSchema.safeParse({ ...value({ mode: "none" }), physicalDelivery }).success).toBe(false);
  });
});

describe("voucher offering deletion policy", () => {
  const counts = { unexpiredCodeCount: 0, perpetualCodeCount: 0, pendingOrderCount: 0 };
  it("allows deletion when codes are expired or none exist", () => {
    expect(decideVoucherOfferingDeletion(counts).canDelete).toBe(true);
    expect(() => assertVoucherOfferingDeletable(decideVoucherOfferingDeletion(counts))).not.toThrow();
  });
  it("never allows typed confirmation to bypass finite expiry or pending purchase protection", () => {
    for (const blocking of [{ unexpiredCodeCount: 1 }, { pendingOrderCount: 1 }]) {
      const policy = decideVoucherOfferingDeletion({ ...counts, perpetualCodeCount: 1, ...blocking });
      expect(policy.requiresConfirmation).toBe(false);
      expect(() => assertVoucherOfferingDeletable(policy, VOUCHER_DELETE_CONFIRMATION)).toThrow();
    }
  });
  it("excludes completed full refunds from pending-order checks while retaining processing protection", async () => {
    const tenantId = "507f1f77bcf86cd799439011";
    const productId = "507f1f77bcf86cd799439012";
    const policy = await getVoucherOfferingDeletionPolicy({ tenantId, productId });
    expect(policy.canDelete).toBe(true);
    const filter = deletionModels.orderCount.mock.calls.at(-1)![0] as any;
    expect(String(filter.tenant)).toBe(tenantId);
    expect(String(filter.product)).toBe(productId);
    expect(filter.$or).toContainEqual({ isProcessing: true });
    const paymentClauses = filter.$or.filter((clause: any) => !clause.isProcessing);
    expect(paymentClauses).toHaveLength(2);
    for (const clause of paymentClauses) {
      // Only the definitive full-refund state is exempt; manual_review,
      // missing refund state and partial refunds still receive protection.
      expect(clause.refundState).toEqual({ $ne: "revoked" });
    }
  });

  it("requires the exact phrase for perpetual codes", () => {
    const policy = decideVoucherOfferingDeletion({ ...counts, perpetualCodeCount: 2 });
    expect(policy).toMatchObject({ canDelete: false, requiresConfirmation: true, reason: "confirmation_required" });
    for (const phrase of [undefined, "I agree", VOUCHER_DELETE_CONFIRMATION.toLowerCase(), `${VOUCHER_DELETE_CONFIRMATION} `]) {
      expect(() => assertVoucherOfferingDeletable(policy, phrase)).toThrow();
    }
    expect(() => assertVoucherOfferingDeletable(policy, VOUCHER_DELETE_CONFIRMATION)).not.toThrow();
  });
});

describe("voucher quota rollout", () => {
  it.each([["starter", 3], ["professional", 10], ["studio_plus", 25], ["enterprise", null]] as const)("limits newly enrolled %s tenants", (plan, limit) => {
    expect(resolveVoucherOfferingLimit({ plan, voucherQuotaVersion: 1 })).toBe(limit);
  });
  it("preserves existing tenant and subscription contracts", () => {
    for (const plan of ["starter", "professional", "studio_plus", "enterprise"] as const) {
      for (const planVersion of [1, 2, 3]) expect(resolveVoucherOfferingLimit({ plan, planVersion })).toBeNull();
      expect(getCurrentPlanVersion(plan)).toBe(3);
      expect(getPlanConfig(plan, 3).limits).not.toHaveProperty("maxActiveVoucherOfferings");
    }
  });
  it("fails closed for unknown rollout versions", () => {
    expect(() => resolveVoucherOfferingLimit({ plan: "starter", voucherQuotaVersion: 99 })).toThrow();
  });
  it("does not assign new quota rules while hydrating an existing workspace", async () => {
    const { TenantModel } = await import("@/modules/tenants/tenant.model.js");
    const historical = TenantModel.hydrate({ name: "Existing studio", slug: "existing-studio", plan: "starter", planVersion: 3 });
    expect(historical.voucherQuotaVersion).toBeUndefined();
    expect(resolveVoucherOfferingLimit(historical)).toBeNull();
  });

});
