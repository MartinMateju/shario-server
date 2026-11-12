import { describe, expect, it } from "vitest";

import {
  assertSupportedInvoiceLineTaxMode,
  assertSupportedInvoiceTaxMode,
  assertValidInvoiceAutomationSettings,
  ensureInvoiceSettings,
} from "@/modules/invoice/invoice-settings.service.js";

describe("invoice settings tax mode", () => {
  it("allows inclusive prices with tax", () => {
    expect(() =>
      assertSupportedInvoiceTaxMode({
        pricesIncludeTax: true,
        defaultTaxRateBps: 2_100,
      }),
    ).not.toThrow();
  });

  it("allows exclusive prices only when the configured tax rate is zero", () => {
    expect(() =>
      assertSupportedInvoiceTaxMode({
        pricesIncludeTax: false,
        defaultTaxRateBps: 0,
      }),
    ).not.toThrow();
  });

  it("rejects unsupported tax-exclusive prices with a stable error code", () => {
    expect(() =>
      assertSupportedInvoiceTaxMode({
        pricesIncludeTax: false,
        defaultTaxRateBps: 2_100,
      }),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 400,
        code: "EXCLUSIVE_TAX_NOT_SUPPORTED",
      }),
    );
  });

  it("rejects invalid default basis-point rates in every price mode", () => {
    for (const defaultTaxRateBps of [2_100.5, -1, 10_001]) {
      expect(() =>
        assertSupportedInvoiceTaxMode({
          pricesIncludeTax: true,
          defaultTaxRateBps,
        }),
      ).toThrow(/integer between 0 and 10000 basis points/);
    }
  });

  it("does not permit a line-level tax override in zero-tax exclusive mode", () => {
    expect(() =>
      assertSupportedInvoiceLineTaxMode(
        { pricesIncludeTax: false, defaultTaxRateBps: 0 },
        2_100,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "EXCLUSIVE_TAX_NOT_SUPPORTED" }),
    );
    expect(
      assertSupportedInvoiceLineTaxMode(
        { pricesIncludeTax: false, defaultTaxRateBps: 0 },
        0,
      ),
    ).toBe(0);
  });
});

describe("invoice automation settings", () => {
  it("accepts the safe off and fully-enabled combinations", () => {
    expect(() =>
      assertValidInvoiceAutomationSettings({
        autoCreatePaidOrderInvoices: true,
        autoFinalizePaidOrderInvoices: false,
        autoSendPaidOrderInvoices: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertValidInvoiceAutomationSettings({
        autoCreatePaidOrderInvoices: true,
        autoFinalizePaidOrderInvoices: true,
        autoSendPaidOrderInvoices: true,
      }),
    ).not.toThrow();
  });

  it("rejects finalize without create and send without finalize", () => {
    for (const settings of [
      {
        autoCreatePaidOrderInvoices: false,
        autoFinalizePaidOrderInvoices: true,
        autoSendPaidOrderInvoices: false,
      },
      {
        autoCreatePaidOrderInvoices: true,
        autoFinalizePaidOrderInvoices: false,
        autoSendPaidOrderInvoices: true,
      },
    ]) {
      expect(() => assertValidInvoiceAutomationSettings(settings)).toThrowError(
        expect.objectContaining({
          code: "INVOICE_AUTOMATION_SETTINGS_INVALID",
        }),
      );
    }
  });
});

describe("invoice settings tenant guard", () => {
  it("rejects a missing tenant before Mongoose can cast it", async () => {
    await expect(
      ensureInvoiceSettings("undefined"),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVOICE_TENANT_ID_INVALID",
    });
  });
});
