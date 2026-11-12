import { describe, expect, it } from "vitest";

import BookingIntentModel from "@/modules/booking-intent/booking-intent.model.js";
import {
  checkoutBookingIntentSchema,
  createBookingIntentSchema,
} from "@/modules/booking-intent/booking-intent.validators.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";

const PRODUCT_ID = "507f1f77bcf86cd799439011";

describe("booking intent locale contract", () => {
  it.each([
    ["en-GB", "en"],
    ["CZ", "cs"],
    ["de-DE", "de"],
    ["pl_PL", "pl"],
    ["sk-SK", "sk"],
    ["da-DK", "da"],
    ["fr-FR", "fr"],
    ["es_ES", "es"],
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
  ] as const)("canonicalizes %s to %s", (input, expected) => {
    expect(
      createBookingIntentSchema.parse({ productId: PRODUCT_ID, locale: input })
        .locale,
    ).toBe(expected);
    expect(
      checkoutBookingIntentSchema.parse({
        paymentMethod: "card",
        termsAccepted: true,
        locale: input,
      }).locale,
    ).toBe(expected);
  });

  it("rejects unsupported locales and canonicalizes legacy persistence assignments", () => {
    expect(() =>
      createBookingIntentSchema.parse({ productId: PRODUCT_ID, locale: "ja" }),
    ).toThrow();
    expect(BookingIntentModel.schema.path("payload.locale").options.enum).toEqual(
      [...ROLLOUT_ELIGIBLE_APP_LOCALES],
    );
    expect(
      new BookingIntentModel({ payload: { locale: "CZ" } }).payload.locale,
    ).toBe("cs");
  });
});

