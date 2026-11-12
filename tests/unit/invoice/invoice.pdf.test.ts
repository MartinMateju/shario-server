import { describe, expect, it } from "vitest";

import { renderInvoicePdf } from "@/modules/invoice/invoice.pdf.service.js";

describe("invoice PDF", () => {
  it("renders Czech Unicode, credit references, and payment details", async () => {
    const pdf = await renderInvoicePdf({
      documentType: "credit_note",
      number: "CN-2026-000001",
      originalInvoiceNumber: "INV-2026-000001",
      creditReason:
        "Vrácení platby za zrušenou lekci – příliš žluťoučký kůň úpěl ďábelské ódy.",
      locale: "cs",
      timezone: "Europe/Prague",
      currency: "CZK",
      sellerSnapshot: {
        legalName: "Keramické studio Žďár s.r.o.",
        email: "fakturace@example.test",
        phone: "+420 123 456 789",
        address: { line1: "Česká 1", city: "Brno", country: "Česko" },
        bank: {
          accountName: "Keramické studio",
          accountNumber: "123456789/0100",
          iban: "CZ6508000000192000145399",
          bic: "GIBACZPX",
        },
      },
      customerSnapshot: {
        legalName: "Odběratel s.r.o.",
        address: { line1: "Příční 2", city: "Praha", country: "Česko" },
      },
      lineItems: [
        {
          description: "Částečné vrácení za keramickou lekci",
          quantity: 1,
          taxRateBps: 2_100,
          grossAmountMinor: 1_000,
        },
      ],
      netAmountMinor: 826,
      taxAmountMinor: 174,
      totalAmountMinor: 1_000,
      amountPaidMinor: 0,
      amountDueMinor: 0,
      issueDate: new Date("2026-07-21T22:00:00Z"),
      dueDate: new Date("2026-07-21T22:00:00Z"),
      taxableSupplyDate: new Date("2026-07-21T22:00:00Z"),
    });

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(5_000);
  });
});
