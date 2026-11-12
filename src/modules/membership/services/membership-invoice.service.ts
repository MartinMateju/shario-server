import type Stripe from "stripe";

import MembershipInvoiceModel from "../membership-invoice.schema.js";
import { MEMBERSHIP_INVOICE_STATUS } from "../membership.constants.js";
import { retrieveMembershipInvoice } from "../membership.stripe.gateway.js";

type InvoiceSyncSource = {
  id: string;
  created: number;
};

const normalizedInvoiceStatus = (invoice: Stripe.Invoice) =>
  invoice.status && Object.values(MEMBERSHIP_INVOICE_STATUS).includes(invoice.status as any)
    ? invoice.status
    : MEMBERSHIP_INVOICE_STATUS.DRAFT;

/**
 * Idempotently materializes a Stripe invoice as a local MembershipInvoice.
 * Passing an id forces a fresh direct connected-account retrieval (webhooks);
 * passing an Invoice is reserved for objects returned by an authenticated
 * connected-account list/retrieve operation (reconciliation).
 */
export const syncMembershipInvoice = async (input: {
  membership: any;
  connectedAccountId: string;
  invoice: Stripe.Invoice | string;
  source: InvoiceSyncSource;
}): Promise<Stripe.Invoice> => {
  const invoice = typeof input.invoice === "string"
    ? await retrieveMembershipInvoice(input.connectedAccountId, input.invoice)
    : input.invoice;
  const linePeriod = invoice.lines?.data?.[0]?.period;

  await MembershipInvoiceModel.findOneAndUpdate(
    {
      tenant: input.membership.tenant,
      user: input.membership.user,
      membership: input.membership._id,
      connectedAccountId: input.connectedAccountId,
      stripeInvoiceId: invoice.id,
    },
    {
      $setOnInsert: {
        tenant: input.membership.tenant,
        user: input.membership.user,
        membership: input.membership._id,
        connectedAccountId: input.connectedAccountId,
        stripeInvoiceId: invoice.id,
      },
      $set: {
        number: invoice.number ?? "",
        status: normalizedInvoiceStatus(invoice),
        currency: invoice.currency.toUpperCase(),
        totalAmountMinor: invoice.total,
        amountPaidMinor: invoice.amount_paid,
        amountDueMinor: invoice.amount_due,
        periodStart: linePeriod ? new Date(linePeriod.start * 1000) : null,
        periodEnd: linePeriod ? new Date(linePeriod.end * 1000) : null,
        issuedAt: invoice.created ? new Date(invoice.created * 1000) : null,
        paidAt: invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : null,
        // Both raw Stripe URLs are select:false and only served through the
        // existing authenticated local invoice document proxy.
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? "",
        invoicePdfUrl: invoice.invoice_pdf ?? "",
        lastStripeEventId: input.source.id,
      },
      $max: { lastStripeEventCreated: Math.max(input.source.created, 0) },
    },
    { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true },
  ).exec();

  return invoice;
};
