import { describe, expect, it } from "vitest";

import {
  PLATFORM_BILLING_CURRENCIES,
  STUDIO_COMMERCE_CURRENCIES,
  fromCurrencyMinorUnits,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";
import {
  ALLOWED_CURRENCIES,
  STRIPE_MIN_TOTAL,
  toMinorUnits,
} from "@/infrastructure/payments/stripe-pricing.js";

describe("currency foundation", () => {
  it("exposes the agreed commerce and platform billing sets", () => {
    expect(STUDIO_COMMERCE_CURRENCIES).toHaveLength(22);
    expect(PLATFORM_BILLING_CURRENCIES).toEqual([
      "EUR",
      "USD",
      "CZK",
      "GBP",
      "CHF",
      "PLN",
      "DKK",
      "SEK",
      "NOK",
      "CAD",
      "AUD",
    ]);
    expect(ALLOWED_CURRENCIES).toHaveLength(22);
    expect(Object.keys(STRIPE_MIN_TOTAL)).toHaveLength(22);
  });

  it("uses two decimal places for EUR and HUF charges", () => {
    expect(toCurrencyMinorUnits(10.25, "EUR")).toBe(1025);
    expect(toCurrencyMinorUnits(175.5, "HUF")).toBe(17550);
    expect(toMinorUnits(10.25, "eur")).toBe(1025);
  });

  it("uses zero decimal places for JPY and CLP", () => {
    expect(toCurrencyMinorUnits(500, "JPY")).toBe(500);
    expect(toCurrencyMinorUnits(500, "CLP")).toBe(500);
    expect(fromCurrencyMinorUnits(500, "JPY")).toBe(500);
  });

  it("rejects precision that the currency cannot represent", () => {
    expect(() => toCurrencyMinorUnits(10.999, "EUR")).toThrow(
      /more decimal places/,
    );
    expect(() => toCurrencyMinorUnits(10.5, "JPY")).toThrow(
      /more decimal places/,
    );
    expect(() => toCurrencyMinorUnits(10.5, "CLP")).toThrow(
      /more decimal places/,
    );
  });
});

