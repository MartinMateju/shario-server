import { describe, expect, it } from "vitest";

import {
  assertMinorAmount,
  calculateCreditTaxSlice,
  calculateInclusiveTax,
  majorToMinor,
  sumInvoiceLineTotals,
} from "@/modules/invoice/invoice.money.js";

describe("invoice money", () => {
  describe("calculateInclusiveTax", () => {
    it("rounds exact half-minor-unit net values up", () => {
      expect(
        calculateInclusiveTax({
          grossAmountMinor: 1,
          taxRateBps: 10_000,
        }),
      ).toEqual({
        netAmountMinor: 1,
        taxAmountMinor: 0,
      });

      expect(
        calculateInclusiveTax({
          grossAmountMinor: 3,
          taxRateBps: 10_000,
        }),
      ).toEqual({
        netAmountMinor: 2,
        taxAmountMinor: 1,
      });
    });

    it("preserves gross exactly near Number.MAX_SAFE_INTEGER", () => {
      const grossAmountMinor = Number.MAX_SAFE_INTEGER;

      const result = calculateInclusiveTax({
        grossAmountMinor,
        taxRateBps: 10_000,
      });

      expect(result).toEqual({
        netAmountMinor: 4_503_599_627_370_496,
        taxAmountMinor: 4_503_599_627_370_495,
      });
      expect(result.netAmountMinor + result.taxAmountMinor).toBe(
        grossAmountMinor,
      );
    });

    it("uses BigInt arithmetic for large nontrivial tax rates", () => {
      const grossAmountMinor = Number.MAX_SAFE_INTEGER;

      const result = calculateInclusiveTax({
        grossAmountMinor,
        taxRateBps: 1,
      });

      expect(Number.isSafeInteger(result.netAmountMinor)).toBe(true);
      expect(Number.isSafeInteger(result.taxAmountMinor)).toBe(true);
      expect(result.netAmountMinor + result.taxAmountMinor).toBe(
        grossAmountMinor,
      );
    });

    it("accepts both inclusive-tax boundaries and rejects rates outside them", () => {
      expect(
        calculateInclusiveTax({
          grossAmountMinor: 125,
          taxRateBps: 0,
        }),
      ).toEqual({ netAmountMinor: 125, taxAmountMinor: 0 });

      expect(() =>
        calculateInclusiveTax({
          grossAmountMinor: 125,
          taxRateBps: -1,
        }),
      ).toThrow(/between 0 and 10000 basis points/);

      expect(() =>
        calculateInclusiveTax({
          grossAmountMinor: 125,
          taxRateBps: 10_001,
        }),
      ).toThrow(/between 0 and 10000 basis points/);

      expect(() =>
        calculateInclusiveTax({
          grossAmountMinor: 125,
          taxRateBps: 2_000.5,
        }),
      ).toThrow(/between 0 and 10000 basis points/);
    });
  });

  describe("minor-unit integrity", () => {
    it("rejects negative, fractional, and unsafe minor-unit amounts", () => {
      expect(() => assertMinorAmount(-1)).toThrow(/nonnegative minor-unit/);
      expect(() => assertMinorAmount(1.5)).toThrow(/nonnegative minor-unit/);
      expect(() => assertMinorAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow(
        /nonnegative minor-unit/,
      );
    });

    it("rejects an invoice total that crosses the safe-integer boundary", () => {
      expect(() =>
        sumInvoiceLineTotals([
          {
            netAmountMinor: Number.MAX_SAFE_INTEGER,
            taxAmountMinor: 0,
            grossAmountMinor: Number.MAX_SAFE_INTEGER,
          },
          {
            netAmountMinor: 1,
            taxAmountMinor: 0,
            grossAmountMinor: 1,
          },
        ]),
      ).toThrow(/total exceeds the supported amount range/);
    });
  });

  describe("partial credit tax residuals", () => {
    it("allocates the exact original tax across multiple partial credits", () => {
      const first = calculateCreditTaxSlice({
        originalGrossMinor: 1_000,
        originalTaxMinor: 174,
        creditedGrossMinor: 0,
        creditedTaxMinor: 0,
        creditGrossMinor: 333,
      });
      const second = calculateCreditTaxSlice({
        originalGrossMinor: 1_000,
        originalTaxMinor: 174,
        creditedGrossMinor: 333,
        creditedTaxMinor: first,
        creditGrossMinor: 333,
      });
      const final = calculateCreditTaxSlice({
        originalGrossMinor: 1_000,
        originalTaxMinor: 174,
        creditedGrossMinor: 666,
        creditedTaxMinor: first + second,
        creditGrossMinor: 334,
      });

      expect(first + second + final).toBe(174);
    });

    it("rejects a slice larger than the remaining line amount", () => {
      expect(() =>
        calculateCreditTaxSlice({
          originalGrossMinor: 1_000,
          originalTaxMinor: 174,
          creditedGrossMinor: 900,
          creditedTaxMinor: 157,
          creditGrossMinor: 101,
        }),
      ).toThrow(/exceeds the remaining/);
    });
  });

  describe("currency precision", () => {
    it("uses zero decimal places for JPY and CLP", () => {
      expect(majorToMinor(500, "JPY")).toBe(500);
      expect(majorToMinor("725", "clp")).toBe(725);

      expect(() => majorToMinor(500.5, "JPY")).toThrow(
        /invalid precision for JPY/,
      );
      expect(() => majorToMinor(725.01, "CLP")).toThrow(
        /invalid precision for CLP/,
      );
    });

    it("uses two decimal places for ordinary supported currencies", () => {
      expect(majorToMinor("10.25", "eur")).toBe(1_025);
      expect(() => majorToMinor(10.255, "EUR")).toThrow(
        /invalid precision for EUR/,
      );
    });

    it("rejects unsupported currencies with an operational bad request", () => {
      expect(() => majorToMinor(10, "BTC")).toThrow(
        /Invoice currency is not supported/,
      );
    });
  });
});
