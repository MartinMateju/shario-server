import mongoose, { type ClientSession } from "mongoose";
import UserMembership from "../user-membership.model.js";
import { PaymentRefundReconciliation } from "@/modules/tenant-payments/payment-refund-reconciliation.model.js";
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
  session?: ClientSession;
}): Promise<Stripe.Invoice> => {
  const invoice = typeof input.invoice === "string"
    ? await retrieveMembershipInvoice(input.connectedAccountId, input.invoice)
    : input.invoice;
  const linePeriod = invoice.lines?.data?.[0]?.period;
  const write = async (session: ClientSession) => {
    // Reconciliation and invoice materialization write the same membership. This
    // also serializes the case where no local invoice/refund row exists yet.
    await UserMembership.updateOne({ _id: input.membership._id, tenant: input.membership.tenant }, { $inc: { refundReconciliationRevision: 1 } }, { session });
    const refund = await PaymentRefundReconciliation.findOne({ tenant: input.membership.tenant,
      membership: input.membership._id, connectedAccountId: input.connectedAccountId, stripeInvoiceId: invoice.id }).session(session).lean().exec() as any;

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
          ...(refund?.summary ? { refund: refund.summary } : {}),
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
      { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true, session },
    ).exec();

  };
  if (input.session) await write(input.session);
  else await mongoose.connection.transaction(write);

  return invoice;
};
