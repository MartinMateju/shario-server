import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRODUCT_KIND } from "@/modules/product/product-kind-v2.contract.js";
import { isProductKindEntitledForTenant } from "@/modules/product/product-plan-entitlements.js";
import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";

const source = (relativeUrl: string) =>
  readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");

describe("V3 product capability enforcement", () => {
  it("blocks only Open Studio for Starter while preserving classes and V2", () => {
    expect(
      isProductKindEntitledForTenant({
        tenant: { plan: TENANT_PLAN.STARTER, planVersion: 3 },
        kind: PRODUCT_KIND.OPEN_STUDIO,
      }),
    ).toBe(false);
    expect(
      isProductKindEntitledForTenant({
        tenant: { plan: TENANT_PLAN.STARTER, planVersion: 3 },
        kind: PRODUCT_KIND.CLASS,
      }),
    ).toBe(true);
    expect(
      isProductKindEntitledForTenant({
        tenant: { plan: TENANT_PLAN.STARTER, planVersion: 2 },
        kind: PRODUCT_KIND.OPEN_STUDIO,
      }),
    ).toBe(true);
    expect(
      isProductKindEntitledForTenant({
        tenant: { plan: TENANT_PLAN.PROFESSIONAL, planVersion: 3 },
        kind: PRODUCT_KIND.OPEN_STUDIO,
      }),
    ).toBe(true);
  });

  it("preserves legacy behavior when a tenant projection omits its plan", () => {
    expect(
      isProductKindEntitledForTenant({
        tenant: {},
        kind: PRODUCT_KIND.OPEN_STUDIO,
      }),
    ).toBe(true);
    expect(
      isProductKindEntitledForTenant({
        tenant: { planVersion: 3 },
        kind: PRODUCT_KIND.OPEN_STUDIO,
      }),
    ).toBe(true);

    expect(
      isProductKindEntitledForTenant({
        tenant: { plan: TENANT_PLAN.STARTER, planVersion: 3 },
        kind: PRODUCT_KIND.OPEN_STUDIO,
      }),
    ).toBe(false);
  });

  it("checks product management, booking intent and all three checkout paths", () => {
    const productService = source(
      "../../../src/modules/product/services/product.service.ts",
    );
    const bookingIntentService = source(
      "../../../src/modules/booking-intent/booking-intent.service.ts",
    );
    const checkoutService = source(
      "../../../src/modules/checkout/services/checkout.service.ts",
    );

    expect(productService).toContain("assertProductKindEntitledForTenant");
    expect(bookingIntentService).toContain(
      "assertProductKindEntitledForTenant({ tenant, kind: productKind",
    );
    // Check each payment entry point independently: an additional guard in a
    // shared quote helper must not hide a missing guard in another path.
    const checkoutPaths = [
      "const quoteAuthenticatedCartTotal = async",
      "async quoteVoucherCheckout(",
      "async createStripeCheckout(",
      "async checkoutWithCredits(",
    ];
    for (const [index, entryPoint] of checkoutPaths.entries()) {
      const start = checkoutService.indexOf(entryPoint);
      expect(start, entryPoint).toBeGreaterThanOrEqual(0);
      const nextEntryPoint = checkoutPaths[index + 1];
      const end = nextEntryPoint
        ? checkoutService.indexOf(nextEntryPoint, start)
        : checkoutService.length;
      expect(end, entryPoint).toBeGreaterThan(start);
      expect(checkoutService.slice(start, end), entryPoint).toContain(
        "assertProductsEntitledForTenant({ tenant, products: dbProducts })",
      );
    }
  });
});
