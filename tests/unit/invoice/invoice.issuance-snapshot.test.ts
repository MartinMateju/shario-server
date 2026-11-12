import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildInvoiceIssuanceSnapshot,
  resolveInvoiceIssuanceSnapshot,
} from "@/modules/invoice/invoice-issuance-snapshot.js";
import { renderInvoicePdf } from "@/modules/invoice/invoice.pdf.service.js";

const issuedInvoice = (): any => ({
  documentType: "invoice",
  documentStatus: "issued",
  number: "INV-2026-000001",
  locale: "en",
  timezone: "Europe/Prague",
  currency: "EUR",
  sellerSnapshot: {
    legalName: "Stable Studio s.r.o.",
    email: "billing@example.test",
    address: { line1: "Main 1", city: "Brno", country: "Czechia" },
    bank: { iban: "CZ6508000000192000145399" },
  },
  customerSnapshot: {
    legalName: "Customer Ltd.",
    address: { line1: "Customer 2", city: "Prague", country: "Czechia" },
  },
  lineItems: [
    {
      description: "Pottery course",
      quantity: 1,
      grossAmountMinor: 1_000,
      netAmountMinor: 826,
      taxAmountMinor: 174,
      taxRateBps: 2_100,
      creditedAmountMinor: 0,
    },
  ],
  netAmountMinor: 826,
  taxAmountMinor: 174,
  totalAmountMinor: 1_000,
  amountPaidMinor: 0,
  amountDueMinor: 1_000,
  creditedAmountMinor: 0,
  paymentStatus: "unpaid",
  paymentAllocations: [],
  issueDate: new Date("2026-07-21T08:00:00.000Z"),
  dueDate: new Date("2026-08-04T08:00:00.000Z"),
  taxableSupplyDate: new Date("2026-07-21T08:00:00.000Z"),
});

const sha256 = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

describe("invoice issuance snapshots", () => {
  it("freezes every legal PDF input while settlement and credit state changes", async () => {
    const invoice = issuedInvoice();
    const issuanceSnapshot = buildInvoiceIssuanceSnapshot(invoice);
    const stored = { ...invoice, issuanceSnapshot };
    const firstPdf = await renderInvoicePdf(stored);

    stored.amountPaidMinor = 1_000;
    stored.amountDueMinor = 0;
    stored.paymentStatus = "paid";
    stored.creditedAmountMinor = 400;
    stored.paymentAllocations = [
      { method: "bank_transfer", amountMinor: 1_000, reversedAt: null },
    ];
    stored.lineItems[0].creditedAmountMinor = 400;
    const secondPdf = await renderInvoicePdf(stored);

    expect(resolveInvoiceIssuanceSnapshot(stored)).toEqual(issuanceSnapshot);
    expect(sha256(secondPdf)).toBe(sha256(firstPdf));
    expect(issuanceSnapshot).not.toHaveProperty("amountPaidMinor");
    expect(issuanceSnapshot).not.toHaveProperty("amountDueMinor");
    expect(issuanceSnapshot.lineItems[0]).not.toHaveProperty(
      "creditedAmountMinor",
    );
  });

  it("keeps legacy PDF input independent from mutable settlement fields", () => {
    const invoice = issuedInvoice();
    const before = resolveInvoiceIssuanceSnapshot(invoice);

    invoice.amountPaidMinor = 500;
    invoice.amountDueMinor = 500;
    invoice.paymentStatus = "partially_paid";
    invoice.creditedAmountMinor = 200;
    invoice.lineItems[0].creditedAmountMinor = 200;

    expect(resolveInvoiceIssuanceSnapshot(invoice)).toEqual(before);
  });
});
