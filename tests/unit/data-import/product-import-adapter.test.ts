import { describe, expect, it } from "vitest";

import {
  normalizeProductImportRow,
  parseImportNumber,
  validateProductImportRow,
} from "@/modules/data-import/adapters/product-import.adapter.js";

const codes = (issues: ReturnType<typeof validateProductImportRow>) =>
  issues.map((issue) => issue.code);

describe("product import adapter", () => {
  it("normalizes Czech decimal, boolean, and policy values", () => {
    const product = normalizeProductImportRow(
      {
        Name: "Otevřená dílna",
        Kind: "Otevřené studio",
        Price: "1 234,50",
        Extra: "12,50",
        Currency: "czk",
        Capacity: "8",
        Mode: "public",
        Registration: "ano",
        Firing: "ne",
        Active: "ne",
        Order: "20",
      },
      {
        name: "Name",
        kind: "Kind",
        price: "Price",
        extraCharge: "Extra",
        currency: "Currency",
        capacity: "Capacity",
        bookingMode: "Mode",
        isActive: "Active",
        sortOrder: "Order",
      },
    );

    expect(product).toMatchObject({
      name: "Otevřená dílna",
      kind: "open-studio",
      type: "workshop",
      price: 1234.5,
      extraCharge: 12.5,
      currency: "CZK",
      capacity: 8,
      bookingMode: "public",
      isActive: false,
      sortOrder: 20,
      parseErrors: [],
    });
    expect(validateProductImportRow(product, "CZK")).toEqual([]);
  });

  it("parses both comma and dot locale number conventions", () => {
    expect(parseImportNumber("1.234,56")).toBe(1234.56);
    expect(parseImportNumber("1,234.56")).toBe(1234.56);
    expect(parseImportNumber("1\u00a0234,5")).toBe(1234.5);
    expect(parseImportNumber("1 234")).toBe(1234);
    expect(parseImportNumber("1,234,567")).toBe(1234567);
    expect(parseImportNumber("1.234.567")).toBe(1234567);
    expect(parseImportNumber("12,34")).toBe(12.34);
    expect(parseImportNumber("not a number")).toBeNull();
  });

  it.each(["1,234", "1.234", "1,2,3", "12,34,567", "1.23,4.5", "12 CZK"])(
    "rejects ambiguous or malformed numeric input %s",
    (value) => {
      expect(parseImportNumber(value)).toBeNull();
    },
  );

  it.each([
    ["Service", "PRODUCT_KIND_AMBIGUOUS"],
    ["Služba", "PRODUCT_KIND_AMBIGUOUS"],
    ["Voucher", "PRODUCT_DEDICATED_IMPORT_REQUIRED"],
    ["Membership", "PRODUCT_DEDICATED_IMPORT_REQUIRED"],
  ])("rejects unsupported or ambiguous kind %s", (kind, expectedCode) => {
    const product = normalizeProductImportRow(
      { Name: "Legacy offer", Kind: kind, Capacity: "8" },
      { name: "Name", kind: "Kind", capacity: "Capacity" },
    );

    expect(codes(validateProductImportRow(product))).toContain(expectedCode);
  });

  it("does not accept an invalid locale boolean silently", () => {
    const product = normalizeProductImportRow(
      {
        Name: "Studio",
        Kind: "Open Studio",
        Capacity: "8",
        Active: "sometimes",
      },
      {
        name: "Name",
        kind: "Kind",
        capacity: "Capacity",
        isActive: "Active",
      },
    );

    expect(codes(validateProductImportRow(product))).toContain(
      "PRODUCT_ACTIVE_INVALID",
    );
  });

  it("requires a non-empty product name and kind on every row", () => {
    const product = normalizeProductImportRow(
      { Name: " ", Kind: " ", Capacity: "8" },
      { name: "Name", kind: "Kind", capacity: "Capacity" },
    );

    expect(codes(validateProductImportRow(product))).toEqual(
      expect.arrayContaining(["PRODUCT_NAME_REQUIRED", "PRODUCT_KIND_INVALID"]),
    );
  });
});
