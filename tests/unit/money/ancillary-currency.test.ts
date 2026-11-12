import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { InventoryMovement } from "@/modules/inventory/inventory.model.js";
import { calculateAverageCost } from "@/modules/inventory/inventory.utils.js";
import { roundDerivedCurrencyAmount } from "@/shared/money/amount.js";
import {
  assertCurrencyAmountFields,
  resolveFinancialRecordCurrency,
} from "@/shared/money/financial-record.js";

describe("ancillary financial currency integrity", () => {
  it("validates entered amounts using the currency exponent", () => {
    expect(() =>
      assertCurrencyAmountFields({ price: 10.5 }, "JPY"),
    ).toThrow(/not a valid JPY amount/);

    expect(() =>
      assertCurrencyAmountFields({ price: 10.5 }, "HUF"),
    ).not.toThrow();
  });

  it("only attaches a current currency to legacy records with no money", () => {
    expect(
      resolveFinancialRecordCurrency({
        tenantCurrency: "EUR",
        recordCurrency: undefined,
        existingAmounts: [0, 0],
      }),
    ).toEqual({
      currency: "EUR",
      persistSnapshot: true,
    });

    expect(() =>
      resolveFinancialRecordCurrency({
        tenantCurrency: "EUR",
        recordCurrency: undefined,
        existingAmounts: [20, 0],
      }),
    ).toThrow(/legacy record has monetary values/);
  });

  it("rounds derived totals and averages to minor units", () => {
    expect(roundDerivedCurrencyAmount(1.005, "EUR")).toBe(1.01);
    expect(roundDerivedCurrencyAmount(10.005, "EUR")).toBe(10.01);
    expect(roundDerivedCurrencyAmount(100.5, "JPY")).toBe(101);

    expect(
      calculateAverageCost({
        currentQuantity: 1,
        currentAverageCost: 100,
        addedQuantity: 1,
        addedUnitCost: 101,
        currency: "JPY",
      }),
    ).toBe(101);
  });

  it("stores inventory movement VAT totals without floating artifacts", async () => {
    const movement = new InventoryMovement({
      tenant: new mongoose.Types.ObjectId(),
      item: new mongoose.Types.ObjectId(),
      type: "in",
      reason: "purchase",
      location: new mongoose.Types.ObjectId(),
      quantity: 3,
      currency: "EUR",
      unitCostWithoutVat: 0.01,
      vatRate: 21,
      createdBy: new mongoose.Types.ObjectId(),
    });

    await movement.validate();

    expect(movement.totalWithoutVat).toBe(0.03);
    expect(movement.totalWithVat).toBe(0.04);
  });
});
