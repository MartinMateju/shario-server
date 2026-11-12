import { describe, expect, it } from "vitest";

import {
  membershipInvoiceLocalUrl,
  serializeMembershipInvoice,
  serializePlan,
} from "@/modules/membership/membership.serializers.js";
import {
  assertMembershipIdempotencyIdentity,
  membershipIdentityHash,
} from "@/modules/membership/membership.idempotency.js";
import { versionMatchesLocation } from "@/modules/membership/services/membership-plan.service.js";
import { membershipCheckoutUrls, membershipStripeIdempotencyKey } from "@/modules/membership/services/membership-checkout.service.js";
import { isTerminalCheckoutFailure } from "@/modules/membership/services/membership-checkout-recovery.service.js";
import {
  fixedPeriodFromPaymentConfirmation,
  isMembershipStripeEvent,
  membershipStatusFromSubscription,
} from "@/modules/membership/services/membership-webhook.service.js";

const published = {
  _id: "507f1f77bcf86cd799439012",
  status: "published",
  version: 1,
  name: "Public name",
  description: "Public description",
  terms: "Published terms",
  prices: [{ currency: "CZK", amountMinor: 10_000 }],
  billing: { type: "recurring", interval: "month", intervalCount: 1 },
  locationScope: { type: "all", locationIds: [] },
  benefits: [],
};

describe("membership API invariants", () => {
  it.each(["en", "cs"] as const)("returns cancelled checkout through the existing %s cancellation page with its selected studio", (locale) => {
    const urls = membershipCheckoutUrls({ slug: "clay" }, {
      planId: "507f1f77bcf86cd799439011",
      currency: "CZK",
      termsAccepted: true,
      locale,
      locationId: "507f1f77bcf86cd799439012",
      origin: "https://unrelated.example",
    });
    const cancel = new URL(urls.cancelUrl);
    expect(cancel.origin).not.toBe("https://unrelated.example");
    expect(cancel.pathname).toBe(`/${locale}/memberships/checkout/cancel`);
    expect(cancel.searchParams.get("checkout")).toBe("cancelled");
    expect(cancel.searchParams.get("location")).toBe("507f1f77bcf86cd799439012");
    expect(urls.successUrl).toContain(`/${locale}/memberships/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
  });

  it("does not invent a selected studio for an all-location checkout return", () => {
    const urls = membershipCheckoutUrls({ slug: "clay" }, {
      planId: "507f1f77bcf86cd799439011",
      currency: "CZK", termsAccepted: true, locale: "en",
    });
    expect(new URL(urls.cancelUrl).searchParams.has("location")).toBe(false);
  });

  it("never leaks a newer draft through a public plan serializer", () => {
    const plan = {
      _id: "507f1f77bcf86cd799439011",
      status: "published",
      currentPublishedVersion: published,
      currentDraftVersion: { ...published, _id: "507f1f77bcf86cd799439013", version: 2, status: "draft", name: "Secret draft" },
    };
    expect(serializePlan(plan).name).toBe("Public name");
    expect((serializePlan(plan) as any).draftVersion).toBeUndefined();
    expect(serializePlan(plan, { owner: true }).name).toBe("Secret draft");
  });

  it("enforces selected location scope", () => {
    expect(versionMatchesLocation({ locationScope: { type: "selected", locationIds: ["a"] } }, "a")).toBe(true);
    expect(versionMatchesLocation({ locationScope: { type: "selected", locationIds: ["a"] } }, "b")).toBe(false);
    expect(versionMatchesLocation({ locationScope: { type: "all", locationIds: [] } }, "b")).toBe(true);
  });

  it("validates idempotency identity, independent of object key order", () => {
    const first = membershipIdentityHash({ planId: "p", amount: 2 });
    const same = membershipIdentityHash({ amount: 2, planId: "p" });
    const other = membershipIdentityHash({ amount: 3, planId: "p" });
    expect(first).toBe(same);
    expect(() => assertMembershipIdempotencyIdentity(first, same)).not.toThrow();
    expect(() => assertMembershipIdempotencyIdentity(first, other)).toThrow(/different membership operation/i);
  });

  it("scopes Stripe idempotency to the replacement membership identity", () => {
    const first = membershipStripeIdempotencyKey("tenant-1", "membership-1", "frontend-key-1");
    const replacement = membershipStripeIdempotencyKey("tenant-1", "membership-2", "frontend-key-1");
    expect(first).not.toBe(replacement);
    expect(first).toContain("membership-1");
    expect(replacement).toContain("membership-2");
  });

  it("serializes only local membership invoice URLs", () => {
    const invoice = serializeMembershipInvoice({
      _id: "507f1f77bcf86cd799439014",
      status: "paid",
      currency: "CZK",
      totalAmountMinor: 100,
      amountPaidMinor: 100,
      amountDueMinor: 0,
      hostedInvoiceUrl: "https://invoice.stripe.com/secret",
      invoicePdfUrl: "https://pay.stripe.com/secret.pdf",
    });
    expect(invoice.url).toBe(membershipInvoiceLocalUrl("507f1f77bcf86cd799439014"));
    expect(invoice.documentUrl).toMatch(/^\/memberships\/mine\/invoices\/.+\/document$/);
    expect(invoice).not.toHaveProperty("hostedInvoiceUrl");
    expect(invoice).not.toHaveProperty("invoicePdfUrl");
  });

  it("routes only namespaced membership events while allowing invoice mapping", () => {
    expect(isMembershipStripeEvent({
      type: "checkout.session.completed",
      data: { object: { metadata: { sharioFlow: "customer_membership_v1" } } },
    } as any)).toBe(true);
    expect(isMembershipStripeEvent({
      type: "checkout.session.completed",
      data: { object: { metadata: { sharioFlow: "order_checkout" } } },
    } as any)).toBe(false);
    expect(isMembershipStripeEvent({
      type: "invoice.payment_failed",
      data: { object: {} },
    } as any)).toBe(true);
    expect(isMembershipStripeEvent({
      type: "checkout.session.async_payment_failed",
      data: { object: { metadata: { sharioFlow: "customer_membership_v1" } } },
    } as any)).toBe(true);
  });

  it("maps current Stripe subscription lifecycle states deterministically", () => {
    const subscription = (status: string, cancelAtPeriodEnd = false) => ({
      status,
      cancel_at_period_end: cancelAtPeriodEnd,
    }) as any;

    expect(membershipStatusFromSubscription(subscription("active"))).toBe("active");
    expect(membershipStatusFromSubscription(subscription("active", true))).toBe("cancel_scheduled");
    expect(membershipStatusFromSubscription(subscription("past_due"))).toBe("past_due");
    expect(membershipStatusFromSubscription(subscription("paused"))).toBe("paused");
    expect(membershipStatusFromSubscription(subscription("canceled"))).toBe("cancelled");
  });

  it("starts fixed terms at confirmed payment and preserves the period on replay", () => {
    const membership = {
      _id: "membership-fixed",
      startedAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      planSnapshot: { billing: { type: "fixed", durationDays: 30 } },
    };
    const first = fixedPeriodFromPaymentConfirmation({
      membership,
      eventCreated: 1_700_000_000,
      invoicePaidAt: 1_700_000_100,
    });
    expect(first.start).toEqual(new Date(1_700_000_100 * 1000));
    expect(first.end.getTime() - first.start.getTime()).toBe(30 * 86_400_000);

    const replay = fixedPeriodFromPaymentConfirmation({
      membership: {
        ...membership,
        startedAt: first.start,
        currentPeriodStart: first.start,
        currentPeriodEnd: first.end,
      },
      eventCreated: 1_800_000_000,
      invoicePaidAt: 1_800_000_100,
    });
    expect(replay).toEqual(first);
  });

  it("keeps processing/incomplete payments pending and closes only terminal failures", () => {
    const session = (overrides: Record<string, unknown>) => ({
      status: "complete",
      payment_status: "unpaid",
      payment_intent: null,
      subscription: null,
      ...overrides,
    }) as any;
    expect(isTerminalCheckoutFailure(session({
      payment_intent: { status: "processing" },
    }))).toBe(false);
    expect(isTerminalCheckoutFailure(session({
      payment_intent: { status: "requires_payment_method" },
    }))).toBe(true);
    expect(isTerminalCheckoutFailure(session({
      subscription: {
        status: "incomplete",
        latest_invoice: { payment_intent: { status: "requires_payment_method" } },
      },
    }))).toBe(false);
    expect(isTerminalCheckoutFailure(session({
      subscription: { status: "incomplete_expired" },
    }))).toBe(true);
    for (const status of ["active", "past_due", "unpaid"]) {
      expect(isTerminalCheckoutFailure(session({
        subscription: { status, latest_invoice: { payment_intent: { status: "requires_payment_method" } } },
      }))).toBe(false);
    }
  });
});
