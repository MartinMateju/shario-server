import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { publicSubscriptionCatalogRouter } from "@/modules/tenant-subscription/routes/tenant-subscription.public.routes.js";
import { PLATFORM_BILLING_CURRENCIES } from "@/shared/money/currency.js";
import { INTERNATIONAL_OFFER_ID } from "@/modules/tenant-subscription/tenant-subscription.prices.js";
import { checkoutSchema } from "@/modules/tenant-subscription/tenant-subscription.validators.js";

describe("public subscription catalogue", () => {
  const app = express();
  app.use("/public", publicSubscriptionCatalogRouter);

  it("returns configured prices without authentication, tenant, or Stripe credentials", async () => {
    const response = await request(app)
      .get("/public/subscription-catalog")
      .expect(200);
    expect(response.body).toMatchObject({
      offerId: INTERNATIONAL_OFFER_ID,
      currencies: PLATFORM_BILLING_CURRENCIES,
      availableCurrencies: PLATFORM_BILLING_CURRENCIES,
      defaultCurrency: "USD",
    });
    const starter = response.body.plans.find(
      (plan: { id: string }) => plan.id === "starter",
    );
    expect(starter.monthly.EUR).toEqual({
      amountMinor: 3900,
      available: true,
      type: "fixed",
    });
    expect(starter.yearly.CZK).toEqual({
      amountMinor: 990000,
      available: true,
      type: "fixed",
    });
    const monthlyAmounts = {
      EUR: 3_900,
      USD: 4_500,
      CZK: 99_000,
      GBP: 3_500,
      CHF: 3_900,
      PLN: 16_900,
      DKK: 29_900,
      SEK: 44_900,
      NOK: 42_900,
      CAD: 6_500,
      AUD: 6_500,
    };
    for (const currency of PLATFORM_BILLING_CURRENCIES) {
      expect(starter.monthly[currency]).toEqual({
        amountMinor: monthlyAmounts[currency],
        available: true,
        type: "fixed",
      });
    }
    expect(JSON.stringify(response.body)).not.toMatch(
      /priceId|lookupKey|customerId|subscriptionId|metadata/,
    );
  });

  it("mounts before the global authentication boundary", () => {
    const source = readFileSync(
      new URL("../../../src/app/routes.ts", import.meta.url),
      "utf8",
    );
    const mountIndex = source.indexOf(
      'apiRouter.use("/public", publicSubscriptionCatalogRouter)',
    );
    expect(mountIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeLessThan(
      source.indexOf(
        "apiRouter.use(verifyJWT, requireTenantSubscriptionAccess)",
      ),
    );
  });

  it.each(PLATFORM_BILLING_CURRENCIES)(
    "accepts an explicit %s selection and rejects supplied amounts",
    (billingCurrency) => {
      const input = {
        plan: "starter",
        billingInterval: "monthly",
        billingCurrency: billingCurrency.toLowerCase(),
      };
      expect(checkoutSchema.parse(input).billingCurrency).toBe(billingCurrency);
      expect(checkoutSchema.safeParse({ ...input, amount: 1 }).success).toBe(
        false,
      );
    },
  );
});
