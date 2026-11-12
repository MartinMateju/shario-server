import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPEN_STUDIO_BOOKING_POLICY,
  OPEN_STUDIO_BOOKING_MODE,
  PRODUCT_KIND,
  PRODUCT_KIND_CAPABILITIES,
  PRODUCT_KIND_CONTRACT_VERSION,
  PRODUCT_KIND_MANUAL_REVIEW_REASON,
  PRODUCT_KINDS,
  getLegacyCompatibilityTypeForKind,
  resolveLegacyProductTypeV2,
  resolveOpenStudioBookingModeV2,
} from "@/modules/product/product-kind-v2.contract.js";
import { planProductKindV2Migration } from "@/modules/product/product-kind-v2.migration.js";

describe("product kind V2 contract", () => {
  it("exposes exactly the five canonical tenant-facing kinds", () => {
    expect(PRODUCT_KIND_CONTRACT_VERSION).toBe(2);
    expect(PRODUCT_KINDS).toEqual([
      "open-studio",
      "class",
      "membership",
      "voucher",
      "private-studio",
    ]);
  });

  it("keeps Private Studio internal and separate from Open Studio privacy", () => {
    expect(PRODUCT_KIND_CAPABILITIES[PRODUCT_KIND.PRIVATE_STUDIO]).toEqual({
      customerBookable: false,
      sellable: false,
      internalOnly: true,
      supportsOpenStudioBookingMode: false,
    });
    expect(PRODUCT_KIND_CAPABILITIES[PRODUCT_KIND.OPEN_STUDIO]).toMatchObject({
      customerBookable: true,
      sellable: true,
      internalOnly: false,
      supportsOpenStudioBookingMode: true,
    });

    expect(
      resolveOpenStudioBookingModeV2({
        kind: PRODUCT_KIND.PRIVATE_STUDIO,
        bookingMode: "private",
      }),
    ).toBeNull();
    expect(
      resolveOpenStudioBookingModeV2({
        kind: PRODUCT_KIND.OPEN_STUDIO,
        bookingMode: "private",
      }),
    ).toBe(OPEN_STUDIO_BOOKING_MODE.PRIVATE);
  });

  it("maps every unambiguous class and voucher legacy value", () => {
    for (const type of ["course", "public-course", "private-course", "class"]) {
      expect(resolveLegacyProductTypeV2(type)).toEqual({
        status: "mapped",
        kind: PRODUCT_KIND.CLASS,
      });
    }

    for (const type of ["coupon", "gift-card", "voucher"]) {
      expect(resolveLegacyProductTypeV2(type)).toEqual({
        status: "mapped",
        kind: PRODUCT_KIND.VOUCHER,
      });
    }
  });

  it("maps workshop variants to Open Studio with explicit mode policy", () => {
    expect(resolveLegacyProductTypeV2("workshop")).toEqual({
      status: "mapped",
      kind: PRODUCT_KIND.OPEN_STUDIO,
      openStudioBookingPolicy: DEFAULT_OPEN_STUDIO_BOOKING_POLICY,
    });
    expect(resolveLegacyProductTypeV2("public-workshop")).toMatchObject({
      status: "mapped",
      kind: PRODUCT_KIND.OPEN_STUDIO,
      openStudioBookingPolicy: {
        allowedModes: [OPEN_STUDIO_BOOKING_MODE.PUBLIC],
        defaultMode: OPEN_STUDIO_BOOKING_MODE.PUBLIC,
      },
    });
    expect(resolveLegacyProductTypeV2("private-workshop")).toMatchObject({
      status: "mapped",
      // A private booking is not the internal Private Studio product.
      kind: PRODUCT_KIND.OPEN_STUDIO,
      openStudioBookingPolicy: {
        allowedModes: [OPEN_STUDIO_BOOKING_MODE.PRIVATE],
        defaultMode: OPEN_STUDIO_BOOKING_MODE.PRIVATE,
      },
    });
    expect(resolveLegacyProductTypeV2("blocker")).toEqual({
      status: "mapped",
      kind: PRODUCT_KIND.PRIVATE_STUDIO,
    });
  });

  it("requires manual review for ambiguous services and generic passes", () => {
    expect(resolveLegacyProductTypeV2("service")).toEqual({
      status: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.SERVICE_USAGE_AMBIGUOUS,
    });
    expect(resolveLegacyProductTypeV2("membership")).toEqual({
      status: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.GENERIC_MEMBERSHIP_REQUIRES_PLAN_MIGRATION,
    });
    expect(resolveLegacyProductTypeV2("credit-pack")).toEqual({
      status: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.CREDIT_PACK_REQUIRES_PLAN_MIGRATION,
    });
  });

  it("leaves operational products outside the tenant-facing taxonomy", () => {
    for (const type of [
      "booking-addon",
      "guest-increase",
      "prolong",
      "system",
    ]) {
      expect(resolveLegacyProductTypeV2(type)).toEqual({
        status: "system-owned",
        reason: "system-owned-product",
      });
    }
  });

  it("supports an additive bookingMode field with bookingType fallback", () => {
    expect(
      resolveOpenStudioBookingModeV2({
        kind: "open-studio",
        bookingMode: "PUBLIC",
        bookingType: "private",
      }),
    ).toBe("public");
    expect(
      resolveOpenStudioBookingModeV2({
        kind: "open-studio",
        bookingType: "private",
      }),
    ).toBe("private");
    expect(
      resolveOpenStudioBookingModeV2({
        kind: "class",
        bookingType: "private",
      }),
    ).toBeNull();
  });

  it("projects only Product-backed kinds to old client types", () => {
    expect(getLegacyCompatibilityTypeForKind("open-studio")).toBe("workshop");
    expect(getLegacyCompatibilityTypeForKind("class")).toBe("course");
    expect(getLegacyCompatibilityTypeForKind("voucher")).toBe("coupon");
    expect(getLegacyCompatibilityTypeForKind("private-studio")).toBe("blocker");
    expect(getLegacyCompatibilityTypeForKind("membership")).toBeNull();
  });
});

describe("product kind V2 migration planner", () => {
  it("creates an additive patch without mutating legacy type", () => {
    const plan = planProductKindV2Migration({
      _id: "product-1",
      type: "course",
    });

    expect(plan).toEqual({
      action: "update",
      patch: {
        kind: PRODUCT_KIND.CLASS,
        kindContractVersion: PRODUCT_KIND_CONTRACT_VERSION,
      },
    });
    expect(plan).not.toHaveProperty("patch.type");
  });

  it("carries the safe fixed Open Studio mode into the migration patch", () => {
    expect(
      planProductKindV2Migration({
        _id: "product-generic-workshop",
        type: "workshop",
      }),
    ).toMatchObject({
      action: "update",
      patch: {
        kind: PRODUCT_KIND.OPEN_STUDIO,
        bookingMode: OPEN_STUDIO_BOOKING_MODE.PUBLIC,
      },
    });

    expect(
      planProductKindV2Migration({
        _id: "product-2",
        type: "private-workshop",
      }),
    ).toMatchObject({
      action: "update",
      patch: {
        kind: PRODUCT_KIND.OPEN_STUDIO,
        bookingMode: OPEN_STUDIO_BOOKING_MODE.PRIVATE,
      },
    });
  });

  it("does not replace a previously authored Open Studio mode", () => {
    const plan = planProductKindV2Migration({
      _id: "product-3",
      type: "workshop",
      bookingMode: "private",
    });

    expect(plan).toEqual({
      action: "update",
      patch: {
        kind: PRODUCT_KIND.OPEN_STUDIO,
        kindContractVersion: PRODUCT_KIND_CONTRACT_VERSION,
      },
    });
  });

  it("does not silently preserve an invalid Open Studio mode", () => {
    expect(
      planProductKindV2Migration({
        _id: "product-invalid-mode",
        type: "workshop",
        bookingMode: "shared-ish",
      }),
    ).toEqual({
      action: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.INVALID_OPEN_STUDIO_BOOKING_MODE,
    });
  });

  it("is idempotent for an already matching canonical kind", () => {
    expect(
      planProductKindV2Migration({
        _id: "product-4",
        type: "workshop",
        kind: "open-studio",
        kindContractVersion: 2,
        bookingMode: "public",
      }),
    ).toEqual({
      action: "already-migrated",
      kind: PRODUCT_KIND.OPEN_STUDIO,
    });

    const source = { _id: "product-round-trip", type: "private-workshop" };
    const firstPlan = planProductKindV2Migration(source);
    expect(firstPlan.action).toBe("update");
    if (firstPlan.action !== "update") return;

    expect(
      planProductKindV2Migration({ ...source, ...firstPlan.patch }),
    ).toEqual({
      action: "already-migrated",
      kind: PRODUCT_KIND.OPEN_STUDIO,
    });
  });

  it("reports invalid and conflicting pre-existing kinds without overwrite", () => {
    expect(
      planProductKindV2Migration({
        _id: "product-5",
        type: "course",
        kind: "event",
      }),
    ).toEqual({
      action: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.INVALID_EXISTING_KIND,
    });
    expect(
      planProductKindV2Migration({
        _id: "product-noncanonical-kind",
        type: "course",
        kind: " Class ",
      }),
    ).toEqual({
      action: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.INVALID_EXISTING_KIND,
    });
    expect(
      planProductKindV2Migration({
        _id: "product-6",
        type: "private-workshop",
        kind: "private-studio",
      }),
    ).toEqual({
      action: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.EXISTING_KIND_CONFLICT,
    });
  });

  it("reports incomplete or misplaced booking modes for manual review", () => {
    expect(
      planProductKindV2Migration({
        _id: "open-studio-without-mode",
        type: "workshop",
        kind: "open-studio",
      }),
    ).toEqual({
      action: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.MISSING_OPEN_STUDIO_BOOKING_MODE,
    });
    expect(
      planProductKindV2Migration({
        _id: "class-with-mode",
        type: "course",
        kind: "class",
        bookingMode: "public",
      }),
    ).toEqual({
      action: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.UNEXPECTED_OPEN_STUDIO_BOOKING_MODE,
    });
  });

  it("keeps manual-review and system-owned records out of writes", () => {
    expect(
      planProductKindV2Migration({ _id: "service", type: "service" }),
    ).toEqual({
      action: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.SERVICE_USAGE_AMBIGUOUS,
    });
    expect(
      planProductKindV2Migration({ _id: "pass", type: "membership" }),
    ).toEqual({
      action: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.GENERIC_MEMBERSHIP_REQUIRES_PLAN_MIGRATION,
    });
    expect(
      planProductKindV2Migration({
        _id: "pre-labelled-pass",
        type: "membership",
        kind: "membership",
      }),
    ).toEqual({
      action: "manual-review",
      reason:
        PRODUCT_KIND_MANUAL_REVIEW_REASON.GENERIC_MEMBERSHIP_REQUIRES_PLAN_MIGRATION,
    });
    expect(
      planProductKindV2Migration({ _id: "addon", type: "guest-increase" }),
    ).toEqual({
      action: "system-owned",
      reason: "system-owned-product",
    });
    expect(
      planProductKindV2Migration({
        _id: "pre-labelled-addon",
        type: "guest-increase",
        kind: "voucher",
      }),
    ).toEqual({
      action: "manual-review",
      reason: PRODUCT_KIND_MANUAL_REVIEW_REASON.EXISTING_KIND_CONFLICT,
    });
  });
});
