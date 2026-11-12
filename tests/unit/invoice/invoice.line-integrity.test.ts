import { describe, expect, it } from "vitest";

import { assertInvoiceLineIntegrity } from "@/modules/invoice/invoice.service.js";

const validLine = {
  quantity: 1,
  unitGrossMinor: 1_000,
  grossAmountMinor: 1_000,
  netAmountMinor: 826,
  taxAmountMinor: 174,
  taxRateBps: 2_100,
};

describe("invoice line integrity", () => {
  it("accepts the exact tax-inclusive derivation", () => {
    expect(() => assertInvoiceLineIntegrity(validLine)).not.toThrow();
  });

  it("rejects net/tax values that merely add up to gross", () => {
    expect(() =>
      assertInvoiceLineIntegrity({
        ...validLine,
        netAmountMinor: 825,
        taxAmountMinor: 175,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVOICE_LINE_TAX_SNAPSHOT_INVALID" }),
    );
  });

  it("rejects fractional and out-of-range basis-point rates", () => {
    for (const taxRateBps of [2_100.5, -1, 10_001]) {
      expect(() =>
        assertInvoiceLineIntegrity({ ...validLine, taxRateBps }),
      ).toThrow(/integer between 0 and 10000 basis points/);
    }
  });
});
