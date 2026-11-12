import { describe, expect, it } from "vitest";

import {
  assertValidBookingColumnMapping,
  assertValidProductColumnMapping,
  suggestBookingColumnMapping,
  suggestProductColumnMapping,
} from "@/modules/data-import/services/import-column-mapping.service.js";

describe("product and booking import column mapping", () => {
  it("suggests English and Czech product aliases deterministically", () => {
    expect(
      suggestProductColumnMapping([
        "Název služby",
        "Typ služby",
        "Cena",
        "Kapacita",
        "Aktivní",
        "Unrelated",
      ]),
    ).toEqual({
      name: "Název služby",
      kind: "Typ služby",
      price: "Cena",
      capacity: "Kapacita",
      isActive: "Aktivní",
    });
  });

  it("requires both product name and kind mappings", () => {
    expect(
      assertValidProductColumnMapping(["Name", "Kind"], {
        name: "Name",
        kind: "Kind",
      }),
    ).toEqual({ name: "Name", kind: "Kind" });

    expect(() =>
      assertValidProductColumnMapping(["Name"], { name: "Name" }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_PRODUCT_REQUIRED" }),
    );
    expect(() =>
      assertValidProductColumnMapping(["Kind"], { kind: "Kind" }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_PRODUCT_REQUIRED" }),
    );
  });

  it("maps From and To as local times rather than absolute timestamps", () => {
    expect(
      suggestBookingColumnMapping([
        "Service",
        "Date",
        "From",
        "To",
        "Customer Email",
      ]),
    ).toEqual({
      customerEmail: "Customer Email",
      productName: "Service",
      date: "Date",
      startTime: "From",
      endTime: "To",
    });
  });

  it("accepts either complete booking time shape and rejects partial shapes", () => {
    expect(
      assertValidBookingColumnMapping(["SKU", "Start", "End"], {
        productSku: "SKU",
        start: "Start",
        end: "End",
      }),
    ).toEqual({ productSku: "SKU", start: "Start", end: "End" });

    expect(
      assertValidBookingColumnMapping(["Service", "Date", "From", "To"], {
        productName: "Service",
        date: "Date",
        startTime: "From",
        endTime: "To",
      }),
    ).toEqual({
      productName: "Service",
      date: "Date",
      startTime: "From",
      endTime: "To",
    });

    expect(() =>
      assertValidBookingColumnMapping(["Service", "Date", "From"], {
        productName: "Service",
        date: "Date",
        startTime: "From",
      }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_BOOKING_TIME_REQUIRED" }),
    );
  });

  it("requires one product identity and never reuses a source column", () => {
    expect(() =>
      assertValidBookingColumnMapping(["Start", "End"], {
        start: "Start",
        end: "End",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "IMPORT_MAPPING_BOOKING_PRODUCT_REQUIRED",
      }),
    );

    expect(() =>
      assertValidBookingColumnMapping(["Service", "Start", "End"], {
        productName: "Service",
        productSku: "Service",
        start: "Start",
        end: "End",
      }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_SOURCE_DUPLICATE" }),
    );
  });
});
