import { describe, expect, it } from "vitest";

import {
  membershipPlanFileIdentityKeys,
  normalizeMembershipPlanImportRow,
  validateMembershipPlanImportRow,
} from "@/modules/data-import/adapters/membership-plan-import.adapter.js";
import {
  normalizeMembershipImportRow,
  validateMembershipImportRow,
} from "@/modules/data-import/adapters/membership-import.adapter.js";
import {
  normalizeCreditImportRow,
  validateCreditImportRow,
} from "@/modules/data-import/adapters/credit-import.adapter.js";
import {
  normalizeVoucherProductImportRow,
  validateVoucherProductImportRow,
} from "@/modules/data-import/adapters/voucher-product-import.adapter.js";
import {
  normalizeVoucherImportRow,
  validateVoucherImportRow,
  voucherFileIdentityKeys,
} from "@/modules/data-import/adapters/voucher-import.adapter.js";
import {
  parseImportAmount,
  parseImportBoolean,
  parseImportDateTime,
  parseNonnegativeIntegerMap,
} from "@/modules/data-import/adapters/import-adapter.utils.js";

const issueCodes = (issues: Array<{ code: string }>) =>
  issues.map((issue) => issue.code);

describe("Step 3 shared import parsing", () => {
  it("parses locale amounts without guessing ambiguous thousands separators", () => {
    expect(parseImportAmount("1 234,50")).toBe(1234.5);
    expect(parseImportAmount("1,234.50")).toBe(1234.5);
    expect(parseImportAmount("1.234,50")).toBe(1234.5);
    expect(parseImportAmount("1,234")).toBeNull();
    expect(parseImportAmount("12 CZK")).toBeNull();
  });

  it("accepts Czech booleans and only ISO dates with explicit timezone", () => {
    expect(parseImportBoolean("ano")).toBe(true);
    expect(parseImportBoolean("ne")).toBe(false);
    expect(parseImportBoolean("sometimes")).toBeNull();
    expect(parseImportDateTime("2026-08-05")).toBe("2026-08-05T00:00:00.000Z");
    expect(parseImportDateTime("2026-08-05", "end")).toBe(
      "2026-08-05T23:59:59.999Z",
    );
    expect(parseImportDateTime("2026-08-05T10:30:00")).toBe("");
    expect(parseImportDateTime("2026-02-30")).toBe("");
  });

  it("parses only non-negative whole-number allowance maps", () => {
    expect(parseNonnegativeIntegerMap('{"credits": 4, "FIRINGS": 2}')).toEqual({
      credits: 4,
      firings: 2,
    });
    expect(parseNonnegativeIntegerMap('{"credits": -1}')).toBeNull();
    expect(parseNonnegativeIntegerMap('{"credits": 1.5}')).toBeNull();
    expect(parseNonnegativeIntegerMap("[]")).toBeNull();
  });
});

describe("membership plan import adapter", () => {
  it("normalizes recurring plans and builds canonical convenience benefits", () => {
    const normalized = normalizeMembershipPlanImportRow(
      {
        ID: "PLAN-1",
        Name: "Studio membership",
        Price: "1 490,50",
        Billing: "opakující",
        Interval: "měsíc",
        Credits: "8",
        Discount: "12,50",
        Perk: "Priority kiln access",
      },
      {
        externalId: "ID",
        name: "Name",
        price: "Price",
        billingType: "Billing",
        billingInterval: "Interval",
        creditAllowance: "Credits",
        discountPercent: "Discount",
        customPerk: "Perk",
      },
    );

    expect(normalized).toMatchObject({
      externalId: "PLAN-1",
      name: "Studio membership",
      price: 1490.5,
      billingType: "recurring",
      billingInterval: "month",
      intervalCount: 1,
      locationScope: "all",
      status: "published",
      sortOrder: 0,
      parseErrors: [],
    });
    expect(normalized.benefits).toEqual([
      {
        key: "credits",
        label: "Credits",
        type: "allowance",
        unit: "credit",
        quantity: 8,
        adjustable: true,
      },
      {
        key: "product_discount",
        label: "Product discount",
        type: "percentage",
        percentageBps: 1250,
        appliesTo: "products",
      },
      {
        key: "custom_perk",
        label: "Priority kiln access",
        type: "boolean",
        enabled: true,
      },
    ]);
    expect(validateMembershipPlanImportRow(normalized)).toEqual([]);
  });

  it("rejects mixed JSON and convenience benefits", () => {
    const normalized = normalizeMembershipPlanImportRow(
      {
        Name: "Mixed plan",
        Price: "100",
        Billing: "fixed",
        Duration: "30",
        Benefits: '[{"key":"credits","type":"allowance","quantity":2}]',
        Credits: "2",
      },
      {
        name: "Name",
        price: "Price",
        billingType: "Billing",
        durationDays: "Duration",
        benefits: "Benefits",
        creditAllowance: "Credits",
      },
    );

    expect(issueCodes(validateMembershipPlanImportRow(normalized))).toContain(
      "MEMBERSHIP_PLAN_BENEFITS_MIXED",
    );
  });

  it("requires the conditional billing and selected-location fields", () => {
    const recurring = normalizeMembershipPlanImportRow(
      { Name: "Recurring", Price: "100", Billing: "recurring" },
      { name: "Name", price: "Price", billingType: "Billing" },
    );
    const selected = normalizeMembershipPlanImportRow(
      {
        Name: "Selected",
        Price: "100",
        Billing: "fixed",
        Duration: "30",
        Scope: "selected",
      },
      {
        name: "Name",
        price: "Price",
        billingType: "Billing",
        durationDays: "Duration",
        locationScope: "Scope",
      },
    );

    expect(issueCodes(validateMembershipPlanImportRow(recurring))).toContain(
      "MEMBERSHIP_PLAN_BILLING_INVALID",
    );
    expect(issueCodes(validateMembershipPlanImportRow(selected))).toContain(
      "MEMBERSHIP_PLAN_LOCATION_REQUIRED",
    );
  });

  it("uses external ID and case-folded name as deterministic file identities", () => {
    const normalized = normalizeMembershipPlanImportRow(
      {
        ID: "PLAN-9",
        Name: "Studio PLUS",
        Price: "100",
        Billing: "fixed",
        Duration: "30",
      },
      {
        externalId: "ID",
        name: "Name",
        price: "Price",
        billingType: "Billing",
        durationDays: "Duration",
      },
    );

    expect(membershipPlanFileIdentityKeys(normalized)).toEqual([
      { kind: "externalId", value: "PLAN-9" },
      { kind: "name", value: "studio plus" },
    ]);
  });
});

describe("customer membership import adapter", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");

  it("allows a historical cancelled membership without inventing cancelledAt", () => {
    const normalized = normalizeMembershipImportRow(
      {
        Customer: "CUS-1",
        Plan: "PLAN-1",
        Status: "cancelled",
        Started: "2026-01-01",
        End: "2026-07-01",
      },
      {
        customerExternalId: "Customer",
        planExternalId: "Plan",
        status: "Status",
        startedAt: "Started",
        periodEnd: "End",
      },
    );

    expect(normalized).toMatchObject({
      customerExternalId: "CUS-1",
      planExternalId: "PLAN-1",
      status: "cancelled",
      startedAt: "2026-01-01T00:00:00.000Z",
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-07-01T23:59:59.999Z",
      cancelledAt: "",
      allowanceBalances: null,
      parseErrors: [],
    });
    expect(validateMembershipImportRow(normalized, now)).toEqual([]);
  });

  it("does not infer periodStart for an open membership", () => {
    const normalized = normalizeMembershipImportRow(
      {
        Customer: "CUS-1",
        Plan: "PLAN-1",
        Status: "active",
        Started: "2026-08-01",
        End: "2026-09-01",
      },
      {
        customerExternalId: "Customer",
        planExternalId: "Plan",
        status: "Status",
        startedAt: "Started",
        periodEnd: "End",
      },
    );

    expect(normalized.periodStart).toBe("");
    expect(issueCodes(validateMembershipImportRow(normalized, now))).toContain(
      "MEMBERSHIP_PERIOD_INVALID",
    );
  });

  it("rejects invalid lifecycle dates and non-integer allowance balances", () => {
    const normalized = normalizeMembershipImportRow(
      {
        Customer: "customer@example.com",
        Plan: "Studio plan",
        Status: "expired",
        Started: "2026-08-05",
        PeriodStart: "2026-08-04",
        End: "2026-09-01",
        Balances: '{"credits": 1.5}',
      },
      {
        customerEmail: "Customer",
        planName: "Plan",
        status: "Status",
        startedAt: "Started",
        periodStart: "PeriodStart",
        periodEnd: "End",
        allowanceBalances: "Balances",
      },
    );

    expect(issueCodes(validateMembershipImportRow(normalized, now))).toEqual(
      expect.arrayContaining([
        "MEMBERSHIP_PERIOD_INVALID",
        "MEMBERSHIP_EXPIRED_PERIOD_INVALID",
        "MEMBERSHIP_ALLOWANCE_BALANCES_INVALID",
      ]),
    );
  });
});

describe("opening credit allocation import adapter", () => {
  it("normalizes customer identity and accepts a zero opening allocation", () => {
    const normalized = normalizeCreditImportRow(
      {
        ID: "CREDIT-1",
        Email: " Customer@Example.COM ",
        Phone: "+420 777 123 456",
        Balance: "0",
        Currency: "czk",
        Note: "Opening balance",
      },
      {
        externalId: "ID",
        customerEmail: "Email",
        customerPhone: "Phone",
        balance: "Balance",
        currency: "Currency",
        note: "Note",
      },
    );

    expect(normalized).toMatchObject({
      externalId: "CREDIT-1",
      customerEmail: "customer@example.com",
      customerPhone: "+420777123456",
      balance: 0,
      currency: "CZK",
      note: "Opening balance",
      parseErrors: [],
    });
    expect(validateCreditImportRow(normalized)).toEqual([]);
  });

  it("requires customer identity and a non-negative amount", () => {
    const normalized = normalizeCreditImportRow(
      { Balance: "-1" },
      { balance: "Balance" },
    );

    expect(issueCodes(validateCreditImportRow(normalized))).toEqual(
      expect.arrayContaining([
        "CREDIT_CUSTOMER_REQUIRED",
        "CREDIT_BALANCE_INVALID",
      ]),
    );
  });
});

describe("voucher product import adapter", () => {
  it("defaults a new voucher product to inactive and normalizes its value", () => {
    const normalized = normalizeVoucherProductImportRow(
      {
        Name: "Gift voucher",
        Value: "1 500,00",
        Currency: "czk",
      },
      { name: "Name", value: "Value", currency: "Currency" },
    );

    expect(normalized).toMatchObject({
      name: "Gift voucher",
      value: 1500,
      currency: "CZK",
      isActive: false,
      sortOrder: 0,
      parseErrors: [],
    });
    expect(validateVoucherProductImportRow(normalized)).toEqual([]);
  });

  it("leaves active-product eligibility to contextual validation", () => {
    const normalized = normalizeVoucherProductImportRow(
      { Name: "Existing voucher", Value: "100", Active: "yes" },
      { name: "Name", value: "Value", isActive: "Active" },
    );

    expect(normalized.isActive).toBe(true);
    expect(
      issueCodes(validateVoucherProductImportRow(normalized)),
    ).not.toContain("VOUCHER_PRODUCT_TEMPLATE_REQUIRED");
  });
});

describe("issued voucher import adapter", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");

  it("accepts a redeemed voucher without requiring a customer", () => {
    const normalized = normalizeVoucherImportRow(
      {
        ID: "VOUCHER-1",
        Code: "STUDIO-2026-01",
        Product: "GIFT-1500",
        Status: "redeemed",
        Value: "1500",
        Currency: "czk",
        Redeemed: "2026-08-01T10:00:00+02:00",
      },
      {
        externalId: "ID",
        promoCode: "Code",
        productSku: "Product",
        status: "Status",
        value: "Value",
        currency: "Currency",
        redeemedAt: "Redeemed",
      },
    );

    expect(normalized).toMatchObject({
      externalId: "VOUCHER-1",
      promoCode: "STUDIO-2026-01",
      productSku: "GIFT-1500",
      status: "redeemed",
      value: 1500,
      currency: "CZK",
      redeemedAt: "2026-08-01T08:00:00.000Z",
      parseErrors: [],
    });
    expect(validateVoucherImportRow(normalized, now)).toEqual([]);
    expect(voucherFileIdentityKeys(normalized)).toEqual([
      { kind: "externalId", value: "VOUCHER-1" },
      { kind: "promoCode", value: "STUDIO-2026-01" },
    ]);
  });

  it("rejects malformed codes and redemption data on active vouchers", () => {
    const normalized = normalizeVoucherImportRow(
      {
        Code: "BAD--CODE",
        Product: "Gift voucher",
        Status: "active",
        Value: "100",
        Customer: "customer@example.com",
        Redeemed: "2026-08-01",
      },
      {
        promoCode: "Code",
        productName: "Product",
        status: "Status",
        value: "Value",
        customerEmail: "Customer",
        redeemedAt: "Redeemed",
      },
    );

    expect(issueCodes(validateVoucherImportRow(normalized, now))).toEqual(
      expect.arrayContaining(["VOUCHER_CODE_INVALID", "VOUCHER_STATE_INVALID"]),
    );
  });

  it("rejects voucher statuses that contradict expiry or redemption dates", () => {
    const active = normalizeVoucherImportRow(
      {
        Code: "ACTIVE-2026-01",
        Product: "Gift voucher",
        Status: "active",
        Value: "100",
        Expires: "2026-08-01",
      },
      {
        promoCode: "Code",
        productName: "Product",
        status: "Status",
        value: "Value",
        expiresAt: "Expires",
      },
    );
    const redeemed = normalizeVoucherImportRow(
      {
        Code: "REDEEMED-2026-01",
        Product: "Gift voucher",
        Status: "redeemed",
        Value: "100",
        Expires: "2026-07-31",
        Redeemed: "2026-08-01",
      },
      {
        promoCode: "Code",
        productName: "Product",
        status: "Status",
        value: "Value",
        expiresAt: "Expires",
        redeemedAt: "Redeemed",
      },
    );
    const disabled = normalizeVoucherImportRow(
      {
        Code: "DISABLED-2026-01",
        Product: "Gift voucher",
        Status: "disabled",
        Value: "100",
        Expires: "2026-07-31",
      },
      {
        promoCode: "Code",
        productName: "Product",
        status: "Status",
        value: "Value",
        expiresAt: "Expires",
      },
    );

    expect(issueCodes(validateVoucherImportRow(active, now))).toContain(
      "VOUCHER_STATE_INVALID",
    );
    expect(issueCodes(validateVoucherImportRow(redeemed, now))).toContain(
      "VOUCHER_STATE_INVALID",
    );
    expect(issueCodes(validateVoucherImportRow(disabled, now))).toContain(
      "VOUCHER_STATE_INVALID",
    );
  });
});
