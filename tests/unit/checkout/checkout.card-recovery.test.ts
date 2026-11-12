import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import {
  assertNoUnattachedCardOrder,
  assertPersistedCardCartSnapshot,
  assertPersistedCardOrderSnapshot,
  assertReusablePendingWorkshopBooking,
  assertStripeCheckoutSessionIsAttachable,
  recoverAttachedCardCheckout,
} from "@/modules/checkout/checkout.card-recovery.js";

const TENANT_ID = "64b000000000000000000301";
const ORDER_ID = "64b000000000000000000302";
const ACCOUNT_ID = "acct_recovery";

const buildSession = (
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session =>
  ({
    id: "cs_recovery",
    object: "checkout.session",
    amount_total: 12_500,
    client_reference_id: ORDER_ID,
    currency: "czk",
    livemode: false,
    metadata: {
      sharioManaged: "true",
      sharioFlow: "order",
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      expectedAmountMinor: "12500",
    },
    status: "open",
    url: "https://checkout.stripe.test/c/pay/cs_recovery",
    ...overrides,
  }) as Stripe.Checkout.Session;

const buildOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: ORDER_ID,
  currency: "CZK",
  expectedAmountMinor: 12_500,
  appliedDiscount: { source: "membership", amountMinor: 500 },
  stripe: {
    connectedAccountId: ACCOUNT_ID,
    sessionId: "cs_recovery",
    livemode: false,
  },
  ...overrides,
});

describe("card checkout crash recovery", () => {
  it("retrieves and reconstructs the attached Session response", async () => {
    const retrieveSession = vi.fn().mockResolvedValue(buildSession());

    await expect(
      recoverAttachedCardCheckout({
        tenantId: TENANT_ID,
        connectedAccountId: ACCOUNT_ID,
        order: buildOrder(),
        retrieveSession,
      }),
    ).resolves.toEqual({
      url: "https://checkout.stripe.test/c/pay/cs_recovery",
      orderId: ORDER_ID,
      sessionId: "cs_recovery",
      appliedDiscount: { source: "membership", amountMinor: 500 },
    });

    expect(retrieveSession).toHaveBeenCalledWith("cs_recovery");
  });

  it("does not call Stripe when no Session was attached", async () => {
    const retrieveSession = vi.fn();

    await expect(
      recoverAttachedCardCheckout({
        tenantId: TENANT_ID,
        connectedAccountId: ACCOUNT_ID,
        order: buildOrder({
          stripe: {
            connectedAccountId: ACCOUNT_ID,
            sessionId: "",
            livemode: null,
          },
        }),
        retrieveSession,
      }),
    ).resolves.toBeNull();

    expect(retrieveSession).not.toHaveBeenCalled();
  });

  it("rejects a Session whose tenant/order/amount identity was changed", async () => {
    const retrieveSession = vi.fn().mockResolvedValue(
      buildSession({
        metadata: {
          sharioManaged: "true",
          sharioFlow: "order",
          tenantId: TENANT_ID,
          orderId: "64b000000000000000000399",
          expectedAmountMinor: "12500",
        },
      }),
    );

    await expect(
      recoverAttachedCardCheckout({
        tenantId: TENANT_ID,
        connectedAccountId: ACCOUNT_ID,
        order: buildOrder(),
        retrieveSession,
      }),
    ).rejects.toMatchObject({
      code: "CHECKOUT_SESSION_RECOVERY_MISMATCH",
    });
  });

  it("rejects an attached Session that has expired", async () => {
    await expect(
      recoverAttachedCardCheckout({
        tenantId: TENANT_ID,
        connectedAccountId: ACCOUNT_ID,
        order: buildOrder(),
        retrieveSession: vi
          .fn()
          .mockResolvedValue(buildSession({ status: "expired", url: null })),
      }),
    ).rejects.toMatchObject({ code: "CHECKOUT_SESSION_EXPIRED" });
  });

  it("detects an expired deterministic Session before attachment", () => {
    expect(() =>
      assertStripeCheckoutSessionIsAttachable(
        buildSession({ status: "expired", url: null }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CHECKOUT_SESSION_EXPIRED" }),
    );
  });

  it("fails closed when a stable order exists without an attached Session", () => {
    expect(() =>
      assertNoUnattachedCardOrder(
        buildOrder({
          stripe: {
            connectedAccountId: ACCOUNT_ID,
            sessionId: "",
            livemode: null,
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_PERSISTED_SNAPSHOT_UNATTACHED",
      }),
    );
  });

  it("rejects a duplicate persisted order with a different immutable snapshot", () => {
    const expected = {
      _id: ORDER_ID,
      cart: "64b000000000000000000303",
      currency: "CZK",
      expectedAmountMinor: 12_500,
      lineItems: [{ description: "Open Studio", grossAmountMinor: 12_500 }],
      workshopBookings: ["64b000000000000000000304"],
    };
    const persisted = {
      ...expected,
      expectedAmountMinor: 13_000,
      lineItems: [
        {
          _id: "64b000000000000000000305",
          description: "Open Studio",
          grossAmountMinor: 13_000,
        },
      ],
    };

    expect(() =>
      assertPersistedCardOrderSnapshot(persisted, expected),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_PERSISTED_SNAPSHOT_CONFLICT",
      }),
    );
  });

  it("accepts the same snapshot while ignoring generated subdocument ids", () => {
    const expected = {
      _id: ORDER_ID,
      currency: "CZK",
      expectedAmountMinor: 12_500,
      lineItems: [{ description: "Open Studio", grossAmountMinor: 12_500 }],
    };

    expect(() =>
      assertPersistedCardOrderSnapshot(
        {
          ...expected,
          lineItems: [
            {
              _id: "64b000000000000000000305",
              description: "Open Studio",
              grossAmountMinor: 12_500,
            },
          ],
        },
        expected,
      ),
    ).not.toThrow();
  });

  it("rejects a stale persisted cart before an order or Session is created", () => {
    const expected = {
      _id: "64b000000000000000000303",
      user: "64b000000000000000000306",
      currency: "CZK",
      expectedAmountMinor: 12_500,
      cartItems: [{ quantity: 1, price: 125 }],
    };

    expect(() =>
      assertPersistedCardCartSnapshot(
        {
          ...expected,
          expectedAmountMinor: 13_000,
          cartItems: [{ quantity: 1, price: 130 }],
        },
        expected,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_PERSISTED_SNAPSHOT_CONFLICT",
      }),
    );
  });

  it("does not create Stripe for an expired deterministic booking on a reclaimed operation", async () => {
    const createStripeSession = vi.fn();
    const resumeReclaimedCheckout = async () => {
      assertReusablePendingWorkshopBooking(
        {
          status: "pending",
          paymentStatus: "PENDING_PAYMENT",
          paymentExpiresAt: new Date("2026-08-04T09:59:59.000Z"),
        },
        new Date("2026-08-04T10:00:00.000Z"),
        new Date("2026-08-05T10:00:00.000Z"),
      );

      return createStripeSession();
    };

    await expect(resumeReclaimedCheckout()).rejects.toMatchObject({
      code: "CHECKOUT_WORKSHOP_RESERVATION_NOT_REUSABLE",
    });
    expect(createStripeSession).not.toHaveBeenCalled();
  });

  it("rejects an unexpired reused booking whose hold is shorter than the new Session", () => {
    expect(() =>
      assertReusablePendingWorkshopBooking(
        {
          status: "pending",
          paymentStatus: "PENDING_PAYMENT",
          paymentExpiresAt: new Date("2026-08-04T11:00:00.000Z"),
        },
        new Date("2026-08-04T10:00:00.000Z"),
        new Date("2026-08-05T10:00:00.000Z"),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CHECKOUT_WORKSHOP_RESERVATION_NOT_REUSABLE",
      }),
    );
  });
});
