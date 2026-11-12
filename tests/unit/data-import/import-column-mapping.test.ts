import { describe, expect, it } from "vitest";

import {
  assertValidCustomerColumnMapping,
  suggestCreditColumnMapping,
  suggestCustomerColumnMapping,
} from "@/modules/data-import/services/import-column-mapping.service.js";

describe("customer import column mapping", () => {
  it("suggests exact English and Czech aliases without fuzzy guessing", () => {
    expect(
      suggestCustomerColumnMapping([
        "Jméno",
        "Příjmení",
        "Mail",
        "Mobil",
        "Favorite glaze",
      ]),
    ).toEqual({
      firstName: "Jméno",
      lastName: "Příjmení",
      email: "Mail",
      phone: "Mobil",
    });
  });

  it("accepts a name-only mapping and rejects duplicate source use", () => {
    expect(
      assertValidCustomerColumnMapping(["Customer"], {
        fullName: "Customer",
      }),
    ).toEqual({ fullName: "Customer" });

    expect(() =>
      assertValidCustomerColumnMapping(["Name"], {
        firstName: "Name",
        lastName: "Name",
      }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_SOURCE_DUPLICATE" }),
    );
  });

  it("requires at least one mapped name field", () => {
    expect(() =>
      assertValidCustomerColumnMapping(["Email"], { email: "Email" }),
    ).toThrow(
      expect.objectContaining({ code: "IMPORT_MAPPING_NAME_REQUIRED" }),
    );
  });

  it("maps the combined customer and opening-credit template", () => {
    const headers = [
      "Full Name",
      "Email",
      "Phone",
      "Customer External ID",
      "Legacy Password Hash (bcrypt)",
      "Opening Credit Balance",
      "Credit Currency",
    ];
    expect(suggestCustomerColumnMapping(headers)).toEqual({
      fullName: "Full Name",
      email: "Email",
      phone: "Phone",
      externalId: "Customer External ID",
      passwordHash: "Legacy Password Hash (bcrypt)",
    });
    expect(suggestCreditColumnMapping(headers)).toEqual({
      customerExternalId: "Customer External ID",
      customerEmail: "Email",
      customerPhone: "Phone",
      balance: "Opening Credit Balance",
      currency: "Credit Currency",
    });
  });
});
