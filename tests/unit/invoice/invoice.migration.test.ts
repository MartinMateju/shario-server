import { describe, expect, it } from "vitest";

import {
  getInvoiceNumberingBackfillDecision,
  getIssuedCustomerLinkMismatchReasons,
  parseStoredInvoiceNumber,
} from "@/modules/invoice/invoice-migration.service.js";

describe("invoice foundation migration", () => {
  it("parses and safely plans only unambiguous numbering backfills", () => {
    expect(parseStoredInvoiceNumber("INV-2026-000123")).toEqual({
      series: "INV-2026",
      sequence: 123,
    });
    expect(parseStoredInvoiceNumber("INV-2026-not-a-number")).toBeNull();
    expect(
      getInvoiceNumberingBackfillDecision({
        number: "INV-2026-000123",
        series: null,
        sequence: null,
      }),
    ).toEqual({
      status: "candidate",
      series: "INV-2026",
      sequence: 123,
      set: { series: "INV-2026", sequence: 123 },
    });
  });

  it("does not overwrite numbering that conflicts with the stored number", () => {
    expect(
      getInvoiceNumberingBackfillDecision({
        number: "INV-2026-000123",
        series: "OTHER-2026",
        sequence: null,
      }),
    ).toMatchObject({ status: "conflict", reason: "SERIES_MISMATCH" });
    expect(
      getInvoiceNumberingBackfillDecision({
        number: "INV-2026-000123",
        series: "INV-2026",
        sequence: 124,
      }),
    ).toMatchObject({ status: "conflict", reason: "SEQUENCE_MISMATCH" });
  });

  it("audits linked-customer identity without treating legal fields as identity", () => {
    expect(
      getIssuedCustomerLinkMismatchReasons({
        snapshot: {
          firstname: "Ada",
          lastname: "Lovelace",
          email: "ADA@example.test",
          phone: "+420 111",
          legalName: "Different billing company s.r.o.",
        },
        user: {
          tenantRole: "customer",
          firstname: "Ada",
          lastname: "Lovelace",
          email: "ada@example.test",
          phone: "+420 111",
        },
      }),
    ).toEqual([]);
  });

  it("quarantines missing, non-customer, or mismatched account links", () => {
    expect(
      getIssuedCustomerLinkMismatchReasons({ snapshot: {}, user: null }),
    ).toEqual(["CUSTOMER_USER_MISSING"]);
    expect(
      getIssuedCustomerLinkMismatchReasons({
        snapshot: {
          firstname: "Customer B",
          lastname: "Person",
          email: "b@example.test",
          phone: "222",
        },
        user: {
          tenantRole: "admin",
          firstname: "Customer A",
          lastname: "Person",
          email: "a@example.test",
          phone: "111",
        },
      }),
    ).toEqual([
      "CUSTOMER_ROLE_INVALID",
      "FIRSTNAME_MISMATCH",
      "EMAIL_MISMATCH",
      "PHONE_MISMATCH",
    ]);
  });
});
