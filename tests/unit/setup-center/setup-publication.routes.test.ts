import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("public publication route coverage", () => {
  it("guards voucher sales and opt-in guest course checkout while preserving historical status access", () => {
    const checkout = source(
      "../../../src/modules/checkout/checkout.public.routes.ts",
    );
    const commerceBoundary = checkout.match(
      /publicTenantCommerceRouter\.use\(\s*"\/tenants\/:tenantSlug",\s*publicTenantLookupLimiter,\s*loadPublishedTenant,\s*requirePublicCommerceSubscription,\s*\);/,
    );
    const guestCheckout = checkout.match(
      /publicTenantCommerceRouter\.post\(\s*"\/tenants\/:tenantSlug\/checkout\/guest",([\s\S]*?)\n\);/,
    );

    expect(commerceBoundary).not.toBeNull();
    expect(guestCheckout).not.toBeNull();
    const boundaryIndex = commerceBoundary!.index!;
    const historicalStatusIndex = checkout.indexOf(
      '"/tenants/:tenantSlug/checkout/guest/orders/:orderId/status"',
    );
    expect(historicalStatusIndex).toBeGreaterThan(-1);
    expect(historicalStatusIndex).toBeLessThan(boundaryIndex);
    expect(guestCheckout!.index).toBeGreaterThan(boundaryIndex);
    expect(guestCheckout![1]).toMatch(
      /voucherPurchaseResponseHeaders,\s*publicCommerceMutationLimiter,\s*requireModules\("payments",\s*"courses"\),/,
    );
    expect(guestCheckout![1]).toMatch(
      /if\s*\(!req\.tenant\s*\|\|\s*!isGuestCourseCheckoutEnabled\(req\.tenant\)\)\s*\{[\s\S]*?res\.status\(404\)[\s\S]*?GUEST_COURSE_CHECKOUT_UNAVAILABLE[\s\S]*?return;\s*\}\s*next\(\);/,
    );
    expect(guestCheckout![1]).toMatch(/sendGuestCourseCheckout,\s*$/);
    expect(
      checkout.indexOf('"/tenants/:tenantSlug/vouchers/products"'),
    ).toBeGreaterThan(boundaryIndex);
    expect(
      checkout.indexOf('"/tenants/:tenantSlug/vouchers/checkout"'),
    ).toBeGreaterThan(boundaryIndex);
  });

  it("guards both current and legacy public membership catalogs", () => {
    const memberships = source(
      "../../../src/modules/membership/routes/membership.routes.ts",
    );

    expect(memberships).toMatch(
      /"\/tenants\/:tenantSlug\/memberships",[\s\S]*?loadPublishedTenant,[\s\S]*?getPublicMembershipCatalog/,
    );
    expect(memberships).toMatch(
      /"\/tenants\/:tenantSlug\/membership-plans",[\s\S]*?loadPublishedTenant,[\s\S]*?getPublicMembershipCatalog/,
    );
  });

  it("guards public concierge discovery and messages", () => {
    const ai = source("../../../src/modules/ai/ai.routes.ts");

    expect(ai).toMatch(
      /"\/tenants\/:tenantSlug\/ai\/concierge\/config",[\s\S]*?loadPublishedTenant,[\s\S]*?publicConciergeConfig/,
    );
    expect(ai).toMatch(
      /"\/tenants\/:tenantSlug\/ai\/concierge",[\s\S]*?loadPublishedTenant,[\s\S]*?publicConcierge/,
    );
  });

  it("mounts public tenant configuration outside the authenticated subscription boundary", () => {
    const routes = source("../../../src/app/routes.ts");
    const publicConfig = routes.indexOf(
      'apiRouter.use("/public", publicTenantRouter);',
    );
    const subscriptionBoundary = routes.indexOf(
      "apiRouter.use(verifyJWT, requireTenantSubscriptionAccess);",
    );

    expect(publicConfig).toBeGreaterThan(-1);
    expect(subscriptionBoundary).toBeGreaterThan(publicConfig);
  });
});
