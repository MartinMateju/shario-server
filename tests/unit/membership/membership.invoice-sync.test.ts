import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieveInvoice: vi.fn(),
  findOneAndUpdate: vi.fn(),
  exec: vi.fn(),
}));

vi.mock(
  "@/modules/membership/membership.stripe.gateway.js",
  () => ({ retrieveMembershipInvoice: mocks.retrieveInvoice }),
);

vi.mock(
  "@/modules/membership/membership-invoice.schema.js",
  () => ({
    default: { findOneAndUpdate: mocks.findOneAndUpdate },
  }),
);

import { syncMembershipInvoice } from "@/modules/membership/services/membership-invoice.service.js";

const invoice = {
  id: "in_membership_123",
  number: "INV-0001",
  status: "paid",
  currency: "czk",
  total: 12_900,
  amount_paid: 12_900,
  amount_due: 0,
  created: 1_721_736_000,
  status_transitions: { paid_at: 1_721_736_100 },
  hosted_invoice_url: "https://invoice.stripe.com/i/acct_test/in_membership_123",
  invoice_pdf: "https://pay.stripe.com/invoice/acct_test/in_membership_123/pdf",
  lines: {
    data: [{ period: { start: 1_721_736_000, end: 1_724_414_400 } }],
  },
} as any;

const membership = {
  _id: "membership_123",
  tenant: "tenant_123",
  user: "user_123",
};

describe("membership invoice sync", () => {
  beforeEach(() => {
    mocks.exec.mockReset().mockResolvedValue({ _id: "local_invoice_123" });
    mocks.findOneAndUpdate.mockReset().mockReturnValue({ exec: mocks.exec });
    mocks.retrieveInvoice.mockReset().mockResolvedValue(invoice);
  });

  it("retrieves webhook invoices in the connected account and idempotently upserts the local snapshot", async () => {
    await syncMembershipInvoice({
      membership,
      connectedAccountId: "acct_tenant_123",
      invoice: invoice.id,
      source: { id: "evt_invoice_paid", created: 1_721_736_101 },
    });

    expect(mocks.retrieveInvoice).toHaveBeenCalledWith("acct_tenant_123", invoice.id);
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      tenant: "tenant_123",
      user: "user_123",
      membership: "membership_123",
      connectedAccountId: "acct_tenant_123",
      stripeInvoiceId: invoice.id,
    });
    expect(update).toMatchObject({
      $set: {
        status: "paid",
        currency: "CZK",
        totalAmountMinor: 12_900,
        amountPaidMinor: 12_900,
        amountDueMinor: 0,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdfUrl: invoice.invoice_pdf,
        lastStripeEventId: "evt_invoice_paid",
      },
      $max: { lastStripeEventCreated: 1_721_736_101 },
    });
    expect(options).toMatchObject({ upsert: true, runValidators: true, setDefaultsOnInsert: true });
  });

  it("accepts an invoice returned by connected-account listing without retrieving it again", async () => {
    await syncMembershipInvoice({
      membership,
      connectedAccountId: "acct_tenant_123",
      invoice,
      source: { id: `reconcile:subscription-invoice:${invoice.id}`, created: 1_721_736_200 },
    });

    expect(mocks.retrieveInvoice).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
