import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: {} as any,
  membership: null as any,
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: async () => mocks.tenant,
}));
vi.mock("@/modules/membership/membership.repository.js", () => ({
  membershipRepository: {
    findActiveUserMembership: async () => mocks.membership,
  },
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
    requireReadyTenantConnectedAccount: async () => ({
      stripeAccountId: "acct_waitlist_member",
    }),
  }),
);
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({
    checkout: {
      sessions: {
        create: mocks.create,
        retrieve: mocks.retrieve,
        expire: mocks.expire,
      },
    },
  }),
  getConnectedAccountRequestOptions: (stripeAccount: string, rest = {}) => ({
    stripeAccount,
    ...rest,
  }),
}));
vi.mock("@/modules/waitlist/waitlist.customer-notification.service.js", () => ({
  publishWaitlistCustomerNotificationForEntry: vi.fn(),
}));

import Booking from "@/modules/booking/booking.model.js";
import Product from "@/modules/product/product.model.js";
import Location from "@/modules/location/location.model.js";
import User from "@/modules/user/user.model.js";
import Order from "@/modules/order/order.model.js";
import Cart from "@/modules/cart/cart.model.js";
import Claim from "@/modules/membership/membership-course-discount-claim.model.js";
import { WaitlistEntryModel } from "@/modules/waitlist/waitlist.model.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";
import {
  deriveWaitlistToken,
  hashWaitlistEmail,
  hashWaitlistToken,
} from "@/modules/waitlist/waitlist.policy.js";
import { WAITLIST_TOKEN_PURPOSE } from "@/modules/waitlist/waitlist.constants.js";

const id = () => new mongoose.Types.ObjectId();
const tenant = id(),
  member = id(),
  product = id(),
  booking = id(),
  location = id(),
  entry = id();
const email = "member@example.test";
let db: MongoMemoryReplSet;
const request = (overrides: any = {}) => ({
  tenantId: String(tenant),
  user: {
    _id: member,
    firstname: "Ada",
    lastname: "Clay",
    customId: "M-01",
    email,
  },
  cartItems: [],
  originUrl: "https://studio.example",
  currency: "CZK",
  membershipDiscountEligible: true,
  idempotencyKey: "waitlist-member-checkout",
  waitlistEntryId: String(entry),
  ...overrides,
});

describe("personal membership discount on a captured waitlist price", () => {
  beforeAll(async () => {
    db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(db.getUri());
    await Promise.all([Claim.init(), CheckoutOperationModel.init()]);
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await db?.stop();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv(
      "WAITLIST_TOKEN_PEPPER",
      "test-waitlist-secret-pepper-1234567890-abcdefghijklmnopqrstuvwxyz",
    );
    for (const collection of Object.values(mongoose.connection.collections))
      await collection.deleteMany({});
    const now = new Date(),
      start = new Date(Date.now() + 7 * 86400000),
      expires = new Date(Date.now() + 3600000);
    mocks.tenant = {
      _id: tenant,
      slug: "studio",
      settings: { currency: "CZK" },
      modules: { courses: true, payments: true },
    };
    mocks.membership = {
      _id: id(),
      plan: id(),
      planVersion: id(),
      status: "active",
      currentPeriodStart: new Date(Date.now() - 86400000),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      planSnapshot: {
        version: 1,
        locationScope: {
          type: "shared_selected",
          locationIds: [String(location)],
        },
        benefits: [
          {
            key: "courses",
            label: "Personal course discount",
            type: "percentage",
            appliesTo: "products",
            productScope: "courses",
            memberOnly: true,
            percentageBps: 1000,
          },
        ],
      },
    };
    await Product.collection.insertOne({
      _id: product,
      tenant,
      createdBy: member,
      type: "public-course",
      kind: "class",
      name: "Course",
      description: "Pottery",
      isActive: true,
      isArchived: false,
      price: 900,
      currency: "czk",
      maxNumberOfParticipants: 8,
      courseContent: { locationIds: [String(location)] },
    } as any);
    await Location.collection.insertOne({
      _id: location,
      tenant,
      name: "Studio",
      isActive: true,
    } as any);
    await User.collection.insertOne({
      _id: member,
      tenant,
      email,
      firstname: "Ada",
      lastname: "Clay",
      customId: "M-01",
      isAccessGranted: true,
      isEmailVerified: true,
      tenantRole: "customer",
      platformRole: "none",
    } as any);
    await Booking.collection.insertOne({
      _id: booking,
      tenant,
      createdBy: member,
      bookingProduct: product,
      tag: "class",
      location,
      status: "processed",
      archive: false,
      start,
      end: new Date(start.getTime() + 3600000),
      numberOfGuests: 0,
      participants: [],
      capacityReservations: [],
      orders: [],
      waitlistCapacityHolds: [
        { entry, offerGeneration: 1, expiresAt: expires },
      ],
    } as any);
    const offerToken = deriveWaitlistToken({
      subject: entry,
      purpose: WAITLIST_TOKEN_PURPOSE.OFFER,
      generation: 1,
    });
    await WaitlistEntryModel.collection.insertOne({
      _id: entry,
      tenant,
      courseSession: booking,
      product,
      customer: member,
      identityKey: hashWaitlistEmail(email),
      email,
      firstName: "Ada",
      lastName: "Clay",
      source: "customer",
      locale: "cs",
      emailVerifiedAt: now,
      state: "offered",
      isLive: true,
      sequence: 1,
      joinedAt: now,
      sessionStartSnapshot: start,
      offerGeneration: 1,
      offerExpiresAt: expires,
      offerTokenHash: hashWaitlistToken(
        offerToken,
        WAITLIST_TOKEN_PURPOSE.OFFER,
      ),
      priceSnapshot: {
        amountMinor: 25000,
        currency: "CZK",
        version: "saved-price-1",
        productId: product,
        capturedAt: now,
      },
    } as any);
    await WaitlistEntryModel.collection.updateOne(
      { _id: entry },
      {
        $set: {
          managementGeneration: 1,
          managementTokenHash: "test-management-hash",
          managementExpiresAt: new Date(start.getTime() + 86400000),
        },
      },
    );
    mocks.create.mockImplementation(async (payload) => ({
      id: "cs_waitlist_member",
      url: "https://checkout.stripe.test/member",
      status: "open",
      payment_status: "unpaid",
      livemode: false,
      currency: "czk",
      amount_total: payload.line_items.reduce(
        (sum, line) => sum + line.price_data.unit_amount * line.quantity,
        0,
      ),
      expires_at: payload.expires_at,
      client_reference_id: payload.client_reference_id,
      metadata: payload.metadata,
    }));
  });
  it("discounts the saved base price, reserves one member claim with the hold, and leaves the saved price unchanged", async () => {
    const result = await checkoutService.createStripeCheckout(request());
    const order = await Order.findById(result.orderId).lean();
    expect(order).toMatchObject({
      expectedAmountMinor: 22500,
      grossAmountMinor: 22500,
      appliedDiscount: { amountMinor: 2500, subtotalAmountMinor: 25000 },
      waitlist: { priceVersion: "saved-price-1" },
    });
    expect(order?.lineItems[0].quantity).toBe(1);
    expect(order?.lineItems[0].locationIds.map(String)).toEqual([
      String(location),
    ]);
    expect(
      await Claim.countDocuments({
        tenant,
        user: member,
        booking,
        order: result.orderId,
      }),
    ).toBe(1);
    expect(
      (await WaitlistEntryModel.findById(entry).lean())?.priceSnapshot
        .amountMinor,
    ).toBe(25000);
    expect((await WaitlistEntryModel.findById(entry).lean())?.state).toBe(
      "payment_pending",
    );
    const slot = await Booking.findById(booking).lean();
    expect(slot?.waitlistCapacityHolds).toHaveLength(0);
    expect(slot?.capacityReservations).toHaveLength(1);
  });
  it("also honors the discount after the member signs into an email-token offer originally joined as a guest", async () => {
    await WaitlistEntryModel.updateOne(
      { _id: entry },
      { $set: { customer: null, source: "guest" } },
    );
    const offerToken = deriveWaitlistToken({
      subject: entry,
      purpose: WAITLIST_TOKEN_PURPOSE.OFFER,
      generation: 1,
    });
    const result = await checkoutService.createStripeCheckout(
      request({ waitlistEntryId: "", waitlistOfferToken: offerToken }),
    );
    expect(
      (await Order.findById(result.orderId).lean())?.expectedAmountMinor,
    ).toBe(22500);
    expect(
      String((await WaitlistEntryModel.findById(entry).lean())?.customer),
    ).toBe(String(member));
  });
  it("persists a regular discounted card purchase with a base-price Cart and final-price Order", async () => {
    const result = await checkoutService.createStripeCheckout(
      request({
        waitlistEntryId: "",
        cartItems: [
          {
            product: { _id: String(product), type: "public-course" },
            quantity: 3,
            numberOfGuests: 3,
            bookingCourse: String(booking),
          },
        ],
      }),
    );
    const order = await Order.findById(result.orderId).lean();
    expect(order).toMatchObject({
      expectedAmountMinor: 261000,
      grossAmountMinor: 261000,
      appliedDiscount: { amountMinor: 9000 },
    });
    expect(
      order?.lineItems.map((line) => ({
        quantity: line.quantity,
        grossAmountMinor: line.grossAmountMinor,
      })),
    ).toEqual([
      { quantity: 1, grossAmountMinor: 81000 },
      { quantity: 2, grossAmountMinor: 180000 },
    ]);
    expect(await Cart.findById(order?.cart).lean()).toMatchObject({
      totalPrice: 2700,
      expectedAmountMinor: 261000,
      cartItems: [{ basePrice: 900, totalPrice: 2700 }],
    });
    expect(await Claim.countDocuments()).toBe(1);
  });
  it.each(["guest", "outside-location", "previous-purchase"])(
    "does not grant a personal discount to %s",
    async (scenario) => {
      if (scenario === "outside-location")
        mocks.membership.planSnapshot.locationScope.locationIds = [
          String(id()),
        ];
      if (scenario === "previous-purchase")
        await Order.collection.insertOne({
          _id: id(),
          tenant,
          createdBy: member,
          isPaid: true,
          courseBookings: [{ bookingId: booking, quantity: 1 }],
        } as any);
      const result = await checkoutService.createStripeCheckout(
        request({ membershipDiscountEligible: scenario !== "guest" }),
      );
      expect(
        (await Order.findById(result.orderId).lean())?.expectedAmountMinor,
      ).toBe(25000);
      expect(await Claim.countDocuments()).toBe(0);
    },
  );
  it("rolls back the discount claim and order if the reserved place can no longer transfer", async () => {
    await Booking.updateOne(
      { _id: booking },
      { $set: { waitlistCapacityHolds: [] } },
    );
    await expect(
      checkoutService.createStripeCheckout(request()),
    ).rejects.toMatchObject({ code: "WAITLIST_HOLD_TRANSFER_FAILED" });
    expect(await Claim.countDocuments()).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("retains the exact saved payment request after membership expiry during an interrupted Stripe create", async () => {
    mocks.create.mockRejectedValueOnce(
      new Error("provider response interrupted"),
    );
    await expect(
      checkoutService.createStripeCheckout(request()),
    ).rejects.toThrow("provider response interrupted");
    const originalPayload = mocks.create.mock.calls[0][0];
    const originalOptions = mocks.create.mock.calls[0][1];
    const originalOrder = await Order.findOne({
      tenant,
      createdBy: member,
    }).lean();
    expect(originalOrder?.expectedAmountMinor).toBe(22500);
    mocks.membership = null;
    const later = Date.now() + 5000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    let result;
    try {
      result = await checkoutService.createStripeCheckout(request());
    } finally {
      clock.mockRestore();
    }
    expect(String(result.orderId)).toBe(String(originalOrder?._id));
    expect(mocks.create.mock.calls[1]).toEqual([
      originalPayload,
      originalOptions,
    ]);
    expect(await Claim.countDocuments()).toBe(1);
    expect(await Order.countDocuments()).toBe(1);
  });
  it("resumes an old full-price waitlist attempt after authenticated membership eligibility is enabled", async () => {
    mocks.create.mockRejectedValueOnce(
      new Error("provider response interrupted"),
    );
    await expect(
      checkoutService.createStripeCheckout(
        request({ membershipDiscountEligible: false }),
      ),
    ).rejects.toThrow("provider response interrupted");
    const originalPayload = mocks.create.mock.calls[0][0];
    const originalOptions = mocks.create.mock.calls[0][1];
    const result = await checkoutService.createStripeCheckout(
      request({ membershipDiscountEligible: true }),
    );
    expect(
      (await Order.findById(result.orderId).lean())?.expectedAmountMinor,
    ).toBe(25000);
    expect(mocks.create.mock.calls[1]).toEqual([
      originalPayload,
      originalOptions,
    ]);
    expect(await Claim.countDocuments()).toBe(0);
    expect(await Order.countDocuments()).toBe(1);
  });
});
