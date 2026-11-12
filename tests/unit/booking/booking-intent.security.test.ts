import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindOne: vi.fn(),
  bookingFind: vi.fn(),
  productFindOne: vi.fn(),
  tenantFindById: vi.fn(),
  locationFindOne: vi.fn(),
  userFindOne: vi.fn(),
  intentFindOne: vi.fn(),
  intentFindOneAndUpdate: vi.fn(),
  intentCreate: vi.fn(),
  intentUpdateOne: vi.fn(),
  membershipFind: vi.fn(),
  entitlementFind: vi.fn(),
  membershipDiscount: vi.fn(),
  unavailableDiscounts: vi.fn(),
  createStripeCheckout: vi.fn(),
  checkoutWithCredits: vi.fn(),
  quoteVoucherCheckout: vi.fn(),
}));

vi.mock(
  "@/modules/booking/booking.model.js",
  () => ({
    default: {
      findOne:
        mocks.bookingFindOne,
      find: mocks.bookingFind,
    },
  }),
);

vi.mock(
  "@/modules/product/product.model.js",
  () => ({
    default: {
      findOne:
        mocks.productFindOne,
    },
  }),
);

vi.mock(
  "@/modules/tenants/tenant.model.js",
  () => ({
    default: {
      findById:
        mocks.tenantFindById,
    },
  }),
);

vi.mock(
  "@/modules/location/location.model.js",
  () => ({
    default: {
      findOne:
        mocks.locationFindOne,
    },
  }),
);

vi.mock(
  "@/modules/user/user.model.js",
  () => ({
    default: {
      findOne:
        mocks.userFindOne,
    },
  }),
);

vi.mock(
  "@/modules/booking-intent/booking-intent.model.js",
  () => ({
    default: {
      findOne:
        mocks.intentFindOne,
      findOneAndUpdate:
        mocks.intentFindOneAndUpdate,
      create:
        mocks.intentCreate,
      updateOne:
        mocks.intentUpdateOne,
    },
  }),
);

vi.mock(
  "@/modules/membership/membership-entitlement-balance.schema.js",
  () => ({
    default: {
      find:
        mocks.entitlementFind,
    },
  }),
);

vi.mock(
  "@/modules/membership/membership.repository.js",
  () => ({
    membershipRepository: {
      findActiveUserMembership:
        mocks.membershipFind,
    },
  }),
);

vi.mock(
  "@/modules/membership/services/membership-discount.service.js",
  () => ({
    resolveMembershipProductDiscount:
      mocks.membershipDiscount,
  }),
);
vi.mock("@/modules/checkout/services/checkout.membership-course.service.js", () => ({ unavailablePersonalCourseDiscounts: mocks.unavailableDiscounts }));

vi.mock(
  "@/modules/checkout/services/checkout.service.js",
  () => ({
    checkoutService: {
      createStripeCheckout:
        mocks.createStripeCheckout,
      checkoutWithCredits:
        mocks.checkoutWithCredits,
      quoteVoucherCheckout: mocks.quoteVoucherCheckout,
    },
  }),
);

import {
  checkoutBookingIntent,
  createSignedBookingIntent,
  requireBookingCustomerAccount,
  restoreBookingIntent,
  quoteBookingIntentVoucher,
} from "@/modules/booking-intent/booking-intent.service.js";
import { createBookingIntentSchema, checkoutBookingIntentSchema, quoteBookingIntentVoucherSchema } from "@/modules/booking-intent/booking-intent.validators.js";

const SECRET =
  "booking-intent-test-secret-at-least-32-characters";
const TENANT_A =
  "64b000000000000000000101";
const TENANT_B =
  "64b000000000000000000102";
const USER_A =
  "64b000000000000000000103";
const PRODUCT_ID =
  "64b000000000000000000104";
const COURSE_SLOT_ID =
  "64b000000000000000000105";
const COURSE_LOCATION_ID =
  "64b000000000000000000107";
const INTENT_ID =
  "64b000000000000000000106";

const execQuery = (
  value: unknown,
) => ({
  exec: vi
    .fn()
    .mockResolvedValue(value),
});

const selectExecQuery = (
  value: unknown,
) => ({
  select: vi.fn(() =>
    execQuery(value),
  ),
});

const selectLeanExecQuery = (
  value: unknown,
) => ({
  select: vi.fn(() => ({
    lean: vi.fn(() =>
      execQuery(value),
    ),
  })),
});

const selectAndExecQuery = (
  value: unknown,
) => ({
  select: vi.fn(() =>
    execQuery(value),
  ),
  exec: vi
    .fn()
    .mockResolvedValue(value),
});

const leanExecQuery = (
  value: unknown,
) => ({
  lean: vi.fn(() =>
    execQuery(value),
  ),
});

const signToken = ({
  tenantId = TENANT_A,
  expiresIn = "30m",
  jti = "intent-jti",
}: {
  tenantId?: string;
  expiresIn?: string | number;
  jti?: string;
} = {}) =>
  jwt.sign(
    {
      typ: "booking_intent",
      jti,
      tenant: tenantId,
      tenantSlug:
        tenantId === TENANT_A
          ? "studio-alpha"
          : "studio-beta",
    },
    SECRET,
    {
      algorithm: "HS256",
      issuer: "shario-api",
      audience:
        "booking-intent",
      expiresIn:
        expiresIn as never,
    },
  );

const verifiedCustomer = {
  _id: USER_A,
  tenantRole: "customer",
  platformRole: "none",
  isAccessGranted: true,
  isEmailVerified: true,
  moneyCredits: 0,
};

const prepareVoucherIntent = () => {
  const start = new Date(Date.now() + 3_600_000);
  const end = new Date(start.getTime() + 7_200_000);
  const record = {
    _id: INTENT_ID, tenant: TENANT_A, tenantSlug: "studio-alpha", jti: "intent-jti", claimedBy: USER_A,
    expiresAt: new Date(Date.now() + 60_000),
    payload: { productId: PRODUCT_ID, locationId: COURSE_LOCATION_ID, courseSlotId: COURSE_SLOT_ID,
      start, end, quantity: 1, numberOfGuests: 1, bookingType: "public", plannedActivity: "UNDEFINED", locale: "en" },
    checkout: { status: "idle", leaseExpiresAt: null },
  };
  mocks.intentFindOne.mockReturnValue(execQuery(record));
  mocks.intentFindOneAndUpdate.mockReset().mockReturnValue(execQuery(record));
  mocks.intentUpdateOne.mockReturnValue(execQuery({ modifiedCount: 1 }));
  mocks.tenantFindById.mockReturnValue(selectAndExecQuery({ _id: TENANT_A, slug: "studio-alpha", settings: { currency: "EUR" }, modules: { bookings: true, courses: true, payments: true }, domains: [] }));
  mocks.productFindOne.mockReturnValue(execQuery({ _id: PRODUCT_ID, name: "Wheel course", type: "course", price: 123.45, currency: "EUR", maxNumberOfParticipants: 8 }));
  mocks.bookingFindOne.mockReturnValue(selectLeanExecQuery({ _id: COURSE_SLOT_ID, location: COURSE_LOCATION_ID, start, end, numberOfGuests: 0, capacityReservations: [] }));
  mocks.locationFindOne.mockReturnValue(selectLeanExecQuery({ _id: COURSE_LOCATION_ID, name: "Studio", booking: { timezone: "Europe/Prague" } }));
  return record;
};

describe("booking intent security contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BOOKING_INTENT_SECRET =
      SECRET;
    mocks.userFindOne.mockReturnValue(
      selectExecQuery(
        verifiedCustomer,
      ),
    );
    mocks.membershipFind.mockResolvedValue(
      null,
    );
    mocks.membershipDiscount.mockResolvedValue(
      null,
    );
    mocks.unavailableDiscounts.mockResolvedValue(new Set());
    mocks.entitlementFind.mockReturnValue(
      leanExecQuery([]),
    );
    mocks.intentCreate.mockResolvedValue(
      {},
    );
  });

  it("offers no hour redemption for courses and quotes only the member's own course seat", async () => {
    const record = prepareVoucherIntent();
    record.payload.quantity = 3;
    record.payload.numberOfGuests = 3;
    mocks.membershipFind.mockResolvedValue({ _id: "membership", status: "active", planSnapshot: { locationScope: { type: "shared_selected", locationIds: [COURSE_LOCATION_ID] }, benefits: [{ key: "hours", type: "allowance", unit: "minute", usageScope: "open_studio", memberOnly: true }] } });
    mocks.entitlementFind.mockReturnValue(leanExecQuery([{ benefitKey: "hours", available: 600 }]));
    mocks.membershipDiscount.mockResolvedValue({ percentageBps: 1000, selectedLocationId: null, productScope: "courses", memberOnly: true, benefitLabel: "Course member" });
    const restored = await restoreBookingIntent({ token: signToken(), tenantId: TENANT_A, userId: USER_A });
    expect(restored.quote.discountAmountMinor).toBe(1234);
    expect(restored.paymentOptions).toEqual(expect.arrayContaining([expect.objectContaining({ benefitKey: "hours", coversTotal: false, unavailableReason: "membership_open_studio_only" })]));
    mocks.unavailableDiscounts.mockResolvedValue(new Set([COURSE_SLOT_ID]));
    const repeat = await restoreBookingIntent({ token: signToken(), tenantId: TENANT_A, userId: USER_A });
    expect(repeat.quote.discountAmountMinor).toBe(0);
  });

  it.each([
    [undefined, "PRODUCT_LOCATION_REQUIRED"],
    ["64b000000000000000000199", "PRODUCT_LOCATION_MISMATCH"],
  ])("rejects a new studio intent with an unavailable product location %s", async (location, code) => {
    const tenant = { _id: TENANT_A, settings: { currency: "CZK" }, modules: { bookings: true, payments: true } };
    mocks.tenantFindById.mockReturnValue(selectExecQuery(tenant));
    mocks.productFindOne.mockReturnValue(execQuery({
      _id: PRODUCT_ID, type: "workshop", kind: "open-studio", location, currency: "CZK", price: 100,
    }));
    const input = createBookingIntentSchema.parse({
      productId: PRODUCT_ID, locationId: COURSE_LOCATION_ID,
      start: new Date(Date.now() + 86400000).toISOString(),
      end: new Date(Date.now() + 90000000).toISOString(),
      numberOfGuests: 1, bookingMode: "public", locale: "en",
    });
    await expect(createSignedBookingIntent({ tenant: tenant as never, input }))
      .rejects.toMatchObject({ code });
    expect(mocks.productFindOne).toHaveBeenCalledWith(expect.objectContaining({ tenant: TENANT_A }));
    expect(mocks.intentCreate).not.toHaveBeenCalled();
  });

  it("quotes voucher payment from the signed, claimed booking instead of client supplied prices", async () => {
    prepareVoucherIntent();
    const tender = { currency: "EUR", totalAmountMinor: 12345, voucherAppliedMinor: 10000, remainingToPayMinor: 2345, voucherType: "value" };
    mocks.quoteVoucherCheckout.mockResolvedValue(tender);
    const result = await quoteBookingIntentVoucher({ token: signToken(), tenantId: TENANT_A, userId: USER_A, voucherCode: "PRIVATE-GIFT-001" });
    expect(result).toEqual(tender);
    expect(mocks.quoteVoucherCheckout).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A, user: verifiedCustomer, voucherCode: "PRIVATE-GIFT-001", currency: "EUR", membershipDiscountEligible: true,
      cartItems: [expect.objectContaining({ product: expect.objectContaining({ _id: PRODUCT_ID }), bookingCourse: COURSE_SLOT_ID, quantity: 1 })] }));
    expect(quoteBookingIntentVoucherSchema.safeParse({ voucherCode: "PRIVATE-GIFT-001", totalAmountMinor: 1 }).success).toBe(false);
    expect(checkoutBookingIntentSchema.safeParse({ paymentMethod: "money_credits", termsAccepted: true, voucherCode: "PRIVATE-GIFT-001" }).success).toBe(false);
    expect(checkoutBookingIntentSchema.parse({ paymentMethod: "card", termsAccepted: true, voucherCode: " private-gift-001 ", expectedVoucherQuote: { currency: tender.currency, totalAmountMinor: tender.totalAmountMinor, voucherAppliedMinor: tender.voucherAppliedMinor, remainingToPayMinor: tender.remainingToPayMinor } }).voucherCode).toBe("PRIVATE-GIFT-001");
  });

  it("does not quote a signed voucher booking for another tenant or after checkout starts", async () => {
    const record = prepareVoucherIntent();
    await expect(quoteBookingIntentVoucher({ token: signToken(), tenantId: TENANT_B, userId: USER_A, voucherCode: "PRIVATE-GIFT-001" })).rejects.toMatchObject({ code: "BOOKING_INTENT_NOT_FOUND" });
    record.checkout.status = "processing";
    await expect(quoteBookingIntentVoucher({ token: signToken(), tenantId: TENANT_A, userId: USER_A, voucherCode: "PRIVATE-GIFT-001" })).rejects.toMatchObject({ code: "CHECKOUT_ALREADY_STARTED" });
    expect(mocks.quoteVoucherCheckout).not.toHaveBeenCalled();
  });

  it.each(["confirmed", "requires_payment"])("preserves the %s result for a voucher booking and hashes its code into request identity", async (status) => {
    prepareVoucherIntent();
    const expectedVoucherQuote = { currency: "EUR" as const, totalAmountMinor: 12345, voucherAppliedMinor: 10000, remainingToPayMinor: 2345 };
    mocks.createStripeCheckout.mockResolvedValue({ status, orderId: "64b000000000000000000111", url: "https://studio-alpha.shario.io/en/confirmation" });
    const result = await checkoutBookingIntent({ token: signToken(), tenantId: TENANT_A, userId: USER_A, idempotencyKey: "voucher-intent-checkout", input: { paymentMethod: "card", termsAccepted: true, voucherCode: "PRIVATE-GIFT-001", expectedVoucherQuote } });
    expect(result.status).toBe(status);
    expect(status === "confirmed" ? result.confirmationUrl : result.url).toBe("https://studio-alpha.shario.io/en/confirmation");
    expect(mocks.createStripeCheckout).toHaveBeenCalledWith(expect.objectContaining({ voucherCode: "PRIVATE-GIFT-001", expectedVoucherQuote, membershipDiscountEligible: true }));
    expect(mocks.checkoutWithCredits).not.toHaveBeenCalled();
    const leaseUpdate = mocks.intentFindOneAndUpdate.mock.calls.find(call => call[1]?.$set?.["checkout.requestHash"]);
    const hash = crypto.createHash("sha256").update(JSON.stringify({ paymentMethod: "card", voucherCode: "PRIVATE-GIFT-001", expectedVoucherQuote, membershipBenefitKey: null, termsAccepted: true, locale: null, origin: null })).digest("hex");
    expect(leaseUpdate?.[1].$set["checkout.requestHash"]).toBe(hash);
  });

  it("requires zero-only fulfillment when a card request is quoted free", async () => {
    prepareVoucherIntent();
    mocks.productFindOne.mockReturnValue(
      execQuery({
        _id: PRODUCT_ID,
        name: "Free class",
        type: "course",
        price: 0,
        currency: "EUR",
        maxNumberOfParticipants: 8,
      }),
    );
    mocks.checkoutWithCredits.mockResolvedValue({
      status: "confirmed",
      orderId: "64b000000000000000000111",
      url: "https://studio-alpha.shario.io/en/confirmation",
    });
    const result = await checkoutBookingIntent({
      token: signToken(),
      tenantId: TENANT_A,
      userId: USER_A,
      idempotencyKey: "free-card-intent-checkout",
      input: { paymentMethod: "card", termsAccepted: true },
    });
    expect(result).toMatchObject({
      status: "confirmed",
      confirmationUrl: "https://studio-alpha.shario.io/en/confirmation",
    });
    expect(mocks.checkoutWithCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentSource: "money_credits",
        requireZeroTotal: true,
      }),
    );
    expect(mocks.createStripeCheckout).not.toHaveBeenCalled();
  });

  it("preserves a confirmed result when card checkout is repriced free", async () => {
    prepareVoucherIntent();
    mocks.createStripeCheckout.mockResolvedValue({
      status: "confirmed",
      orderId: "64b000000000000000000111",
      url: "https://studio-alpha.shario.io/en/confirmation",
    });
    const result = await checkoutBookingIntent({
      token: signToken(),
      tenantId: TENANT_A,
      userId: USER_A,
      idempotencyKey: "repriced-free-intent-checkout",
      input: { paymentMethod: "card", termsAccepted: true },
    });
    expect(result).toMatchObject({
      status: "confirmed",
      confirmationUrl: "https://studio-alpha.shario.io/en/confirmation",
    });
    expect(mocks.checkoutWithCredits).not.toHaveBeenCalled();
  });

  it("rejects malformed or signature-tampered intent tokens before a database lookup", async () => {
    const valid = signToken();
    const tampered = `${valid.slice(
      0,
      -1,
    )}${valid.endsWith("a") ? "b" : "a"}`;

    await expect(
      restoreBookingIntent({
        token: tampered,
        tenantId: TENANT_A,
        userId: USER_A,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code:
        "INVALID_BOOKING_INTENT",
    });

    expect(
      mocks.intentFindOne,
    ).not.toHaveBeenCalled();
  });

  it("reports an expired signed intent distinctly", async () => {
    const expired = signToken({
      expiresIn: -1,
    });

    await expect(
      restoreBookingIntent({
        token: expired,
        tenantId: TENANT_A,
        userId: USER_A,
      }),
    ).rejects.toMatchObject({
      statusCode: 410,
      code:
        "BOOKING_INTENT_EXPIRED",
    });
  });

  it("hides a valid intent when presented in another tenant", async () => {
    const token = signToken({
      tenantId: TENANT_A,
    });

    await expect(
      restoreBookingIntent({
        token,
        tenantId: TENANT_B,
        userId: USER_A,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code:
        "BOOKING_INTENT_NOT_FOUND",
    });

    expect(
      mocks.intentFindOne,
    ).not.toHaveBeenCalled();
  });

  it("allows active customer and owner accounts without email verification but rejects platform identities", async () => {
    const owner = {
      ...verifiedCustomer,
      tenantRole: "owner",
    };
    mocks.userFindOne.mockReturnValueOnce(
      selectExecQuery(owner),
    );

    await expect(
      requireBookingCustomerAccount({
        tenantId: TENANT_A,
        userId: USER_A,
      }),
    ).resolves.toBe(owner);

    mocks.userFindOne.mockReturnValueOnce(
      selectExecQuery({
        ...owner,
        platformRole: "admin",
      }),
    );

    await expect(
      requireBookingCustomerAccount({
        tenantId: TENANT_A,
        userId: USER_A,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code:
        "CUSTOMER_CONTEXT_PLATFORM_ACCOUNT_FORBIDDEN",
    });

    const unverifiedCustomer = { ...verifiedCustomer, isEmailVerified: false };
    mocks.userFindOne.mockReturnValueOnce(selectExecQuery(unverifiedCustomer));

    await expect(
      requireBookingCustomerAccount({
        tenantId: TENANT_A,
        userId: USER_A,
      }),
    ).resolves.toBe(unverifiedCustomer);
    expect(unverifiedCustomer.isEmailVerified).toBe(false);
    expect(mocks.userFindOne).toHaveBeenLastCalledWith({
      _id: USER_A,
      tenant: TENANT_A,
      isAccessGranted: true,
    });
  });

  it.each(["card", "money_credits", "membership_credits"] as const)(
    "lets an unverified customer restore and complete a booking using %s",
    async (paymentMethod) => {
      prepareVoucherIntent();
      const customer = { ...verifiedCustomer, isEmailVerified: false };
      mocks.userFindOne.mockReturnValue(selectExecQuery(customer));
      mocks.createStripeCheckout.mockResolvedValue({ orderId: "64b000000000000000000111", url: "https://checkout.stripe.test/session" });
      mocks.checkoutWithCredits.mockResolvedValue({ orderId: "64b000000000000000000111", url: "https://studio-alpha.shario.io/en/confirmation" });
      if (paymentMethod === "membership_credits") {
        mocks.membershipFind.mockResolvedValue({
          _id: "64b000000000000000000109", status: "active",
          planSnapshot: { locationScope: { type: "all" }, benefits: [{ key: "sessions", type: "allowance", unit: "session" }] },
        });
        mocks.entitlementFind.mockReturnValue(leanExecQuery([{ benefitKey: "sessions", available: 1 }]));
      }

      await expect(restoreBookingIntent({ token: signToken(), tenantId: TENANT_A, userId: USER_A })).resolves.toMatchObject({
        quote: { totalAmountMinor: 12345 },
      });
      const result = await checkoutBookingIntent({
        token: signToken(), tenantId: TENANT_A, userId: USER_A,
        idempotencyKey: `unverified-${paymentMethod}`,
        input: { paymentMethod, termsAccepted: true, ...(paymentMethod === "membership_credits" ? { membershipBenefitKey: "sessions" } : {}) },
      });
      expect(result.status).toBe(paymentMethod === "card" ? "requires_payment" : "confirmed");
      expect(paymentMethod === "card" ? mocks.createStripeCheckout : mocks.checkoutWithCredits).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A, user: customer }),
      );
      expect(customer.isEmailVerified).toBe(false);
    },
  );

  it("keeps tenant isolation and account access checks for unverified customers", async () => {
    prepareVoucherIntent();
    mocks.userFindOne.mockReturnValue(selectExecQuery({ ...verifiedCustomer, isEmailVerified: false }));
    await expect(checkoutBookingIntent({ token: signToken(), tenantId: TENANT_B, userId: USER_A,
      idempotencyKey: "wrong-tenant", input: { paymentMethod: "card", termsAccepted: true } })).rejects.toMatchObject({ code: "BOOKING_INTENT_NOT_FOUND" });
    mocks.userFindOne.mockReturnValue(selectExecQuery(null));
    await expect(requireBookingCustomerAccount({ tenantId: TENANT_A, userId: USER_A })).rejects.toMatchObject({ code: "CUSTOMER_ACCOUNT_NOT_FOUND" });
    expect(mocks.createStripeCheckout).not.toHaveBeenCalled();
    expect(mocks.checkoutWithCredits).not.toHaveBeenCalled();
  });

  it.each(["public", "private"] as const)("quotes a customer-choice %s session from tenant prices and the selected mode", async (bookingMode) => {
    const start = new Date(Date.now() + 86400000);
    start.setUTCHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 3600000);
    const tenant = { _id: TENANT_A, slug: "studio-alpha", settings: { currency: "EUR" }, modules: { bookings: true, payments: true } };
    mocks.tenantFindById.mockReturnValue(selectExecQuery(tenant));
    mocks.productFindOne.mockReturnValue(execQuery({
      _id: PRODUCT_ID, name: "Choice studio", type: "workshop", kind: "open-studio", bookingMode: "customer-choice",
      location: COURSE_LOCATION_ID,
      price: 10, extraCharge: 999, currency: "EUR", maxNumberOfParticipants: 1,
      openStudioPolicy: { publicCapacityMode: "fixed", publicCapacityLimit: 2, privateBookingSurcharge: 17.25 },
    }));
    mocks.locationFindOne.mockReturnValue(selectLeanExecQuery({
      _id: COURSE_LOCATION_ID, isActive: true, name: "Studio", booking: {
        enabled: true, timezone: "UTC", globalCapacity: 8, minBookingMinutes: 60, maxBookingMinutes: 180, slotStepMinutes: 30,
        activitySelectionMode: "OPTIONAL", activityCapacities: [],
      },
      openingHours: Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => [day, { isOpen: true, openTime: "08:00", closeTime: "20:00" }])),
    }));
    mocks.bookingFind.mockReturnValue(selectLeanExecQuery([]));
    const numberOfGuests = bookingMode === "private" ? 8 : 2;
    const input = createBookingIntentSchema.parse({ productId: PRODUCT_ID, locationId: COURSE_LOCATION_ID, start: start.toISOString(), end: end.toISOString(), numberOfGuests, bookingMode, locale: "en" });
    const result = await createSignedBookingIntent({ tenant: tenant as never, input });
    expect(result.quote).toMatchObject({
      unitPriceMinor: 1000, billableUnits: numberOfGuests * 2,
      privateBookingSurchargeMinor: bookingMode === "private" ? 1725 : 0,
      totalAmountMinor: numberOfGuests * 2000 + (bookingMode === "private" ? 1725 : 0),
      product: { bookingMode },
    });
    expect(mocks.intentCreate).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ bookingMode, bookingType: bookingMode }) }));
    if (bookingMode === "private") {
      const record = { _id: INTENT_ID, tenant: TENANT_A, jti: "intent-jti", payload: input, expiresAt: new Date(Date.now() + 60000) };
      mocks.intentFindOne.mockReturnValue(execQuery(record));
      mocks.intentFindOneAndUpdate.mockReturnValue(execQuery(record));
      mocks.membershipFind.mockResolvedValue({
        _id: "64b000000000000000000109", status: "active", planSnapshot: { locationScope: { type: "all" },
          benefits: [{ key: "visits", label: "Studio visits", type: "allowance", unit: "session" }, { key: "money", label: "Money credits", type: "allowance", unit: "money_minor", currency: "EUR" }] },
      });
      mocks.entitlementFind.mockReturnValue(leanExecQuery([{ benefitKey: "visits", available: 100 }, { benefitKey: "money", available: 20000 }]));
      const restored = await restoreBookingIntent({ token: signToken(), tenantId: TENANT_A, userId: USER_A });
      expect(restored.paymentOptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "membership_credits", benefitKey: "visits", coversTotal: false, unavailableReason: "private_booking_surcharge_requires_money" }),
        expect.objectContaining({ method: "membership_credits", benefitKey: "money", coversTotal: true, required: 17725 }),
      ]));
    }
    await expect(createSignedBookingIntent({ tenant: tenant as never, input: { ...input, bookingMode: undefined, bookingType: undefined } })).rejects.toMatchObject({ code: "OPEN_STUDIO_BOOKING_MODE_REQUIRED" });
  });

  it("uses only persisted product pricing in the public quote", async () => {
    expect(() =>
      createBookingIntentSchema.parse(
        {
          productId:
            PRODUCT_ID,
          courseSlotId:
            COURSE_SLOT_ID,
          quantity: 2,
          numberOfGuests: 2,
          price: 0.01,
        },
      ),
    ).toThrow();

    const futureStart = new Date(
      Date.now() + 3_600_000,
    );
    const futureEnd = new Date(
      futureStart.getTime() +
        7_200_000,
    );
    mocks.tenantFindById.mockReturnValue(
      selectExecQuery({
        _id: TENANT_A,
        settings: {
          currency: "EUR",
        },
        modules: {
          bookings: true,
          courses: true,
          payments: true,
        },
      }),
    );
    mocks.productFindOne.mockReturnValue(
      execQuery({
        _id: PRODUCT_ID,
        name: "Wheel course",
        type: "course",
        price: 123.45,
        currency: "EUR",
        maxNumberOfParticipants: 8,
      }),
    );
    mocks.bookingFindOne.mockReturnValue(
      selectLeanExecQuery({
        _id:
          COURSE_SLOT_ID,
        location:
          COURSE_LOCATION_ID,
        start: futureStart,
        end: futureEnd,
        numberOfGuests: 0,
        capacityReservations: [],
      }),
    );
    mocks.locationFindOne.mockReturnValue(
      selectLeanExecQuery({
        _id: COURSE_LOCATION_ID,
        name: "Studio",
        booking: {
          timezone:
            "Europe/Prague",
        },
      }),
    );

    const input =
      createBookingIntentSchema.parse(
        {
          productId:
            PRODUCT_ID,
          courseSlotId:
            COURSE_SLOT_ID,
          quantity: 2,
          numberOfGuests: 2,
          locale: "en",
        },
      );
    const result =
      await createSignedBookingIntent(
        {
          tenant: {
            _id: TENANT_A,
            slug: "studio-alpha",
          } as never,
          input,
        },
      );

    expect(result.quote).toMatchObject({
      currency: "EUR",
      unitPriceMinor: 12_345,
      billableUnits: 2,
      subtotalAmountMinor:
        24_690,
      totalAmountMinor:
        24_690,
    });
    expect(
      mocks.productFindOne,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: PRODUCT_ID,
        tenant: TENANT_A,
        isActive: true,
      }),
    );
  });

  it("replays a completed checkout for the same key and rejects the same key with a changed request", async () => {
    const token = signToken();
    const response = {
      orderId:
        "64b000000000000000000108",
      status:
        "requires_payment",
      url:
        "https://checkout.stripe.test/session",
    };
    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          paymentMethod: "card",
          membershipBenefitKey:
            null,
          termsAccepted: true,
          locale: null,
          origin: null,
        }),
      )
      .digest("hex");
    const record = {
      _id: INTENT_ID,
      tenant: TENANT_A,
      tenantSlug:
        "studio-alpha",
      jti: "intent-jti",
      claimedBy: USER_A,
      expiresAt: new Date(
        Date.now() + 60_000,
      ),
      payload: {},
      checkout: {
        idempotencyKey:
          "booking-submit-001",
        requestHash,
        status: "completed",
        response,
      },
    };
    mocks.intentFindOne.mockReturnValue(
      execQuery(record),
    );
    mocks.intentFindOneAndUpdate.mockReturnValue(
      execQuery(record),
    );

    await expect(
      checkoutBookingIntent({
        token,
        tenantId: TENANT_A,
        userId: USER_A,
        idempotencyKey:
          "booking-submit-001",
        input: {
          paymentMethod: "card",
          termsAccepted: true,
        },
      }),
    ).resolves.toEqual(response);

    expect(
      mocks.createStripeCheckout,
    ).not.toHaveBeenCalled();
    expect(
      mocks.checkoutWithCredits,
    ).not.toHaveBeenCalled();

    await expect(
      checkoutBookingIntent({
        token,
        tenantId: TENANT_A,
        userId: USER_A,
        idempotencyKey:
          "booking-submit-001",
        input: {
          paymentMethod:
            "money_credits",
          termsAccepted: true,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code:
        "IDEMPOTENCY_KEY_CONFLICT",
    });
  });

  it("restores an already-created card checkout from its purchased quote without revalidating the current product location", async () => {
    const record = prepareVoucherIntent() as any;
    const quote = {
      currency: "EUR", unitPriceMinor: 1000, totalAmountMinor: 2000,
      subtotalAmountMinor: 2000, discountAmountMinor: 0, billableUnits: 2,
      participantCount: 1, durationMinutes: 60, privateBookingSurchargeMinor: 0,
      product: { id: PRODUCT_ID, name: "Original studio", type: "workshop", kind: "open-studio", bookingMode: "public", currency: "EUR" },
      location: { id: COURSE_LOCATION_ID, name: "Original location", timezone: "UTC" },
    };
    record.checkout = { status: "completed", response: { status: "requires_payment", orderId: "64b000000000000000000108", quote } };
    record.payload.courseSlotId = null;
    mocks.productFindOne.mockReturnValue(execQuery(null));
    const result = await restoreBookingIntent({ token: signToken(), tenantId: TENANT_A, userId: USER_A });
    expect(result.quote).toEqual(quote);
    expect(result.intent.locationId).toBe(COURSE_LOCATION_ID);
    expect(mocks.productFindOne).not.toHaveBeenCalled();
    expect(mocks.tenantFindById).not.toHaveBeenCalled();
  });

  it("keeps a checkout in manual review terminal instead of retrying fulfillment", async () => {
    const token = signToken();
    const record = {
      _id: INTENT_ID,
      tenant: TENANT_A,
      tenantSlug:
        "studio-alpha",
      jti: "intent-jti",
      claimedBy: USER_A,
      expiresAt: new Date(
        Date.now() + 60_000,
      ),
      payload: {},
      checkout: {
        idempotencyKey:
          "booking-submit-review",
        requestHash: "previous",
        status:
          "manual_review",
      },
    };
    mocks.intentFindOne.mockReturnValue(
      execQuery(record),
    );
    mocks.intentFindOneAndUpdate.mockReturnValue(
      execQuery(record),
    );

    await expect(
      checkoutBookingIntent({
        token,
        tenantId: TENANT_A,
        userId: USER_A,
        idempotencyKey:
          "booking-submit-review",
        input: {
          paymentMethod:
            "money_credits",
          termsAccepted: true,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code:
        "BOOKING_INTENT_MANUAL_REVIEW_REQUIRED",
    });

    expect(
      mocks.checkoutWithCredits,
    ).not.toHaveBeenCalled();
    expect(
      mocks.createStripeCheckout,
    ).not.toHaveBeenCalled();
  });

  it("moves an expired processing lease to manual review instead of retrying fulfillment", async () => {
    const token = signToken();
    const record = {
      _id: INTENT_ID,
      tenant: TENANT_A,
      tenantSlug:
        "studio-alpha",
      jti: "intent-jti",
      claimedBy: USER_A,
      expiresAt: new Date(
        Date.now() + 60_000,
      ),
      payload: {},
      checkout: {
        idempotencyKey:
          "abandoned-checkout",
        requestHash:
          "abandoned-request",
        status: "processing",
        leaseToken:
          "abandoned-lease",
        leaseExpiresAt: new Date(
          Date.now() - 60_000,
        ),
      },
    };
    mocks.intentFindOne.mockReturnValue(
      execQuery(record),
    );
    mocks.intentFindOneAndUpdate.mockReturnValue(
      execQuery(record),
    );
    mocks.intentUpdateOne.mockReturnValue(
      execQuery({
        modifiedCount: 1,
      }),
    );

    await expect(
      checkoutBookingIntent({
        token,
        tenantId: TENANT_A,
        userId: USER_A,
        idempotencyKey:
          "retry-after-crash",
        input: {
          paymentMethod:
            "money_credits",
          termsAccepted: true,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code:
        "BOOKING_INTENT_MANUAL_REVIEW_REQUIRED",
    });

    expect(
      mocks.intentUpdateOne,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: INTENT_ID,
        claimedBy: USER_A,
        "checkout.status":
          "processing",
      }),
      expect.objectContaining({
        $set:
          expect.objectContaining({
            "checkout.status":
              "manual_review",
            "checkout.lastErrorCode":
              "CHECKOUT_PROCESSING_LEASE_EXPIRED",
          }),
        $unset: {
          "checkout.leaseToken": 1,
        },
      }),
    );
    expect(
      mocks.checkoutWithCredits,
    ).not.toHaveBeenCalled();
    expect(
      mocks.createStripeCheckout,
    ).not.toHaveBeenCalled();
  });

  it("marks an incomplete credit rollback for manual review", async () => {
    const token = signToken();
    const futureStart = new Date(
      Date.now() + 3_600_000,
    );
    const futureEnd = new Date(
      futureStart.getTime() +
        7_200_000,
    );
    const tenant = {
      _id: TENANT_A,
      slug: "studio-alpha",
      settings: {
        currency: "EUR",
      },
      modules: {
        bookings: true,
        courses: true,
        payments: true,
      },
      domains: [],
    };
    const record = {
      _id: INTENT_ID,
      tenant: TENANT_A,
      tenantSlug:
        "studio-alpha",
      jti: "intent-jti",
      claimedBy: USER_A,
      expiresAt: new Date(
        Date.now() + 60_000,
      ),
      payload: {
        productId: PRODUCT_ID,
        locationId:
          COURSE_LOCATION_ID,
        courseSlotId:
          COURSE_SLOT_ID,
        start: futureStart,
        end: futureEnd,
        quantity: 1,
        numberOfGuests: 1,
        bookingType: "public",
        plannedActivity:
          "UNDEFINED",
        locale: "en",
      },
      checkout: {
        status: "idle",
        leaseExpiresAt: null,
      },
    };
    mocks.intentFindOne.mockReturnValue(
      execQuery(record),
    );
    mocks.intentFindOneAndUpdate
      .mockReturnValueOnce(
        execQuery(record),
      )
      .mockReturnValueOnce(
        execQuery(record),
      );
    mocks.tenantFindById.mockReturnValue(
      selectAndExecQuery(tenant),
    );
    mocks.productFindOne.mockReturnValue(
      execQuery({
        _id: PRODUCT_ID,
        name: "Wheel course",
        type: "course",
        price: 123.45,
        currency: "EUR",
        maxNumberOfParticipants: 8,
      }),
    );
    mocks.bookingFindOne.mockReturnValue(
      selectLeanExecQuery({
        _id:
          COURSE_SLOT_ID,
        location:
          COURSE_LOCATION_ID,
        start: futureStart,
        end: futureEnd,
        numberOfGuests: 0,
        capacityReservations: [],
      }),
    );
    mocks.locationFindOne.mockReturnValue(
      selectLeanExecQuery({
        _id: COURSE_LOCATION_ID,
        name: "Studio",
        booking: {
          timezone:
            "Europe/Prague",
        },
      }),
    );
    mocks.checkoutWithCredits.mockRejectedValue(
      new AggregateError(
        [
          new Error(
            "Booking rollback failed",
          ),
        ],
        "Credit checkout rollback was incomplete",
      ),
    );
    mocks.intentUpdateOne.mockReturnValue(
      execQuery({
        modifiedCount: 1,
      }),
    );

    await expect(
      checkoutBookingIntent({
        token,
        tenantId: TENANT_A,
        userId: USER_A,
        idempotencyKey:
          "booking-submit-credit",
        input: {
          paymentMethod:
            "money_credits",
          termsAccepted: true,
          locale: "en",
        },
      }),
    ).rejects.toBeInstanceOf(
      AggregateError,
    );

    expect(
      mocks.intentUpdateOne,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: INTENT_ID,
        claimedBy: USER_A,
      }),
      expect.objectContaining({
        $set:
          expect.objectContaining({
            "checkout.status":
              "manual_review",
            "checkout.lastErrorCode":
              "CHECKOUT_ROLLBACK_INCOMPLETE",
          }),
      }),
    );
  });
});
