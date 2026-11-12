import { describe, expect, it } from "vitest";

import {
  buildLinkableInvoiceCustomerFilter,
  normalizeCustomerSnapshot,
  normalizeLinkedCustomerSnapshot,
  serializeInvoice,
  serializeCustomerInvoice,
  serializePaymentAllocation,
} from "@/modules/invoice/invoice.service.js";
import InvoiceModel from "@/modules/invoice/invoice.schema.js";

describe("invoice serialization", () => {
  it("preserves direct manual billing fields", () => {
    expect(
      normalizeCustomerSnapshot({
        legalName: "Žluťoučká keramika s.r.o.",
        registrationNumber: "12345678",
        taxId: "CZ12345678",
        vatId: "CZ12345678",
        address: { line1: "Česká 1", city: "Brno", country: "Česko" },
        email: "billing@example.test",
      }),
    ).toMatchObject({
      legalName: "Žluťoučká keramika s.r.o.",
      registrationNumber: "12345678",
      taxId: "CZ12345678",
      vatId: "CZ12345678",
      address: { line1: "Česká 1", city: "Brno", country: "Česko" },
    });
  });

  it("derives linked-customer identity while preserving business billing fields", () => {
    expect(
      normalizeLinkedCustomerSnapshot(
        {
          legalName: "Customer B Holdings s.r.o.",
          firstname: "Customer",
          lastname: "B",
          email: "customer-b@example.test",
          phone: "+420222222222",
          vatId: "CZ12345678",
          address: { line1: "Billing 2", city: "Brno" },
        },
        {
          firstname: "Customer",
          lastname: "A",
          email: "CUSTOMER-A@example.test",
          phone: "+420111111111",
        },
      ),
    ).toMatchObject({
      legalName: "Customer B Holdings s.r.o.",
      firstname: "Customer",
      lastname: "A",
      email: "customer-a@example.test",
      phone: "+420111111111",
      vatId: "CZ12345678",
      address: { line1: "Billing 2", city: "Brno" },
    });
  });

  it("only permits a tenant customer account to be linked to an invoice", () => {
    expect(
      buildLinkableInvoiceCustomerFilter({
        tenantId: "tenant-1",
        userId: "user-1",
      }),
    ).toEqual({
      tenant: "tenant-1",
      _id: "user-1",
      tenantRole: "customer",
    });
  });

  it("preserves arbitrary legal-party identity when no user is linked", () => {
    expect(
      normalizeCustomerSnapshot({
        legalName: "External Buyer GmbH",
        firstname: "External",
        lastname: "Buyer",
        email: "accounts@external.example",
      }),
    ).toMatchObject({
      legalName: "External Buyer GmbH",
      firstname: "External",
      lastname: "Buyer",
      email: "accounts@external.example",
    });
  });

  it("does not expose provider or internal delivery data to a customer", () => {
    const result = serializeCustomerInvoice({
      _id: "invoice-1",
      tenant: "tenant-1",
      source: { kind: "order", id: "order-1", key: "secret-key" },
      documentType: "invoice",
      documentStatus: "issued",
      paymentStatus: "paid",
      number: "INV-2026-000001",
      currency: "EUR",
      locale: "en",
      timezone: "Europe/Prague",
      sellerSnapshot: {},
      customerSnapshot: {},
      lineItems: [],
      totalAmountMinor: 100,
      netAmountMinor: 100,
      taxAmountMinor: 0,
      amountPaidMinor: 100,
      amountDueMinor: 0,
      creditedAmountMinor: 0,
      paymentAllocations: [
        { method: "stripe", amountMinor: 100, providerReference: "pi_secret" },
      ],
      stripe: { paymentIntentId: "pi_secret" },
      deliveryLog: [{ providerMessageId: "mail-secret", sentBy: "staff-id" }],
      issuanceError: "internal",
    });

    expect(result).not.toHaveProperty("source");
    expect(result).not.toHaveProperty("stripe");
    expect(result).not.toHaveProperty("paymentAllocations");
    expect(result).not.toHaveProperty("deliveryLog");
    expect(result).not.toHaveProperty("issuanceError");
  });

  it("assigns a stable payment id and hides idempotency audit keys", () => {
    const invoice = new InvoiceModel({
      paymentAllocations: [
        {
          method: "cash",
          amountMinor: 500,
          providerReference: "receipt-1",
          idempotencyKey: "payment:receipt-1",
        },
      ],
    });
    const allocation = invoice.paymentAllocations[0];
    const serialized = serializePaymentAllocation(allocation);

    expect(serialized.id).toMatch(/^[a-f\d]{24}$/i);
    expect(serialized).toMatchObject({
      method: "cash",
      amountMinor: 500,
      reference: "receipt-1",
      active: true,
    });
    expect(serialized).not.toHaveProperty("idempotencyKey");
    expect(serialized).not.toHaveProperty("reversalIdempotencyKey");
  });

  it("exposes payment audit details only when explicitly requested", () => {
    const source = {
      _id: "invoice-1",
      tenant: "tenant-1",
      source: { kind: "manual", id: null },
      documentType: "invoice",
      documentStatus: "issued",
      paymentStatus: "partially_paid",
      currency: "EUR",
      sellerSnapshot: {},
      customerSnapshot: {},
      lineItems: [],
      paymentAllocations: [
        {
          _id: "64b000000000000000000099",
          method: "cash",
          amountMinor: 100,
          providerReference: "receipt-100",
        },
      ],
      stripe: { paymentIntentId: "pi_private" },
    };

    expect(serializeInvoice(source)).not.toHaveProperty("paymentAllocations");
    expect(serializeInvoice(source)).not.toHaveProperty("stripe");
    expect(
      serializeInvoice(source, { includePaymentAudit: true }),
    ).toMatchObject({
      paymentAllocations: [
        expect.objectContaining({ reference: "receipt-100" }),
      ],
    });
    expect(
      serializeInvoice(source, { includePaymentAudit: true }),
    ).not.toHaveProperty("stripe");
  });

  it("redacts provider references even from the payment audit view", () => {
    expect(
      serializePaymentAllocation({
        _id: "64b000000000000000000098",
        method: "stripe",
        amountMinor: 100,
        providerReference: "pi_private",
      }),
    ).toMatchObject({ reference: "" });
  });
});
