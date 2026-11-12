import { lockExtensionTargets, releaseBookingExtensionHolds } from "@/modules/booking/booking.extension.service.js";
import { releaseCancelledPersonalCourseDiscounts } from "./services/checkout.membership-course.service.js";
import { releaseCheckoutVouchers } from "./services/checkout.voucher.service.js";
import mongoose, { type ClientSession } from "mongoose";

import Booking from "@/modules/booking/booking.model.js";
import { loadCourseCapacityForBookings } from "@/modules/booking/booking.course-capacity.js";
import { Cart } from "@/modules/cart/cart.model.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import MetadataModel from "@/modules/metadata/metadata.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { LocationModel as Location } from "@/modules/location/location.model.js";
import { Order } from "@/modules/order/order.model.js";
import { Product } from "@/modules/product/product.model.js";
import User from "@/modules/user/user.model.js";
import { conflict } from "@/shared/http/httpErrors.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";
import { buildStripeOrderLeaseAvailabilityFilter } from "./checkout.processing-claim.js";
import {
  assertPersistedWorkshopBookingSnapshot,
  assertReusablePendingWorkshopBooking,
} from "./checkout.card-recovery.js";
import {
  validateGuestIncreaseAvailabilityOrThrow,
  validateWorkshopAvailabilityOrThrow,
} from "./services/checkout.capacity.service.js";

import type { IdLike, PlainObject, TenantId } from "./checkout.types.js";

type TenantArgs = {
  tenantId: TenantId;
};

type SessionArgs = {
  session?: ClientSession | null;
};

type UserEmailArgs = TenantArgs & {
  email?: string;
};

type ProductIdsArgs = TenantArgs & {
  productIds: IdLike[];
};

type IdsArgs = TenantArgs & {
  ids: IdLike[];
};

type PayloadArgs = TenantArgs &
  SessionArgs & {
    payload: PlainObject;
  };

type PayloadsArgs = TenantArgs &
  SessionArgs & {
    payloads: PlainObject[];
    atomicCapacity?: boolean;
  };

type UserIdArgs = TenantArgs & {
  userId: IdLike;
};

type CardCheckoutRecoveryArgs = TenantArgs & {
  orderId: IdLike;
  userId: IdLike;
};

type TenantOrderArgs = TenantArgs & {
  orderId: IdLike;
};

type ClaimStripeOrderArgs = TenantArgs & {
  orderId: IdLike;
  eventId: string;
  claimToken: string;
  now: Date;
  leaseExpiresAt: Date;
  session: {
    id?: string;
    payment_intent?: string | null;
    currency: string;
    amount_total: number;
    connectedAccountId: string;
    livemode: boolean;
  };
};

type ClaimLegacyPlatformStripeOrderArgs = TenantArgs & {
  orderId: IdLike;
  eventId: string;
  claimToken: string;
  now: Date;
  leaseExpiresAt: Date;
  session: {
    id: string;
    payment_intent?: string | null;
    currency: string;
    amount_total: number;
    livemode: boolean;
  };
};

type MarkOrderProcessedArgs = TenantArgs & {
  orderId: IdLike;
  eventId: string;
  claimToken: string;
  paidAt?: Date;
  session?: ClientSession | null;
};

type MarkLateWaitlistOrderRefundedArgs = TenantArgs & {
  orderId: IdLike;
  eventId: string;
  paymentIntentId: string;
  paidAmountMinor: number;
  paidAt?: Date;
};

type MarkOrderFailedArgs = TenantArgs & {
  orderId: IdLike;
  error: unknown;
  claimToken?: string;
};

type MarkOrderProcessingRetryableArgs = TenantArgs & {
  orderId: IdLike;
  error: unknown;
  claimToken: string;
};

type PromoCodeArgs = TenantArgs & {
  promoCode: string;
};

type ProductIdArgs = TenantArgs & {
  productId: IdLike;
};

type CreditMutationArgs = TenantArgs & {
  userId: IdLike;
  amount: number;
};

type AttachStripeSessionArgs = TenantArgs & {
  orderId: IdLike;
  sessionId: string;
  amountMinor: number;
  currency: string;
  connectedAccountId: string;
  livemode: boolean;
};

type ReleaseExpiredStripeOrderArgs = TenantArgs & {
  orderId: IdLike;
  sessionId: string;
  connectedAccountId: string;
};

type ReleaseExpiredLegacyPlatformStripeOrderArgs = TenantArgs & {
  orderId: IdLike;
  sessionId: string;
  currency: string;
  amountTotal: number;
  livemode: boolean;
};

type CourseCapacityReservationRequest = {
  bookingId: IdLike;
  productId: IdLike;
  quantity: number;
  capacity: number;
};

type ReserveCourseCapacityArgs = TenantArgs &
  SessionArgs & {
    orderId: IdLike;
    reservations: CourseCapacityReservationRequest[];
    expiresAt: Date;
    minimumStart?: Date;
    now?: Date;
  };

type GuestIncreaseCapacityReservationRequest = {
  bookingId: IdLike;
  addGuests: number;
  billingBlocks: number;
};

type ReserveGuestIncreaseCapacityArgs = TenantArgs &
  SessionArgs & {
    userId: IdLike;
    orderId: IdLike;
    reservations: GuestIncreaseCapacityReservationRequest[];
    expiresAt: Date;
    now?: Date;
  };

type ReleaseCourseCapacityArgs = TenantArgs & {
  orderId: IdLike;
  bookingIds?: IdLike[];
};

const toObjectId = (value: IdLike | TenantId): mongoose.Types.ObjectId => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return new mongoose.Types.ObjectId(String(value));
};

const scopeTenant = <TFilter extends Record<string, unknown>>(
  tenantId: TenantId,
  filter: TFilter = {} as TFilter,
): TFilter & { tenant: mongoose.Types.ObjectId } => ({
  ...filter,
  tenant: toObjectId(tenantId),
});

const attachTenant = <TPayload extends PlainObject>(
  tenantId: TenantId,
  payload: TPayload,
): TPayload & { tenant: mongoose.Types.ObjectId } => ({
  ...payload,
  tenant: toObjectId(tenantId),
});

const attachTenantToMany = (
  tenantId: TenantId,
  payloads: PlainObject[],
): Array<PlainObject & { tenant: mongoose.Types.ObjectId }> =>
  payloads.map((payload) => attachTenant(tenantId, payload));

const PROCESSING_RECORD_REPLACEMENT_GRACE_MS = 5 * 60 * 1000;

export const checkoutRepository = {
  findUserByEmail({ tenantId, email }: UserEmailArgs) {
    if (!email) return Promise.resolve(null);

    return User.findOne(
      scopeTenant(tenantId, {
        email: String(email).trim().toLowerCase(),
      }),
    ).exec();
  },

  loadProductsByIds({ tenantId, productIds }: ProductIdsArgs) {
    return Product.find(
      scopeTenant(tenantId, {
        _id: { $in: productIds.map((id) => toObjectId(id)) },
        isActive: true,
        isArchived: { $ne: true },
      }),
    )
      .select({
        _id: 1,
        name: 1,
        description: 1,
        sku: 1,
        price: 1,
        type: 1,
        kind: 1,
        location: 1,
        bookingMode: 1,
        openStudioPolicy: 1,
        extraCharge: 1,
        currency: 1,
        imageSrc: 1,
        maxNumberOfParticipants: 1,
      })
      .lean()
      .exec();
  },

  loadLocationsByIds({ tenantId, ids }: IdsArgs) {
    return Location.find(
      scopeTenant(tenantId, {
        _id: { $in: ids.map((id) => toObjectId(id)) },
        isActive: true,
      }),
    )
      .select({
        _id: 1,
        name: 1,
        slug: 1,
        code: 1,
        isActive: 1,
        address: 1,
        contact: 1,
        booking: 1,
      })
      .lean()
      .exec();
  },

  async findCurrentBookings({
    tenantId,
    locationIds = [],
    since = new Date(),
  }: TenantArgs & { locationIds?: IdLike[]; since?: Date }) {
    const bookings = await Booking.find(
      scopeTenant(tenantId, {
        // An active booking that started before the query window can still
        // overlap a requested interval. End-time filtering is the safe lower
        // bound for all later overlap checks.
        end: { $gt: since },
        ...(locationIds.length
          ? { location: { $in: locationIds.map((id) => toObjectId(id)) } }
          : {}),
      }),
    )
      .lean()
      .exec();
    await loadCourseCapacityForBookings({ bookings, tenantId });
    return bookings;
  },

  findCourseSlots({ tenantId, ids }: IdsArgs) {
    return Booking.find(
      scopeTenant(tenantId, {
        _id: { $in: ids.map((id) => toObjectId(id)) },
        tag: { $in: ["class", "course"] },
        archive: { $ne: true },
        status: { $ne: "cancelled" },
        start: { $gte: new Date() },
      }),
    )
      .select({
        _id: 1,
        bookingProduct: 1,
        numberOfGuests: 1,
        location: 1,
        start: 1,
        status: 1,
        archive: 1,
      })
      .lean()
      .exec();
  },

  /**
   * Atomically reserves each course slot. The capacity predicate and the
   * reservation append are one MongoDB update per slot, so two concurrent
   * Checkout requests cannot both observe and claim the same remaining seat.
   * If a multi-slot cart fails part-way through, all holds for this order are
   * compensated before the capacity error is returned.
   */
  async reserveCourseCapacity({
    tenantId,
    orderId,
    reservations,
    expiresAt,
    minimumStart,
    now = new Date(),
    session = null,
  }: ReserveCourseCapacityArgs) {
    if (!reservations.length) return true;

    const orderObjectId = toObjectId(orderId);
    const tenantObjectId = toObjectId(tenantId);

    const activeOtherReservations = {
      $filter: {
        input: { $ifNull: ["$capacityReservations", []] },
        as: "reservation",
        cond: {
          $and: [
            { $gt: ["$$reservation.expiresAt", now] },
            { $ne: ["$$reservation.order", orderObjectId] },
          ],
        },
      },
    };
    const activeWaitlistHolds = {
      $filter: {
        input: { $ifNull: ["$waitlistCapacityHolds", []] },
        as: "hold",
        cond: { $gt: ["$$hold.expiresAt", now] },
      },
    };

    try {
      for (const reservation of reservations) {
        const bookingId = toObjectId(reservation.bookingId);
        const productId = toObjectId(reservation.productId);

        const result = await Booking.updateOne(
          {
            tenant: tenantObjectId,
            _id: bookingId,
            tag: { $in: ["class", "course"] },
            bookingProduct: productId,
            archive: { $ne: true },
            status: { $ne: "cancelled" },
            start: { $gt: minimumStart || now },
            $expr: {
              $lte: [
                {
                  $add: [
                    { $ifNull: ["$numberOfGuests", 0] },
                    {
                      $sum: {
                        $map: {
                          input: activeOtherReservations,
                          as: "reservation",
                          in: "$$reservation.quantity",
                        },
                      },
                    },
                    { $size: activeWaitlistHolds },
                    reservation.quantity,
                  ],
                },
                reservation.capacity,
              ],
            },
          },
          [
            {
              $set: {
                capacityReservations: {
                  $concatArrays: [
                    activeOtherReservations,
                    [
                      {
                        order: orderObjectId,
                        quantity: reservation.quantity,
                        expiresAt,
                      },
                    ],
                  ],
                },
              },
            },
          ],
          { session, updatePipeline: true },
        ).exec();

        if (result.modifiedCount !== 1) {
          conflict({
            message:
              "The selected Class no longer has enough available places.",
            code: "CHECKOUT_COURSE_CAPACITY_EXCEEDED",
            details: {
              bookingId: String(bookingId),
              requested: reservation.quantity,
            },
          });
        }
      }
    } catch (error) {
      if (session) throw error;

      await Booking.updateMany(
        {
          tenant: tenantObjectId,
          "capacityReservations.order": orderObjectId,
        },
        {
          $pull: {
            capacityReservations: { order: orderObjectId },
          },
        },
      ).exec();

      throw error;
    }

    return true;
  },

  async reserveGuestIncreaseCapacity({
    tenantId,
    userId,
    orderId,
    reservations,
    expiresAt,
    now = new Date(),
    session = null,
  }: ReserveGuestIncreaseCapacityArgs) {
    if (!reservations.length) return true;

    const tenantObjectId = toObjectId(tenantId);
    const userObjectId = toObjectId(userId);
    const orderObjectId = toObjectId(orderId);
    const byBookingId = new Map<
      string,
      GuestIncreaseCapacityReservationRequest
    >();

    for (const reservation of reservations) {
      const key = String(reservation.bookingId);
      const existing = byBookingId.get(key);
      byBookingId.set(key, {
        bookingId: reservation.bookingId,
        addGuests: (existing?.addGuests || 0) + reservation.addGuests,
        billingBlocks: reservation.billingBlocks,
      });
    }

    const normalized = [...byBookingId.values()];
    const bookingIds = normalized.map((item) => toObjectId(item.bookingId));

    const run = async (activeSession: ClientSession) => {
      const initialTargets = await Booking.find({
        tenant: tenantObjectId,
        _id: { $in: bookingIds },
        createdBy: userObjectId,
        tag: { $in: ["open-studio", "workshop"] },
      })
        .select({ location: 1 })
        .session(activeSession)
        .lean()
        .exec();
      const locationIds = [
        ...new Set(initialTargets.map((target) => String(target.location))),
      ].map((id) => toObjectId(id));

      if (
        initialTargets.length !== bookingIds.length ||
        locationIds.length === 0
      ) {
        conflict({
          message: "An Open Studio booking is no longer available.",
          code: "CHECKOUT_GUEST_INCREASE_BOOKING_UNAVAILABLE",
        });
      }

      /*
       * Location.capacityRevision is the serialization point shared with new
       * Open Studio checkout reservations. A concurrent transaction touching
       * the same location is retried by MongoDB with a fresh capacity view.
       */
      const locked = await Location.updateMany(
        {
          tenant: tenantObjectId,
          _id: { $in: locationIds },
          isActive: true,
          "booking.enabled": true,
        },
        { $inc: { "booking.capacityRevision": 1 } },
        { session: activeSession },
      ).exec();

      if (locked.matchedCount !== locationIds.length) {
        conflict({
          message: "A selected studio location is no longer available.",
          code: "LOCATION_NOT_AVAILABLE",
        });
      }

      const targets = await Booking.find({
        tenant: tenantObjectId,
        _id: { $in: bookingIds },
        createdBy: userObjectId,
        tag: { $in: ["open-studio", "workshop"] },
      })
        .select({
          _id: 1,
          createdBy: 1,
          bookingProduct: 1,
          location: 1,
          start: 1,
          end: 1,
          status: 1,
          paymentStatus: 1,
          numberOfGuests: 1,
          capacityReservations: 1,
          bookingMode: 1,
          publicCapacityLimit: 1,
          customerChoiceBooking: 1,
          bookingType: 1,
          plannedActivity: 1,
          tag: 1,
        })
        .session(activeSession)
        .lean()
        .exec();
      const locations = await Location.find({
        tenant: tenantObjectId,
        _id: { $in: locationIds },
        isActive: true,
        "booking.enabled": true,
      })
        .select("booking isActive")
        .session(activeSession)
        .lean()
        .exec();
      const earliestStart = targets.reduce((earliest, target) => {
        const start = new Date(target.start);
        return start < earliest ? start : earliest;
      }, new Date(8.64e15));
      const currentBookings = await Booking.find({
        tenant: tenantObjectId,
        location: { $in: locationIds },
        end: {
          $gt: Number.isFinite(earliestStart.getTime()) ? earliestStart : now,
        },
      })
        .session(activeSession)
        .lean()
        .exec();

      await loadCourseCapacityForBookings({ bookings: currentBookings, tenantId, session: activeSession });

      const withoutOwnHold = (booking: any) => ({
        ...booking,
        capacityReservations: (booking.capacityReservations || []).filter(
          (reservation: any) =>
            String(reservation.order) !== String(orderObjectId),
        ),
      });

      validateGuestIncreaseAvailabilityOrThrow({
        guestIncreaseBookings: normalized,
        targets: targets.map(withoutOwnHold),
        userId: userObjectId,
        currentBookings: currentBookings.map(withoutOwnHold),
        locationById: new Map(
          locations.map((location) => [String(location._id), location]),
        ),
      });

      const activeOtherReservations = {
        $filter: {
          input: { $ifNull: ["$capacityReservations", []] },
          as: "reservation",
          cond: {
            $and: [
              { $gt: ["$$reservation.expiresAt", now] },
              { $ne: ["$$reservation.order", orderObjectId] },
            ],
          },
        },
      };

      for (const reservation of normalized) {
        const result = await Booking.updateOne(
          {
            tenant: tenantObjectId,
            _id: toObjectId(reservation.bookingId),
            createdBy: userObjectId,
            tag: { $in: ["open-studio", "workshop"] },
            status: { $ne: "cancelled" },
            paymentStatus: "CONFIRMED",
            start: { $gt: now },
          },
          [
            {
              $set: {
                capacityReservations: {
                  $concatArrays: [
                    activeOtherReservations,
                    [
                      {
                        order: orderObjectId,
                        quantity: reservation.addGuests,
                        expiresAt,
                      },
                    ],
                  ],
                },
              },
            },
          ],
          { session: activeSession, updatePipeline: true },
        ).exec();

        if (result.modifiedCount !== 1) {
          conflict({
            message: "Guest capacity could not be reserved.",
            code: "CHECKOUT_GUEST_INCREASE_CAPACITY_RESERVATION_FAILED",
            details: { bookingId: String(reservation.bookingId) },
          });
        }
      }

      return true;
    };

    if (session) return run(session);

    const ownedSession = await mongoose.startSession();
    try {
      let reserved = false;
      await ownedSession.withTransaction(async () => {
        reserved = await run(ownedSession);
      });
      return reserved;
    } finally {
      await ownedSession.endSession();
    }
  },

  releaseCourseCapacity({
    tenantId,
    orderId,
    bookingIds = [],
  }: ReleaseCourseCapacityArgs) {
    const orderObjectId = toObjectId(orderId);

    return Booking.updateMany(
      scopeTenant(tenantId, {
        ...(bookingIds.length
          ? { _id: { $in: bookingIds.map((id) => toObjectId(id)) } }
          : {}),
        "capacityReservations.order": orderObjectId,
      }),
      {
        $pull: {
          capacityReservations: { order: orderObjectId },
        },
      },
    ).exec();
  },

  findBookingLocations({ tenantId, ids }: IdsArgs) {
    if (!ids.length) return Promise.resolve([]);

    return Booking.find(
      scopeTenant(tenantId, {
        _id: { $in: ids.map((id) => toObjectId(id)) },
      }),
    )
      .select({ _id: 1, tag: 1, location: 1 })
      .lean()
      .exec();
  },

  findGuestIncreaseTargets({ tenantId, ids }: IdsArgs) {
    if (!ids.length) return Promise.resolve([]);

    return Booking.find(
      scopeTenant(tenantId, {
        _id: { $in: ids.map((id) => toObjectId(id)) },
        tag: { $in: ["open-studio", "workshop"] },
      }),
    )
      .select({
        _id: 1,
        createdBy: 1,
        bookingProduct: 1,
        location: 1,
        start: 1,
        end: 1,
        status: 1,
        paymentStatus: 1,
        numberOfGuests: 1,
        capacityReservations: 1,
        bookingMode: 1,
        publicCapacityLimit: 1,
        customerChoiceBooking: 1,
        bookingType: 1,
        plannedActivity: 1,
        tag: 1,
      })
      .lean()
      .exec();
  },

  async createCart({ tenantId, payload, session = null }: PayloadArgs) {
    const cart = new Cart(attachTenant(tenantId, payload));
    try {
      return await cart.save({ session: session ?? undefined });
    } catch (error: any) {
      if (error?.code !== 11000 || !payload._id) throw error;

      const existing = await Cart.findOne(
        scopeTenant(tenantId, {
          _id: toObjectId(payload._id as IdLike),
          user: payload.user,
        }),
      )
        .session(session)
        .exec();
      if (!existing) throw error;
      return existing;
    }
  },

  async createOrder({ tenantId, payload, session = null }: PayloadArgs) {
    const order = new Order(attachTenant(tenantId, payload));
    try {
      return await order.save({ session: session ?? undefined });
    } catch (error: any) {
      if (error?.code !== 11000 || !payload._id) throw error;

      const existing = await Order.findOne(
        scopeTenant(tenantId, {
          _id: toObjectId(payload._id as IdLike),
          createdBy: payload.createdBy,
        }),
      )
        .session(session)
        .exec();
      if (!existing) throw error;
      return existing;
    }
  },

  findWaitlistRefundSnapshot({ tenantId, orderId }: TenantOrderArgs) {
    return Order.findOne(scopeTenant(tenantId, { _id: toObjectId(orderId) }))
      .select(
        "currency expectedAmountMinor waitlist waitlistRefund stripe.connectedAccountId",
      )
      .lean()
      .exec();
  },

  recordWaitlistRefundAttempt({
    tenantId,
    orderId,
    refundId,
    status,
    amountMinor,
  }: TenantOrderArgs & {
    refundId: string;
    status: string;
    amountMinor: number | null;
  }) {
    return Order.updateOne(
      scopeTenant(tenantId, { _id: toObjectId(orderId) }),
      {
        $set: {
          "waitlistRefund.refundId": refundId,
          "waitlistRefund.status": status,
          "waitlistRefund.amountMinor": amountMinor,
          "waitlistRefund.lastCheckedAt": new Date(),
        },
      },
    ).exec();
  },

  async attachStripeSession({
    tenantId,
    orderId,
    sessionId,
    amountMinor,
    currency,
    connectedAccountId,
    livemode,
  }: AttachStripeSessionArgs) {
    const normalizedCurrency = normalizeStudioCommerceCurrency(currency);

    const result = await Order.updateOne(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        isPaid: false,
        currency: normalizedCurrency,
        expectedAmountMinor: amountMinor,
        "stripe.connectedAccountId": connectedAccountId,
        "stripe.livemode": null,
        "paymentAllocations.method": { $ne: "stripe" },
        $or: [
          { "stripe.sessionId": { $exists: false } },
          { "stripe.sessionId": "" },
          { "stripe.sessionId": null },
        ],
      }),
      {
        $set: {
          "stripe.sessionId": sessionId,
          "stripe.livemode": livemode,
        },
        $push: {
          paymentAllocations: {
            $each: [
              {
                method: "stripe",
                amountMinor,
                providerReference: sessionId,
              },
            ],
            $position: 0,
          },
        },
      },
    ).exec();

    if (result.modifiedCount === 1) return result;

    const alreadyAttached = await Order.exists(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        currency: normalizedCurrency,
        expectedAmountMinor: amountMinor,
        "stripe.sessionId": sessionId,
        "stripe.connectedAccountId": connectedAccountId,
        "stripe.livemode": livemode,
        paymentAllocations: {
          $elemMatch: {
            method: "stripe",
            amountMinor,
            providerReference: sessionId,
          },
        },
      }),
    ).exec();

    return alreadyAttached ? { ...result, modifiedCount: 1 } : result;
  },

  findCardCheckoutRecovery({
    tenantId,
    orderId,
    userId,
  }: CardCheckoutRecoveryArgs) {
    return Order.findOne(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        createdBy: toObjectId(userId),
      }),
    )
      .select("+voucherStripeRequest")
      .lean()
      .exec();
  },

  findCardCartRecovery({
    tenantId,
    cartId,
    userId,
  }: TenantArgs & { cartId: IdLike; userId: IdLike }) {
    return Cart.findOne(
      scopeTenant(tenantId, {
        _id: toObjectId(cartId),
        user: toObjectId(userId),
      }),
    )
      .lean()
      .exec();
  },

  async releaseExpiredStripeOrder({
    tenantId,
    orderId,
    sessionId,
    connectedAccountId,
  }: ReleaseExpiredStripeOrderArgs) {
    /*
     * Stripe documents an expired Checkout Session as terminal: no further
     * payment processing will occur. Mark first, then delete idempotently so
     * a retried expired event can finish cleanup after a partial failure.
     */
    const order = await Order.findOneAndUpdate(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        isPaid: false,
        status: { $in: ["pending_order", "cancelled_order"] },
        "stripe.sessionId": sessionId,
        "stripe.connectedAccountId": connectedAccountId,
        "stripe.paymentIntentId": { $in: ["", null] },
        $or: [
          { "stripe.processingClaimToken": { $exists: false } },
          { "stripe.processingClaimToken": "" },
          { "stripe.processingClaimToken": null },
        ],
      }),
      { $set: { status: "cancelled_order" } },
      { returnDocument: "after" },
    )
      .select({
        _id: 1,
        cart: 1,
        createdBy: 1,
        currency: 1,
        voucherRedemptions: 1,
        workshopBookings: 1,
        courseBookings: 1,
        guestIncreaseBookings: 1,
        appliedDiscount: 1,
      })
      .lean()
      .exec();

    if (!order) return false;
    await releaseBookingExtensionHolds({ tenantId, orderId });
    if (order.appliedDiscount?.source === "membership") await releaseCancelledPersonalCourseDiscounts(String(tenantId), String(orderId));
    await releaseCheckoutVouchers({
      tenantId: String(tenantId),
      order,
      paymentState: "expired",
      reason: "Stripe Checkout Session expired.",
    });

    if (order.workshopBookings.length > 0) {
      await Booking.deleteMany(
        scopeTenant(tenantId, {
          _id: { $in: order.workshopBookings },
          orders: order._id,
          status: "pending",
          paymentStatus: "PENDING_PAYMENT",
        }),
      ).exec();
    }

    const capacityBookingIds = [
      ...(order.courseBookings || []).map((course) => course?.bookingId),
      ...(order.guestIncreaseBookings || []).map(
        (increase) => increase?.bookingId,
      ),
    ].filter(Boolean);

    if (capacityBookingIds.length > 0) {
      await Booking.updateMany(
        scopeTenant(tenantId, {
          _id: { $in: capacityBookingIds },
          "capacityReservations.order": order._id,
        }),
        {
          $pull: {
            capacityReservations: { order: order._id },
          },
        },
      ).exec();
    }

    if (order.cart) {
      await Cart.deleteOne(
        scopeTenant(tenantId, {
          _id: order.cart,
        }),
      ).exec();
    }

    if (order.voucherRedemptions?.length)
      await Order.updateOne(
        scopeTenant(tenantId, {
          _id: order._id,
          status: "cancelled_order",
          isPaid: false,
        }),
        { $set: { voucherCheckoutReleasedAt: new Date() } },
      ).exec();

    // Keep the terminal order as the immutable payment/audit record. The
    // customer status endpoint and invoice reconciliation must never observe
    // a paid-attempt record disappearing after Stripe expiration.
    return true;
  },

  async releaseExpiredLegacyPlatformStripeOrder({
    tenantId,
    orderId,
    sessionId,
    currency,
    amountTotal,
    livemode,
  }: ReleaseExpiredLegacyPlatformStripeOrderArgs) {
    /*
     * Migration-only equivalent of releaseExpiredStripeOrder. The two `$or`
     * groups are intentionally nested in `$and`: MongoDB cannot represent
     * independent legacy-account, legacy-mode and processing-lease clauses as
     * sibling `$or` keys. This filter can never match a Connect-owned order.
     */
    const order = await Order.findOneAndUpdate(
      scopeTenant(tenantId, {
        $and: [
          { _id: toObjectId(orderId) },
          { currency: currency.toUpperCase() },
          { expectedAmountMinor: amountTotal },
          { isPaid: false },
          { status: { $in: ["pending_order", "cancelled_order"] } },
          { "stripe.sessionId": sessionId },
          { "stripe.paymentIntentId": { $in: ["", null] } },
          {
            $or: [
              { "stripe.connectedAccountId": { $exists: false } },
              { "stripe.connectedAccountId": "" },
              { "stripe.connectedAccountId": null },
            ],
          },
          {
            $or: [
              { "stripe.livemode": { $exists: false } },
              { "stripe.livemode": null },
              { "stripe.livemode": livemode },
            ],
          },
          {
            $or: [
              { "stripe.processingClaimToken": { $exists: false } },
              { "stripe.processingClaimToken": "" },
              { "stripe.processingClaimToken": null },
            ],
          },
        ],
      }) as never,
      {
        $set: {
          status: "cancelled_order",
          "stripe.livemode": livemode,
        },
      },
      { returnDocument: "after" },
    )
      .select({
        _id: 1,
        cart: 1,
        workshopBookings: 1,
        courseBookings: 1,
        guestIncreaseBookings: 1,
      })
      .lean()
      .exec();

    if (!order) return false;

    if (order.workshopBookings.length > 0) {
      await Booking.deleteMany(
        scopeTenant(tenantId, {
          _id: { $in: order.workshopBookings },
          orders: order._id,
          status: "pending",
          paymentStatus: "PENDING_PAYMENT",
        }),
      ).exec();
    }

    const capacityBookingIds = [
      ...(order.courseBookings || []).map((course) => course?.bookingId),
      ...(order.guestIncreaseBookings || []).map(
        (increase) => increase?.bookingId,
      ),
    ].filter(Boolean);

    if (capacityBookingIds.length > 0) {
      await Booking.updateMany(
        scopeTenant(tenantId, {
          _id: { $in: capacityBookingIds },
          "capacityReservations.order": order._id,
        }),
        {
          $pull: {
            capacityReservations: { order: order._id },
          },
        },
      ).exec();
    }

    if (order.cart) {
      await Cart.deleteOne(
        scopeTenant(tenantId, {
          _id: order.cart,
        }),
      ).exec();
    }

    return true;
  },

  findOrderPaymentSnapshot({
    tenantId,
    orderId,
  }: TenantArgs & { orderId: IdLike }) {
    return Order.findOne(scopeTenant(tenantId, { _id: toObjectId(orderId) }))
      .select({
        _id: 1,
        status: 1,
        currency: 1,
        expectedAmountMinor: 1,
        bookingExtension: 1,
        creditPurchase: 1,
        voucherRedemptions: 1,
        "stripe.sessionId": 1,
        "stripe.connectedAccountId": 1,
        "stripe.livemode": 1,
        "stripe.processedEventIds": 1,
        "stripe.processingClaimToken": 1,
        "stripe.processingEventId": 1,
        "stripe.processingLeaseExpiresAt": 1,
      })
      .lean()
      .exec();
  },

  async createBookings({
    tenantId,
    payloads,
    atomicCapacity = false,
    session = null,
  }: PayloadsArgs) {
    if (!Array.isArray(payloads) || payloads.length === 0) {
      return [];
    }

    if (!atomicCapacity) {
      return Booking.insertMany(attachTenantToMany(tenantId, payloads), {
        ordered: false,
        session: session ?? undefined,
      });
    }

    const locationIds = [
      ...new Set(
        payloads
          .map((payload) => String(payload.location || ""))
          .filter((id) => mongoose.isValidObjectId(id)),
      ),
    ].map((id) => toObjectId(id));

    if (locationIds.length === 0) {
      throw new Error(
        "Atomic Open Studio reservation requires at least one location.",
      );
    }

    const run = async (activeSession: ClientSession) => {
      const deterministicIds = payloads
        .map((payload) => payload._id)
        .filter((id) => mongoose.isValidObjectId(String(id)))
        .map((id) => toObjectId(id as IdLike));

      if (deterministicIds.length === payloads.length) {
        const existing = await Booking.find(
          scopeTenant(tenantId, { _id: { $in: deterministicIds } }),
        )
          .session(activeSession)
          .exec();

        if (existing.length === payloads.length) {
          const existingById = new Map(
            existing.map((booking) => [String(booking._id), booking]),
          );
          const now = new Date();

          for (const payload of payloads) {
            const existingBooking = existingById.get(String(payload._id));

            assertPersistedWorkshopBookingSnapshot(existingBooking, payload);
            assertReusablePendingWorkshopBooking(
              existingBooking || {},
              now,
              payload.paymentExpiresAt,
            );
          }

          return existing;
        }
        if (existing.length > 0) {
          throw new Error(
            "A deterministic checkout booking set is incomplete.",
          );
        }
      }

      /*
       * This first write is the shared serialization point. Concurrent
       * transactions that touch the same location cannot both commit from
       * stale availability snapshots; MongoDB retries one with a fresh
       * snapshot.
       */
      const locked = await Location.updateMany(
        scopeTenant(tenantId, {
          _id: { $in: locationIds },
          isActive: true,
          "booking.enabled": true,
        }),
        { $inc: { "booking.capacityRevision": 1 } },
        { session: activeSession },
      ).exec();

      if (locked.matchedCount !== locationIds.length) {
        conflict({
          message: "A selected studio location is no longer available.",
          code: "LOCATION_NOT_AVAILABLE",
        });
      }

      await lockExtensionTargets({ tenantId, payloads, session: activeSession });

      const earliestStart = payloads.reduce((earliest, payload) => {
        const start = new Date(payload.start as never);
        return start < earliest ? start : earliest;
      }, new Date(8.64e15));
      const locations = await Location.find(
        scopeTenant(tenantId, {
          _id: { $in: locationIds },
          isActive: true,
          "booking.enabled": true,
        }),
      )
        .select("booking isActive")
        .session(activeSession)
        .lean()
        .exec();
      const currentBookings = await Booking.find(
        scopeTenant(tenantId, {
          location: { $in: locationIds },
          end: {
            $gt: Number.isFinite(earliestStart.getTime())
              ? earliestStart
              : new Date(),
          },
        }),
      )
        .session(activeSession)
        .lean()
        .exec();

      await loadCourseCapacityForBookings({ bookings: currentBookings, tenantId, session: activeSession });

      validateWorkshopAvailabilityOrThrow({
        workshopBookings: payloads,
        currentBookings,
        locationById: new Map(
          locations.map((location) => [String(location._id), location]),
        ),
      });

      return Booking.insertMany(attachTenantToMany(tenantId, payloads), {
        ordered: true,
        session: activeSession,
      });
    };

    if (session) return run(session);

    const ownedSession = await mongoose.startSession();
    try {
      let created: any[] = [];
      await ownedSession.withTransaction(async () => {
        created = await run(ownedSession);
      });
      return created;
    } finally {
      await ownedSession.endSession();
    }
  },

  async deleteCheckoutBookings({
    tenantId,
    orderId,
    bookingIds,
  }: TenantArgs & {
    orderId: IdLike;
    bookingIds: IdLike[];
  }) {
    await releaseBookingExtensionHolds({ tenantId, orderId });
    if (!bookingIds.length) {
      return Promise.resolve({ deletedCount: 0 });
    }

    return Booking.deleteMany(
      scopeTenant(tenantId, {
        _id: {
          $in: bookingIds.map((id) => toObjectId(id)),
        },
        orders: toObjectId(orderId),
      }),
    ).exec();
  },

  deleteCheckoutOrder({ tenantId, orderId }: TenantArgs & { orderId: IdLike }) {
    return Order.deleteOne(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
      }),
    ).exec();
  },

  deleteCheckoutCart({ tenantId, cartId }: TenantArgs & { cartId: IdLike }) {
    return Cart.deleteOne(
      scopeTenant(tenantId, {
        _id: toObjectId(cartId),
      }),
    ).exec();
  },

  deleteProcessingMetadata({ tenantId, userId }: UserIdArgs) {
    return MetadataModel.deleteMany(
      scopeTenant(tenantId, {
        createdBy: toObjectId(userId),
      }),
    ).exec();
  },

  async deleteProcessingRecords({
    tenantId,
    userId,
    preserveOrderId,
  }: UserIdArgs & { preserveOrderId?: IdLike }) {
    const userObjectId = toObjectId(userId);

    const orders = await Order.find(
      scopeTenant(tenantId, {
        isPaid: false,
        "voucherRedemptions.0": { $exists: false },
        createdBy: userObjectId,
        ...(preserveOrderId
          ? { _id: { $ne: toObjectId(preserveOrderId) } }
          : {}),
      }),
    )
      .select({
        _id: 1,
        cart: 1,
        createdAt: 1,
        "stripe.sessionId": 1,
      })
      .lean()
      .exec();

    const replacementCutoff =
      Date.now() - PROCESSING_RECORD_REPLACEMENT_GRACE_MS;
    const deletableOrders = orders.filter((order) => {
      const sessionId = order.stripe?.sessionId;
      const createdAt = new Date(order.createdAt).getTime();

      return (
        (!sessionId || !sessionId.trim()) &&
        Number.isFinite(createdAt) &&
        createdAt <= replacementCutoff
      );
    });

    /*
     * A second Checkout tab must not invalidate an earlier live Stripe
     * Session or an order that is concurrently being attached to one. Delete
     * only older, non-Stripe orders and the bookings explicitly linked to
     * them. The scheduled job owns genuinely orphaned booking cleanup.
     */
    if (!deletableOrders.length) return;

    const deletableOrderIds = deletableOrders.map((order) => order._id);

    await Booking.deleteMany(
      scopeTenant(tenantId, {
        status: "pending",
        createdBy: userObjectId,
        orders: { $in: deletableOrderIds },
      }),
    ).exec();

    await Booking.updateMany(
      scopeTenant(tenantId, {
        "capacityReservations.order": { $in: deletableOrderIds },
      }),
      {
        $pull: {
          capacityReservations: { order: { $in: deletableOrderIds } },
        },
      },
    ).exec();

    const cartIds = deletableOrders.map((order) => order.cart).filter(Boolean);

    if (cartIds.length > 0) {
      await Cart.deleteMany(
        scopeTenant(tenantId, {
          _id: { $in: cartIds },
        }),
      ).exec();
    }

    await Order.deleteMany(
      scopeTenant(tenantId, {
        _id: { $in: deletableOrderIds },
      }),
    ).exec();
  },

  claimLegacyPlatformStripeOrder({
    tenantId,
    orderId,
    eventId,
    claimToken,
    now,
    leaseExpiresAt,
    session,
  }: ClaimLegacyPlatformStripeOrderArgs) {
    return Order.findOneAndUpdate(
      scopeTenant(tenantId, {
        $and: [
          { _id: toObjectId(orderId) },
          { currency: session.currency.toUpperCase() },
          { expectedAmountMinor: session.amount_total },
          { status: { $nin: ["processed_order", "cancelled_order"] } },
          { "stripe.sessionId": session.id },
          { "stripe.processedEventIds": { $ne: eventId } },
          {
            $or: [
              { "stripe.connectedAccountId": { $exists: false } },
              { "stripe.connectedAccountId": "" },
              { "stripe.connectedAccountId": null },
            ],
          },
          {
            $or: [
              { "stripe.livemode": { $exists: false } },
              { "stripe.livemode": null },
              { "stripe.livemode": session.livemode },
            ],
          },
          buildStripeOrderLeaseAvailabilityFilter(now),
        ],
      }) as never,
      {
        $set: {
          isPaid: true,
          paidAt: new Date(),
          "stripe.sessionId": session.id,
          "stripe.paymentIntentId": session.payment_intent || undefined,
          "stripe.livemode": session.livemode,
          paidAmountMinor: session.amount_total,
          "stripe.processingClaimToken": claimToken,
          "stripe.processingEventId": eventId,
          "stripe.processingClaimedAt": now,
          "stripe.processingLeaseExpiresAt": leaseExpiresAt,
        },
        $inc: {
          "stripe.processingAttemptCount": 1,
        },
      },
      {
        returnDocument: "after",
        projection: {
          _id: 1,
          tenant: 1,
          createdBy: 1,
          bookingExtension: 1,
          creditPurchase: 1,
          credits: 1,
          currency: 1,
          expectedAmountMinor: 1,
          paidAmountMinor: 1,
          workshopBookings: 1,
          courseBookings: 1,
          guestIncreaseBookings: 1,
          appliedCoupons: 1,
          customer: 1,
          status: 1,
          isPaid: 1,
          paidAt: 1,
        },
      },
    )
      .lean()
      .exec();
  },

  claimStripeOrder({
    tenantId,
    orderId,
    eventId,
    claimToken,
    now,
    leaseExpiresAt,
    session,
  }: ClaimStripeOrderArgs) {
    return Order.findOneAndUpdate(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        currency: session.currency.toUpperCase(),
        expectedAmountMinor: session.amount_total,
        status: { $nin: ["processed_order", "cancelled_order"] },
        "stripe.connectedAccountId": session.connectedAccountId,
        "stripe.livemode": session.livemode,
        "stripe.processedEventIds": { $ne: eventId },
        ...buildStripeOrderLeaseAvailabilityFilter(now),
      }) as never,
      {
        $set: {
          isPaid: true,
          paidAt: new Date(),
          "stripe.sessionId": session.id || undefined,
          "stripe.paymentIntentId": session.payment_intent || undefined,
          paidAmountMinor: session.amount_total,
          "stripe.processingClaimToken": claimToken,
          "stripe.processingEventId": eventId,
          "stripe.processingClaimedAt": now,
          "stripe.processingLeaseExpiresAt": leaseExpiresAt,
        },
        $inc: {
          "stripe.processingAttemptCount": 1,
        },
      },
      {
        returnDocument: "after",
        projection: {
          _id: 1,
          tenant: 1,
          createdBy: 1,
          bookingExtension: 1,
          creditPurchase: 1,
          voucherRedemptions: 1,
          credits: 1,
          currency: 1,
          expectedAmountMinor: 1,
          paidAmountMinor: 1,
          workshopBookings: 1,
          courseBookings: 1,
          guestIncreaseBookings: 1,
          appliedCoupons: 1,
          customer: 1,
          "guestCourseCheckout.version": 1,
          status: 1,
          isPaid: 1,
          paidAt: 1,
        },
      },
    )
      .lean()
      .exec();
  },

  markOrderProcessed({
    tenantId,
    orderId,
    eventId,
    claimToken,
    paidAt,
    session = null,
  }: MarkOrderProcessedArgs) {
    return Order.updateOne(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        "stripe.processingClaimToken": claimToken,
      }),
      {
        $set: {
          status: "processed_order",
          isPaid: true,
          paidAt: paidAt || new Date(),
        },
        $addToSet: { "stripe.processedEventIds": eventId },
        $unset: {
          "stripe.processingClaimToken": 1,
          "stripe.processingEventId": 1,
          "stripe.processingClaimedAt": 1,
          "stripe.processingLeaseExpiresAt": 1,
          "stripe.lastProcessingError": 1,
          "stripe.lastProcessingFailedAt": 1,
        },
      },
      { session },
    ).exec();
  },

  markLateWaitlistOrderRefunded({
    tenantId,
    orderId,
    eventId,
    paymentIntentId,
    paidAmountMinor,
    paidAt,
  }: MarkLateWaitlistOrderRefundedArgs) {
    return Order.updateOne(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        "stripe.processedEventIds": { $ne: eventId },
        "waitlist.entryId": { $type: "objectId" },
      }),
      {
        $set: {
          status: "cancelled_order",
          isPaid: true,
          paidAt: paidAt || new Date(),
          paidAmountMinor,
          "stripe.paymentIntentId": paymentIntentId,
          note: "Late waitlist payment refunded without fulfillment.",
        },
        $addToSet: { "stripe.processedEventIds": eventId },
        $unset: {
          "stripe.processingClaimToken": 1,
          "stripe.processingEventId": 1,
          "stripe.processingClaimedAt": 1,
          "stripe.processingLeaseExpiresAt": 1,
        },
      },
    ).exec();
  },

  markOrderFailed({
    tenantId,
    orderId,
    error,
    claimToken,
  }: MarkOrderFailedArgs) {
    const message =
      error instanceof Error ? error.message : String(error || "failed");

    return Order.updateOne(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        status: { $ne: "processed_order" },
        ...(claimToken ? { "stripe.processingClaimToken": claimToken } : {}),
      }),
      {
        $set: {
          status: "failed_order",
          note: message,
          "stripe.lastProcessingError": message.slice(0, 2000),
          "stripe.lastProcessingFailedAt": new Date(),
        },
        ...(claimToken
          ? {
              $unset: {
                "stripe.processingClaimToken": 1,
                "stripe.processingEventId": 1,
                "stripe.processingClaimedAt": 1,
                "stripe.processingLeaseExpiresAt": 1,
              },
            }
          : {}),
      },
    ).exec();
  },

  markOrderProcessingRetryable({
    tenantId,
    orderId,
    error,
    claimToken,
  }: MarkOrderProcessingRetryableArgs) {
    const message =
      error instanceof Error ? error.message : String(error || "failed");

    return Order.updateOne(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        status: { $nin: ["processed_order", "cancelled_order"] },
        "stripe.processingClaimToken": claimToken,
      }),
      {
        $set: {
          status: "pending_order",
          isPaid: true,
          "stripe.lastProcessingError": message.slice(0, 2000),
          "stripe.lastProcessingFailedAt": new Date(),
        },
        $unset: {
          "stripe.processingClaimToken": 1,
          "stripe.processingEventId": 1,
          "stripe.processingClaimedAt": 1,
          "stripe.processingLeaseExpiresAt": 1,
        },
      },
    ).exec();
  },

  findCustomerOrderStatus({
    tenantId,
    orderId,
    userId,
  }: TenantArgs & { orderId: IdLike; userId: IdLike }) {
    return Order.findOne(
      scopeTenant(tenantId, {
        _id: toObjectId(orderId),
        createdBy: toObjectId(userId),
      }),
    )
      .select({
        _id: 1,
        status: 1,
        isPaid: 1,
        paidAt: 1,
        currency: 1,
        expectedAmountMinor: 1,
        paidAmountMinor: 1,
        bookingExtension: 1,
        creditPurchase: 1,
        "stripe.sessionId": 1,
        "stripe.processingEventId": 1,
        "stripe.processingLeaseExpiresAt": 1,
        "stripe.processingAttemptCount": 1,
        "stripe.lastProcessingFailedAt": 1,
      })
      .lean()
      .exec();
  },

  findCouponByPromoCode({ tenantId, promoCode }: PromoCodeArgs) {
    return Coupon.findOne(
      scopeTenant(tenantId, {
        promoCode,
      }),
    )
      .lean()
      .exec();
  },

  findCouponProduct({ tenantId, productId }: ProductIdArgs) {
    return Product.findOne(
      scopeTenant(tenantId, {
        _id: toObjectId(productId),
      }),
    )
      .select({
        _id: 1,
        type: 1,
        price: 1,
        name: 1,
      })
      .lean()
      .exec();
  },

  findMoneyCredit({ tenantId, userId }: UserIdArgs) {
    return MoneyCredit.findOne({
      tenant: toObjectId(tenantId),
      user: toObjectId(userId),
    }).exec();
  },

  createMoneyCredit({ tenantId, payload }: PayloadArgs) {
    return new MoneyCredit({
      ...payload,
      tenant: toObjectId(tenantId),
    });
  },

  updateUserCredits({ tenantId, userId, amount }: CreditMutationArgs) {
    return User.findOneAndUpdate(
      scopeTenant(tenantId, {
        _id: toObjectId(userId),
      }),
      {
        $inc: {
          moneyCredits: amount,
        },
      },
      {
        returnDocument: "after",
      },
    )
      .lean()
      .exec();
  },

  deductUserCredits({ tenantId, userId, amount }: CreditMutationArgs) {
    return User.findOneAndUpdate(
      scopeTenant(tenantId, {
        _id: toObjectId(userId),
        moneyCredits: { $gte: amount },
      }),
      {
        $inc: {
          moneyCredits: -amount,
        },
      },
      {
        returnDocument: "after",
      },
    )
      .lean()
      .exec();
  },
};

export type CheckoutRepository = typeof checkoutRepository;
