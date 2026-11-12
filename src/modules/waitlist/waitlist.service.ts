import mongoose, { type ClientSession } from "mongoose";

import Booking from "@/modules/booking/booking.model.js";
import Product from "@/modules/product/product.model.js";
import { Order } from "@/modules/order/order.model.js";
import {
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";
import {
  resolveRolloutEligibleAppLocale,
  type RolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { emitWorkspaceNotificationEvent } from "@/modules/workspace-notifications/workspace-notification.events.js";

import {
  WAITLIST_ADMIN_ACTION,
  WAITLIST_EMAIL_TYPE,
  WAITLIST_MANAGEMENT_TTL_MS,
  WAITLIST_MANAGEMENT_AFTER_SESSION_GRACE_MS,
  WAITLIST_STATE,
  WAITLIST_TOKEN_PURPOSE,
  WAITLIST_VERIFICATION_TTL_MS,
} from "./waitlist.constants.js";
import {
  WaitlistAuditModel,
  WaitlistEmailOutboxModel,
  WaitlistEntryModel,
  WaitlistSequenceModel,
  WaitlistVerificationModel,
} from "./waitlist.model.js";
import {
  createWaitlistPriceVersion,
  deriveWaitlistToken,
  getPublicWaitlistAvailability,
  getWaitlistCapacity,
  hashWaitlistEmail,
  hashWaitlistToken,
  normalizeWaitlistEmail,
  resolveWaitlistOfferExpiry,
  resolveWaitlistSettings,
  waitlistEntryDto,
} from "./waitlist.policy.js";
import type {
  WaitlistEntryDto,
  WaitlistProductLike,
  WaitlistSessionLike,
  WaitlistSettings,
} from "./waitlist.types.js";
import { publishWaitlistCustomerNotificationForEntry } from "./waitlist.customer-notification.service.js";

type SessionProduct = {
  session: any;
  product: any;
  settings: WaitlistSettings;
};

type JoinIdentity = {
  email: string;
  firstName: string;
  lastName: string;
  customerId?: string | null;
  locale?: RolloutEligibleAppLocale;
  customId?: string;
};

type AdminActor = {
  actorUserId: string;
  reason?: string;
  overrideFifo?: boolean;
};

const objectId = (value: unknown): mongoose.Types.ObjectId =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));

const emitWaitlistJoinedNotification = ({
  tenantId,
  entryId,
  locationId,
  occurredAt,
}: {
  tenantId: string;
  entryId: string;
  locationId: string | null;
  occurredAt: Date;
}): void => {
  emitWorkspaceNotificationEvent({
    tenantId,
    requiredPermission: WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    ...(locationId ? { locationId } : {}),
    eventType: "waitlist.joined",
    severity: "info",
    title: {
      en: "Customer joined a waitlist",
      cs: "Zákazník se přidal na čekací listinu",
    },
    message: {
      en: "A new customer is waiting for a place in a class.",
      cs: "Nový zákazník čeká na místo v kurzu.",
    },
    actionUrl: "/app/bookings",
    sourceType: "waitlist-entry",
    sourceId: entryId,
    deduplicationKey: `waitlist:${entryId}:joined`,
    groupKey: "waitlist.joined",
    occurredAt,
  });
};

const withTransaction = async <T>(
  work: (session: ClientSession) => Promise<T>,
  existing?: ClientSession | null,
): Promise<T> => {
  if (existing) return work(existing);

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

const loadSessionProduct = async ({
  tenantId,
  sessionId,
  mongoSession,
}: {
  tenantId: string;
  sessionId: string;
  mongoSession?: ClientSession | null;
}): Promise<SessionProduct> => {
  const courseSession = await Booking.findOne({
    _id: objectId(sessionId),
    tenant: objectId(tenantId),
    tag: { $in: ["class", "course"] },
    archive: { $ne: true },
    status: { $nin: ["cancelled", "canceled"] } as any,
  })
    .select(
      "_id tenant bookingProduct location start end status archive numberOfGuests capacityReservations waitlistCapacityHolds waitlistConfig",
    )
    .session(mongoSession ?? null)
    .lean()
    .exec();

  if (!courseSession) {
    notFound({
      message: "Class session not found.",
      code: "WAITLIST_SESSION_NOT_FOUND",
    });
  }

  const product = await Product.findOne({
    _id: courseSession.bookingProduct,
    tenant: objectId(tenantId),
    isActive: true,
  })
    .select(
      "_id name price currency updatedAt maxNumberOfParticipants waitlistDefaults isActive",
    )
    .session(mongoSession ?? null)
    .lean()
    .exec();

  if (!product) {
    notFound({
      message: "Class not found.",
      code: "WAITLIST_PRODUCT_NOT_FOUND",
    });
  }

  return {
    session: courseSession,
    product,
    settings: resolveWaitlistSettings(
      courseSession.waitlistConfig,
      product.waitlistDefaults,
    ),
  };
};

const assertJoinAllowed = ({
  session,
  product,
  now,
}: {
  session: WaitlistSessionLike;
  product: WaitlistProductLike;
  now: Date;
}) => {
  const availability = getPublicWaitlistAvailability({ session, product, now });
  if (!availability.enabled) {
    conflict({
      message: "The waitlist is not enabled for this Class.",
      code: "WAITLIST_NOT_ACCEPTING",
      details: { reason: "disabled" },
    });
  }
  if (
    availability.reason === "session_started" ||
    availability.reason === "join_closed"
  ) {
    conflict({
      message: "This Class is too near its start time to join the waitlist.",
      code: "WAITLIST_NOT_ACCEPTING",
      details: { reason: availability.reason },
    });
  }

  const capacity = getWaitlistCapacity({ session, product, now });
  if (!capacity.full) {
    conflict({
      message: "A place is available; refresh and use normal checkout.",
      code: "BOOKING_AVAILABLE",
      details: { sessionId: String(session._id ?? "") },
    });
  }
};

const lockFullSessionForJoin = async ({
  tenantId,
  sessionProduct,
  now,
  session,
}: {
  tenantId: string;
  sessionProduct: SessionProduct;
  now: Date;
  session: ClientSession;
}) => {
  const capacity = Math.max(
    0,
    Math.floor(Number(sessionProduct.product.maxNumberOfParticipants ?? 0)),
  );
  const locked = await Booking.updateOne(
    {
      _id: sessionProduct.session._id,
      tenant: objectId(tenantId),
      status: { $nin: ["cancelled", "canceled"] } as any,
      start: sessionProduct.session.start,
      $expr: {
        $gte: [
          {
            $add: [
              { $ifNull: ["$numberOfGuests", 0] },
              {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: { $ifNull: ["$capacityReservations", []] },
                        as: "reservation",
                        cond: { $gt: ["$$reservation.expiresAt", now] },
                      },
                    },
                    as: "reservation",
                    in: "$$reservation.quantity",
                  },
                },
              },
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$waitlistCapacityHolds", []] },
                    as: "hold",
                    cond: { $gt: ["$$hold.expiresAt", now] },
                  },
                },
              },
            ],
          },
          capacity,
        ],
      },
    },
    { $inc: { waitlistJoinRevision: 1 } },
    { session },
  ).exec();
  if (locked.modifiedCount !== 1) {
    conflict({
      message: "A place is available; refresh and use normal checkout.",
      code: "BOOKING_AVAILABLE",
      details: { sessionId: String(sessionProduct.session._id) },
    });
  }
};

const snapshotPrice = (product: any, now: Date) => {
  const currency = normalizeStudioCommerceCurrency(product.currency);
  const amountMinor = toCurrencyMinorUnits(Number(product.price), currency);

  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    conflict({
      message: "Waitlist offers require a positive payable Class price.",
      code: "WAITLIST_PAID_PRICE_REQUIRED",
    });
  }

  return {
    amountMinor,
    currency,
    version: createWaitlistPriceVersion(product, amountMinor, currency),
    productId: product._id,
    capturedAt: now,
  };
};

const assertNotConfirmedParticipant = async ({
  tenantId,
  sessionId,
  identity,
  session,
}: {
  tenantId: string;
  sessionId: string;
  identity: JoinIdentity;
  session: ClientSession;
}) => {
  const email = normalizeWaitlistEmail(identity.email);
  const confirmedOrder = await Order.exists({
    tenant: objectId(tenantId),
    status: "processed_order",
    isPaid: true,
    courseBookings: { $elemMatch: { bookingId: objectId(sessionId) } },
    "courseCancellations.bookingId": { $ne: objectId(sessionId) },
    $or: [
      ...(identity.customerId
        ? [{ createdBy: objectId(identity.customerId) }]
        : []),
      { "customer.email": email },
    ],
  })
    .session(session)
    .exec();
  if (confirmedOrder) {
    conflict({
      message: "This customer already has a confirmed place in the Class.",
      code: "WAITLIST_ALREADY_CONFIRMED",
    });
  }
};

const safeEntryDto = (entry: any) => ({
  ...waitlistEntryDto(entry),
  session: {
    id: String(entry.courseSession?._id ?? entry.courseSession ?? ""),
    title: String(
      entry.product?.name ?? entry.courseSession?.bookingProduct?.name ?? "",
    ),
    start: entry.courseSession?.start ?? null,
    end: entry.courseSession?.end ?? null,
    locationName: String(entry.courseSession?.location?.name ?? ""),
  },
});

const loadSafeEntryDto = async (tenantId: string, entryId: unknown) => {
  const entry = await WaitlistEntryModel.findOne({
    _id: entryId,
    tenant: objectId(tenantId),
  })
    .populate({ path: "product", select: "name" })
    .populate({
      path: "courseSession",
      select: "_id bookingProduct location start end",
      populate: [
        { path: "bookingProduct", select: "name" },
        { path: "location", select: "name" },
      ],
    })
    .lean()
    .exec();
  return entry ? safeEntryDto(entry) : null;
};

const nextSequence = async ({
  tenantId,
  sessionId,
  session,
}: {
  tenantId: string;
  sessionId: string;
  session: ClientSession;
}): Promise<number> => {
  const counter = await WaitlistSequenceModel.findOneAndUpdate(
    { tenant: objectId(tenantId), courseSession: objectId(sessionId) },
    { $inc: { next: 1 } },
    { upsert: true, returnDocument: "after", session },
  ).lean();
  return Number(counter?.next);
};

const enqueueEmail = async ({
  tenantId,
  entry,
  verification,
  email,
  name,
  type,
  tokenPurpose = "",
  tokenGeneration = null,
  deduplicationKey,
  session,
}: {
  tenantId: string;
  entry?: unknown;
  verification?: unknown;
  email: string;
  name?: string;
  type: (typeof WAITLIST_EMAIL_TYPE)[keyof typeof WAITLIST_EMAIL_TYPE];
  tokenPurpose?: string;
  tokenGeneration?: number | null;
  deduplicationKey: string;
  session: ClientSession;
}) => {
  await publishWaitlistCustomerNotificationForEntry({
    tenantId,
    entryId: entry,
    type,
    deduplicationKey,
    session,
  });

  await WaitlistEmailOutboxModel.updateOne(
    { deduplicationKey },
    {
      $setOnInsert: {
        tenant: objectId(tenantId),
        entry: entry ? objectId(entry) : null,
        verification: verification ? objectId(verification) : null,
        recipientEmail: email,
        recipientName: name ?? "",
        type,
        tokenPurpose,
        tokenGeneration,
        deduplicationKey,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, session },
  ).exec();
};

const managementTokenFor = (entry: any): string =>
  deriveWaitlistToken({
    subject: entry._id,
    purpose: WAITLIST_TOKEN_PURPOSE.MANAGE,
    generation: Number(entry.managementGeneration),
  });

const createEntry = async ({
  tenantId,
  sessionProduct,
  identity,
  source,
  now,
  session,
}: {
  tenantId: string;
  sessionProduct: SessionProduct;
  identity: JoinIdentity;
  source: "customer" | "guest";
  now: Date;
  session: ClientSession;
}) => {
  const email = normalizeWaitlistEmail(identity.email);
  const identityKey = hashWaitlistEmail(email);
  const customerId = identity.customerId ? objectId(identity.customerId) : null;

  const existing = await WaitlistEntryModel.findOne({
    tenant: objectId(tenantId),
    courseSession: sessionProduct.session._id,
    isLive: true,
    $or: [{ identityKey }, ...(customerId ? [{ customer: customerId }] : [])],
  })
    .select("+managementTokenHash")
    .session(session)
    .exec();

  if (existing) {
    if (customerId && !existing.customer) {
      existing.customer = customerId;
      existing.source = "customer";
      await existing.save({ session });
    }
    return { entry: existing, created: false };
  }

  const entryId = new mongoose.Types.ObjectId();
  const managementGeneration = 1;
  const managementToken = deriveWaitlistToken({
    subject: entryId,
    purpose: WAITLIST_TOKEN_PURPOSE.MANAGE,
    generation: managementGeneration,
  });
  const sequence = await nextSequence({
    tenantId,
    sessionId: String(sessionProduct.session._id),
    session,
  });

  const [entry] = await WaitlistEntryModel.create(
    [
      {
        _id: entryId,
        tenant: objectId(tenantId),
        courseSession: sessionProduct.session._id,
        product: sessionProduct.product._id,
        customer: customerId,
        identityKey,
        email,
        firstName: identity.firstName,
        lastName: identity.lastName,
        source,
        locale: resolveRolloutEligibleAppLocale(identity.locale),
        emailVerifiedAt: now,
        state: WAITLIST_STATE.WAITING,
        isLive: true,
        sequence,
        joinedAt: now,
        sessionStartSnapshot: new Date(sessionProduct.session.start),
        priceSnapshot: snapshotPrice(sessionProduct.product, now),
        managementGeneration,
        managementTokenHash: hashWaitlistToken(
          managementToken,
          WAITLIST_TOKEN_PURPOSE.MANAGE,
        ),
        managementExpiresAt: new Date(
          Math.max(
            now.getTime() + WAITLIST_MANAGEMENT_TTL_MS,
            new Date(sessionProduct.session.start).getTime() +
              WAITLIST_MANAGEMENT_AFTER_SESSION_GRACE_MS,
          ),
        ),
      },
    ],
    { session },
  );

  await enqueueEmail({
    tenantId,
    entry: entry._id,
    email,
    name: `${identity.firstName} ${identity.lastName}`.trim(),
    type: WAITLIST_EMAIL_TYPE.JOINED,
    tokenPurpose: WAITLIST_TOKEN_PURPOSE.MANAGE,
    tokenGeneration: managementGeneration,
    deduplicationKey: `waitlist:${String(entry._id)}:joined`,
    session,
  });

  return { entry, created: true };
};

export const joinCustomerWaitlist = async ({
  tenantId,
  sessionId,
  customer,
  now = new Date(),
}: {
  tenantId: string;
  sessionId: string;
  customer: JoinIdentity & { customerId: string };
  now?: Date;
}) => {
  const identityKey = hashWaitlistEmail(normalizeWaitlistEmail(customer.email));
  try {
    const result = await withTransaction(async (session) => {
      const normalizedEmail = normalizeWaitlistEmail(customer.email);
      const existing = await WaitlistEntryModel.findOne({
        tenant: objectId(tenantId),
        courseSession: objectId(sessionId),
        isLive: true,
        $or: [
          { customer: objectId(customer.customerId) },
          { identityKey: hashWaitlistEmail(normalizedEmail) },
        ],
      })
        .select("+managementTokenHash")
        .session(session)
        .exec();
      if (existing) {
        if (!existing.customer) {
          existing.customer = objectId(customer.customerId);
          existing.source = "customer";
          await existing.save({ session });
        }
        return {
          entry: waitlistEntryDto(existing),
          created: false,
          notificationLocationId: null,
        };
      }

      const sessionProduct = await loadSessionProduct({
        tenantId,
        sessionId,
        mongoSession: session,
      });
      assertJoinAllowed({ ...sessionProduct, now });
      await lockFullSessionForJoin({
        tenantId,
        sessionProduct,
        now,
        session,
      });
      await assertNotConfirmedParticipant({
        tenantId,
        sessionId,
        identity: customer,
        session,
      });
      const result = await createEntry({
        tenantId,
        sessionProduct,
        identity: customer,
        source: "customer",
        now,
        session,
      });
      return {
        entry: waitlistEntryDto(result.entry),
        created: result.created,
        notificationLocationId: String(
          sessionProduct.session.location ?? "",
        ).trim(),
      };
    });
    const { notificationLocationId, ...publicResult } = result;
    if (publicResult.created) {
      emitWaitlistJoinedNotification({
        tenantId,
        entryId: publicResult.entry.id,
        locationId: notificationLocationId || null,
        occurredAt: now,
      });
      await promoteWaitlistEntry({ tenantId, sessionId, automatic: true, now });
    }
    return publicResult;
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const surviving = await WaitlistEntryModel.findOne({
      tenant: objectId(tenantId),
      courseSession: objectId(sessionId),
      isLive: true,
      $or: [{ customer: objectId(customer.customerId) }, { identityKey }],
    }).lean();
    if (!surviving) throw error;
    return { entry: waitlistEntryDto(surviving), created: false };
  }
};

export const requestGuestWaitlistVerification = async ({
  tenantId,
  sessionId,
  identity,
  now = new Date(),
}: {
  tenantId: string;
  sessionId: string;
  identity: JoinIdentity;
  now?: Date;
}): Promise<void> =>
  withTransaction(async (session) => {
    const sessionProduct = await loadSessionProduct({
      tenantId,
      sessionId,
      mongoSession: session,
    });
    assertJoinAllowed({ ...sessionProduct, now });

    const email = normalizeWaitlistEmail(identity.email);
    const identityKey = hashWaitlistEmail(email);
    const requestKey = `${tenantId}:${sessionId}:${identityKey}`;
    const verificationId = new mongoose.Types.ObjectId();
    const previous = await WaitlistVerificationModel.findOne({ requestKey })
      .select("generation")
      .session(session)
      .lean();
    const generation = Number(previous?.generation ?? 0) + 1;
    const subject = previous?._id ?? verificationId;
    const token = deriveWaitlistToken({
      subject,
      purpose: WAITLIST_TOKEN_PURPOSE.VERIFY,
      generation,
    });

    const verification = await WaitlistVerificationModel.findOneAndUpdate(
      { requestKey },
      {
        $set: {
          tenant: objectId(tenantId),
          courseSession: sessionProduct.session._id,
          product: sessionProduct.product._id,
          identityKey,
          email,
          firstName: identity.firstName,
          lastName: identity.lastName,
          locale: resolveRolloutEligibleAppLocale(identity.locale),
          generation,
          tokenHash: hashWaitlistToken(token, WAITLIST_TOKEN_PURPOSE.VERIFY),
          expiresAt: new Date(now.getTime() + WAITLIST_VERIFICATION_TTL_MS),
          consumedAt: null,
          entry: null,
        },
        $setOnInsert: { _id: verificationId, requestKey },
      },
      { upsert: true, returnDocument: "after", session },
    ).lean();

    await enqueueEmail({
      tenantId,
      verification: verification?._id,
      email,
      name: `${identity.firstName} ${identity.lastName}`.trim(),
      type: WAITLIST_EMAIL_TYPE.VERIFY,
      tokenPurpose: WAITLIST_TOKEN_PURPOSE.VERIFY,
      tokenGeneration: generation,
      deduplicationKey: `waitlist-verification:${String(verification?._id)}:${generation}`,
      session,
    });
  });

export const verifyGuestWaitlist = async ({
  tenantId,
  token,
  now = new Date(),
}: {
  tenantId: string;
  token: string;
  now?: Date;
}) => {
  const result = await withTransaction(async (session) => {
    const tokenHash = hashWaitlistToken(token, WAITLIST_TOKEN_PURPOSE.VERIFY);
    const verification = await WaitlistVerificationModel.findOneAndUpdate(
      {
        tenant: objectId(tenantId),
        tokenHash,
        consumedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { consumedAt: now } },
      { returnDocument: "after", session },
    )
      .select("+tokenHash")
      .exec();

    if (!verification) {
      const replay = await WaitlistVerificationModel.findOne({
        tenant: objectId(tenantId),
        tokenHash,
        consumedAt: { $ne: null },
        entry: { $type: "objectId" },
        expiresAt: { $gt: now },
      })
        .select("entry +tokenHash")
        .session(session)
        .lean()
        .exec();
      if (replay?.entry) {
        const entry = await WaitlistEntryModel.findOne({
          _id: replay.entry,
          tenant: objectId(tenantId),
        })
          .select("+managementTokenHash")
          .session(session)
          .exec();
        if (entry) {
          return {
            entry: waitlistEntryDto(entry),
            managementToken: managementTokenFor(entry),
            created: false,
            notificationLocationId: null,
          };
        }
      }
      notFound({
        message: "This verification link is invalid or expired.",
        code: "WAITLIST_TOKEN_INVALID",
      });
    }

    const sessionProduct = await loadSessionProduct({
      tenantId,
      sessionId: String(verification.courseSession),
      mongoSession: session,
    });
    // Assigning FIFO order happens only after this second authoritative check.
    assertJoinAllowed({ ...sessionProduct, now });
    await lockFullSessionForJoin({
      tenantId,
      sessionProduct,
      now,
      session,
    });
    await assertNotConfirmedParticipant({
      tenantId,
      sessionId: String(verification.courseSession),
      identity: {
        email: verification.email,
        firstName: verification.firstName,
        lastName: verification.lastName,
      },
      session,
    });

    const result = await createEntry({
      tenantId,
      sessionProduct,
      identity: {
        email: verification.email,
        firstName: verification.firstName,
        lastName: verification.lastName,
        locale: verification.locale,
      },
      source: "guest",
      now,
      session,
    });
    verification.entry = result.entry._id;
    await verification.save({ session });

    return {
      entry: waitlistEntryDto(result.entry),
      managementToken: managementTokenFor(result.entry),
      created: result.created,
      notificationLocationId: String(
        sessionProduct.session.location ?? "",
      ).trim(),
    };
  });
  const { notificationLocationId, ...publicResult } = result;
  if (publicResult.created) {
    emitWaitlistJoinedNotification({
      tenantId,
      entryId: publicResult.entry.id,
      locationId: notificationLocationId || null,
      occurredAt: now,
    });
    await promoteWaitlistEntry({
      tenantId,
      sessionId: publicResult.entry.sessionId,
      automatic: true,
      now,
    });
  }
  return {
    ...publicResult,
    entry:
      (await loadSafeEntryDto(tenantId, publicResult.entry.id)) ??
      publicResult.entry,
  };
};

export const getGuestManagedEntry = async ({
  tenantId,
  token,
  now = new Date(),
}: {
  tenantId: string;
  token: string;
  now?: Date;
}) => {
  const tokenHash = hashWaitlistToken(token, WAITLIST_TOKEN_PURPOSE.MANAGE);
  const entry = await WaitlistEntryModel.findOne({
    tenant: objectId(tenantId),
    managementTokenHash: tokenHash,
    managementExpiresAt: { $gt: now },
  })
    .select("+managementTokenHash")
    .populate({ path: "product", select: "name" })
    .populate({
      path: "courseSession",
      select: "_id bookingProduct location start end",
      populate: [
        { path: "bookingProduct", select: "name" },
        { path: "location", select: "name" },
      ],
    })
    .lean()
    .exec();

  if (!entry) {
    notFound({
      message: "This management link is invalid or expired.",
      code: "WAITLIST_TOKEN_INVALID",
    });
  }
  return safeEntryDto(entry);
};

const releaseEntryCapacity = async ({
  tenantId,
  entry,
  session,
}: {
  tenantId: string;
  entry: any;
  session: ClientSession;
}) => {
  const pulls: Record<string, unknown> = {
    waitlistCapacityHolds: { entry: entry._id },
  };
  if (entry.checkout?.orderId) {
    pulls.capacityReservations = { order: entry.checkout.orderId };
  }

  await Booking.updateOne(
    { _id: entry.courseSession, tenant: objectId(tenantId) },
    { $pull: pulls },
    { session },
  ).exec();
};

export const withdrawWaitlistEntry = async ({
  tenantId,
  entryId,
  customerId,
  managementToken,
  now = new Date(),
}: {
  tenantId: string;
  entryId?: string;
  customerId?: string;
  managementToken?: string;
  now?: Date;
}) => {
  const result = await withTransaction(async (session) => {
    if (!entryId && !managementToken) {
      conflict({
        message: "A waitlist entry selector is required.",
        code: "WAITLIST_ENTRY_SELECTOR_REQUIRED",
      });
    }
    if (customerId && !entryId) {
      conflict({
        message: "Authenticated withdrawal requires an entry identifier.",
        code: "WAITLIST_ENTRY_SELECTOR_REQUIRED",
      });
    }
    const filter: Record<string, unknown> = {
      tenant: objectId(tenantId),
      isLive: true,
      state: { $in: [WAITLIST_STATE.WAITING, WAITLIST_STATE.OFFERED] },
    };
    if (entryId) filter._id = objectId(entryId);
    if (customerId) filter.customer = objectId(customerId);
    if (managementToken) {
      filter.managementTokenHash = hashWaitlistToken(
        managementToken,
        WAITLIST_TOKEN_PURPOSE.MANAGE,
      );
      filter.managementExpiresAt = { $gt: now };
    }

    const entry = await WaitlistEntryModel.findOne(filter)
      .select("+managementTokenHash")
      .session(session)
      .exec();
    if (!entry) {
      const replay = await WaitlistEntryModel.findOne({
        tenant: objectId(tenantId),
        ...(entryId ? { _id: objectId(entryId) } : {}),
        ...(customerId ? { customer: objectId(customerId) } : {}),
        ...(managementToken
          ? {
              managementTokenHash: hashWaitlistToken(
                managementToken,
                WAITLIST_TOKEN_PURPOSE.MANAGE,
              ),
              managementExpiresAt: { $gt: now },
            }
          : {}),
        state: WAITLIST_STATE.WITHDRAWN,
      })
        .select("+managementTokenHash")
        .session(session)
        .lean()
        .exec();
      if (replay) return waitlistEntryDto(replay);
      const paymentPending = await WaitlistEntryModel.exists({
        tenant: objectId(tenantId),
        ...(entryId ? { _id: objectId(entryId) } : {}),
        ...(customerId ? { customer: objectId(customerId) } : {}),
        ...(managementToken
          ? {
              managementTokenHash: hashWaitlistToken(
                managementToken,
                WAITLIST_TOKEN_PURPOSE.MANAGE,
              ),
            }
          : {}),
        state: WAITLIST_STATE.PAYMENT_PENDING,
      }).session(session);
      if (paymentPending) {
        conflict({
          message: "Payment is already in progress and cannot be withdrawn.",
          code: "WAITLIST_PAYMENT_IN_PROGRESS",
        });
      }
      notFound({
        message: "Waitlist entry not found.",
        code: "WAITLIST_ENTRY_NOT_FOUND",
      });
    }

    await releaseEntryCapacity({ tenantId, entry, session });
    entry.state = WAITLIST_STATE.WITHDRAWN;
    entry.isLive = false;
    entry.terminalAt = now;
    entry.offerTokenHash = "";
    await entry.save({ session });

    await enqueueEmail({
      tenantId,
      entry: entry._id,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`.trim(),
      type: WAITLIST_EMAIL_TYPE.WITHDRAWN,
      deduplicationKey: `waitlist:${String(entry._id)}:withdrawn`,
      session,
    });

    return waitlistEntryDto(entry);
  });

  await promoteWaitlistEntry({
    tenantId,
    sessionId: result.sessionId,
    automatic: true,
    now,
  }).catch(() => null);
  return result;
};

export const listCustomerWaitlistEntries = async ({
  tenantId,
  customerId,
  sessionId,
}: {
  tenantId: string;
  customerId: string;
  sessionId?: string;
}) => {
  const query: Record<string, unknown> = {
    tenant: objectId(tenantId),
    customer: objectId(customerId),
  };
  if (sessionId) query.courseSession = objectId(sessionId);

  const entries = await WaitlistEntryModel.find(query)
    .sort({ joinedAt: -1, _id: -1 })
    .populate({
      path: "courseSession",
      select: "_id bookingProduct location start end",
      populate: [
        { path: "bookingProduct", select: "name" },
        { path: "location", select: "name" },
      ],
    })
    .lean()
    .exec();

  return entries.map(safeEntryDto);
};

const audit = async ({
  tenantId,
  sessionId,
  entryId,
  actor,
  action,
  before,
  after,
  session,
}: {
  tenantId: string;
  sessionId: unknown;
  entryId?: unknown;
  actor: AdminActor;
  action: (typeof WAITLIST_ADMIN_ACTION)[keyof typeof WAITLIST_ADMIN_ACTION];
  before?: unknown;
  after?: unknown;
  session: ClientSession;
}) =>
  WaitlistAuditModel.create(
    [
      {
        tenant: objectId(tenantId),
        courseSession: objectId(sessionId),
        entry: entryId ? objectId(entryId) : null,
        actor: objectId(actor.actorUserId),
        action,
        reason: actor.reason ?? "",
        overrideFifo: actor.overrideFifo === true,
        before,
        after,
      },
    ],
    { session },
  );

export const getWaitlistSettings = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const value = await loadSessionProduct({ tenantId, sessionId });
  return value.settings;
};

export const updateWaitlistSettings = async ({
  tenantId,
  sessionId,
  patch,
  actor,
}: {
  tenantId: string;
  sessionId: string;
  patch: Partial<WaitlistSettings>;
  actor: AdminActor;
}) =>
  withTransaction(async (session) => {
    const current = await loadSessionProduct({
      tenantId,
      sessionId,
      mongoSession: session,
    });
    const next = resolveWaitlistSettings(
      { ...current.settings, ...patch },
      current.product.waitlistDefaults,
    );
    await Booking.updateOne(
      { _id: current.session._id, tenant: objectId(tenantId) },
      { $set: { waitlistConfig: next } },
      { session },
    ).exec();
    await audit({
      tenantId,
      sessionId,
      actor,
      action: WAITLIST_ADMIN_ACTION.SETTINGS_UPDATED,
      before: current.settings,
      after: next,
      session,
    });
    return next;
  });

const appendOfferHold = async ({
  tenantId,
  sessionProduct,
  entry,
  offerGeneration,
  expiresAt,
  now,
  session,
}: {
  tenantId: string;
  sessionProduct: SessionProduct;
  entry: any;
  offerGeneration: number;
  expiresAt: Date;
  now: Date;
  session: ClientSession;
}) => {
  const capacity = Math.floor(
    Number(sessionProduct.product.maxNumberOfParticipants),
  );
  const result = await Booking.updateOne(
    {
      _id: sessionProduct.session._id,
      tenant: objectId(tenantId),
      archive: { $ne: true },
      status: { $nin: ["cancelled", "canceled"] } as any,
      start: entry.sessionStartSnapshot,
      $expr: {
        $lt: [
          {
            $add: [
              { $ifNull: ["$numberOfGuests", 0] },
              {
                $sum: {
                  $map: {
                    input: {
                      $filter: {
                        input: { $ifNull: ["$capacityReservations", []] },
                        as: "reservation",
                        cond: { $gt: ["$$reservation.expiresAt", now] },
                      },
                    },
                    as: "reservation",
                    in: "$$reservation.quantity",
                  },
                },
              },
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$waitlistCapacityHolds", []] },
                    as: "hold",
                    cond: { $gt: ["$$hold.expiresAt", now] },
                  },
                },
              },
            ],
          },
          capacity,
        ],
      },
    },
    [
      {
        $set: {
          waitlistCapacityHolds: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ["$waitlistCapacityHolds", []] },
                  as: "hold",
                  cond: {
                    $and: [
                      { $gt: ["$$hold.expiresAt", now] },
                      { $ne: ["$$hold.entry", entry._id] },
                    ],
                  },
                },
              },
              [
                {
                  entry: entry._id,
                  offerGeneration,
                  expiresAt,
                },
              ],
            ],
          },
        },
      },
    ],
    { session },
  ).exec();
  return result.modifiedCount === 1;
};

export const promoteWaitlistEntry = async ({
  tenantId,
  sessionId,
  entryId,
  actor,
  automatic = false,
  now = new Date(),
}: {
  tenantId: string;
  sessionId: string;
  entryId?: string;
  actor?: AdminActor;
  automatic?: boolean;
  now?: Date;
}): Promise<WaitlistEntryDto | null> =>
  withTransaction(async (session) => {
    const sessionProduct = await loadSessionProduct({
      tenantId,
      sessionId,
      mongoSession: session,
    });
    if (
      !sessionProduct.settings.enabled ||
      (automatic && !sessionProduct.settings.autoPromote)
    ) {
      if (!automatic) {
        conflict({
          message: "Waitlist is disabled for this Class session.",
          code: "WAITLIST_DISABLED",
        });
      }
      return null;
    }

    const head = await WaitlistEntryModel.findOne({
      tenant: objectId(tenantId),
      courseSession: sessionProduct.session._id,
      state: WAITLIST_STATE.WAITING,
      isLive: true,
    })
      .sort({ sequence: 1, _id: 1 })
      .session(session)
      .exec();
    if (!head) {
      if (!automatic) {
        notFound({
          message: "No waiting entry is available to promote.",
          code: "WAITLIST_ENTRY_NOT_WAITING",
        });
      }
      return null;
    }

    if (entryId && String(head._id) !== String(entryId)) {
      if (!actor?.overrideFifo || !actor.reason?.trim()) {
        conflict({
          message: "A different customer is first in the waitlist.",
          code: "WAITLIST_FIFO_CONFLICT",
          details: { headEntryId: String(head._id) },
        });
      }
    }

    const entry = entryId
      ? await WaitlistEntryModel.findOne({
          _id: objectId(entryId),
          tenant: objectId(tenantId),
          courseSession: sessionProduct.session._id,
          state: WAITLIST_STATE.WAITING,
          isLive: true,
        }).session(session)
      : head;
    if (!entry) {
      if (!automatic) {
        notFound({
          message: "The requested waiting entry was not found.",
          code: "WAITLIST_ENTRY_NOT_WAITING",
        });
      }
      return null;
    }
    if (
      new Date(entry.sessionStartSnapshot).getTime() !==
      new Date(sessionProduct.session.start).getTime()
    ) {
      if (!automatic) {
        conflict({
          message: "The Class schedule changed; this entry cannot be promoted.",
          code: "WAITLIST_SESSION_CHANGED",
        });
      }
      return null;
    }

    const expiresAt = resolveWaitlistOfferExpiry({
      now,
      sessionStart: sessionProduct.session.start,
      settings: sessionProduct.settings,
    });
    if (!expiresAt) {
      if (!automatic) {
        conflict({
          message: "It is too late to create a safe payment offer.",
          code: "WAITLIST_JOIN_CLOSED",
        });
      }
      return null;
    }

    const generation = Number(entry.offerGeneration ?? 0) + 1;
    const token = deriveWaitlistToken({
      subject: entry._id,
      purpose: WAITLIST_TOKEN_PURPOSE.OFFER,
      generation,
    });
    const held = await appendOfferHold({
      tenantId,
      sessionProduct,
      entry,
      offerGeneration: generation,
      expiresAt,
      now,
      session,
    });
    if (!held) {
      if (!automatic) {
        conflict({
          message: "No unreserved Class seat is available.",
          code: "WAITLIST_NO_CAPACITY",
        });
      }
      return null;
    }

    const updated = await WaitlistEntryModel.findOneAndUpdate(
      {
        _id: entry._id,
        tenant: objectId(tenantId),
        state: WAITLIST_STATE.WAITING,
        offerGeneration: generation - 1,
      },
      {
        $set: {
          state: WAITLIST_STATE.OFFERED,
          offeredAt: now,
          offerExpiresAt: expiresAt,
          offerTokenHash: hashWaitlistToken(
            token,
            WAITLIST_TOKEN_PURPOSE.OFFER,
          ),
        },
        $inc: { offerGeneration: 1 },
      },
      { returnDocument: "after", session },
    ).exec();
    if (!updated) {
      throw new Error("Waitlist offer generation changed during promotion.");
    }

    await enqueueEmail({
      tenantId,
      entry: updated._id,
      email: updated.email,
      name: `${updated.firstName} ${updated.lastName}`.trim(),
      type: WAITLIST_EMAIL_TYPE.OFFERED,
      tokenPurpose: WAITLIST_TOKEN_PURPOSE.OFFER,
      tokenGeneration: generation,
      deduplicationKey: `waitlist:${String(updated._id)}:offer:${generation}`,
      session,
    });
    if (actor) {
      await audit({
        tenantId,
        sessionId,
        entryId: updated._id,
        actor,
        action: WAITLIST_ADMIN_ACTION.PROMOTED,
        before: { state: WAITLIST_STATE.WAITING },
        after: { state: WAITLIST_STATE.OFFERED, offerGeneration: generation },
        session,
      });
    }
    return waitlistEntryDto(updated);
  });

export const listAdminWaitlist = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const sessionProduct = await loadSessionProduct({ tenantId, sessionId });
  const entries = await WaitlistEntryModel.find({
    tenant: objectId(tenantId),
    courseSession: objectId(sessionId),
    isLive: true,
    state: {
      $in: [
        WAITLIST_STATE.WAITING,
        WAITLIST_STATE.OFFERED,
        WAITLIST_STATE.PAYMENT_PENDING,
      ],
    },
  })
    .sort({ sequence: 1, _id: 1 })
    .lean()
    .exec();
  return {
    entries: entries.map((entry: any, index: number) => ({
      ...waitlistEntryDto(entry),
      position: index + 1,
      customerId: entry.customer ? String(entry.customer) : null,
      customer: {
        name: `${entry.firstName} ${entry.lastName}`.trim(),
        email: entry.email,
      },
      source: entry.source,
    })),
    summary: {
      booked: Math.max(
        0,
        Math.floor(Number(sessionProduct.session.numberOfGuests ?? 0)),
      ),
      capacity: Math.max(
        0,
        Math.floor(Number(sessionProduct.product.maxNumberOfParticipants ?? 0)),
      ),
      waiting: entries.filter(
        (entry: any) => entry.state === WAITLIST_STATE.WAITING,
      ).length,
      offered: entries.filter(
        (entry: any) =>
          entry.state === WAITLIST_STATE.OFFERED ||
          entry.state === WAITLIST_STATE.PAYMENT_PENDING,
      ).length,
    },
  };
};

export const resendWaitlistOffer = async ({
  tenantId,
  sessionId,
  entryId,
  actor,
  now = new Date(),
}: {
  tenantId: string;
  sessionId: string;
  entryId: string;
  actor: AdminActor;
  now?: Date;
}) =>
  withTransaction(async (session) => {
    const entry = await WaitlistEntryModel.findOne({
      _id: objectId(entryId),
      tenant: objectId(tenantId),
      courseSession: objectId(sessionId),
      state: WAITLIST_STATE.OFFERED,
      isLive: true,
      offerExpiresAt: { $gt: now },
    })
      .select("+offerTokenHash")
      .session(session)
      .exec();
    if (!entry) {
      notFound({
        message: "An active waitlist offer was not found.",
        code: "WAITLIST_OFFER_EXPIRED",
      });
    }

    const sessionProduct = await loadSessionProduct({
      tenantId,
      sessionId,
      mongoSession: session,
    });
    if (
      new Date(entry.sessionStartSnapshot).getTime() !==
      new Date(sessionProduct.session.start).getTime()
    ) {
      conflict({
        message: "The Class schedule changed; this offer cannot be resent.",
        code: "WAITLIST_SESSION_CHANGED",
      });
    }

    const nextGeneration = Number(entry.offerGeneration) + 1;
    const hold = await Booking.updateOne(
      {
        _id: objectId(sessionId),
        tenant: objectId(tenantId),
        archive: { $ne: true },
        status: { $nin: ["cancelled", "canceled"] } as any,
        start: entry.sessionStartSnapshot,
        waitlistCapacityHolds: {
          $elemMatch: {
            entry: entry._id,
            offerGeneration: entry.offerGeneration,
            expiresAt: { $gt: now },
          },
        },
      },
      {
        $set: {
          "waitlistCapacityHolds.$[hold].offerGeneration": nextGeneration,
        },
      },
      {
        arrayFilters: [
          {
            "hold.entry": entry._id,
            "hold.offerGeneration": entry.offerGeneration,
          },
        ],
        session,
      },
    ).exec();
    if (hold.modifiedCount !== 1) {
      conflict({
        message: "The waitlist seat hold is no longer active.",
        code: "WAITLIST_OFFER_EXPIRED",
      });
    }

    const token = deriveWaitlistToken({
      subject: entry._id,
      purpose: WAITLIST_TOKEN_PURPOSE.OFFER,
      generation: nextGeneration,
    });
    entry.offerGeneration = nextGeneration;
    entry.offerTokenHash = hashWaitlistToken(
      token,
      WAITLIST_TOKEN_PURPOSE.OFFER,
    );
    await entry.save({ session });
    await enqueueEmail({
      tenantId,
      entry: entry._id,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`.trim(),
      type: WAITLIST_EMAIL_TYPE.OFFERED,
      tokenPurpose: WAITLIST_TOKEN_PURPOSE.OFFER,
      tokenGeneration: nextGeneration,
      deduplicationKey: `waitlist:${String(entry._id)}:offer:${nextGeneration}`,
      session,
    });
    await audit({
      tenantId,
      sessionId,
      entryId,
      actor,
      action: WAITLIST_ADMIN_ACTION.OFFER_RESENT,
      before: { offerGeneration: nextGeneration - 1 },
      after: { offerGeneration: nextGeneration },
      session,
    });
    return waitlistEntryDto(entry);
  });

export const cancelWaitlistEntryByAdmin = async ({
  tenantId,
  sessionId,
  entryId,
  actor,
  now = new Date(),
}: {
  tenantId: string;
  sessionId: string;
  entryId: string;
  actor: AdminActor;
  now?: Date;
}) => {
  const result = await withTransaction(async (session) => {
    const entry = await WaitlistEntryModel.findOne({
      _id: objectId(entryId),
      tenant: objectId(tenantId),
      courseSession: objectId(sessionId),
      isLive: true,
      state: { $in: [WAITLIST_STATE.WAITING, WAITLIST_STATE.OFFERED] },
    })
      .select("+managementTokenHash +offerTokenHash")
      .session(session)
      .exec();
    if (!entry) {
      const replay = await WaitlistEntryModel.findOne({
        _id: objectId(entryId),
        tenant: objectId(tenantId),
        courseSession: objectId(sessionId),
        state: WAITLIST_STATE.CANCELLED,
      })
        .session(session)
        .lean()
        .exec();
      if (replay) return waitlistEntryDto(replay);
      const pending = await WaitlistEntryModel.exists({
        _id: objectId(entryId),
        tenant: objectId(tenantId),
        state: WAITLIST_STATE.PAYMENT_PENDING,
      }).session(session);
      if (pending) {
        conflict({
          message: "Expire the payable Stripe Session before cancellation.",
          code: "WAITLIST_PAYMENT_IN_PROGRESS",
        });
      }
      notFound({
        message: "Waitlist entry not found.",
        code: "WAITLIST_ENTRY_NOT_FOUND",
      });
    }
    const beforeState = entry.state;
    await releaseEntryCapacity({ tenantId, entry, session });
    entry.state = WAITLIST_STATE.CANCELLED;
    entry.isLive = false;
    entry.terminalAt = now;
    entry.terminalReason = actor.reason ?? "Cancelled by studio.";
    entry.offerTokenHash = "";
    await entry.save({ session });
    await enqueueEmail({
      tenantId,
      entry: entry._id,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`.trim(),
      type: WAITLIST_EMAIL_TYPE.CANCELLED,
      deduplicationKey: `waitlist:${String(entry._id)}:cancelled`,
      session,
    });
    await audit({
      tenantId,
      sessionId,
      entryId,
      actor,
      action: WAITLIST_ADMIN_ACTION.CANCELLED,
      before: { state: beforeState },
      after: { state: WAITLIST_STATE.CANCELLED },
      session,
    });
    return waitlistEntryDto(entry);
  });

  await promoteWaitlistEntry({
    tenantId,
    sessionId,
    automatic: true,
    now,
  }).catch(() => null);
  return result;
};

/**
 * A customer who obtains the same Class through normal checkout must not keep
 * a second live FIFO identity. A different PAYMENT_PENDING attempt remains
 * capacity-reserved until Stripe terminates it, but is terminalized so any
 * later paid webhook is refunded rather than fulfilled twice.
 */
export const reconcileWaitlistAfterDirectCourseBooking = async ({
  tenantId,
  sessionId,
  orderId,
  customerId,
  email,
  now = new Date(),
  mongoSession = null,
}: {
  tenantId: string;
  sessionId: string;
  orderId: string;
  customerId?: string;
  email?: string;
  now?: Date;
  mongoSession?: ClientSession | null;
}) =>
  withTransaction(async (session) => {
    const identityKey = email
      ? hashWaitlistEmail(normalizeWaitlistEmail(email))
      : "";
    const entry = await WaitlistEntryModel.findOne({
      tenant: objectId(tenantId),
      courseSession: objectId(sessionId),
      isLive: true,
      "checkout.orderId": { $ne: objectId(orderId) },
      $or: [
        ...(customerId && mongoose.isValidObjectId(customerId)
          ? [{ customer: objectId(customerId) }]
          : []),
        ...(identityKey ? [{ identityKey }] : []),
      ],
    })
      .select("+offerTokenHash +managementTokenHash")
      .session(session)
      .exec();
    if (!entry) return false;

    const confirmedFromDirectBooking =
      entry.state !== WAITLIST_STATE.PAYMENT_PENDING;
    if (confirmedFromDirectBooking) {
      await Booking.updateOne(
        { _id: entry.courseSession, tenant: objectId(tenantId) },
        { $pull: { waitlistCapacityHolds: { entry: entry._id } } },
        { session },
      ).exec();
      entry.state = WAITLIST_STATE.CONFIRMED;
      entry.confirmedAt = now;
    } else {
      entry.state = WAITLIST_STATE.CANCELLED;
    }
    entry.isLive = false;
    entry.terminalAt = now;
    entry.terminalReason =
      "Customer booked this Class through the normal checkout flow.";
    entry.offerTokenHash = "";
    await entry.save({ session });
    if (confirmedFromDirectBooking) {
      await publishWaitlistCustomerNotificationForEntry({
        tenantId,
        entry,
        type: WAITLIST_EMAIL_TYPE.CONFIRMED,
        deduplicationKey: `waitlist:${String(entry._id)}:confirmed`,
        session,
        occurredAt: now,
      });
    }
    return true;
  }, mongoSession);

export const waitlistServiceInternals = {
  loadSessionProduct,
  assertJoinAllowed,
  appendOfferHold,
  releaseEntryCapacity,
  enqueueEmail,
};
