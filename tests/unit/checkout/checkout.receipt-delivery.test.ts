import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repository: {
    findCardCheckoutRecovery: vi.fn(),
    deleteProcessingRecords: vi.fn(),
    deleteProcessingMetadata: vi.fn(),
    loadProductsByIds: vi.fn(),
    findCurrentBookings: vi.fn(),
    findCourseSlots: vi.fn(),
    findBookingLocations: vi.fn(),
    reserveCourseCapacity: vi.fn(),
    reserveGuestIncreaseCapacity: vi.fn(),
    releaseCourseCapacity: vi.fn(),
    deleteCheckoutBookings: vi.fn(),
    createCart: vi.fn(),
    createOrder: vi.fn(),
    attachStripeSession: vi.fn(),
  },
  createSession: vi.fn(),
  retrieveSession: vi.fn(),
  expireSession: vi.fn(),
  requireReadyTenantConnectedAccount: vi.fn(),
}));

vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: mocks.repository,
}));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: async () => ({ settings: { currency: "CZK" } }),
}));
vi.mock("@/modules/product/product-plan-entitlements.js", () => ({
  assertProductsEntitledForTenant: vi.fn(),
}));
vi.mock("@/modules/invoice/invoice-settings.service.js", () => ({
  ensureInvoiceSettings: async () => ({
    defaultTaxRateBps: 0,
    pricesIncludeTax: true,
  }),
}));
vi.mock(
  "@/modules/tenant-payments/services/tenant-payment-connect.service.js",
  () => ({
    requireReadyTenantConnectedAccount:
      mocks.requireReadyTenantConnectedAccount,
  }),
);
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({
    checkout: {
      sessions: {
        create: mocks.createSession,
        retrieve: mocks.retrieveSession,
        expire: mocks.expireSession,
      },
    },
  }),
  getConnectedAccountRequestOptions: (stripeAccount: string, extra = {}) => ({
    stripeAccount,
    ...extra,
  }),
}));

import { checkoutService } from "@/modules/checkout/services/checkout.service.js";

const TENANT_ID = "64b000000000000000000401";
const PRODUCT_ID = "64b000000000000000000402";
const SLOT_ID = "64b000000000000000000403";
const LOCATION_ID = "64b000000000000000000404";
const ORDER_ID = "64b000000000000000000405";
const CART_ID = "64b000000000000000000406";
const USER_ID = "64b000000000000000000407";
const ACCOUNT_ID = "acct_receipt_tenant";
const SESSION_ID = "cs_receipt";
const CHECKOUT_URL = "https://checkout.stripe.test/c/pay/cs_receipt";

const checkoutInput = (email: string, customId = "GUEST") => ({
  tenantId: TENANT_ID,
  user: {
    _id: USER_ID,
    firstname: "Alex",
    lastname: "Buyer",
    email,
    customId,
  },
  cartItems: [
    {
      product: { _id: PRODUCT_ID, type: "course" },
      bookingCourse: SLOT_ID,
      quantity: 1,
    },
  ],
  originUrl: "https://studio.shario.io",
  currency: "CZK",
  checkoutOperation: {
    operationId: "receipt-operation",
    orderId: ORDER_ID,
    cartId: CART_ID,
  },
});

describe("Stripe checkout receipt delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.repository.findCardCheckoutRecovery.mockResolvedValue(null);
    mocks.requireReadyTenantConnectedAccount.mockResolvedValue({
      stripeAccountId: ACCOUNT_ID,
    });
    mocks.repository.loadProductsByIds.mockResolvedValue([
      {
        _id: PRODUCT_ID,
        type: "course",
        name: "Pottery course",
        currency: "CZK",
        price: 500,
        maxNumberOfParticipants: 8,
      },
    ]);
    mocks.repository.findCurrentBookings.mockResolvedValue([]);
    mocks.repository.findCourseSlots.mockResolvedValue([
      {
        _id: SLOT_ID,
        bookingProduct: PRODUCT_ID,
        numberOfGuests: 0,
        start: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    ]);
    mocks.repository.findBookingLocations.mockResolvedValue([
      { _id: SLOT_ID, tag: "course", location: LOCATION_ID },
    ]);
    mocks.repository.createCart.mockImplementation(
      async ({ payload }) => payload,
    );
    mocks.repository.createOrder.mockImplementation(
      async ({ payload }) => payload,
    );
    mocks.repository.attachStripeSession.mockResolvedValue({
      modifiedCount: 1,
    });
    mocks.createSession.mockResolvedValue({
      id: SESSION_ID,
      status: "open",
      url: CHECKOUT_URL,
      livemode: false,
    });
  });

  it.each([
    { buyer: "guest", customId: "GUEST", email: "guest@example.test" },
    { buyer: "signed-in", customId: "U-42", email: "member@example.test" },
  ])(
    "requests a payment receipt for the $buyer buyer on the tenant account",
    async ({ email, customId }) => {
      await expect(
        checkoutService.createStripeCheckout(checkoutInput(email, customId)),
      ).resolves.toMatchObject({
        url: CHECKOUT_URL,
        orderId: ORDER_ID,
        sessionId: SESSION_ID,
      });

      expect(mocks.createSession).toHaveBeenCalledOnce();
      const [payload, options] = mocks.createSession.mock.calls[0];
      expect(payload).toMatchObject({
        mode: "payment",
        customer_email: email,
        payment_intent_data: { receipt_email: email },
        line_items: [
          {
            quantity: 1,
            price_data: { currency: "czk", unit_amount: 50_000 },
          },
        ],
      });
      expect(payload).not.toHaveProperty("invoice_creation");
      expect(options).toEqual({
        stripeAccount: ACCOUNT_ID,
        idempotencyKey: `checkout-session:${ORDER_ID}`,
      });
      expect(mocks.repository.attachStripeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          connectedAccountId: ACCOUNT_ID,
        }),
      );
    },
  );

  it("recovers an attached checkout without requesting a second payment or receipt", async () => {
    mocks.repository.findCardCheckoutRecovery.mockResolvedValue({
      _id: ORDER_ID,
      currency: "CZK",
      expectedAmountMinor: 50_000,
      stripe: {
        sessionId: SESSION_ID,
        connectedAccountId: ACCOUNT_ID,
        livemode: false,
      },
    });
    mocks.retrieveSession.mockResolvedValue({
      id: SESSION_ID,
      status: "open",
      url: CHECKOUT_URL,
      livemode: false,
      currency: "czk",
      amount_total: 50_000,
      client_reference_id: ORDER_ID,
      metadata: {
        sharioManaged: "true",
        sharioFlow: "order",
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        expectedAmountMinor: "50000",
      },
    });

    await expect(
      checkoutService.createStripeCheckout(checkoutInput("buyer@example.test")),
    ).resolves.toMatchObject({ url: CHECKOUT_URL, sessionId: SESSION_ID });

    expect(mocks.retrieveSession).toHaveBeenCalledWith(SESSION_ID, {
      stripeAccount: ACCOUNT_ID,
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.repository.createOrder).not.toHaveBeenCalled();
    expect(mocks.requireReadyTenantConnectedAccount).not.toHaveBeenCalled();
  });

  it("persists protected guest metadata before Stripe and uses canonical guest return links", async () => {
    const snapshot = {
      version: 1 as const, accessNonce: "N".repeat(43), accessTokenHash: "a".repeat(64),
      accessExpiresAt: new Date(Date.now() + 86400000), locale: "cs",
    };
    const successUrl = `https://studio.shario.io/cs/checkout/success?orderId=${ORDER_ID}#access_token=${"T".repeat(43)}`;
    const cancelUrl = `https://studio.shario.io/cs/checkout/cancel?orderId=${ORDER_ID}#access_token=${"T".repeat(43)}`;
    await checkoutService.createStripeCheckout({
      ...checkoutInput("guest@example.test", "G-0123456789abcdefabcd"),
      guestCheckout: { orderSnapshot: snapshot, successUrl, cancelUrl },
    });
    expect(mocks.repository.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        guestCourseCheckout: snapshot,
        customer: expect.objectContaining({ email: "guest@example.test" }),
      }),
    }));
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      success_url: successUrl, cancel_url: cancelUrl,
      customer_email: "guest@example.test",
    }), expect.any(Object));
    expect(mocks.repository.createOrder.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createSession.mock.invocationCallOrder[0]);
  });
});
