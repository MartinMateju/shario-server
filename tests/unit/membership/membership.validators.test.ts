import { describe, expect, it } from "vitest";

import {
  adjustmentSchema,
  assignMembershipSchema,
  billingPortalSchema,
  checkoutSchema,
  createMembershipPlanSchema,
  customerCancellationSchema,
} from "@/modules/membership/membership.validators.js";

const objectId = "507f1f77bcf86cd799439011";

const plan = () => ({
  name: "Studio Pass",
  description: "A stable membership",
  terms: "Cancel before renewal.",
  sortOrder: 1,
  prices: [
    { currency: "CZK", amountMinor: 129_900 },
    { currency: "EUR", amountMinor: 5_200 },
  ],
  billing: { type: "fixed", durationDays: 90 },
  locationScope: { type: "selected", locationIds: [objectId] },
  benefits: [
    {
      key: "visits",
      label: "Studio visits",
      type: "allowance",
      unit: "visit",
      quantity: 10,
      adjustable: true,
    },
    {
      key: "booking_discount",
      label: "Booking discount",
      type: "percentage",
      percentageBps: 1_500,
      appliesTo: "bookings",
    },
  ],
});

describe("membership validators", () => {
  it("accepts canonical translation maps and rejects unsupported keys, fields and excessive text", () => {
    const value = {
      ...plan(), translations: { cs: { name: "  Členství  ", description: "Popis", terms: "Podmínky" }, "pt-PT": { name: "Assinatura" } },
      benefits: plan().benefits.map((benefit) => ({ ...benefit, translations: { cs: { label: "  Výhoda  " } } })),
    };
    const parsed = createMembershipPlanSchema.parse(value);
    expect(parsed.translations?.cs?.name).toBe("Členství");
    expect(parsed.benefits[0].translations?.cs?.label).toBe("Výhoda");
    for (const translations of [{ xx: { name: "No" } }, { cs: { price: 100 } }, { cs: { name: "x".repeat(161) } }]) {
      expect(createMembershipPlanSchema.safeParse({ ...value, translations }).success).toBe(false);
    }
    expect(createMembershipPlanSchema.safeParse({ ...value, benefits: [{ ...value.benefits[0], translations: { cs: { label: "x".repeat(121) } } }] }).success).toBe(false);
  });

  it("accepts fixed duration, terms, typed benefits and integer multi-currency prices", () => {
    const parsed = createMembershipPlanSchema.parse(plan());
    expect(parsed.billing).toEqual({ type: "fixed", durationDays: 90 });
    expect(parsed.prices).toContainEqual({ currency: "CZK", amountMinor: 129_900 });
    expect(parsed.prices).toContainEqual({ currency: "EUR", amountMinor: 5_200 });
  });

  it("rejects fractional minor units and duplicate currencies", () => {
    const value = plan();
    value.prices = [
      { currency: "EUR", amountMinor: 100.5 },
      { currency: "EUR", amountMinor: 200 },
    ];
    expect(createMembershipPlanSchema.safeParse(value).success).toBe(false);
  });

  it("rejects zero-priced checkout plans; complimentary access is manually assigned", () => {
    const value = plan();
    value.prices = [{ currency: "CZK", amountMinor: 0 }];
    expect(createMembershipPlanSchema.safeParse(value).success).toBe(false);
  });

  it("allows at most one legacy credit allowance", () => {
    const value = plan();
    value.benefits = [
      { key: "credits_a", label: "A", type: "allowance", unit: "credit", quantity: 1, adjustable: true },
      { key: "credits_b", label: "B", type: "allowance", unit: "credit", quantity: 1, adjustable: true },
    ] as any;
    expect(createMembershipPlanSchema.safeParse(value).success).toBe(false);
  });

  it("accepts the first-release credits, product discount and custom perk model", () => {
    const value = plan();
    value.benefits = [
      {
        key: "monthly_credits",
        label: "Monthly studio credits",
        type: "allowance",
        unit: "credit",
        quantity: 8,
        adjustable: true,
      },
      {
        key: "member_products",
        label: "Member product discount",
        type: "percentage",
        percentageBps: 1_500,
        appliesTo: "products",
      },
      {
        key: "coffee",
        label: "Unlimited coffee",
        type: "boolean",
        enabled: true,
      },
    ] as any;

    expect(createMembershipPlanSchema.safeParse(value).success).toBe(true);
  });

  it("allows one product discount between 0.01% and 99%", () => {
    const duplicate = plan();
    duplicate.benefits = [
      {
        key: "products_a",
        label: "A",
        type: "percentage",
        percentageBps: 1_000,
        appliesTo: "products",
      },
      {
        key: "products_b",
        label: "B",
        type: "percentage",
        percentageBps: 2_000,
        appliesTo: "products",
      },
    ] as any;
    expect(createMembershipPlanSchema.safeParse(duplicate).success).toBe(false);

    const free = plan();
    free.benefits = [
      {
        key: "free_products",
        label: "Free products",
        type: "percentage",
        percentageBps: 10_000,
        appliesTo: "products",
      },
    ] as any;
    expect(createMembershipPlanSchema.safeParse(free).success).toBe(false);
  });

  it("requires explicit terms acceptance for checkout", () => {
    const request = {
      planId: objectId,
      currency: "CZK",
      locale: "en",
    };
    expect(checkoutSchema.safeParse(request).success).toBe(false);
    expect(
      checkoutSchema.safeParse({ ...request, termsAccepted: true }).success,
    ).toBe(true);
  });

  it.each(
    [
      ["de-DE", "de"],
      ["pl-PL", "pl"],
      ["sk-SK", "sk"],
      ["da-DK", "da"],
      ["fr-FR", "fr"],
      ["es-ES", "es"],
      ["it-IT", "it"],
      ["pt_PT", "pt-PT"],
    ["sv-SE", "sv"],
    ["nb-NO", "nb"],
    ["no-NO", "nb"],
    ["fi-FI", "fi"],
    ["hu-HU", "hu"],
    ["el-GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ] as const,
  )(
    "canonicalizes rollout locale %s for membership commerce",
    (input, expected) => {
      const checkout = checkoutSchema.parse({
        planId: objectId,
        currency: "EUR",
        locale: input,
        termsAccepted: true,
      });

      expect(checkout.locale).toBe(expected);
      expect(billingPortalSchema.parse({ locale: input }).locale).toBe(
        expected,
      );
    },
  );

  it.each(["ja-JP", "nn-NO", "pt-BR", "english"])(
    "rejects non-rollout membership commerce locale %s",
    (locale) => {
      expect(
        checkoutSchema.safeParse({
          planId: objectId,
          currency: "EUR",
          locale,
          termsAccepted: true,
        }).success,
      ).toBe(false);
      expect(billingPortalSchema.safeParse({ locale }).success).toBe(false);
    },
  );

  it("uses the exact customer cancellation reason enum", () => {
    for (const reason of ["too_expensive", "not_using", "missing_features", "moving", "temporary", "other"]) {
      expect(customerCancellationSchema.safeParse({ reason }).success).toBe(true);
    }
    expect(customerCancellationSchema.safeParse({ reason: "customer_request" }).success).toBe(false);
  });

  it("whitelists adjustment fields and requires an assignment audit reason", () => {
    expect(adjustmentSchema.safeParse({
      benefitKey: "visits",
      delta: 1,
      reason: "manual_correction",
      idempotencyKey: "adjust-0001",
      stripeSubscriptionId: "sub_untrusted",
    }).success).toBe(false);
    expect(assignMembershipSchema.safeParse({
      userId: objectId,
      planId: objectId,
      currency: "CZK",
    }).success).toBe(false);
    expect(assignMembershipSchema.safeParse({
      userId: objectId,
      planId: objectId,
      currency: "CZK",
      reason: "complimentary",
    }).success).toBe(true);
  });
});
