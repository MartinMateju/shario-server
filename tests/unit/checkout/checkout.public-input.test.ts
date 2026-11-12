import { describe, expect, it } from "vitest";

import { assertSupportedCheckoutInput } from "@/modules/checkout/checkout.validators.js";
import {
  couponCheckoutSchema,
  PUBLIC_VOUCHER_CHECKOUT_LIMITS,
} from "@/modules/coupon/coupon.validators.js";
import { AppError } from "@/shared/http/AppError.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";

const PRODUCT_ID = "64b000000000000000000001";

const voucherInput = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT_ID,
  quantity: 1,
  firstname: "Ada",
  lastname: "Lovelace",
  email: "ada@example.test",
  sendPost: false,
  ...overrides,
});

const expectAppErrorCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
    throw new Error("Expected an AppError to be thrown.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).statusCode).toBe(400);
  }
};

describe("public checkout input validation", () => {
  it("rejects checkout promo codes and partial credit/card payment", () => {
    expectAppErrorCode(
      () => assertSupportedCheckoutInput({ promoCode: "ABC-123-XYZ" }),
      "PROMO_CODE_CHECKOUT_UNSUPPORTED",
    );

    expectAppErrorCode(
      () => assertSupportedCheckoutInput({ creditsToApplyMajor: 10 }),
      "PARTIAL_CREDIT_CARD_PAYMENT_UNSUPPORTED",
    );

    expect(() =>
      assertSupportedCheckoutInput({ creditsToApplyMajor: 0 }),
    ).not.toThrow();
  });
});

describe("public voucher checkout input validation", () => {
  it("accepts a bounded voucher order", () => {
    expect(couponCheckoutSchema.parse(voucherInput())).toMatchObject({
      productId: PRODUCT_ID,
      quantity: 1,
      email: "ada@example.test",
    });
  });

  it.each(ROLLOUT_ELIGIBLE_APP_LOCALES)(
    "accepts the %s rollout locale for voucher checkout",
    (locale) => {
      expect(couponCheckoutSchema.parse(voucherInput({ locale })).locale).toBe(
        locale,
      );
    },
  );

  it.each([
    ["fr-FR", "fr"],
    ["es_MX", "es"],
    ["it-CH", "it"],
    ["pt_PT", "pt-PT"],
    ["sv-SE", "sv"],
    ["no-NO", "nb"],
    ["fi-FI", "fi"],
    ["hu-HU", "hu"],
    ["el-GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ] as const)(
    "canonicalizes the Wave 2 voucher locale alias %s to %s",
    (locale, expected) => {
      expect(
        couponCheckoutSchema.parse(
          voucherInput({ locale }),
        ).locale,
      ).toBe(expected);
    },
  );

  it.each(["ja", "nn-NO", "pt-BR"])(
    "rejects ineligible voucher locale %s",
    (locale) => {
      expect(
        couponCheckoutSchema.safeParse(
          voucherInput({ locale }),
        ).success,
      ).toBe(false);
    },
  );

  it("caps quantity and customer-entered text", () => {
    expect(
      couponCheckoutSchema.safeParse(
        voucherInput({
          quantity: PUBLIC_VOUCHER_CHECKOUT_LIMITS.quantity + 1,
        }),
      ).success,
    ).toBe(false);

    expect(
      couponCheckoutSchema.safeParse(
        voucherInput({
          note: "x".repeat(PUBLIC_VOUCHER_CHECKOUT_LIMITS.note + 1),
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects client-controlled ownership fields", () => {
    expect(
      couponCheckoutSchema.safeParse(
        voucherInput({
          createdBy: "64b000000000000000000099",
        }),
      ).success,
    ).toBe(false);
  });
});

