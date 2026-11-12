import type Stripe from "stripe";

import UserMembershipModel from "../user-membership.model.js";
import { MEMBERSHIP_STATUS } from "../membership.constants.js";
import { retrieveMembershipSubscription } from "../membership.stripe.gateway.js";
import { syncMembershipInvoice } from "./membership-invoice.service.js";
import { applyPaymentConfirmed } from "./membership-webhook.service.js";

type RecoveryOutcome = "activated" | "closed" | "pending" | "unchanged";

const expandedPaymentIntent = (checkout: Stripe.Checkout.Session): any =>
  typeof checkout.payment_intent === "object" && checkout.payment_intent
    ? checkout.payment_intent
    : typeof checkout.subscription === "object" && checkout.subscription &&
        typeof (checkout.subscription as any).latest_invoice === "object" &&
        (checkout.subscription as any).latest_invoice &&
        typeof (checkout.subscription as any).latest_invoice.payment_intent === "object"
      ? (checkout.subscription as any).latest_invoice.payment_intent
      : null;

const expandedLatestCharge = (checkout: Stripe.Checkout.Session): any => {
  const paymentIntent = expandedPaymentIntent(checkout);
  return typeof paymentIntent?.latest_charge === "object"
    ? paymentIntent.latest_charge
    : null;
};

const isTerminalCheckoutFailure = (checkout: Stripe.Checkout.Session): boolean => {
  const subscriptionStatus = typeof checkout.subscription === "object" && checkout.subscription
    ? (checkout.subscription as any).status
    : null;
  if (subscriptionStatus === "incomplete_expired" || subscriptionStatus === "canceled") return true;
  // A failed payment method is recoverable while Stripe still has a live
  // recurring subscription (past_due/active/incomplete). Never release the
  // one-open slot while that subscription can collect a subsequent payment.
  if (subscriptionStatus) return false;
  const paymentIntentStatus = expandedPaymentIntent(checkout)?.status;
  // Async methods can leave a completed Session's PaymentIntent processing.
  // Never release the one-open slot until Stripe reaches a definitive failure.
  if (paymentIntentStatus === "processing") return false;
  if (paymentIntentStatus === "canceled") return true;
  if (
    paymentIntentStatus === "requires_payment_method" &&
    (checkout.status === "complete" || checkout.status === "expired")
  ) return true;
  return checkout.status === "expired";
};

export const recoverMembershipCheckout = async (input: {
  membership: any;
  checkout: Stripe.Checkout.Session;
  connectedAccountId: string;
}): Promise<RecoveryOutcome> => {
  const initialUnpaidFailure = !input.membership.startedAt && !input.membership.currentPeriodStart &&
    [MEMBERSHIP_STATUS.PAST_DUE, MEMBERSHIP_STATUS.PAUSED].includes(input.membership.status);
  if (input.membership.status !== MEMBERSHIP_STATUS.PENDING && !initialUnpaidFailure) return "unchanged";

  let checkout = input.checkout;
  if (
    typeof checkout.subscription === "string" &&
    (
      checkout.payment_status !== "paid" ||
      input.membership.planSnapshot.billing.type === "recurring"
    )
  ) {
    const subscription = await retrieveMembershipSubscription(
      input.connectedAccountId,
      checkout.subscription,
    );
    checkout = { ...checkout, subscription } as Stripe.Checkout.Session;
  }

  if (checkout.payment_status === "paid") {
    let invoice: Stripe.Invoice | undefined;
    let confirmationCreated = checkout.created;
    const latestSubscriptionInvoice = typeof checkout.subscription === "object" &&
      checkout.subscription &&
      typeof (checkout.subscription as any).latest_invoice === "object"
      ? (checkout.subscription as any).latest_invoice as Stripe.Invoice
      : undefined;
    const checkoutInvoice = typeof checkout.invoice === "object" && checkout.invoice
      ? checkout.invoice as Stripe.Invoice
      : typeof checkout.invoice === "string"
        ? checkout.invoice
        : latestSubscriptionInvoice;
    if (checkoutInvoice) {
      invoice = await syncMembershipInvoice({
        membership: input.membership,
        connectedAccountId: input.connectedAccountId,
        invoice: checkoutInvoice,
        source: {
          id: `recover:checkout-invoice:${checkout.id}`,
          created: Math.floor(Date.now() / 1000),
        },
      });
    }
    if (input.membership.planSnapshot.billing.type === "fixed") {
      const confirmedAt = invoice?.status_transitions?.paid_at ??
        expandedLatestCharge(checkout)?.created;
      // Session.created is not a payment timestamp. If expansion is temporarily
      // incomplete, keep the record pending and let a webhook/retry establish
      // the full sold duration accurately.
      if (!confirmedAt) return "pending";
      confirmationCreated = confirmedAt;
    }
    await applyPaymentConfirmed({
      id: `recover:checkout:${checkout.id}`,
      type: "checkout.session.completed",
      created: confirmationCreated,
      data: { object: checkout },
    } as any, input.membership, input.connectedAccountId, invoice);
    return "activated";
  }

  if (typeof checkout.subscription === "object" && checkout.subscription) {
    const subscription = checkout.subscription;
    // Keep the recurring identity even when its initial Checkout never gets
    // paid. A later automatic invoice can then be recovered by subscription
    // reconciliation if its webhook is delayed or lost.
    await UserMembershipModel.updateOne(
      { _id: input.membership._id, status: input.membership.status, isOpen: true },
      { $set: {
        "stripe.subscriptionId": subscription.id,
        "stripe.customerId": typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      } },
    ).exec();
  }

  if (!isTerminalCheckoutFailure(checkout)) return "pending";
  const result = await UserMembershipModel.updateOne(
    { _id: input.membership._id, status: input.membership.status, isOpen: true },
    {
      $set: {
        status: MEMBERSHIP_STATUS.EXPIRED,
        isOpen: false,
        autoRenew: false,
        "stripe.lastEventId": `recover:checkout:${checkout.id}:terminal`,
        "stripe.lastEventCreated": Math.floor(Date.now() / 1000),
      },
    },
  ).exec();
  return result.modifiedCount > 0 ? "closed" : "unchanged";
};

export { isTerminalCheckoutFailure };

export default recoverMembershipCheckout;
