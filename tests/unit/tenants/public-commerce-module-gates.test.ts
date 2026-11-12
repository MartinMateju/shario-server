import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../src/${relativePath}`, import.meta.url)),
    "utf8",
  );

describe("public and legacy commerce effective-module gates", () => {
  it("requires subscription, memberships, and payments for public membership catalogs", () => {
    const membershipRoutes = source(
      "modules/membership/routes/membership.routes.ts",
    );

    for (const path of ["memberships", "membership-plans"]) {
      const route = membershipRoutes.match(
        new RegExp(
          `publicMembershipRouter\\.get\\([\\s\\S]*?${path}[\\s\\S]*?getPublicMembershipCatalog`,
        ),
      )?.[0];

      expect(route).toContain("requirePublicProductSubscription");
      expect(route).toContain(
        "requirePublicProductModule(TENANT_MODULE.MEMBERSHIPS)",
      );
      expect(route).toContain(
        "requirePublicProductModule(TENANT_MODULE.PAYMENTS)",
      );
    }
  });

  it("requires payments only for the legacy voucher checkout mutation", () => {
    const couponRoutes = source("modules/coupon/routes/coupon.routes.ts");

    expect(couponRoutes).toMatch(
      /router\.post\([\s\S]*?"\/checkout"[\s\S]*?verifyJWT,[\s\S]*?requireCustomerSession,[\s\S]*?paymentsModule,[\s\S]*?sendCouponCheckout/,
    );
    expect(couponRoutes).toMatch(
      /router\.get\([\s\S]*?"\/products"[\s\S]*?verifyJWT,[\s\S]*?requireCustomerSession,[\s\S]*?getCoupons/,
    );
    expect(couponRoutes).toMatch(
      /customerCouponRouter\.get\([\s\S]*?"\/redeem"[\s\S]*?verifyJWT,[\s\S]*?requireCustomerSession,[\s\S]*?getUserRedeemedCoupons/,
    );
    expect(couponRoutes).toMatch(
      /customerCouponRouter\.post\([\s\S]*?"\/redeem"[\s\S]*?verifyJWT,[\s\S]*?requireCustomerSession,[\s\S]*?applyCouponPromoCode/,
    );
    expect(couponRoutes).not.toContain('router.get("/redeem"');
    expect(couponRoutes).not.toContain('router.post("/redeem"');
  });
});
