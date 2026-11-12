import { describe, expect, it } from "vitest";

import {
  assertValidCreditColumnMapping,
  assertValidMembershipColumnMapping,
  assertValidMembershipPlanColumnMapping,
  assertValidVoucherColumnMapping,
  assertValidVoucherProductColumnMapping,
  suggestCustomerColumnMapping,
  suggestCreditColumnMapping,
  suggestMembershipColumnMapping,
  suggestMembershipPlanColumnMapping,
  suggestVoucherColumnMapping,
  suggestVoucherProductColumnMapping,
} from "@/modules/data-import/services/import-column-mapping.service.js";

describe("Step 3 import column mapping", () => {
  it("maps common legacy pottery-ID headings to the member number field", () => {
    expect(
      suggestCustomerColumnMapping([
        "Customer name",
        "Member Number (Pottery ID)",
        "External ID",
      ]),
    ).toEqual({
      fullName: "Customer name",
      memberNumber: "Member Number (Pottery ID)",
      externalId: "External ID",
    });
  });

  it("suggests membership-plan aliases without reusing a source column", () => {
    expect(
      suggestMembershipPlanColumnMapping([
        "Plan ID",
        "Membership plan",
        "Cena",
        "Billing type",
        "Included credits",
        "Benefits JSON",
      ]),
    ).toEqual({
      externalId: "Plan ID",
      name: "Membership plan",
      price: "Cena",
      billingType: "Billing type",
      creditAllowance: "Included credits",
      benefits: "Benefits JSON",
    });
  });

  it("requires the minimum membership-plan mapping", () => {
    expect(
      assertValidMembershipPlanColumnMapping(["Name", "Price", "Billing"], {
        name: "Name",
        price: "Price",
        billingType: "Billing",
      }),
    ).toEqual({
      name: "Name",
      price: "Price",
      billingType: "Billing",
    });
    expect(() =>
      assertValidMembershipPlanColumnMapping(["Name", "Price"], {
        name: "Name",
        price: "Price",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "IMPORT_MAPPING_MEMBERSHIP_PLAN_REQUIRED",
      }),
    );
  });

  it("suggests customer-membership aliases including plan version and period dates", () => {
    expect(
      suggestMembershipColumnMapping([
        "Customer email",
        "Plan ID",
        "Plan version",
        "Membership start",
        "Current period start",
        "Current period end",
        "Remaining allowances",
      ]),
    ).toEqual({
      customerEmail: "Customer email",
      planExternalId: "Plan ID",
      planVersion: "Plan version",
      startedAt: "Membership start",
      periodStart: "Current period start",
      periodEnd: "Current period end",
      allowanceBalances: "Remaining allowances",
    });
  });

  it("requires membership references and dates but leaves periodStart conditional per row", () => {
    expect(
      assertValidMembershipColumnMapping(
        ["Customer", "Plan", "Started", "Ended"],
        {
          customerExternalId: "Customer",
          planExternalId: "Plan",
          startedAt: "Started",
          periodEnd: "Ended",
        },
      ),
    ).toEqual({
      customerExternalId: "Customer",
      planExternalId: "Plan",
      startedAt: "Started",
      periodEnd: "Ended",
    });
    expect(() =>
      assertValidMembershipColumnMapping(["Customer", "Started", "Ended"], {
        customerExternalId: "Customer",
        startedAt: "Started",
        periodEnd: "Ended",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "IMPORT_MAPPING_MEMBERSHIP_REFERENCE_REQUIRED",
      }),
    );
  });

  it("maps and validates opening-credit allocation columns", () => {
    expect(
      suggestCreditColumnMapping([
        "Allocation ID",
        "Client email",
        "Opening balance",
        "Měna",
      ]),
    ).toEqual({
      externalId: "Allocation ID",
      customerEmail: "Client email",
      balance: "Opening balance",
      currency: "Měna",
    });
    expect(() =>
      assertValidCreditColumnMapping(["Opening balance"], {
        balance: "Opening balance",
      }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_CREDIT_REQUIRED" }),
    );
  });

  it("maps and validates voucher-product columns", () => {
    expect(
      suggestVoucherProductColumnMapping([
        "Voucher product ID",
        "Voucher name",
        "Amount",
        "Enabled",
      ]),
    ).toEqual({
      externalId: "Voucher product ID",
      name: "Voucher name",
      value: "Amount",
      isActive: "Enabled",
    });
    expect(() =>
      assertValidVoucherProductColumnMapping(["Voucher name"], {
        name: "Voucher name",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "IMPORT_MAPPING_VOUCHER_PRODUCT_REQUIRED",
      }),
    );
  });

  it("maps and validates issued-voucher identity, product, and snapshot fields", () => {
    expect(
      suggestVoucherColumnMapping([
        "Voucher ID",
        "Promo code",
        "Product SKU",
        "Voucher value",
        "Expiration date",
        "Redemption date",
      ]),
    ).toEqual({
      externalId: "Voucher ID",
      promoCode: "Promo code",
      productSku: "Product SKU",
      value: "Voucher value",
      expiresAt: "Expiration date",
      redeemedAt: "Redemption date",
    });
    expect(() =>
      assertValidVoucherColumnMapping(["Promo code", "Voucher value"], {
        promoCode: "Promo code",
        value: "Voucher value",
      }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_VOUCHER_REQUIRED" }),
    );
  });

  it("rejects duplicate source-column use across every Step 3 entity", () => {
    expect(() =>
      assertValidVoucherProductColumnMapping(["Voucher"], {
        name: "Voucher",
        value: "Voucher",
      }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_SOURCE_DUPLICATE" }),
    );
  });
});
