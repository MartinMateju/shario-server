import mongoose, { type SchemaDefinition } from "mongoose";

import {
  ORDER_NOTIFICATION_CHANNEL,
  ORDER_NOTIFICATION_STATUS,
  ORDER_NOTIFICATION_TYPE,
  ORDER_STATUS,
} from "./order.constants.js";
import type { Order, OrderModel } from "./order.types.js";
import {
  DEFAULT_STUDIO_COMMERCE_CURRENCY,
  STUDIO_COMMERCE_CURRENCIES,
} from "@/shared/money/currency.js";

const guestIncreaseSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    addGuests: {
      type: Number,
      required: true,
      min: 1,
    },
    capacityReserved: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  { _id: false },
);

const appliedCouponSchema = new mongoose.Schema(
  {
    promoCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
    },

    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },

    couponProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },

    value: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      default: DEFAULT_STUDIO_COMMERCE_CURRENCY,
      uppercase: true,
      trim: true,
    },

    cartTotal: {
      type: Number,
      min: 0,
    },

    remainingToPay: {
      type: Number,
      min: 0,
    },

    appliedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const appliedDiscountSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ["membership", "coupon"],
      required: true,
    },
    label: { type: String, trim: true, required: true, maxlength: 160 },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      uppercase: true,
      trim: true,
      required: true,
    },
    subtotalAmountMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    percentageBps: {
      type: Number,
      min: 0,
      max: 10_000,
      default: null,
      validate: {
        validator: (value: unknown) =>
          value === null || Number.isSafeInteger(value),
        message: "Discount percentage must be integer basis points.",
      },
    },
    membership: {
      membershipId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "UserMembership",
        default: null,
      },
      planId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MembershipPlan",
        default: null,
      },
      planVersionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MembershipPlanVersion",
        default: null,
      },
      planVersion: { type: Number, min: 1, default: null },
      benefitKey: { type: String, trim: true, default: "", maxlength: 80 },
      benefitLabel: { type: String, trim: true, default: "", maxlength: 120 },
    },
    coupon: {
      couponId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Coupon",
        default: null,
      },
      promoCode: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
        maxlength: 120,
      },
    },
    appliedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false, strict: true },
);

const courseSlotSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    capacityReserved: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  { _id: false },
);

const notificationEventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: Object.values(ORDER_NOTIFICATION_TYPE),
      required: true,
    },

    sentAt: {
      type: Date,
      required: true,
      default: Date.now,
    },

    channel: {
      type: String,
      enum: Object.values(ORDER_NOTIFICATION_CHANNEL),
      default: ORDER_NOTIFICATION_CHANNEL.EMAIL,
    },

    to: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },

    template: {
      type: String,
      default: "",
    },

    provider: {
      type: String,
      default: "",
    },

    providerMessageId: {
      type: String,
      default: "",
    },

    status: {
      type: String,
      enum: Object.values(ORDER_NOTIFICATION_STATUS),
      default: ORDER_NOTIFICATION_STATUS.SENT,
    },

    error: {
      type: String,
      default: "",
    },

    attempt: {
      type: Number,
      default: 1,
      min: 1,
    },
    claimId: { type: String, default: "" },
    // Missing on legacy attempts: do not infer that an old interrupted send
    // stopped before reaching its provider.
    deliveryVersion: { type: Number },
    providerStartedAt: { type: Date, default: null },
    retryable: { type: Boolean, default: true },
    providerDeliveryStatus: {
      type: String,
      enum: ["", "delivered", "bounced", "complained"],
      default: "",
    },
    providerStatusAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { _id: false },
);

const orderDefinition: SchemaDefinition<Order> = {
  tenant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tenant",
    required: true,
    index: true,
  },

  cart: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "Cart",
    index: true,
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "User",
    index: true,
  },

  guestCourseCheckout: {
    type: new mongoose.Schema({
      version: { type: Number, enum: [1], required: true, immutable: true },
      accessNonce: { type: String, required: true, immutable: true, select: false },
      accessTokenHash: { type: String, required: true, immutable: true, select: false },
      accessExpiresAt: { type: Date, required: true, immutable: true, select: false },
      locale: { type: String, required: true, immutable: true },
      acceptedTerms: { type: new mongoose.Schema({
        acceptedAt: { type: Date, required: true, immutable: true },
        contentHash: { type: String, required: true, immutable: true },
      }, { _id: false }), default: undefined, immutable: true },
      returnContext: {
        productId: { type: String, required: true, immutable: true },
        courseSessionId: { type: String, required: true, immutable: true },
        location: { type: String, required: true, immutable: true },
        quantity: { type: String, required: true, immutable: true },
      },
    }, { _id: false }),
    default: undefined,
    immutable: true,
  },
  customer: {
    firstname: {
      type: String,
      trim: true,
      default: "",
    },
    lastname: {
      type: String,
      trim: true,
      default: "",
    },
    customId: {
      type: String,
      trim: true,
      default: "",
    },
    memberNumber: {
      type: Number,
      min: 1,
      validate: Number.isSafeInteger,
      default: undefined,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    phone: { type: String, trim: true, default: "" },
    billing: {
      legalName: { type: String, trim: true, default: "" },
      registrationNumber: { type: String, trim: true, default: "" },
      taxId: { type: String, trim: true, default: "" },
      vatId: { type: String, trim: true, default: "" },
      address: {
        line1: { type: String, trim: true, default: "" },
        line2: { type: String, trim: true, default: "" },
        city: { type: String, trim: true, default: "" },
        postalCode: { type: String, trim: true, default: "" },
        country: { type: String, trim: true, default: "" },
        countryCode: { type: String, trim: true, uppercase: true, default: "" },
      },
    },
  },

  status: {
    type: String,
    enum: Object.values(ORDER_STATUS),
    required: true,
    default: ORDER_STATUS.PENDING,
    index: true,
  },

  currency: {
    type: String,
    enum: STUDIO_COMMERCE_CURRENCIES,
    uppercase: true,
    trim: true,
    required: true,
    immutable: true,
    default: DEFAULT_STUDIO_COMMERCE_CURRENCY,
  },

  grossAmountMinor: {
    type: Number,
    required: true,
    min: 0,
    immutable: true,
    default: 0,
  },

  expectedAmountMinor: {
    type: Number,
    required: true,
    min: 0,
    immutable: true,
    default: 0,
  },

  paidAmountMinor: {
    type: Number,
    min: 0,
    default: null,
  },

  locationIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Location" }],
    default: [],
  },

  lineItems: {
    type: [
      new mongoose.Schema(
        {
          product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            default: null,
          },
          booking: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Booking",
            default: null,
          },
          description: { type: String, trim: true, required: true },
          sku: { type: String, trim: true, default: "" },
          quantity: { type: Number, required: true, min: 1 },
          unitGrossMinor: { type: Number, required: true, min: 0 },
          grossAmountMinor: { type: Number, required: true, min: 0 },
          netAmountMinor: { type: Number, required: true, min: 0 },
          taxAmountMinor: { type: Number, required: true, min: 0 },
          taxRateBps: {
            type: Number,
            required: true,
            min: 0,
            max: 10000,
            validate: {
              validator: Number.isSafeInteger,
              message: "Tax rate must be an integer number of basis points.",
            },
          },
          locationIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Location" }],
            default: [],
          },
        },
        { _id: true },
      ),
    ],
    default: [],
  },

  paymentAllocations: {
    type: [
      new mongoose.Schema(
        {
          method: {
            type: String,
            enum: [
              "stripe",
              "credits",
              "membership_credit",
              "voucher",
              "free",
              "manual",
            ],
            required: true,
          },
          amountMinor: { type: Number, required: true, min: 0 },
          providerReference: { type: String, trim: true, default: "" },
        },
        { _id: false },
      ),
    ],
    default: [],
  },

  voucherRedemptions: {
    type: [
      new mongoose.Schema(
        {
          couponId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Coupon",
            required: true,
          },
          reservationId: { type: String, required: true, maxlength: 160 },
          lineIndex: {
            type: Number,
            required: true,
            min: 0,
            validate: Number.isSafeInteger,
          },
          eligibleProductId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
          },
          amountMinor: {
            type: Number,
            required: true,
            min: 0,
            validate: Number.isSafeInteger,
          },
          quantity: {
            type: Number,
            required: true,
            min: 0,
            validate: Number.isSafeInteger,
          },
          appliedAmountMinor: {
            type: Number,
            required: true,
            min: 1,
            validate: Number.isSafeInteger,
          },
        },
        { _id: false },
      ),
    ],
    default: [],
    immutable: true,
  },
  voucherCheckoutReleasedAt: { type: Date, default: null },
  voucherStripeRequest: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    immutable: true,
    select: false,
  },
  pieceStripeRequest: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    immutable: true,
    select: false,
  },
  pieceCheckout: {
    type: new mongoose.Schema(
      {
        requestHash: { type: String, required: true },
        method: { type: String, enum: ["card", "credits"], required: true },
        state: {
          type: String,
          enum: ["pending", "paid", "cancelled", "refunded"],
          default: "pending",
        },
        expiresAt: { type: Date, required: true },
        refundedAmountMinor: { type: Number, default: 0, min: 0 },
        items: {
          type: [
            new mongoose.Schema(
              {
                potteryPieceId: {
                  type: mongoose.Schema.Types.ObjectId,
                  ref: "PotteryPiece",
                  required: true,
                },
                quoteRevision: { type: String, required: true },
                name: { type: String, required: true },
                registrationNumber: { type: String, required: true },
                amountMinor: { type: Number, required: true, min: 1 },
              },
              { _id: false },
            ),
          ],
          required: true,
        },
      },
      { _id: false },
    ),
    default: null,
  },

  invoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Invoice",
    default: null,
    index: true,
  },

  invoiceAutomation: {
    attempts: { type: Number, min: 0, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    lastError: { type: String, trim: true, default: "", maxlength: 2000 },
  },

  note: {
    type: String,
    trim: true,
    default: "",
  },

  isPaid: {
    type: Boolean,
    default: false,
    index: true,
  },

  paidAt: {
    type: Date,
    default: null,
  },

  creditPurchase: {
    amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      uppercase: true,
      trim: true,
      default: DEFAULT_STUDIO_COMMERCE_CURRENCY,
    },
  },

  credits: {
    appliedMajor: {
      type: Number,
      default: 0,
      min: 0,
    },
    requestedMajor: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      uppercase: true,
      trim: true,
      default: DEFAULT_STUDIO_COMMERCE_CURRENCY,
    },
    couponId: {
      type: String,
      trim: true,
      default: null,
    },
  },

  membershipRedemption: {
    membershipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserMembership",
      default: null,
      immutable: true,
    },
    benefitKey: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
      immutable: true,
    },
    quantity: {
      type: Number,
      min: 0,
      default: 0,
      validate: Number.isSafeInteger,
      immutable: true,
    },
    ledgerEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MembershipEntitlementLedger",
      default: null,
      immutable: true,
    },
  },

  legacyOrder: {
    type: Boolean,
    default: false,
  },

  appliedDiscount: {
    type: appliedDiscountSchema,
    default: null,
    immutable: true,
  },

  appliedCoupons: {
    type: [appliedCouponSchema],
    default: [],
  },

  notificationLog: {
    type: [notificationEventSchema],
    default: [],
  },

  notificationRecovery: {
    type: new mongoose.Schema(
      {
        id: { type: String, required: true },
        requestedAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        reason: {
          type: String,
          enum: ["smtp-loopback-refused", "piece-confirmation-missing"],
          required: true,
        },
        to: { type: String, required: true, trim: true, lowercase: true },
        previousEvents: { type: [notificationEventSchema], default: [] },
      },
      { _id: false },
    ),
    default: undefined,
  },

  notificationLock: {
    lockedUntil: {
      type: Date,
      default: null,
    },
    lockedBy: {
      type: String,
      default: "",
    },
    lockedAt: {
      type: Date,
      default: null,
    },
  },

  bookingExtension: {
    type: new mongoose.Schema({ bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true }, originalEnd: { type: Date, required: true }, end: { type: Date, required: true }, amountMinor: { type: Number, required: true }, refundId: { type: String, default: "" }, refundStatus: { type: String, default: "" } }, { _id: false }),
    default: undefined,
  },
  workshopBookings: {
    type: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Booking",
      },
    ],
    default: [],
  },

  courseBookings: {
    type: [courseSlotSchema],
    default: [],
  },

  courseCancellations: {
    type: [
      new mongoose.Schema(
        {
          bookingId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Booking",
            required: true,
          },
          quantity: { type: Number, required: true, min: 1 },
          releasedQuantity: { type: Number, min: 0 },
          refundAmountMinor: { type: Number, required: true, min: 0 },
          currency: {
            type: String,
            enum: STUDIO_COMMERCE_CURRENCIES,
            required: true,
          },
          actor: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          reason: { type: String, trim: true, required: true, maxlength: 500 },
          refundedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
    ],
    default: [],
  },

  guestIncreaseBookings: {
    type: [guestIncreaseSchema],
    default: [],
  },

  waitlist: {
    stripeSessionExpiresAt: { type: Date, default: null, immutable: true },
    entryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WaitlistEntry",
      default: null,
      immutable: true,
    },
    offerGeneration: {
      type: Number,
      default: null,
      immutable: true,
    },
    priceVersion: {
      type: String,
      trim: true,
      default: "",
      immutable: true,
    },
  },

  waitlistRefund: {
    refundId: { type: String, trim: true, default: "" },
    status: { type: String, trim: true, default: "" },
    amountMinor: { type: Number, min: 0, default: null },
    lastCheckedAt: { type: Date, default: null },
  },

  stripe: {
    connectedAccountId: {
      type: String,
      trim: true,
      default: "",
      immutable: true,
    },
    livemode: {
      type: Boolean,
      default: null,
    },
    customerId: {
      type: String,
      trim: true,
      default: "",
    },
    sessionId: {
      type: String,
      trim: true,
      default: "",
    },
    paymentIntentId: {
      type: String,
      trim: true,
      default: "",
    },
    processedEventIds: {
      type: [String],
      default: [],
    },
    processingClaimToken: { type: String, trim: true, default: "" },
    processingEventId: { type: String, trim: true, default: "" },
    processingClaimedAt: { type: Date, default: null },
    processingLeaseExpiresAt: { type: Date, default: null },
    processingAttemptCount: { type: Number, min: 0, default: 0 },
    lastProcessingError: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    lastProcessingFailedAt: { type: Date, default: null },
  },
};

export const orderSchema = new mongoose.Schema<Order, OrderModel>(
  orderDefinition,
  { timestamps: true },
);

orderSchema.pre("validate", function validateAppliedDiscountSnapshot() {
  const discount = this.appliedDiscount;

  if (!discount) return;

  if (discount.amountMinor > discount.subtotalAmountMinor) {
    this.invalidate(
      "appliedDiscount.amountMinor",
      "Applied discount cannot exceed the checkout subtotal.",
    );
  }

  if (
    discount.subtotalAmountMinor - discount.amountMinor !==
    this.grossAmountMinor
  ) {
    this.invalidate(
      "appliedDiscount",
      "Applied discount snapshot does not match the order total.",
    );
  }

  if (discount.currency !== this.currency) {
    this.invalidate(
      "appliedDiscount.currency",
      "Applied discount currency must match the order currency.",
    );
  }

  if ((this.appliedCoupons ?? []).length > 0) {
    this.invalidate(
      "appliedCoupons",
      "Coupon and membership discounts cannot be combined.",
    );
  }

  if (
    discount.source === "membership" &&
    (!discount.membership?.membershipId ||
      !discount.membership?.planId ||
      !discount.membership?.planVersionId ||
      !discount.membership?.benefitKey)
  ) {
    this.invalidate(
      "appliedDiscount.membership",
      "Membership discount identity is incomplete.",
    );
  }
});

orderSchema.index({ tenant: 1, status: 1 });
orderSchema.index({ tenant: 1, createdAt: -1 });
orderSchema.index({ tenant: 1, isPaid: 1, paidAt: -1 });
orderSchema.index({ tenant: 1, cart: 1 });
orderSchema.index({ tenant: 1, createdBy: 1 });
orderSchema.index({
  tenant: 1,
  createdBy: 1,
  isPaid: 1,
  status: 1,
  "courseBookings.bookingId": 1,
});

orderSchema.index(
  { tenant: 1, "waitlist.entryId": 1, "waitlist.offerGeneration": 1 },
  {
    unique: true,
    name: "tenant_waitlist_offer_order",
    partialFilterExpression: { "waitlist.entryId": { $type: "objectId" } },
  },
);
orderSchema.index({ tenant: 1, locationIds: 1, createdAt: -1 });
orderSchema.index({ tenant: 1, isPaid: 1, invoice: 1, paidAt: -1 });
orderSchema.index({
  tenant: 1,
  "invoiceAutomation.nextAttemptAt": 1,
  paidAt: 1,
});
orderSchema.index({ tenant: 1, "customer.customId": 1 });
orderSchema.index({ tenant: 1, "customer.email": 1 });

orderSchema.index({ tenant: 1, "notificationLog.type": 1 });
orderSchema.index({ "notificationLog.providerMessageId": 1 }, { sparse: true });
orderSchema.index({ tenant: 1, "notificationLog.sentAt": -1 });
orderSchema.index({ tenant: 1, "notificationLock.lockedUntil": 1 });
orderSchema.index({ tenant: 1, "stripe.processingLeaseExpiresAt": 1 });
orderSchema.index(
  { "pieceCheckout.state": 1, "pieceCheckout.method": 1, updatedAt: 1 },
  { partialFilterExpression: { "pieceCheckout.state": "pending" } },
);

orderSchema.index(
  { tenant: 1, "stripe.sessionId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "stripe.sessionId": { $type: "string", $gt: "" },
    },
  },
);

orderSchema.index({
  tenant: 1,
  "stripe.connectedAccountId": 1,
  createdAt: -1,
});

orderSchema.index({
  tenant: 1,
  status: 1,
  "courseBookings.bookingId": 1,
});
orderSchema.index({ tenant: 1, "courseCancellations.bookingId": 1 });

orderSchema.index({
  tenant: 1,
  status: 1,
  workshopBookings: 1,
});
