import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  waitlistFindOne: vi.fn(),
  waitlistFindOneAndUpdate: vi.fn(),
  waitlistUpdateOne: vi.fn(),
  bookingExists: vi.fn(),
  bookingUpdateOne: vi.fn(),
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    exists: mocks.bookingExists,
    updateOne: mocks.bookingUpdateOne,
  },
}));

vi.mock("@/modules/waitlist/waitlist.model.js", () => ({
  WaitlistEntryModel: {
    findOne: mocks.waitlistFindOne,
    findOneAndUpdate: mocks.waitlistFindOneAndUpdate,
    updateOne: mocks.waitlistUpdateOne,
  },
}));

import {
  applyWaitlistPriceSnapshot,
  claimWaitlistOrderForWebhook,
  getWaitlistOrderDisposition,
  resolveWaitlistCheckoutContext,
  transferWaitlistHoldToOrder,
} from "@/modules/waitlist/waitlist.checkout.service.js";
import {
  assertPersistedCardCartSnapshot,
  assertPersistedCardOrderSnapshot,
  recoverAttachedCardCheckout,
} from "@/modules/checkout/checkout.card-recovery.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ENTRY_ID = "507f1f77bcf86cd799439012";
const SESSION_ID = "507f1f77bcf86cd799439013";
const PRODUCT_ID = "507f1f77bcf86cd799439014";
const ORDER_ID = "507f1f77bcf86cd799439015";
const CUSTOMER_ID = "507f1f77bcf86cd799439016";
const NOW = new Date("2026-08-07T10:00:00.000Z");

const execQuery = (value: unknown) => ({
  exec: vi.fn().mockResolvedValue(value),
});
const leanQuery = (value: unknown) => ({
  lean: vi.fn(() => execQuery(value)),
});
const selectLeanQuery = (value: unknown) => ({
  select: vi.fn(() => leanQuery(value)),
});
const selectSessionQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    session: vi.fn(() => execQuery(value)),
  })),
});

const offeredEntry = {
  _id: ENTRY_ID,
  tenant: TENANT_ID,
  courseSession: SESSION_ID,
  product: PRODUCT_ID,
  customer: CUSTOMER_ID,
  identityKey: "identity",
  state: "offered",
  isLive: true,
  offerGeneration: 3,
  offerExpiresAt: new Date("2026-08-07T11:00:00.000Z"),
  sessionStartSnapshot: new Date("2026-08-08T10:00:00.000Z"),
  priceSnapshot: {
    amountMinor: 25_000,
    currency: "CZK",
    version: "price-v1",
    productId: PRODUCT_ID,
  },
};

describe("waitlist checkout state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies the immutable price without mutating unrelated products and fails on currency drift", () => {
    const context = {
      entryId: ENTRY_ID,
      sessionId: SESSION_ID,
      productId: PRODUCT_ID,
      offerGeneration: 3,
      offerExpiresAt: offeredEntry.offerExpiresAt,
      orderId: ORDER_ID,
      cartItems: [],
      price: {
        amountMinor: 25_000,
        amount: 250,
        currency: "CZK" as const,
        version: "price-v1",
        productId: PRODUCT_ID,
      },
    };
    const unrelated = {
      _id: "507f1f77bcf86cd799439099",
      price: 10,
      currency: "EUR",
    };
    const products = applyWaitlistPriceSnapshot({
      products: [
        { _id: PRODUCT_ID, price: 999, currency: "CZK", name: "Class" },
        unrelated,
      ],
      context,
    });
    expect(products[0]).toMatchObject({ price: 250, currency: "CZK" });
    expect(products[1]).toBe(unrelated);
    expect(() =>
      applyWaitlistPriceSnapshot({
        products: [{ _id: PRODUCT_ID, price: 999, currency: "EUR" }],
        context,
      }),
    ).toThrow(/currency changed/i);
  });

  it("validates and recovers persisted Cart/Order snapshots after a committed-before-Stripe retry", async () => {
    const expectedCart = {
      _id: "507f1f77bcf86cd799439090",
      user: CUSTOMER_ID,
      totalPrice: 250,
      expectedAmountMinor: 25_000,
      currency: "CZK",
    };
    const persistedCart = {
      ...expectedCart,
      createdAt: new Date(),
      internalField: "ignored",
    };
    expect(() =>
      assertPersistedCardCartSnapshot(persistedCart, expectedCart),
    ).not.toThrow();
    expect(() =>
      assertPersistedCardCartSnapshot(
        { ...persistedCart, expectedAmountMinor: 24_999 },
        expectedCart,
      ),
    ).toThrow(/persisted checkout cart/i);

    const expectedOrder = {
      _id: ORDER_ID,
      cart: expectedCart._id,
      createdBy: CUSTOMER_ID,
      expectedAmountMinor: 25_000,
      currency: "CZK",
      waitlist: {
        entryId: ENTRY_ID,
        offerGeneration: 3,
        priceVersion: "price-v1",
      },
    };
    const persistedOrder = {
      ...expectedOrder,
      stripe: {
        connectedAccountId: "acct_studio",
        sessionId: "cs_waitlist",
        livemode: false,
      },
      appliedDiscount: null,
    };
    expect(() =>
      assertPersistedCardOrderSnapshot(persistedOrder, expectedOrder),
    ).not.toThrow();

    const recovered = await recoverAttachedCardCheckout({
      tenantId: TENANT_ID,
      connectedAccountId: "acct_studio",
      order: persistedOrder,
      retrieveSession: vi.fn().mockResolvedValue({
        id: "cs_waitlist",
        status: "open",
        url: "https://checkout.stripe.test/waitlist",
        client_reference_id: ORDER_ID,
        metadata: {
          sharioManaged: "true",
          sharioFlow: "order",
          tenantId: TENANT_ID,
          orderId: ORDER_ID,
          expectedAmountMinor: "25000",
        },
        currency: "czk",
        amount_total: 25_000,
        livemode: false,
      } as never),
    });
    expect(recovered).toEqual({
      url: "https://checkout.stripe.test/waitlist",
      orderId: ORDER_ID,
      sessionId: "cs_waitlist",
      appliedDiscount: null,
    });
  });

  it("authorizes an authenticated entry by customer id and creates a canonical one-seat cart", async () => {
    mocks.waitlistFindOne.mockReturnValue(selectLeanQuery(offeredEntry));
    const result = await resolveWaitlistCheckoutContext({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      entryId: ENTRY_ID,
      customerId: CUSTOMER_ID,
      email: "person@example.test",
      now: NOW,
    });

    expect(result).toMatchObject({
      entryId: ENTRY_ID,
      sessionId: SESSION_ID,
      productId: PRODUCT_ID,
      offerGeneration: 3,
      price: {
        amount: 250,
        amountMinor: 25_000,
        currency: "CZK",
        version: "price-v1",
      },
      cartItems: [
        {
          product: { _id: PRODUCT_ID, type: "course" },
          quantity: 1,
          numberOfGuests: 1,
          bookingCourse: SESSION_ID,
        },
      ],
    });
    const query = mocks.waitlistFindOne.mock.calls[0][0];
    expect(query.$or[0]).toMatchObject({
      state: "offered",
      isLive: true,
      _id: expect.anything(),
      customer: expect.anything(),
    });
  });

  it("rejects a caller cart that changes the saved product, session, or quantity", async () => {
    mocks.waitlistFindOne.mockReturnValue(selectLeanQuery(offeredEntry));
    await expect(
      resolveWaitlistCheckoutContext({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        entryId: ENTRY_ID,
        customerId: CUSTOMER_ID,
        email: "person@example.test",
        now: NOW,
        cartItems: [
          {
            product: { _id: PRODUCT_ID },
            bookingCourse: SESSION_ID,
            quantity: 2,
          },
        ],
      }),
    ).rejects.toThrow(/exactly one saved Class place/i);
  });

  it("atomically swaps the exact generation hold for one order reservation and stores distinct expiries", async () => {
    const entry = { ...offeredEntry };
    mocks.waitlistFindOne.mockReturnValue(selectSessionQuery(entry));
    mocks.bookingUpdateOne.mockReturnValue(execQuery({ modifiedCount: 1 }));
    mocks.waitlistUpdateOne.mockReturnValue(execQuery({ modifiedCount: 1 }));
    const reservationExpiresAt = new Date("2026-08-08T11:00:00.000Z");
    const paymentExpiresAt = new Date("2026-08-07T11:00:00.000Z");
    const mongoSession = {} as never;

    await transferWaitlistHoldToOrder({
      tenantId: TENANT_ID,
      context: {
        entryId: ENTRY_ID,
        sessionId: SESSION_ID,
        productId: PRODUCT_ID,
        offerGeneration: 3,
        offerExpiresAt: offeredEntry.offerExpiresAt,
        price: {
          amountMinor: 25_000,
          amount: 250,
          currency: "CZK",
          version: "price-v1",
          productId: PRODUCT_ID,
        },
        orderId: ORDER_ID,
        customerId: CUSTOMER_ID,
        cartItems: [],
      },
      reservationExpiresAt,
      paymentExpiresAt,
      now: NOW,
      mongoSession,
    });

    expect(mocks.bookingUpdateOne).toHaveBeenCalledOnce();
    const [bookingFilter, pipeline, bookingOptions] =
      mocks.bookingUpdateOne.mock.calls[0];
    expect(bookingFilter.waitlistCapacityHolds.$elemMatch).toMatchObject({
      offerGeneration: 3,
      expiresAt: { $gt: NOW },
    });
    expect(Array.isArray(pipeline)).toBe(true);
    expect(pipeline[0].$set.waitlistCapacityHolds.$filter).toBeDefined();
    expect(
      pipeline[0].$set.capacityReservations.$concatArrays[1][0],
    ).toMatchObject({ quantity: 1, expiresAt: reservationExpiresAt });
    expect(bookingOptions).toEqual({ session: mongoSession, updatePipeline: true });

    const [, entryUpdate, entryOptions] = mocks.waitlistUpdateOne.mock.calls[0];
    expect(entryUpdate.$set).toMatchObject({
      state: "payment_pending",
      checkout: {
        expiresAt: paymentExpiresAt,
        reservationExpiresAt,
        offerGeneration: 3,
      },
    });
    expect(entryOptions).toEqual({ session: mongoSession });
  });

  it("makes a replay idempotent only while the exact order reservation remains live", async () => {
    const pending = {
      ...offeredEntry,
      state: "payment_pending",
      checkout: { orderId: ORDER_ID, offerGeneration: 3 },
    };
    mocks.waitlistFindOne.mockReturnValue(selectSessionQuery(pending));
    mocks.bookingUpdateOne.mockReturnValue(execQuery({ matchedCount: 1 }));
    mocks.waitlistUpdateOne.mockReturnValue(execQuery({ matchedCount: 1 }));

    await expect(
      transferWaitlistHoldToOrder({
        tenantId: TENANT_ID,
        context: {
          entryId: ENTRY_ID,
          sessionId: SESSION_ID,
          productId: PRODUCT_ID,
          offerGeneration: 3,
          offerExpiresAt: offeredEntry.offerExpiresAt,
          price: {
            amountMinor: 25_000,
            amount: 250,
            currency: "CZK",
            version: "price-v1",
            productId: PRODUCT_ID,
          },
          orderId: ORDER_ID,
          cartItems: [],
        },
        reservationExpiresAt: new Date("2026-08-08T11:00:00.000Z"),
        paymentExpiresAt: new Date("2026-08-07T11:00:00.000Z"),
        now: NOW,
        mongoSession: {} as never,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.bookingUpdateOne).toHaveBeenCalledOnce();
    expect(mocks.waitlistUpdateOne).toHaveBeenCalledOnce();
    expect(mocks.bookingUpdateOne.mock.calls[0][1].$set).toHaveProperty(
      "capacityReservations.$[reservation].expiresAt",
    );
    expect(mocks.waitlistUpdateOne.mock.calls[0][1].$set).toMatchObject({
      "checkout.expiresAt": new Date("2026-08-07T11:00:00.000Z"),
      "checkout.reservationExpiresAt": new Date("2026-08-08T11:00:00.000Z"),
    });

    mocks.bookingUpdateOne.mockReturnValue(execQuery({ matchedCount: 0 }));
    await expect(
      transferWaitlistHoldToOrder({
        tenantId: TENANT_ID,
        context: {
          entryId: ENTRY_ID,
          sessionId: SESSION_ID,
          productId: PRODUCT_ID,
          offerGeneration: 3,
          offerExpiresAt: offeredEntry.offerExpiresAt,
          price: {
            amountMinor: 25_000,
            amount: 250,
            currency: "CZK",
            version: "price-v1",
            productId: PRODUCT_ID,
          },
          orderId: ORDER_ID,
          cartItems: [],
        },
        reservationExpiresAt: new Date("2026-08-08T11:00:00.000Z"),
        paymentExpiresAt: new Date("2026-08-07T11:00:00.000Z"),
        now: NOW,
        mongoSession: {} as never,
      }),
    ).rejects.toThrow(/reservation is no longer valid/i);
  });

  it("classifies webhook orders by live reservation and terminal state", async () => {
    mocks.waitlistFindOne
      .mockReturnValueOnce(
        selectLeanQuery({
          state: "payment_pending",
          checkout: {
            reservationExpiresAt: new Date("2026-08-07T11:00:00.000Z"),
          },
        }),
      )
      .mockReturnValueOnce(
        selectLeanQuery({
          state: "payment_pending",
          checkout: {
            reservationExpiresAt: new Date("2026-08-07T09:00:00.000Z"),
          },
        }),
      )
      .mockReturnValueOnce(selectLeanQuery(null));
    await expect(
      getWaitlistOrderDisposition({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "fulfill" });
    await expect(
      getWaitlistOrderDisposition({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "refund" });
    await expect(
      getWaitlistOrderDisposition({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "not_waitlist" });
  });

  it("claims fulfillment once, reports concurrent work as busy, and never re-fulfills confirmed orders", async () => {
    mocks.waitlistFindOneAndUpdate
      .mockReturnValueOnce(
        selectLeanQuery({ _id: ENTRY_ID, state: "payment_pending" }),
      )
      .mockReturnValue(selectLeanQuery(null));
    mocks.waitlistFindOne
      .mockReturnValueOnce(
        selectLeanQuery({
          _id: ENTRY_ID,
          state: "payment_pending",
          isLive: true,
          checkout: {
            expiresAt: new Date("2026-08-07T11:00:00.000Z"),
            fulfillmentClaimExpiresAt: new Date("2026-08-07T10:05:00.000Z"),
          },
        }),
      )
      .mockReturnValueOnce(
        selectLeanQuery({ _id: ENTRY_ID, state: "confirmed", isLive: false }),
      )
      .mockReturnValueOnce(
        selectLeanQuery({ _id: ENTRY_ID, state: "expired", isLive: false }),
      );

    const claimed = await claimWaitlistOrderForWebhook({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      now: NOW,
    });
    expect(claimed.kind).toBe("fulfill");
    if (claimed.kind === "fulfill") expect(claimed.claimToken).toBeTruthy();
    await expect(
      claimWaitlistOrderForWebhook({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "busy" });
    await expect(
      claimWaitlistOrderForWebhook({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "already_confirmed" });
    await expect(
      claimWaitlistOrderForWebhook({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({ kind: "refund" });
  });
});
