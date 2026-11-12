import { describe, expect, it } from "vitest";

import {
  buildConnectedAccountCreateParams,
  deriveTenantPaymentOnboardingStatus,
  getConnectedAccountRequestOptions,
  toTenantPaymentAccountSnapshot,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";

const account = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "acct_test",
    object: "account",
    country: "cz",
    default_currency: "czk",
    details_submitted: false,
    charges_enabled: false,
    payouts_enabled: false,
    livemode: false,
    requirements: {
      currently_due: ["business_profile.url"],
      eventually_due: ["business_profile.url"],
      past_due: [],
      pending_verification: [],
      disabled_reason: null,
    },
    ...overrides,
  }) as any;

describe("tenant payment Stripe gateway", () => {
  it("creates the modern full-dashboard controller without country or capabilities", () => {
    const params = buildConnectedAccountCreateParams({
      tenantId: "507f1f77bcf86cd799439011",
      tenantName: "Studio Grohovka",
      ownerEmail: " Owner@Example.com ",
    });

    expect(params).toMatchObject({
      email: "owner@example.com",
      controller: {
        fees: { payer: "account" },
        losses: { payments: "stripe" },
        requirement_collection: "stripe",
        stripe_dashboard: { type: "full" },
      },
      metadata: {
        sharioTenantId: "507f1f77bcf86cd799439011",
      },
    });
    expect(params).not.toHaveProperty("country");
    expect(params).not.toHaveProperty("capabilities");
    expect(params).not.toHaveProperty("type");
  });

  it("marks only fully enabled accounts complete", () => {
    expect(deriveTenantPaymentOnboardingStatus(account())).toBe("pending");
    expect(
      deriveTenantPaymentOnboardingStatus(
        account({
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          requirements: {
            currently_due: [],
            eventually_due: [],
            past_due: [],
            pending_verification: [],
            disabled_reason: null,
          },
        }),
      ),
    ).toBe("complete");
  });

  it("marks disabled and past-due accounts restricted", () => {
    expect(
      deriveTenantPaymentOnboardingStatus(
        account({
          details_submitted: true,
          requirements: {
            currently_due: [],
            eventually_due: [],
            past_due: ["external_account"],
            pending_verification: [],
            disabled_reason: "requirements.past_due",
          },
        }),
      ),
    ).toBe("restricted");
  });

  it("persists status and requirement names without KYC values", () => {
    const snapshot = toTenantPaymentAccountSnapshot(
      account({
        requirements: {
          currently_due: ["person.verification.document"],
          eventually_due: [],
          past_due: [],
          pending_verification: [],
          disabled_reason: null,
        },
      }),
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(snapshot.country).toBe("CZ");
    expect(snapshot.defaultCurrency).toBe("czk");
    expect(snapshot.requirements.currentlyDue).toEqual([
      "person.verification.document",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("bank_account");
  });

  it("builds request options that cannot omit connected-account context", () => {
    expect(
      getConnectedAccountRequestOptions("acct_test", {
        idempotencyKey: "order-1",
      }),
    ).toEqual({ stripeAccount: "acct_test", idempotencyKey: "order-1" });
    expect(() => getConnectedAccountRequestOptions("cus_wrong")).toThrow(
      "connected account",
    );
  });
});

