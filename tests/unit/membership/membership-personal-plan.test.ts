import { describe, expect, it } from "vitest";
import { createMembershipPlanSchema, membershipVersionConfigSchema } from "@/modules/membership/membership.validators.js";
import { membershipAllowsLocation } from "@/modules/membership/membership.location-policy.js";
import MembershipPlanVersion from "@/modules/membership/membership-plan-version.model.js";
import { validatedMembershipVersion } from "@/modules/membership/services/membership-plan.service.js";
import { periodEndFromBilling } from "@/modules/membership/services/user-membership.service.js";

const grohova = "507f1f77bcf86cd799439011";
const vaclavska = "507f1f77bcf86cd799439012";
const another = "507f1f77bcf86cd799439013";
const hours = { key: "studio_hours", label: "Studio hours", type: "allowance", unit: "minute", quantity: 1800, usageScope: "open_studio", memberOnly: true, rolloverPercent: 25 };
const plan = () => ({
  name: "Profi", prices: [{ currency: "CZK", amountMinor: 460000 }],
  billing: { type: "recurring", interval: "month", intervalCount: 1 },
  locationScope: { type: "shared_selected", locationIds: [grohova, vaclavska] }, benefits: [hours],
});

describe("personal membership plan contract", () => {
  it("persists a common 30-hour pool for both studios without a purchased location", async () => {
    const input = createMembershipPlanSchema.parse(plan());
    const version = new MembershipPlanVersion({ ...input, tenant: grohova, plan: another, version: 1 });
    await expect(version.validate()).resolves.toBeUndefined();
    const stored = validatedMembershipVersion(version);
    expect(stored.benefits[0]).toMatchObject(hours);
    const membership = { selectedLocation: null, planSnapshot: stored };
    expect(membershipAllowsLocation(membership, grohova)).toBe(true);
    expect(membershipAllowsLocation(membership, vaclavska)).toBe(true);
    expect(membershipAllowsLocation(membership, another)).toBe(false);
    expect(membershipAllowsLocation(membership)).toBe(false);
  });

  it.each([26, -1, 12.5])("rejects unsupported rollover percentage %s", (rolloverPercent) => {
    expect(createMembershipPlanSchema.safeParse({ ...plan(), benefits: [{ ...hours, rolloverPercent }] }).success).toBe(false);
  });

  it.each([
    { type: "fixed", durationDays: 30 },
    { type: "recurring", interval: "year", intervalCount: 1 },
    { type: "recurring", interval: "month", intervalCount: 2 },
  ])("does not accept monthly carryover with incompatible billing %j", (billing) => {
    expect(membershipVersionConfigSchema.safeParse({ ...plan(), billing }).success).toBe(false);
    expect(() => validatedMembershipVersion({ ...plan(), billing })).toThrow();
  });

  it.each([{ memberOnly: false }, { usageScope: undefined }, { expiresAfterDays: 60 }, { unit: "credit" }])(
    "rejects unsupported hour contract %j", (override) => {
      expect(createMembershipPlanSchema.safeParse({ ...plan(), benefits: [{ ...hours, ...override }] }).success).toBe(false);
    },
  );

  it("requires personal course scope for selected course discounts", () => {
    const discount = { key: "courses", label: "Courses", type: "percentage", appliesTo: "products", productScope: "courses", memberOnly: true, percentageBps: 1000, eligibleProductIds: [another] };
    expect(createMembershipPlanSchema.safeParse({ ...plan(), benefits: [hours, discount] }).success).toBe(true);
    expect(createMembershipPlanSchema.safeParse({ ...plan(), benefits: [{ ...discount, memberOnly: undefined }] }).success).toBe(false);
    expect(createMembershipPlanSchema.safeParse({ ...plan(), benefits: [{ ...discount, eligibleProductIds: [another, another] }] }).success).toBe(false);
  });

  it("retains the existing single-location choice for older selected plans", () => {
    const membership = { selectedLocation: grohova, planSnapshot: { locationScope: { type: "selected", locationIds: [grohova, vaclavska] } } };
    expect(membershipAllowsLocation(membership, grohova)).toBe(true);
    expect(membershipAllowsLocation(membership, vaclavska)).toBe(false);
  });

  it("ends monthly and yearly grants on the last valid day instead of skipping February", () => {
    expect(periodEndFromBilling({ type: "recurring", interval: "month", intervalCount: 1 }, new Date("2027-01-31T10:00:00Z")).toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(periodEndFromBilling({ type: "recurring", interval: "year", intervalCount: 1 }, new Date("2028-02-29T10:00:00Z")).toISOString()).toBe("2029-02-28T10:00:00.000Z");
  });
});
