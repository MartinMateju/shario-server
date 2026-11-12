import { randomUUID } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";

import Booking from "@/modules/booking/booking.model.js";
import {
  normalizeStudioCommerceCurrency,
  fromCurrencyMinorUnits,
} from "@/shared/money/currency.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";

import {
  WAITLIST_EMAIL_TYPE,
  WAITLIST_STATE,
  WAITLIST_TOKEN_PURPOSE,
} from "./waitlist.constants.js";
import {
  WaitlistEmailOutboxModel,
  WaitlistEntryModel,
} from "./waitlist.model.js";
import {
  deriveWaitlistToken,
  hashWaitlistEmail,
  hashWaitlistToken,
  normalizeWaitlistEmail,
  waitlistEntryDto,
} from "./waitlist.policy.js";
import { publishWaitlistCustomerNotificationForEntry } from "./waitlist.customer-notification.service.js";

const objectId = (value: unknown): mongoose.Types.ObjectId =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));

const sameId = (left: unknown, right: unknown): boolean =>
  String(left ?? "") === String(right ?? "");

const withTransaction = async <T>(
  work: (session: ClientSession) => Promise<T>,
  existingSession: ClientSession | null = null,
): Promise<T> => {
  if (existingSession) return work(existingSession);
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const courseCartIdentity = (cartItems: any[]) => {
  if (!Array.isArray(cartItems) || cartItems.length !== 1) {
    conflict({
      message: "A waitlist offer must be checked out by itself.",
      code: "WAITLIST_CHECKOUT_CART_INVALID",
    });
  }
  const item = cartItems[0] ?? {};
  const productId = item.product?._id ?? item.product?.id;
  const sessionId =
    item.bookingCourse ??
    item.courseSessionId ??
    item.courseSlotId ??
    item.bookingId;
  const quantity = Number(item.quantity ?? item.numberOfGuests ?? 1);
  if (!productId || !sessionId || quantity !== 1) {
    conflict({
      message: "The waitlist offer is valid for exactly one saved Class place.",
      code: "WAITLIST_CHECKOUT_CART_INVALID",
    });
  }
  return {
    productId: String(productId),
    sessionId: String(sessionId),
    quantity,
  };
};

const assertPriceSnapshot = (entry: any) => {
  const amountMinor = Number(entry.priceSnapshot?.amountMinor);
  const currency = normalizeStudioCommerceCurrency(
    entry.priceSnapshot?.currency,
  );
  const version = String(entry.priceSnapshot?.version ?? "");
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !version) {
    conflict({
      message: "The saved waitlist price is invalid. Contact the studio.",
      code: "WAITLIST_PRICE_SNAPSHOT_INVALID",
    });
  }
  return {
    amountMinor,
    amount: fromCurrencyMinorUnits(amountMinor, currency),
    currency,
    version,
    productId: String(entry.priceSnapshot.productId),
  };
};

export type WaitlistCheckoutContext = {
  entryId: string;
  sessionId: string;
  productId: string;
  offerGeneration: number;
  offerExpiresAt: Date;
  price: ReturnType<typeof assertPriceSnapshot>;
  orderId: string;
  customerId?: string;
  cartItems: any[];
};

export const resolveWaitlistCheckoutContext = async ({
  tenantId,
  orderId,
  cartItems,
  entryId,
  offerToken,
  customerId,
  email,
  now = new Date(),
}: {
  tenantId: string;
  orderId: string;
  cartItems?: any[];
  entryId?: string;
  offerToken?: string;
  customerId?: string;
  email?: string;
  now?: Date;
}): Promise<WaitlistCheckoutContext> => {
  const normalizedEmail = normalizeWaitlistEmail(email);
  const identityKey = normalizedEmail ? hashWaitlistEmail(normalizedEmail) : "";
  if (entryId && !customerId) {
    notFound({
      message: "This waitlist offer is invalid or expired.",
      code: "WAITLIST_OFFER_EXPIRED",
    });
  }
  if (!entryId && !offerToken) {
    notFound({
      message: "This waitlist offer is invalid or expired.",
      code: "WAITLIST_OFFER_EXPIRED",
    });
  }

  // Entry-id checkout is an authenticated portal operation. Never treat a
  // caller-supplied email as an alternative ownership proof. Token checkout
  // may attach an as-yet guest entry, but only when both the bearer and the
  // verified normalized-email identity match.
  const ownership = entryId
    ? { _id: objectId(entryId), customer: objectId(customerId) }
    : customerId
      ? {
          $or: [
            { customer: objectId(customerId) },
            { customer: null, identityKey },
          ],
        }
      : { customer: null, identityKey };
  const tokenProof = offerToken
    ? {
        offerTokenHash: hashWaitlistToken(
          offerToken,
          WAITLIST_TOKEN_PURPOSE.OFFER,
        ),
      }
    : {};

  const query: Record<string, unknown> = {
    tenant: objectId(tenantId),
    $or: [
      {
        state: WAITLIST_STATE.OFFERED,
        isLive: true,
        offerExpiresAt: { $gt: now },
        ...ownership,
        ...tokenProof,
      },
      {
        state: WAITLIST_STATE.PAYMENT_PENDING,
        "checkout.orderId": objectId(orderId),
        "checkout.expiresAt": { $gt: now },
        ...ownership,
        ...tokenProof,
      },
    ],
  };

  const entry = await WaitlistEntryModel.findOne(query)
    .select("+offerTokenHash")
    .lean()
    .exec();
  if (!entry) {
    notFound({
      message: "This waitlist offer is invalid or expired.",
      code: "WAITLIST_OFFER_EXPIRED",
    });
  }

  const canonicalCartItems = [
    {
      product: { _id: entry.product, type: "course" },
      quantity: 1,
      numberOfGuests: 1,
      bookingCourse: entry.courseSession,
    },
  ];
  const cart = cartItems?.length
    ? courseCartIdentity(cartItems)
    : courseCartIdentity(canonicalCartItems);
  if (
    !sameId(entry.courseSession, cart.sessionId) ||
    !sameId(entry.product, cart.productId)
  ) {
    conflict({
      message: "The waitlist offer does not match this checkout.",
      code: "WAITLIST_CHECKOUT_CART_MISMATCH",
    });
  }

  return {
    entryId: String(entry._id),
    sessionId: String(entry.courseSession),
    productId: String(entry.product),
    offerGeneration: Number(entry.offerGeneration),
    offerExpiresAt: new Date(entry.offerExpiresAt),
    price: assertPriceSnapshot(entry),
    orderId,
    customerId,
    cartItems: cartItems?.length ? cartItems : canonicalCartItems,
  };
};

export const applyWaitlistPriceSnapshot = <T extends Record<string, any>>({
  products,
  context,
}: {
  products: T[];
  context: WaitlistCheckoutContext;
}): T[] =>
  products.map((product) => {
    if (!sameId(product._id, context.productId)) return product;
    const currentCurrency = normalizeStudioCommerceCurrency(product.currency);
    if (currentCurrency !== context.price.currency) {
      conflict({
        message: "The studio currency changed after joining the waitlist.",
        code: "WAITLIST_PRICE_CURRENCY_CHANGED",
      });
    }
    return {
      ...product,
      price: context.price.amount,
      currency: context.price.currency,
    };
  });

/**
 * CAS transfer with no capacity gap: the Booking pipeline removes the exact
 * entry/generation offer hold and appends the normal Order reservation in the
 * same document update. The entry transition commits in the same transaction.
 */
export const transferWaitlistHoldToOrder = async ({
  tenantId,
  context,
  reservationExpiresAt,
  paymentExpiresAt,
  now = new Date(),
  mongoSession = null,
}: {
  tenantId: string;
  context: WaitlistCheckoutContext;
  reservationExpiresAt: Date;
  paymentExpiresAt: Date;
  now?: Date;
  mongoSession?: ClientSession | null;
}): Promise<void> =>
  withTransaction(async (session) => {
    const existing = await WaitlistEntryModel.findOne({
      _id: objectId(context.entryId),
      tenant: objectId(tenantId),
      $or: [
        {
          state: WAITLIST_STATE.OFFERED,
          isLive: true,
          offerGeneration: context.offerGeneration,
          offerExpiresAt: { $gt: now },
        },
        {
          state: WAITLIST_STATE.PAYMENT_PENDING,
          "checkout.orderId": objectId(context.orderId),
          "checkout.offerGeneration": context.offerGeneration,
        },
      ],
    })
      .select("+offerTokenHash")
      .session(session)
      .exec();
    if (!existing) {
      conflict({
        message: "This waitlist offer was already used or expired.",
        code: "WAITLIST_OFFER_EXPIRED",
      });
    }

    if (existing.state === WAITLIST_STATE.PAYMENT_PENDING) {
      const reservation = await Booking.updateOne(
        {
          _id: objectId(context.sessionId),
          tenant: objectId(tenantId),
          archive: { $ne: true },
          status: { $nin: ["cancelled", "canceled"] as any },
          start: existing.sessionStartSnapshot,
          capacityReservations: {
            $elemMatch: {
              order: objectId(context.orderId),
              quantity: 1,
              expiresAt: { $gt: now },
            },
          },
        },
        {
          $set: {
            "capacityReservations.$[reservation].expiresAt":
              reservationExpiresAt,
          },
        },
        {
          arrayFilters: [
            {
              "reservation.order": objectId(context.orderId),
              "reservation.quantity": 1,
              "reservation.expiresAt": { $gt: now },
            },
          ],
          session,
        },
      ).exec();
      if (reservation.matchedCount !== 1) {
        conflict({
          message: "The waitlist payment reservation is no longer valid.",
          code: "WAITLIST_PAYMENT_RESERVATION_MISSING",
        });
      }

      const refreshed = await WaitlistEntryModel.updateOne(
        {
          _id: objectId(context.entryId),
          tenant: objectId(tenantId),
          state: WAITLIST_STATE.PAYMENT_PENDING,
          "checkout.orderId": objectId(context.orderId),
          "checkout.offerGeneration": context.offerGeneration,
          "checkout.expiresAt": { $gt: now },
        },
        {
          $set: {
            "checkout.expiresAt": paymentExpiresAt,
            "checkout.reservationExpiresAt": reservationExpiresAt,
          },
        },
        { session },
      ).exec();
      if (refreshed.matchedCount !== 1) {
        conflict({
          message: "The waitlist payment reservation is no longer valid.",
          code: "WAITLIST_PAYMENT_RESERVATION_MISSING",
        });
      }
      return;
    }

    const orderObjectId = objectId(context.orderId);
    const entryObjectId = objectId(context.entryId);
    const transfer = await Booking.updateOne(
      {
        _id: objectId(context.sessionId),
        tenant: objectId(tenantId),
        archive: { $ne: true },
        status: { $nin: ["cancelled", "canceled"] as any },
        start: existing.sessionStartSnapshot,
        waitlistCapacityHolds: {
          $elemMatch: {
            entry: entryObjectId,
            offerGeneration: context.offerGeneration,
            expiresAt: { $gt: now },
          },
        },
      },
      [
        {
          $set: {
            waitlistCapacityHolds: {
              $filter: {
                input: { $ifNull: ["$waitlistCapacityHolds", []] },
                as: "hold",
                cond: {
                  $and: [
                    { $gt: ["$$hold.expiresAt", now] },
                    {
                      $not: [
                        {
                          $and: [
                            { $eq: ["$$hold.entry", entryObjectId] },
                            {
                              $eq: [
                                "$$hold.offerGeneration",
                                context.offerGeneration,
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            capacityReservations: {
              $concatArrays: [
                {
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
                },
                [
                  {
                    order: orderObjectId,
                    quantity: 1,
                    expiresAt: reservationExpiresAt,
                  },
                ],
              ],
            },
          },
        },
      ],
      { session, updatePipeline: true },
    ).exec();
    if (transfer.modifiedCount !== 1) {
      conflict({
        message: "The saved waitlist place is no longer available.",
        code: "WAITLIST_HOLD_TRANSFER_FAILED",
      });
    }

    const moved = await WaitlistEntryModel.updateOne(
      {
        _id: entryObjectId,
        tenant: objectId(tenantId),
        state: WAITLIST_STATE.OFFERED,
        offerGeneration: context.offerGeneration,
        offerExpiresAt: { $gt: now },
      },
      {
        $set: {
          state: WAITLIST_STATE.PAYMENT_PENDING,
          // The hash remains available only to derive/replay the same durable
          // checkout operation after a lost response. State+generation make
          // the bearer single-use: it cannot transfer another reservation.
          ...(context.customerId
            ? { customer: objectId(context.customerId), source: "customer" }
            : {}),
          checkout: {
            orderId: orderObjectId,
            stripeSessionId: "",
            expiresAt: paymentExpiresAt,
            reservationExpiresAt,
            startedAt: now,
            offerGeneration: context.offerGeneration,
          },
        },
      },
      { session },
    ).exec();
    if (moved.modifiedCount !== 1) {
      throw new Error("Waitlist offer changed during capacity transfer.");
    }
  }, mongoSession);

export const restoreWaitlistHoldAfterCheckoutFailure = async ({
  tenantId,
  context,
  now = new Date(),
}: {
  tenantId: string;
  context: WaitlistCheckoutContext;
  now?: Date;
}) =>
  withTransaction(async (session) => {
    const entry = await WaitlistEntryModel.findOne({
      _id: objectId(context.entryId),
      tenant: objectId(tenantId),
      state: WAITLIST_STATE.PAYMENT_PENDING,
      "checkout.orderId": objectId(context.orderId),
    })
      .select("+offerTokenHash")
      .session(session)
      .exec();
    if (!entry) return;

    await Booking.updateOne(
      { _id: entry.courseSession, tenant: objectId(tenantId) },
      {
        $pull: { capacityReservations: { order: objectId(context.orderId) } },
        ...(context.offerExpiresAt > now
          ? {
              $push: {
                waitlistCapacityHolds: {
                  entry: entry._id,
                  offerGeneration: context.offerGeneration,
                  expiresAt: context.offerExpiresAt,
                },
              },
            }
          : {}),
      },
      { session },
    ).exec();

    if (context.offerExpiresAt > now) {
      // A consumed bearer remains consumed. The portal owner can retry through
      // entryId; email-token retries rely on the stable checkout operation.
      entry.state = WAITLIST_STATE.OFFERED;
      entry.checkout = undefined;
      entry.offerTokenHash = hashWaitlistToken(
        deriveWaitlistToken({
          subject: entry._id,
          purpose: WAITLIST_TOKEN_PURPOSE.OFFER,
          generation: context.offerGeneration,
        }),
        WAITLIST_TOKEN_PURPOSE.OFFER,
      );
    } else {
      entry.state = WAITLIST_STATE.EXPIRED;
      entry.isLive = false;
      entry.terminalAt = now;
    }
    await entry.save({ session });
  });

export const attachWaitlistStripeSession = async ({
  tenantId,
  orderId,
  stripeSessionId,
  paymentExpiresAt,
}: {
  tenantId: string;
  orderId: string;
  stripeSessionId: string;
  paymentExpiresAt: Date;
}) =>
  WaitlistEntryModel.updateOne(
    {
      tenant: objectId(tenantId),
      state: WAITLIST_STATE.PAYMENT_PENDING,
      "checkout.orderId": objectId(orderId),
    },
    {
      $set: {
        "checkout.stripeSessionId": stripeSessionId,
        // Stripe idempotency can return a Session created by an earlier
        // process whose expires_at predates this retry's provisional window.
        // The provider deadline is the authoritative resume/UI deadline.
        "checkout.expiresAt": paymentExpiresAt,
      },
    },
  ).exec();

export const inspectWaitlistOffer = async ({
  tenantId,
  token,
  guestCheckoutAllowed = false,
  now = new Date(),
}: {
  tenantId: string;
  token: string;
  guestCheckoutAllowed?: boolean;
  now?: Date;
}) => {
  const entry = await WaitlistEntryModel.findOne({
    tenant: objectId(tenantId),
    isLive: true,
    offerTokenHash: hashWaitlistToken(token, WAITLIST_TOKEN_PURPOSE.OFFER),
    $or: [
      {
        state: WAITLIST_STATE.OFFERED,
        offerExpiresAt: { $gt: now },
      },
      {
        state: WAITLIST_STATE.PAYMENT_PENDING,
        "checkout.expiresAt": { $gt: now },
      },
    ],
  })
    .select("+offerTokenHash")
    .populate({
      path: "courseSession",
      select: "start end location",
      populate: { path: "location", select: "name" },
    })
    .populate({ path: "product", select: "name" })
    .lean()
    .exec();
  if (!entry) {
    notFound({
      message: "This waitlist offer is invalid or expired.",
      code: "WAITLIST_OFFER_EXPIRED",
    });
  }
  const dto = waitlistEntryDto(entry);
  return {
    entryId: dto.id,
    sessionId: dto.sessionId,
    state: entry.state,
    expiresAt:
      entry.state === WAITLIST_STATE.PAYMENT_PENDING
        ? new Date(entry.checkout?.expiresAt)
        : dto.offerExpiresAt,
    price: dto.price,
    guestCheckoutAllowed,
    requiresAuthentication: !guestCheckoutAllowed,
    session: {
      id: dto.sessionId,
      title: String((entry as any).product?.name ?? ""),
      start: (entry as any).courseSession?.start ?? null,
      end: (entry as any).courseSession?.end ?? null,
      locationName: String((entry as any).courseSession?.location?.name ?? ""),
    },
  };
};

export const getVerifiedGuestOfferProfile = async ({
  tenantId,
  token,
  email,
  now = new Date(),
}: {
  tenantId: string;
  token: string;
  email: string;
  now?: Date;
}) => {
  const normalizedEmail = normalizeWaitlistEmail(email);
  const entry = await WaitlistEntryModel.findOne({
    tenant: objectId(tenantId),
    isLive: true,
    identityKey: hashWaitlistEmail(normalizedEmail),
    offerTokenHash: hashWaitlistToken(token, WAITLIST_TOKEN_PURPOSE.OFFER),
    $or: [
      {
        state: WAITLIST_STATE.OFFERED,
        offerExpiresAt: { $gt: now },
      },
      {
        state: WAITLIST_STATE.PAYMENT_PENDING,
        "checkout.expiresAt": { $gt: now },
      },
    ],
  })
    .select("firstName lastName email locale +offerTokenHash")
    .lean()
    .exec();
  if (!entry) {
    notFound({
      message: "This waitlist offer is invalid or expired.",
      code: "WAITLIST_OFFER_EXPIRED",
    });
  }
  return {
    firstName: String(entry.firstName),
    lastName: String(entry.lastName),
    email: String(entry.email),
    locale: entry.locale === "cs" ? ("cs" as const) : ("en" as const),
  };
};

export const getWaitlistOfferOperationKey = async ({
  tenantId,
  customerId,
  email,
  entryId,
  offerToken,
  now = new Date(),
}: {
  tenantId: string;
  customerId?: string;
  email: string;
  entryId?: string;
  offerToken?: string;
  now?: Date;
}): Promise<string> => {
  if (entryId && !customerId) {
    notFound({
      message: "This waitlist offer is invalid or expired.",
      code: "WAITLIST_OFFER_EXPIRED",
    });
  }
  const identityKey = hashWaitlistEmail(normalizeWaitlistEmail(email));
  const ownership = entryId
    ? { _id: objectId(entryId), customer: objectId(customerId) }
    : customerId
      ? {
          $or: [
            { customer: objectId(customerId) },
            { customer: null, identityKey },
          ],
        }
      : { identityKey };
  const tokenProof = offerToken
    ? {
        offerTokenHash: hashWaitlistToken(
          offerToken,
          WAITLIST_TOKEN_PURPOSE.OFFER,
        ),
      }
    : {};
  const entry = await WaitlistEntryModel.findOne({
    tenant: objectId(tenantId),
    isLive: true,
    ...tokenProof,
    $and: [
      ownership,
      {
        $or: [
          {
            state: WAITLIST_STATE.OFFERED,
            offerExpiresAt: { $gt: now },
          },
          {
            state: WAITLIST_STATE.PAYMENT_PENDING,
            "checkout.expiresAt": { $gt: now },
            "checkout.offerGeneration": { $exists: true },
          },
        ],
      },
    ],
  })
    .select("_id offerGeneration priceSnapshot.version +offerTokenHash")
    .lean()
    .exec();
  if (!entry) {
    notFound({
      message: "This waitlist offer is invalid or expired.",
      code: "WAITLIST_OFFER_EXPIRED",
    });
  }
  return `waitlist:${String(entry._id)}:${Number(entry.offerGeneration)}:${String(
    entry.priceSnapshot?.version ?? "",
  )}`;
};

export const reconcileGuestEntryToCustomer = async ({
  tenantId,
  customerId,
  email,
}: {
  tenantId: string;
  customerId: string;
  email: string;
}) => {
  const identityKey = hashWaitlistEmail(normalizeWaitlistEmail(email));
  const candidates = await WaitlistEntryModel.find({
    tenant: objectId(tenantId),
    isLive: true,
    $or: [{ identityKey }, { customer: objectId(customerId) }],
  })
    .sort({ courseSession: 1, sequence: 1, _id: 1 })
    .lean()
    .exec();
  const bySession = new Map<string, any[]>();
  for (const entry of candidates) {
    const key = String(entry.courseSession);
    bySession.set(key, [...(bySession.get(key) ?? []), entry]);
  }

  for (const [sessionId, entries] of bySession) {
    await withTransaction(async (session) => {
      const current = await WaitlistEntryModel.find({
        _id: { $in: entries.map((entry) => entry._id) },
        tenant: objectId(tenantId),
        courseSession: objectId(sessionId),
        isLive: true,
      })
        .sort({ sequence: 1, _id: 1 })
        .session(session)
        .exec();
      const survivor = current[0];
      if (!survivor) return;

      for (const duplicate of current.slice(1)) {
        const payableReservation =
          duplicate.state === WAITLIST_STATE.PAYMENT_PENDING &&
          duplicate.checkout?.orderId;
        await Booking.updateOne(
          { _id: duplicate.courseSession, tenant: objectId(tenantId) },
          {
            $pull: {
              waitlistCapacityHolds: { entry: duplicate._id },
              // Never release a payable Stripe reservation during identity
              // reconciliation. The terminal entry makes a later webhook
              // refund it without fulfillment; expiry cleanup releases it.
              ...(!payableReservation && duplicate.checkout?.orderId
                ? {
                    capacityReservations: {
                      order: duplicate.checkout.orderId,
                    },
                  }
                : {}),
            },
          },
          { session },
        ).exec();
        duplicate.state = WAITLIST_STATE.CANCELLED;
        duplicate.isLive = false;
        duplicate.terminalAt = new Date();
        duplicate.terminalReason =
          "Merged with the same customer's earlier verified entry.";
        duplicate.offerTokenHash = "";
        await duplicate.save({ session });
      }

      survivor.customer = objectId(customerId);
      survivor.source = "customer";
      await survivor.save({ session });
    });
  }
};

export const getWaitlistOrderDisposition = async ({
  tenantId,
  orderId,
  now = new Date(),
}: {
  tenantId: string;
  orderId: string;
  now?: Date;
}) => {
  const entry = await WaitlistEntryModel.findOne({
    tenant: objectId(tenantId),
    "checkout.orderId": objectId(orderId),
  })
    .select("state checkout courseSession product priceSnapshot offerExpiresAt")
    .lean()
    .exec();
  if (!entry) return { kind: "not_waitlist" as const };
  const checkoutExpiry = new Date(
    entry.checkout?.reservationExpiresAt ?? entry.checkout?.expiresAt ?? 0,
  );
  const valid =
    entry.state === WAITLIST_STATE.PAYMENT_PENDING && checkoutExpiry > now;
  return valid
    ? { kind: "fulfill" as const, entry }
    : { kind: "refund" as const, entry };
};

export const claimWaitlistOrderForWebhook = async ({
  tenantId,
  orderId,
  now = new Date(),
}: {
  tenantId: string;
  orderId: string;
  now?: Date;
}) => {
  const claimToken = randomUUID();
  const entry = await WaitlistEntryModel.findOneAndUpdate(
    {
      tenant: objectId(tenantId),
      state: WAITLIST_STATE.PAYMENT_PENDING,
      isLive: true,
      "checkout.orderId": objectId(orderId),
      "checkout.reservationExpiresAt": { $gt: now },
      $or: [
        { "checkout.fulfillmentClaimToken": "" },
        { "checkout.fulfillmentClaimToken": { $exists: false } },
        { "checkout.fulfillmentClaimExpiresAt": { $lte: now } },
      ],
    },
    {
      $set: {
        "checkout.fulfillmentClaimToken": claimToken,
        "checkout.fulfillmentClaimExpiresAt": new Date(
          now.getTime() + 5 * 60 * 1000,
        ),
      },
    },
    { returnDocument: "after" },
  )
    .select("+checkout.fulfillmentClaimToken")
    .lean()
    .exec();
  if (entry) return { kind: "fulfill" as const, entry, claimToken };

  const any = await WaitlistEntryModel.findOne({
    tenant: objectId(tenantId),
    "checkout.orderId": objectId(orderId),
  })
    .select("state isLive checkout courseSession product")
    .lean()
    .exec();
  if (!any) return { kind: "not_waitlist" as const };
  if (any.state === WAITLIST_STATE.CONFIRMED) {
    return { kind: "already_confirmed" as const, entry: any };
  }
  if (
    any.state === WAITLIST_STATE.PAYMENT_PENDING &&
    any.isLive === true &&
    new Date(any.checkout?.expiresAt ?? 0) > now &&
    new Date(any.checkout?.fulfillmentClaimExpiresAt ?? 0) > now
  ) {
    return { kind: "busy" as const, entry: any };
  }
  return { kind: "refund" as const, entry: any };
};

export const releaseWaitlistWebhookClaim = async ({
  tenantId,
  orderId,
  claimToken,
}: {
  tenantId: string;
  orderId: string;
  claimToken: string;
}) =>
  WaitlistEntryModel.updateOne(
    {
      tenant: objectId(tenantId),
      "checkout.orderId": objectId(orderId),
      "checkout.fulfillmentClaimToken": claimToken,
    },
    {
      $set: {
        "checkout.fulfillmentClaimToken": "",
        "checkout.fulfillmentClaimExpiresAt": null,
      },
    },
  ).exec();

export const lockWaitlistSessionForFulfillment = async ({
  tenantId,
  orderId,
  entry,
  now = new Date(),
  session,
}: {
  tenantId: string;
  orderId: string;
  entry: any;
  now?: Date;
  session: ClientSession;
}): Promise<boolean> => {
  const locked = await Booking.updateOne(
    {
      _id: objectId(entry.courseSession),
      tenant: objectId(tenantId),
      status: { $nin: ["cancelled", "canceled"] as any },
      archive: { $ne: true },
      start: new Date(entry.sessionStartSnapshot),
      capacityReservations: {
        $elemMatch: {
          order: objectId(orderId),
          quantity: 1,
          expiresAt: { $gt: now },
        },
      },
    },
    { $inc: { waitlistJoinRevision: 1 } },
    { session },
  ).exec();
  return locked.modifiedCount === 1;
};

export const confirmWaitlistOrderFromWebhook = async ({
  tenantId,
  orderId,
  claimToken,
  now = new Date(),
  session = null,
}: {
  tenantId: string;
  orderId: string;
  claimToken: string;
  now?: Date;
  session?: ClientSession | null;
}) => {
  // The canonical course checkout already sends its booking confirmation.
  // This transition intentionally does not enqueue a duplicate email.
  return withTransaction(async (activeSession) => {
    const result = await WaitlistEntryModel.updateOne(
      {
        tenant: objectId(tenantId),
        state: WAITLIST_STATE.PAYMENT_PENDING,
        "checkout.orderId": objectId(orderId),
        "checkout.fulfillmentClaimToken": claimToken,
      },
      {
        $set: {
          state: WAITLIST_STATE.CONFIRMED,
          isLive: false,
          confirmedAt: now,
          terminalAt: now,
          offerTokenHash: "",
        },
      },
      { session: activeSession },
    ).exec();

    const confirmedEntry = await WaitlistEntryModel.findOne({
      tenant: objectId(tenantId),
      state: WAITLIST_STATE.CONFIRMED,
      "checkout.orderId": objectId(orderId),
    })
      .select(
        "_id tenant customer source confirmedAt terminalAt refundSnapshot.refundedAt",
      )
      .session(activeSession)
      .lean()
      .exec();
    if (confirmedEntry) {
      await publishWaitlistCustomerNotificationForEntry({
        tenantId,
        entry: confirmedEntry,
        type: WAITLIST_EMAIL_TYPE.CONFIRMED,
        deduplicationKey: `waitlist:${String(confirmedEntry._id)}:confirmed`,
        session: activeSession,
      });
    }

    return result;
  }, session);
};

export const confirmProcessedWaitlistReplay = async ({
  tenantId,
  orderId,
  claimToken,
  now = new Date(),
}: {
  tenantId: string;
  orderId: string;
  claimToken: string;
  now?: Date;
}) => {
  const entry = await WaitlistEntryModel.findOne({
    tenant: objectId(tenantId),
    state: WAITLIST_STATE.PAYMENT_PENDING,
    "checkout.orderId": objectId(orderId),
    "checkout.fulfillmentClaimToken": claimToken,
  })
    .select("courseSession")
    .lean()
    .exec();
  if (!entry) return false;

  const participantExists = await Booking.exists({
    _id: entry.courseSession,
    tenant: objectId(tenantId),
    "participants.order": objectId(orderId),
  }).exec();
  if (!participantExists) {
    throw new Error(
      "Processed waitlist order is missing its confirmed course participant.",
    );
  }
  const confirmed = await confirmWaitlistOrderFromWebhook({
    tenantId,
    orderId,
    claimToken,
    now,
  });
  return confirmed.modifiedCount === 1;
};

export const expireWaitlistOrderAfterStripeSession = async ({
  tenantId,
  orderId,
  stripeSessionId,
  now = new Date(),
}: {
  tenantId: string;
  orderId: string;
  stripeSessionId: string;
  now?: Date;
}) =>
  withTransaction(async (session) => {
    const expired = await WaitlistEntryModel.findOneAndUpdate(
      {
        tenant: objectId(tenantId),
        state: WAITLIST_STATE.PAYMENT_PENDING,
        isLive: true,
        "checkout.orderId": objectId(orderId),
        // Order.waitlist + the webhook's validated Order/Stripe snapshot are
        // durable authority. The convenience entry attach may have failed after
        // the Order was safely attached, so blank is recoverable here.
        $and: [
          {
            $or: [
              { "checkout.stripeSessionId": stripeSessionId },
              { "checkout.stripeSessionId": "" },
              { "checkout.stripeSessionId": { $exists: false } },
            ],
          },
        ],
        $or: [
          { "checkout.fulfillmentClaimToken": "" },
          { "checkout.fulfillmentClaimToken": { $exists: false } },
          { "checkout.fulfillmentClaimExpiresAt": { $lte: now } },
        ],
      },
      {
        $set: {
          state: WAITLIST_STATE.EXPIRED,
          isLive: false,
          terminalAt: now,
          terminalReason: "Stripe Checkout Session expired before payment.",
          offerTokenHash: "",
        },
      },
      { returnDocument: "after", session },
    )
      .lean()
      .exec();
    if (expired) {
      await publishWaitlistCustomerNotificationForEntry({
        tenantId,
        entry: expired,
        type: WAITLIST_EMAIL_TYPE.EXPIRED,
        deduplicationKey: `waitlist:${String(expired._id)}:expired`,
        session,
      });
    }
    return expired
      ? {
          entryId: String(expired._id),
          sessionId: String(expired.courseSession),
        }
      : null;
  });

export const markLateWaitlistPaymentRefunded = async ({
  tenantId,
  orderId,
  now = new Date(),
  terminalState = WAITLIST_STATE.EXPIRED,
  reason = "Late payment refunded without fulfillment.",
  refundId,
  amountMinor,
  currency,
}: {
  tenantId: string;
  orderId: string;
  now?: Date;
  terminalState?:
    typeof WAITLIST_STATE.EXPIRED | typeof WAITLIST_STATE.CANCELLED;
  reason?: string;
  refundId: string;
  amountMinor: number;
  currency: string;
}) =>
  withTransaction(async (session) => {
    const refundSnapshot = {
      refundId,
      status: "succeeded",
      amountMinor,
      currency: normalizeStudioCommerceCurrency(currency),
      paymentMethod: "card",
      refundedAt: now,
    };
    const entry = await WaitlistEntryModel.findOneAndUpdate(
      {
        tenant: objectId(tenantId),
        "checkout.orderId": objectId(orderId),
        state: { $ne: WAITLIST_STATE.CONFIRMED },
      },
      {
        $set: {
          state: terminalState,
          isLive: false,
          terminalAt: now,
          terminalReason: reason,
          offerTokenHash: "",
          refundSnapshot,
        },
      },
      { returnDocument: "after", session },
    ).exec();
    if (!entry) return null;

    const deduplicationKey = `waitlist:${String(entry._id)}:refunded`;
    await publishWaitlistCustomerNotificationForEntry({
      tenantId,
      entry,
      type: WAITLIST_EMAIL_TYPE.REFUNDED,
      deduplicationKey,
      session,
    });
    await WaitlistEmailOutboxModel.updateOne(
      { deduplicationKey },
      {
        $setOnInsert: {
          tenant: objectId(tenantId),
          entry: entry._id,
          recipientEmail: entry.email,
          recipientName: `${entry.firstName} ${entry.lastName}`.trim(),
          type: WAITLIST_EMAIL_TYPE.REFUNDED,
          refundSnapshot,
          deduplicationKey,
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
        },
      },
      { upsert: true, session },
    ).exec();
    return entry;
  });
