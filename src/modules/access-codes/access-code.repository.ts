import { Types, type ClientSession } from "mongoose";
import Location from "@/modules/location/location.model.js";
import { conflict } from "@/shared/http/httpErrors.js";

import {
  ACCESS_CODE_NOTIFICATION_CHANNEL,
  ACCESS_CODE_NOTIFICATION_STATUS,
  ACCESS_CODE_RETRY_DELAY_MINUTES,
} from "./access-code.constants.js";
import {
  AccessCode as AccessCodeModel,
  AccessCodeNotification as AccessCodeNotificationModel,
} from "./access-code.model.js";
import { buildAccessCodeListQuery } from "./access-code.queries.js";

import type {
  AccessCodeDocument,
  AccessCodeLean,
  AccessCodeNotificationLean,
  ReservedAccessCode,
} from "./access-code.types.js";

import type { ListAccessCodesDto } from "./access-code.validators.js";

import { toObjectId } from "./access-code.utils.js";
import {
  activeDeliveryPools,
  reusableDeliveryFilter,
} from "./access-code-delivery-policy.js";

type IdLike = string | Types.ObjectId;

/**
 * Compatibility-only shapes for the dormant delivery reservation code below.
 * Public inventory DTOs deliberately use `code`, `poolId`, and immutable
 * location scope, so they must not be coupled to these legacy CRUD helpers.
 */
type LegacyCreateAccessCodeInput = {
  locationId: string;
} & Record<string, unknown>;

type LegacyUpdateAccessCodeInput = {
  id: string;
  locationId?: string;
} & Record<string, unknown>;

type AccessCodeRepositoryOptions = {
  tenantId: IdLike;
  session?: ClientSession | null;
};

const toIdString = (value: IdLike): string => String(value);

export const createAccessCodeRepository = ({
  tenantId,
  session = null,
}: AccessCodeRepositoryOptions) => {
  if (!tenantId) throw new Error("AccessCodeRepository requires tenantId");

  const tenantIdString = toIdString(tenantId);
  const tenantObjectId = toObjectId(tenantIdString);

  return {
    list(
      filters: ListAccessCodesDto,
      allowedLocationIds: readonly string[] | null = null,
    ): Promise<AccessCodeDocument[]> {
      const page = Math.max(filters.page, 1);
      const limit = Math.min(Math.max(filters.limit, 1), 100);
      const skip = (page - 1) * limit;

      return AccessCodeModel.find(
        buildAccessCodeListQuery(
          tenantIdString,
          filters,
          allowedLocationIds,
        ) as any,
      )
        .sort({ location: 1, usedCount: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .session(session)
        .exec() as unknown as Promise<AccessCodeDocument[]>;
    },

    count(
      filters: ListAccessCodesDto,
      allowedLocationIds: readonly string[] | null = null,
    ): Promise<number> {
      return AccessCodeModel.countDocuments(
        buildAccessCodeListQuery(
          tenantIdString,
          filters,
          allowedLocationIds,
        ) as any,
      )
        .session(session)
        .exec();
    },

    findById(accessCodeId: IdLike): Promise<AccessCodeDocument | null> {
      return AccessCodeModel.findOne({
        _id: toObjectId(toIdString(accessCodeId)),
        tenant: tenantObjectId,
      })
        .session(session)
        .exec();
    },

    async create(
      input: LegacyCreateAccessCodeInput,
    ): Promise<AccessCodeDocument> {
      const { locationId, ...payload } = input;
      const accessCode = await AccessCodeModel.create({
        ...payload,
        location: toObjectId(locationId),
        tenant: tenantObjectId,
      });

      return accessCode as AccessCodeDocument;
    },

    update(
      input: LegacyUpdateAccessCodeInput,
    ): Promise<AccessCodeDocument | null> {
      const { id, locationId, ...patch } = input;

      const update = {
        ...patch,
        ...(locationId ? { location: toObjectId(locationId) } : {}),
      };

      return AccessCodeModel.findOneAndUpdate(
        {
          _id: toObjectId(id),
          tenant: tenantObjectId,
        },
        { $set: update },
        {
          returnDocument: "after",
          runValidators: true,
          ...(session ? { session } : {}),
        },
      ).exec();
    },

    delete(accessCodeId: IdLike): Promise<AccessCodeDocument | null> {
      return AccessCodeModel.findOneAndDelete(
        {
          _id: toObjectId(toIdString(accessCodeId)),
          tenant: tenantObjectId,
        },
        session ? { session } : undefined,
      ).exec();
    },

    async reserveForLocation(
      locationId: IdLike,
      now = new Date(),
      validThrough = now,
    ): Promise<ReservedAccessCode | null> {
      const expiresAfter =
        validThrough.getTime() > now.getTime() ? validThrough : now;
      const pools = await activeDeliveryPools(
        tenantIdString,
        String(locationId),
      );
      const reusableCode = await AccessCodeModel.findOne({
        tenant: tenantObjectId,
        location: toObjectId(toIdString(locationId)),
        pool: { $in: pools },
        ...reusableDeliveryFilter(now, expiresAfter),
      })
        .select("+entryCode")
        .sort({ canBeRepeated: -1, usedCount: 1, createdAt: 1 })
        .lean<AccessCodeLean>()
        .session(session)
        .exec();

      if (!reusableCode) return null;

      return {
        accessCode: reusableCode,
        reservedExclusiveCode: false,
      };
    },

    rollbackExclusiveReservation(accessCodeId: Types.ObjectId): Promise<void> {
      return AccessCodeModel.updateOne(
        { _id: accessCodeId, canBeRepeated: false },
        { $set: { isUsed: false }, $inc: { usedCount: -1 } },
        session ? { session } : undefined,
      )
        .exec()
        .then(() => undefined);
    },

    incrementReusableUsage(accessCodeId: Types.ObjectId): Promise<void> {
      return AccessCodeModel.updateOne(
        { _id: accessCodeId, canBeRepeated: true },
        { $inc: { usedCount: 1 } },
        session ? { session } : undefined,
      )
        .exec()
        .then(() => undefined);
    },
  };
};

export type AccessCodeRepository = ReturnType<
  typeof createAccessCodeRepository
>;

export const createAccessCodeNotificationRepository = ({
  tenantId,
  session = null,
}: AccessCodeRepositoryOptions) => {
  if (!tenantId) {
    throw new Error("AccessCodeNotificationRepository requires tenantId");
  }

  const tenantObjectId = toObjectId(toIdString(tenantId));

  return {
    findByBooking(
      bookingId: IdLike,
    ): Promise<AccessCodeNotificationLean | null> {
      return AccessCodeNotificationModel.findOne({
        tenant: tenantObjectId,
        booking: bookingId,
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
      })
        .lean<AccessCodeNotificationLean>()
        .session(session)
        .exec();
    },

    async claimProcessing(params: {
      bookingId: Types.ObjectId;
      userId: Types.ObjectId;
      accessCodeId: Types.ObjectId;
      bookingStart: Date;
      claimToken: string;
      leaseExpiresAt: Date;
    }): Promise<boolean> {
      try {
        await AccessCodeNotificationModel.create(
          [
            {
              tenant: tenantObjectId,
              booking: params.bookingId,
              user: params.userId,
              accessCode: params.accessCodeId,
              bookingStart: params.bookingStart,
              claimToken: params.claimToken,
              leaseExpiresAt: params.leaseExpiresAt,
              channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
              status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
              attempt: 1,
            },
          ],
          session ? { session } : undefined,
        );

        return true;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === 11000
        ) {
          return false;
        }

        throw error;
      }
    },

    async reclaimRetryable(params: {
      notificationId: Types.ObjectId;
      userId: Types.ObjectId;
      accessCodeId: Types.ObjectId;
      bookingStart: Date;
      claimToken: string;
      leaseExpiresAt: Date;
      leaseExpiredBefore: Date;
    }): Promise<boolean> {
      const result = await AccessCodeNotificationModel.updateOne(
        {
          _id: params.notificationId,
          tenant: tenantObjectId,
          // A worker may have inserted an old-start row just after a reschedule
          // transaction saw no row. An unsubmitted retry can bind to the current
          // occurrence; the booking claim and beforeSend recheck its exact dates.
          providerAttemptStartedAt: null,
          $and: [
            {
              $or: [
                { status: ACCESS_CODE_NOTIFICATION_STATUS.PENDING },
                {
                  status: ACCESS_CODE_NOTIFICATION_STATUS.FAILED,
                  $or: [
                    { nextAttemptAt: { $lte: params.leaseExpiredBefore } },
                    { nextAttemptAt: null },
                    { nextAttemptAt: { $exists: false } },
                  ],
                },
                {
                  status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
                  providerAttemptStartedAt: null,
                  $or: [
                    { leaseExpiresAt: { $lte: params.leaseExpiredBefore } },
                    { leaseExpiresAt: null },
                    { leaseExpiresAt: { $exists: false } },
                  ],
                },
              ],
            },
          ],
        },
        {
          $set: {
            status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
            bookingStart: params.bookingStart,
            claimToken: params.claimToken,
            leaseExpiresAt: params.leaseExpiresAt,
            nextAttemptAt: null,
            failedAt: null,
            errorMessage: "",
            provider: "",
            providerMessageId: "",
            recipientEmail: "",
            providerDeliveryStatus: "",
            providerStatusAt: null,
            providerEventKey: "",
            user: params.userId,
            accessCode: params.accessCodeId,
          },
          $inc: { attempt: 1 },
        },
        session ? { session } : undefined,
      ).exec();

      return result.modifiedCount > 0;
    },

    async rearmForReschedule(params: {
      bookingId: IdLike;
      bookingStart: Date;
      transitionId?: string;
    }): Promise<void> {
      const scope = {
        tenant: tenantObjectId,
        booking: params.bookingId,
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
      };
      const previous = await AccessCodeNotificationModel.findOne(scope)
        .session(session)
        .lean()
        .exec();
      if (
        !previous ||
        (previous.status === ACCESS_CODE_NOTIFICATION_STATUS.CANCELLED &&
          !params.transitionId)
      )
        return;
      if (
        previous.status === ACCESS_CODE_NOTIFICATION_STATUS.SENT &&
        !params.transitionId
      ) {
        conflict({
          code: "BOOKING_EDIT_ACCESS_DETAILS_ISSUED",
          message: "Issued access requires an explicit staff reschedule.",
        });
      }
      const now = new Date();
      if (
        previous.status === ACCESS_CODE_NOTIFICATION_STATUS.DELIVERY_UNKNOWN ||
        (previous.status === ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING &&
          (previous.providerAttemptStartedAt ||
            (previous.leaseExpiresAt && previous.leaseExpiresAt > now)))
      ) {
        conflict({
          code: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS",
          message: "Access delivery is in progress or its outcome is unknown.",
        });
      }
      const history =
        previous.status === ACCESS_CODE_NOTIFICATION_STATUS.SENT ||
        previous.status === ACCESS_CODE_NOTIFICATION_STATUS.CANCELLED
          ? {
              transitionId: params.transitionId || "",
              archivedAt: now,
              bookingStart: previous.bookingStart || null,
              accessCode: previous.accessCode,
              status: previous.status,
              attempt: previous.attempt,
              claimToken: previous.claimToken || "",
              provider: previous.provider || "",
              providerAttemptStartedAt:
                previous.providerAttemptStartedAt || null,
              recipientEmail: previous.recipientEmail || "",
              providerMessageId: previous.providerMessageId || "",
              providerDeliveryStatus: previous.providerDeliveryStatus || "",
              providerStatusAt: previous.providerStatusAt || null,
              providerEventKey: previous.providerEventKey || "",
              sentAt: previous.sentAt || null,
            }
          : null;
      const result = await AccessCodeNotificationModel.updateOne(
        {
          ...scope,
          _id: previous._id,
          status: previous.status,
          claimToken: previous.claimToken ?? null,
          providerAttemptStartedAt: previous.providerAttemptStartedAt ?? null,
          updatedAt: previous.updatedAt ?? null,
        },
        {
          ...(history ? { $push: { deliveryHistory: history } } : {}),
          $set: {
            status: ACCESS_CODE_NOTIFICATION_STATUS.PENDING,
            bookingStart: params.bookingStart,
            sentAt: null,
            failedAt: null,
            errorMessage: "",
            provider: "",
            providerMessageId: "",
            recipientEmail: "",
            providerDeliveryStatus: "",
            providerStatusAt: null,
            providerEventKey: "",
            providerAttemptStartedAt: null,
            claimToken: "",
            leaseExpiresAt: null,
            nextAttemptAt: null,
          },
        },
        session ? { session } : undefined,
      ).exec();
      if (result.matchedCount !== 1) {
        conflict({
          code: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS",
          message:
            "Access delivery changed while the booking was being updated.",
        });
      }
    },

    async markCancelled(bookingId: IdLike): Promise<void> {
      await AccessCodeNotificationModel.updateOne(
        {
          tenant: tenantObjectId,
          booking: bookingId,
          channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
        },
        {
          $set: {
            status: ACCESS_CODE_NOTIFICATION_STATUS.CANCELLED,
            claimToken: "",
            leaseExpiresAt: null,
            nextAttemptAt: null,
            failedAt: null,
            errorMessage: "",
          },
        },
        session ? { session } : undefined,
      ).exec();
    },

    async hasDeliveredForBooking(bookingId: IdLike): Promise<boolean> {
      const exists = await AccessCodeNotificationModel.exists({
        tenant: tenantObjectId,
        booking: bookingId,
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
        status: ACCESS_CODE_NOTIFICATION_STATUS.SENT,
      })
        .session(session)
        .exec();

      return Boolean(exists);
    },

    async hasModificationLockForBooking(
      bookingId: IdLike,
      now = new Date(),
    ): Promise<boolean> {
      const exists = await AccessCodeNotificationModel.exists({
        tenant: tenantObjectId,
        booking: bookingId,
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
        $or: [
          { status: ACCESS_CODE_NOTIFICATION_STATUS.SENT },
          { "deliveryHistory.status": ACCESS_CODE_NOTIFICATION_STATUS.SENT },
          { status: ACCESS_CODE_NOTIFICATION_STATUS.DELIVERY_UNKNOWN },
          {
            status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
            providerAttemptStartedAt: { $ne: null },
          },
          {
            status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
            leaseExpiresAt: { $gt: now },
          },
        ],
      })
        .session(session)
        .exec();

      return Boolean(exists);
    },

    async hasInFlightDeliveryForBooking(
      bookingId: IdLike,
      now = new Date(),
    ): Promise<boolean> {
      const exists = await AccessCodeNotificationModel.exists({
        tenant: tenantObjectId,
        booking: bookingId,
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
        $or: [
          { status: ACCESS_CODE_NOTIFICATION_STATUS.DELIVERY_UNKNOWN },
          {
            status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
            providerAttemptStartedAt: { $ne: null },
          },
          {
            status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
            leaseExpiresAt: { $gt: now },
          },
        ],
      })
        .session(session)
        .exec();
      return Boolean(exists);
    },

    async findDeliveredBookingIds(
      bookingIds: readonly IdLike[],
    ): Promise<string[]> {
      const validBookingIds = [
        ...new Set(
          bookingIds
            .map((bookingId) => String(bookingId).trim())
            .filter((bookingId) => Types.ObjectId.isValid(bookingId)),
        ),
      ];

      if (!validBookingIds.length) return [];

      const ids = await AccessCodeNotificationModel.distinct("booking", {
        tenant: tenantObjectId,
        booking: {
          $in: validBookingIds.map((bookingId) => toObjectId(bookingId)),
        },
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
        status: ACCESS_CODE_NOTIFICATION_STATUS.SENT,
      })
        .session(session)
        .exec();

      return ids.map(String);
    },

    async findModificationLockedBookingIds(
      bookingIds: readonly IdLike[],
      now = new Date(),
    ): Promise<string[]> {
      const validBookingIds = [
        ...new Set(
          bookingIds
            .map((bookingId) => String(bookingId).trim())
            .filter((bookingId) => Types.ObjectId.isValid(bookingId)),
        ),
      ];

      if (!validBookingIds.length) return [];

      const ids = await AccessCodeNotificationModel.distinct("booking", {
        tenant: tenantObjectId,
        booking: {
          $in: validBookingIds.map((bookingId) => toObjectId(bookingId)),
        },
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
        $or: [
          { status: ACCESS_CODE_NOTIFICATION_STATUS.SENT },
          { "deliveryHistory.status": ACCESS_CODE_NOTIFICATION_STATUS.SENT },
          { status: ACCESS_CODE_NOTIFICATION_STATUS.DELIVERY_UNKNOWN },
          {
            status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
            providerAttemptStartedAt: { $ne: null },
          },
          {
            status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
            leaseExpiresAt: { $gt: now },
          },
        ],
      })
        .session(session)
        .exec();

      return ids.map(String);
    },

    async markSent(params: {
      bookingId: Types.ObjectId;
      accessCodeId: Types.ObjectId;
      userId: Types.ObjectId;
      bookingStart: Date;
      claimToken: string;
      provider?: string;
      providerMessageId?: string;
    }): Promise<boolean> {
      const result = await AccessCodeNotificationModel.updateOne(
        {
          tenant: tenantObjectId,
          booking: params.bookingId,
          channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
          status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
          bookingStart: params.bookingStart,
          claimToken: params.claimToken,
        },
        {
          $set: {
            status: ACCESS_CODE_NOTIFICATION_STATUS.SENT,
            bookingStart: params.bookingStart,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            sentAt: new Date(),
            failedAt: null,
            errorMessage: "",
            accessCode: params.accessCodeId,
            user: params.userId,
            provider: params.provider || "smtp",
            providerMessageId: params.providerMessageId || "",
          },
        },
        session ? { session } : undefined,
      ).exec();

      return result.modifiedCount > 0;
    },

    async recoverDelivered(params: {
      bookingId: Types.ObjectId;
      accessCodeId: Types.ObjectId;
      userId: Types.ObjectId;
      bookingStart: Date;
      claimToken: string;
      provider?: string;
      providerMessageId?: string;
    }): Promise<boolean> {
      const result = await AccessCodeNotificationModel.updateOne(
        {
          tenant: tenantObjectId,
          booking: params.bookingId,
          channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
          bookingStart: params.bookingStart,
          status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
          claimToken: params.claimToken,
        },
        {
          $set: {
            status: ACCESS_CODE_NOTIFICATION_STATUS.SENT,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            sentAt: new Date(),
            failedAt: null,
            errorMessage: "",
            accessCode: params.accessCodeId,
            user: params.userId,
            provider: params.provider || "smtp",
            providerMessageId: params.providerMessageId || "",
          },
        },
        session ? { session } : undefined,
      ).exec();

      return result.matchedCount > 0;
    },

    async markFailed(params: {
      bookingId: Types.ObjectId;
      bookingStart: Date;
      claimToken: string;
      errorMessage: string;
    }): Promise<void> {
      await AccessCodeNotificationModel.updateOne(
        {
          tenant: tenantObjectId,
          booking: params.bookingId,
          channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
          status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
          bookingStart: params.bookingStart,
          claimToken: params.claimToken,
        },
        {
          $set: {
            status: ACCESS_CODE_NOTIFICATION_STATUS.FAILED,
            providerAttemptStartedAt: null,
            leaseExpiresAt: null,
            nextAttemptAt: new Date(
              Date.now() + ACCESS_CODE_RETRY_DELAY_MINUTES * 60 * 1000,
            ),
            failedAt: new Date(),
            errorMessage: params.errorMessage,
          },
        },
        session ? { session } : undefined,
      ).exec();
    },

    async markDeliveryUnknown(params: {
      bookingId: Types.ObjectId;
      bookingStart: Date;
      claimToken: string;
      errorMessage: string;
    }): Promise<void> {
      await AccessCodeNotificationModel.updateOne(
        {
          tenant: tenantObjectId,
          booking: params.bookingId,
          channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
          status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
          bookingStart: params.bookingStart,
          claimToken: params.claimToken,
        },
        {
          $set: {
            status: ACCESS_CODE_NOTIFICATION_STATUS.DELIVERY_UNKNOWN,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            failedAt: new Date(),
            errorMessage: params.errorMessage,
          },
        },
        session ? { session } : undefined,
      ).exec();
    },

    async isClaimActive(params: {
      bookingId: Types.ObjectId;
      bookingStart: Date;
      claimToken: string;
      now: Date;
    }): Promise<boolean> {
      const exists = await AccessCodeNotificationModel.exists({
        tenant: tenantObjectId,
        booking: params.bookingId,
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
        status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
        bookingStart: params.bookingStart,
        claimToken: params.claimToken,
        leaseExpiresAt: { $gt: params.now },
      });

      return Boolean(exists);
    },
  };
};

export type AccessCodeNotificationRepository = ReturnType<
  typeof createAccessCodeNotificationRepository
>;

export const accessCodeRepository = {
  list: (
    tenantId: string,
    filters: ListAccessCodesDto,
    allowedLocationIds: readonly string[] | null = null,
  ) =>
    createAccessCodeRepository({ tenantId }).list(filters, allowedLocationIds),
  count: (
    tenantId: string,
    filters: ListAccessCodesDto,
    allowedLocationIds: readonly string[] | null = null,
  ) =>
    createAccessCodeRepository({ tenantId }).count(filters, allowedLocationIds),
  findById: (tenantId: string, accessCodeId: string) =>
    createAccessCodeRepository({ tenantId }).findById(accessCodeId),
  create: (tenantId: string, input: LegacyCreateAccessCodeInput) =>
    createAccessCodeRepository({ tenantId }).create(input),
  update: (tenantId: string, input: LegacyUpdateAccessCodeInput) =>
    createAccessCodeRepository({ tenantId }).update(input),
  delete: (tenantId: string, accessCodeId: string) =>
    createAccessCodeRepository({ tenantId }).delete(accessCodeId),
  reserveForLocation: (
    tenantId: string,
    locationId: IdLike,
    now = new Date(),
    validThrough = now,
  ) =>
    createAccessCodeRepository({ tenantId }).reserveForLocation(
      locationId,
      now,
      validThrough,
    ),
  rollbackExclusiveReservation: (accessCodeId: Types.ObjectId) =>
    AccessCodeModel.updateOne(
      { _id: accessCodeId, canBeRepeated: false },
      { $set: { isUsed: false }, $inc: { usedCount: -1 } },
    )
      .exec()
      .then(() => undefined),
  findReservationForRetry: async (
    tenantId: string,
    accessCodeId: IdLike,
    locationId: IdLike,
    validThrough: Date,
  ): Promise<AccessCodeLean | null> => {
    const pools = await activeDeliveryPools(tenantId, String(locationId));
    return AccessCodeModel.findOne({
      _id: toObjectId(String(accessCodeId)),
      tenant: toObjectId(tenantId),
      location: toObjectId(String(locationId)),
      pool: { $in: pools },
      ...reusableDeliveryFilter(new Date(), validThrough),
    })
      .select("+entryCode")
      .lean<AccessCodeLean>()
      .exec();
  },
  incrementReusableUsage: (accessCodeId: Types.ObjectId) =>
    AccessCodeModel.updateOne(
      { _id: accessCodeId, canBeRepeated: true },
      { $inc: { usedCount: 1 } },
    )
      .exec()
      .then(() => undefined),
  findUsableLocationValidity: async (
    tenantId: string,
    locationIds: readonly string[],
    now = new Date(),
  ): Promise<Map<string, Date>> => {
    const validLocationIds = [
      ...new Set(
        locationIds
          .map((locationId) => String(locationId).trim())
          .filter((locationId) => Types.ObjectId.isValid(locationId)),
      ),
    ];

    if (!validLocationIds.length) return new Map();

    const enabledLocations = await Location.find({
      _id: { $in: validLocationIds },
      tenant: toObjectId(tenantId),
      isActive: true,
      "access.automaticEmailEnabled": true,
    })
      .distinct("_id")
      .exec();
    const pools = await activeDeliveryPools(tenantId);
    const rows = await AccessCodeModel.find({
      tenant: toObjectId(tenantId),
      location: {
        $in: enabledLocations,
      },
      pool: { $in: pools },
      ...reusableDeliveryFilter(now, now),
    })
      .select("location expiresAt validUntil")
      .lean()
      .exec();
    const validity = new Map<string, Date>();

    for (const row of rows) {
      const locationId = String(row.location);
      const expiry = new Date(
        row.validUntil || row.expiresAt || 8_640_000_000_000_000,
      );
      const current = validity.get(locationId);

      if (
        !Number.isNaN(expiry.getTime()) &&
        (!current || expiry.getTime() > current.getTime())
      ) {
        validity.set(locationId, expiry);
      }
    }

    return validity;
  },
};

export const accessCodeNotificationRepository = {
  findByBooking: (tenantId: string, bookingId: string | Types.ObjectId) =>
    createAccessCodeNotificationRepository({ tenantId }).findByBooking(
      bookingId,
    ),
  claimProcessing: (params: {
    tenantId: string;
    bookingId: Types.ObjectId;
    userId: Types.ObjectId;
    accessCodeId: Types.ObjectId;
    bookingStart: Date;
    claimToken: string;
    leaseExpiresAt: Date;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).claimProcessing(params),
  reclaimRetryable: (params: {
    tenantId: string;
    notificationId: Types.ObjectId;
    userId: Types.ObjectId;
    accessCodeId: Types.ObjectId;
    bookingStart: Date;
    claimToken: string;
    leaseExpiresAt: Date;
    leaseExpiredBefore: Date;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).reclaimRetryable(params),
  rearmForReschedule: (params: {
    tenantId: string;
    bookingId: IdLike;
    bookingStart: Date;
    transitionId?: string;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).rearmForReschedule(params),
  markCancelled: (params: { tenantId: string; bookingId: IdLike }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).markCancelled(params.bookingId),
  hasDeliveredForBooking: (params: { tenantId: string; bookingId: IdLike }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).hasDeliveredForBooking(params.bookingId),
  hasModificationLockForBooking: (params: {
    tenantId: string;
    bookingId: IdLike;
    now?: Date;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).hasModificationLockForBooking(params.bookingId, params.now),
  hasInFlightDeliveryForBooking: (params: {
    tenantId: string;
    bookingId: IdLike;
    now?: Date;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).hasInFlightDeliveryForBooking(params.bookingId, params.now),
  findDeliveredBookingIds: (params: {
    tenantId: string;
    bookingIds: readonly IdLike[];
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).findDeliveredBookingIds(params.bookingIds),
  findModificationLockedBookingIds: (params: {
    tenantId: string;
    bookingIds: readonly IdLike[];
    now?: Date;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).findModificationLockedBookingIds(params.bookingIds, params.now),
  markSent: (params: {
    tenantId: string;
    bookingId: Types.ObjectId;
    accessCodeId: Types.ObjectId;
    userId: Types.ObjectId;
    bookingStart: Date;
    claimToken: string;
    provider?: string;
    providerMessageId?: string;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).markSent(params),
  recoverDelivered: (params: {
    tenantId: string;
    bookingId: Types.ObjectId;
    accessCodeId: Types.ObjectId;
    userId: Types.ObjectId;
    bookingStart: Date;
    claimToken: string;
    provider?: string;
    providerMessageId?: string;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).recoverDelivered(params),
  markFailed: (params: {
    tenantId: string;
    bookingId: Types.ObjectId;
    bookingStart: Date;
    claimToken: string;
    errorMessage: string;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).markFailed(params),
  markDeliveryUnknown: (params: {
    tenantId: string;
    bookingId: Types.ObjectId;
    bookingStart: Date;
    claimToken: string;
    errorMessage: string;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).markDeliveryUnknown(params),
  isClaimActive: (params: {
    tenantId: string;
    bookingId: Types.ObjectId;
    bookingStart: Date;
    claimToken: string;
    now: Date;
  }) =>
    createAccessCodeNotificationRepository({
      tenantId: params.tenantId,
    }).isClaimActive(params),
};
