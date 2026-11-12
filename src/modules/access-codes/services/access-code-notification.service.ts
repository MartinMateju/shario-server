import { randomUUID } from "node:crypto";

import { Types } from "mongoose";

import { logger } from "@/config/logger.js";
import Booking from "@/modules/booking/booking.model.js";
import { formatLocationAddress } from "@/modules/location/location.utils.js";
import User from "@/modules/user/user.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import Location from "@/modules/location/location.model.js";
import { getTenantModuleEntitlements } from "@/modules/tenants/tenant-workspace-modules.js";
import Subscription from "@/modules/tenant-subscription/tenant-subscription.schema.js";
import { getSubscriptionAccess } from "@/modules/tenant-subscription/tenant-subscription.access.js";
import { tenantHasModule } from "@/shared/middleware/tenantFeatures.js";
import { decryptAccessCode } from "../access-code.crypto.js";
import {
  CommunicationConsentModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import { isCommunicationAllowed } from "@/modules/communications/services/consent.service.js";

import {
  ACCESS_CODE_BATCH_LIMIT,
  ACCESS_CODE_CANDIDATE_SCAN_LIMIT,
  ACCESS_CODE_MAX_LOOKAHEAD_MINUTES,
  ACCESS_CODE_NOTIFICATION_CHANNEL,
  ACCESS_CODE_NOTIFICATION_STATUS,
  ACCESS_CODE_PROCESSING_LEASE_MINUTES,
  DEFAULT_ACCESS_CODE_SEND_MINUTES_BEFORE,
} from "../access-code.constants.js";
import { AccessCodeNotification } from "../access-code.model.js";
import {
  accessCodeNotificationRepository,
  accessCodeRepository,
} from "../access-code.repository.js";
import type {
  AccessCodeNotificationResult,
  ReservedAccessCode,
} from "../access-code.types.js";
import { truncateAccessCodeError } from "../access-code.utils.js";
import { sendAccessCodeEmail } from "./access-code-email.service.js";
import { accessNotificationOccurrenceFilter } from "../access-code-delivery-policy.js";

type PopulatedLocation = {
  _id: Types.ObjectId;
  name: string;
  tenant: Types.ObjectId;
  access?: { automaticEmailEnabled?: boolean };
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    postalCode?: string;
    country?: string;
  };
  booking?: {
    timezone?: string;
    doorCodeMinutesBefore?: number;
  };
};

type BookingWithTenant = {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  createdBy: Types.ObjectId;
  location: PopulatedLocation | null;
  start: Date;
  end: Date;
  status: string;
  paymentStatus?: string;
};

type BookingUserLean = {
  _id: Types.ObjectId;
  email?: string;
  phone?: string;
};

export const isAccessCodeNotificationDue = ({
  bookingStart,
  minutesBefore,
  now = new Date(),
}: {
  bookingStart: Date;
  minutesBefore?: number;
  now?: Date;
}): boolean => {
  const start = new Date(bookingStart).getTime();
  const normalizedLead = Number.isFinite(Number(minutesBefore))
    ? Math.max(
        0,
        Math.min(
          ACCESS_CODE_MAX_LOOKAHEAD_MINUTES,
          Math.floor(Number(minutesBefore)),
        ),
      )
    : DEFAULT_ACCESS_CODE_SEND_MINUTES_BEFORE;
  const notificationAt = start - normalizedLead * 60 * 1000;

  return (
    Number.isFinite(start) &&
    start >= now.getTime() &&
    notificationAt <= now.getTime()
  );
};

export const isAccessCodeNotificationActionable = (
  notification: {
    status?: string;
    leaseExpiresAt?: Date | string | null;
    nextAttemptAt?: Date | string | null;
    providerAttemptStartedAt?: Date | string | null;
  } | null,
  now = new Date(),
): boolean => {
  if (!notification) return true;
  if (notification.providerAttemptStartedAt) return false;
  if (
    notification.status === ACCESS_CODE_NOTIFICATION_STATUS.SENT ||
    notification.status === ACCESS_CODE_NOTIFICATION_STATUS.DELIVERY_UNKNOWN ||
    notification.status === ACCESS_CODE_NOTIFICATION_STATUS.CANCELLED
  ) {
    return false;
  }
  if (notification.status === ACCESS_CODE_NOTIFICATION_STATUS.FAILED) {
    const nextAttemptAt = notification.nextAttemptAt
      ? new Date(notification.nextAttemptAt).getTime()
      : Number.NEGATIVE_INFINITY;
    return nextAttemptAt <= now.getTime();
  }
  if (notification.status !== ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING) {
    return true;
  }

  const leaseExpiresAt = notification.leaseExpiresAt
    ? new Date(notification.leaseExpiresAt).getTime()
    : Number.NEGATIVE_INFINITY;
  return leaseExpiresAt <= now.getTime();
};

export async function sendAccessCodeNotifications(): Promise<AccessCodeNotificationResult> {
  const result: AccessCodeNotificationResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };
  const now = new Date();
  const until = new Date(
    now.getTime() + ACCESS_CODE_MAX_LOOKAHEAD_MINUTES * 60 * 1000,
  );
  // A worker crash after submission must never turn an uncertain delivery into a retry.
  await AccessCodeNotification.updateMany(
    {
      status: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
      providerAttemptStartedAt: { $ne: null },
      leaseExpiresAt: { $lte: now },
    },
    {
      $set: {
        status: ACCESS_CODE_NOTIFICATION_STATUS.DELIVERY_UNKNOWN,
        leaseExpiresAt: null,
        errorMessage:
          "Provider submission was interrupted; verify delivery before retrying.",
      },
    },
  ).exec();
  const enabledLocations = await Location.find({
    isActive: true,
    "access.automaticEmailEnabled": true,
  })
    .distinct("_id")
    .exec();
  if (!enabledLocations.length) return result;
  const candidates = await Booking.find({
    location: { $in: enabledLocations },
    ...accessNotificationOccurrenceFilter(),
    tag: { $in: ["open-studio", "workshop"] },
    start: { $gte: now, $lte: until },
    status: { $ne: "cancelled" },
    paymentStatus: "CONFIRMED",
  })
    .populate({
      path: "location",
      select:
        "tenant name address booking.timezone booking.doorCodeMinutesBefore isActive access.automaticEmailEnabled",
      match: { isActive: true, "access.automaticEmailEnabled": true },
    })
    .sort({ start: 1 })
    .limit(ACCESS_CODE_CANDIDATE_SCAN_LIMIT)
    .lean<BookingWithTenant[]>()
    .exec();
  const dueBookings = candidates.filter(
    (booking) =>
      booking.location &&
      isAccessCodeNotificationDue({
        bookingStart: booking.start,
        minutesBefore: booking.location?.booking?.doorCodeMinutesBefore,
        now,
      }),
  );
  const notificationRows = dueBookings.length
    ? await AccessCodeNotification.find({
        booking: { $in: dueBookings.map((booking) => booking._id) },
        channel: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
      })
        .lean()
        .exec()
    : [];
  const notificationsByBookingId = new Map(
    notificationRows.map((notification) => [
      String(notification.booking),
      notification,
    ]),
  );
  const bookings = dueBookings.filter((booking) =>
    isAccessCodeNotificationActionable(
      notificationsByBookingId.get(String(booking._id)) || null,
      now,
    ),
  );

  if (!bookings.length) {
    logger.debug("No bookings require access codes.");
    return result;
  }

  for (const booking of bookings) {
    if (result.processed >= ACCESS_CODE_BATCH_LIMIT) break;

    const tenantId = booking.tenant?.toString();
    const location = booking.location;

    if (!tenantId || !location?._id || String(location.tenant) !== tenantId) {
      logger.warn(
        { bookingId: String(booking._id) },
        "Booking has no valid location.",
      );
      result.skipped += 1;
      continue;
    }

    let reservedCode: ReservedAccessCode | null = null;
    let reusedReservation = false;
    let emailDeliveryCommitted = false;
    let emailDeliveryAttempted = false;
    let providerMessageId: string | undefined;
    const claimToken = randomUUID();

    try {
      const [tenant, subscription] = await Promise.all([
        Tenant.findById(tenantId).exec(),
        Subscription.findOne({ tenant: tenantId }).exec(),
      ]);
      if (
        !tenant ||
        !subscription ||
        !tenantHasModule(tenant, "access_codes") ||
        !getTenantModuleEntitlements({
          plan: tenant.plan,
          planVersion: tenant.planVersion,
        }).access_codes ||
        !getSubscriptionAccess({ tenantStatus: tenant.status, subscription })
          .canUseFeatures
      ) {
        result.skipped += 1;
        continue;
      }
      const user = await User.findOne({
        _id: booking.createdBy,
        tenant: booking.tenant,
        isAccessGranted: { $ne: false },
      })
        .select("email phone")
        .lean<BookingUserLean>()
        .exec();

      if (!user?.email) {
        result.skipped += 1;
        continue;
      }
      const [suppression, consent] = await Promise.all([
        CommunicationSuppressionModel.exists({
          tenantId,
          channel: "email",
          identity: user.email.trim().toLowerCase(),
          active: true,
        }),
        CommunicationConsentModel.findOne({
          tenantId,
          customerId: user._id,
          channel: "email",
          purpose: "transactional",
        }).lean(),
      ]);
      if (
        !isCommunicationAllowed({
          channel: "email",
          purpose: "transactional",
          suppressed: Boolean(suppression),
          consent,
        }).allowed
      ) {
        result.skipped += 1;
        continue;
      }

      const existingNotification =
        notificationsByBookingId.get(String(booking._id)) || null;

      const previousReservation = existingNotification?.accessCode
        ? await accessCodeRepository.findReservationForRetry(
            tenantId,
            existingNotification.accessCode,
            location._id,
            new Date(booking.end),
          )
        : null;

      if (previousReservation) {
        reservedCode = {
          accessCode: previousReservation,
          reservedExclusiveCode: false,
        };
        reusedReservation = true;
      } else {
        reservedCode = await accessCodeRepository.reserveForLocation(
          tenantId,
          location._id,
          now,
          new Date(booking.end),
        );
      }

      if (!reservedCode) {
        logger.warn(
          {
            tenantId,
            bookingId: String(booking._id),
            locationId: String(location._id),
          },
          "No access code available for booking.",
        );
        result.failed += 1;
        continue;
      }

      const claimStartedAt = new Date();
      const leaseExpiresAt = new Date(
        claimStartedAt.getTime() +
          ACCESS_CODE_PROCESSING_LEASE_MINUTES * 60 * 1000,
      );
      result.processed += 1;
      const claimed = !existingNotification
        ? await accessCodeNotificationRepository.claimProcessing({
            tenantId,
            bookingId: booking._id,
            userId: user._id,
            accessCodeId: reservedCode.accessCode._id,
            bookingStart: new Date(booking.start),
            claimToken,
            leaseExpiresAt,
          })
        : await accessCodeNotificationRepository.reclaimRetryable({
            tenantId,
            notificationId: existingNotification._id,
            userId: user._id,
            accessCodeId: reservedCode.accessCode._id,
            bookingStart: new Date(booking.start),
            claimToken,
            leaseExpiresAt,
            leaseExpiredBefore: claimStartedAt,
          });

      if (!claimed) {
        if (reservedCode.reservedExclusiveCode) {
          await accessCodeRepository.rollbackExclusiveReservation(
            reservedCode.accessCode._id,
          );
        }
        result.skipped += 1;
        continue;
      }

      const bookingDeliveryClaim = await Booking.updateOne(
        {
          _id: booking._id,
          tenant: booking.tenant,
          start: booking.start,
          status: { $ne: "cancelled" },
          $and: [
            {
              paymentStatus: "CONFIRMED",
            },
            {
              $or: [
                { "accessCodeDelivery.status": { $exists: false } },
                {
                  "accessCodeDelivery.status": {
                    $in: ["idle", "cancelled"],
                  },
                },
                {
                  "accessCodeDelivery.status": "processing",
                  "accessCodeDelivery.leaseExpiresAt": {
                    $lte: claimStartedAt,
                  },
                },
              ],
            },
          ],
        },
        {
          $set: {
            "accessCodeDelivery.status": "processing",
            "accessCodeDelivery.claimToken": claimToken,
            "accessCodeDelivery.leaseExpiresAt": leaseExpiresAt,
            "accessCodeDelivery.deliveredAt": null,
          },
        },
      ).exec();

      if (bookingDeliveryClaim.modifiedCount !== 1) {
        if (reservedCode.reservedExclusiveCode) {
          await accessCodeRepository.rollbackExclusiveReservation(
            reservedCode.accessCode._id,
          );
        }
        await accessCodeNotificationRepository.markFailed({
          tenantId,
          bookingId: booking._id,
          bookingStart: new Date(booking.start),
          claimToken,
          errorMessage:
            "Booking changed before access-code delivery could start.",
        });
        result.skipped += 1;
        continue;
      }

      const claimIsActive =
        await accessCodeNotificationRepository.isClaimActive({
          tenantId,
          bookingId: booking._id,
          bookingStart: new Date(booking.start),
          claimToken,
          now: new Date(),
        });

      if (!claimIsActive) {
        if (reservedCode.reservedExclusiveCode) {
          await accessCodeRepository.rollbackExclusiveReservation(
            reservedCode.accessCode._id,
          );
        }
        await Booking.updateOne(
          {
            _id: booking._id,
            tenant: booking.tenant,
            start: booking.start,
            "accessCodeDelivery.status": "processing",
            "accessCodeDelivery.claimToken": claimToken,
          },
          {
            $set: {
              "accessCodeDelivery.status": "idle",
              "accessCodeDelivery.claimToken": "",
              "accessCodeDelivery.leaseExpiresAt": null,
            },
          },
        ).exec();
        result.skipped += 1;
        continue;
      }

      const bookingStillEligible = await Booking.exists({
        _id: booking._id,
        tenant: booking.tenant,
        start: booking.start,
        status: { $ne: "cancelled" },
        paymentStatus: "CONFIRMED",
        "accessCodeDelivery.status": "processing",
        "accessCodeDelivery.claimToken": claimToken,
        "accessCodeDelivery.leaseExpiresAt": { $gt: new Date() },
      });

      if (!bookingStillEligible) {
        if (reservedCode.reservedExclusiveCode) {
          await accessCodeRepository.rollbackExclusiveReservation(
            reservedCode.accessCode._id,
          );
        }
        await Booking.updateOne(
          {
            _id: booking._id,
            tenant: booking.tenant,
            start: booking.start,
            "accessCodeDelivery.status": "processing",
            "accessCodeDelivery.claimToken": claimToken,
          },
          {
            $set: {
              "accessCodeDelivery.status": "idle",
              "accessCodeDelivery.claimToken": "",
              "accessCodeDelivery.leaseExpiresAt": null,
            },
          },
        ).exec();
        await accessCodeNotificationRepository.markFailed({
          tenantId,
          bookingId: booking._id,
          bookingStart: new Date(booking.start),
          claimToken,
          errorMessage:
            "Booking changed before access-code delivery could be confirmed.",
        });
        result.skipped += 1;
        continue;
      }

      const entryCode = decryptAccessCode({
        tenantId,
        poolId: String(reservedCode.accessCode.pool),
        encryptedEntryCode: reservedCode.accessCode.entryCode,
      });
      const emailMeta = await sendAccessCodeEmail({
        to: user.email,
        tenantId,
        bookingId: String(booking._id),
        deliveryId: claimToken,
        studioName: location.name,
        studioAddress: formatLocationAddress(location),
        timezone: location.booking?.timezone || "UTC",
        entryCode,
        bookingStart: new Date(booking.start),
        bookingEnd: new Date(booking.end),
        beforeSend: async () => {
          const stillDue = isAccessCodeNotificationDue({
            bookingStart: booking.start,
            minutesBefore: location.booking?.doorCodeMinutesBefore,
          });
          const currentCode =
            await accessCodeRepository.findReservationForRetry(
              tenantId,
              reservedCode!.accessCode._id,
              location._id,
              new Date(booking.end),
            );
          if (
            !stillDue ||
            !currentCode ||
            currentCode.entryCode !== reservedCode!.accessCode.entryCode
          ) {
            throw new Error(
              "Booking window or access inventory changed before sending.",
            );
          }
          const [
            eligibleBooking,
            enabledLocation,
            currentUser,
            currentTenant,
            currentSubscription,
            currentSuppression,
            currentConsent,
          ] = await Promise.all([
            Booking.exists({
              _id: booking._id,
              tenant: booking.tenant,
              location: location._id,
              createdBy: user._id,
              start: booking.start,
              end: booking.end,
              status: { $ne: "cancelled" },
              paymentStatus: "CONFIRMED",
              ...accessNotificationOccurrenceFilter(),
              "accessCodeDelivery.status": "processing",
              "accessCodeDelivery.claimToken": claimToken,
              "accessCodeDelivery.leaseExpiresAt": { $gt: new Date() },
            }),
            Location.exists({
              _id: location._id,
              tenant: booking.tenant,
              isActive: true,
              "access.automaticEmailEnabled": true,
            }),
            User.exists({
              _id: user._id,
              tenant: booking.tenant,
              email: user.email,
              isAccessGranted: { $ne: false },
            }),
            Tenant.findById(tenantId).exec(),
            Subscription.findOne({ tenant: tenantId }).exec(),
            CommunicationSuppressionModel.exists({
              tenantId,
              channel: "email",
              identity: user.email!.trim().toLowerCase(),
              active: true,
            }),
            CommunicationConsentModel.findOne({
              tenantId,
              customerId: user._id,
              channel: "email",
              purpose: "transactional",
            }).lean(),
          ]);
          if (!eligibleBooking || !enabledLocation || !currentUser)
            throw new Error(
              "Booking access eligibility changed before sending.",
            );
          if (
            !currentTenant ||
            !currentSubscription ||
            !tenantHasModule(currentTenant, "access_codes") ||
            !getTenantModuleEntitlements({
              plan: currentTenant.plan,
              planVersion: currentTenant.planVersion,
            }).access_codes ||
            !getSubscriptionAccess({
              tenantStatus: currentTenant.status,
              subscription: currentSubscription,
            }).canUseFeatures ||
            !isCommunicationAllowed({
              channel: "email",
              purpose: "transactional",
              suppressed: Boolean(currentSuppression),
              consent: currentConsent,
            }).allowed
          ) {
            throw new Error(
              "Email or subscription eligibility changed before sending.",
            );
          }
          const claimed = await AccessCodeNotification.updateOne(
            {
              tenant: booking.tenant,
              booking: booking._id,
              bookingStart: booking.start,
              status: "processing",
              claimToken,
              leaseExpiresAt: { $gt: new Date() },
              providerAttemptStartedAt: null,
            },
            {
              $set: {
                providerAttemptStartedAt: new Date(),
                provider: "postmark",
                recipientEmail: user.email!.trim().toLowerCase(),
              },
            },
          ).exec();
          if (claimed.modifiedCount !== 1)
            throw new Error(
              "Access delivery claim lost before provider submission.",
            );
          emailDeliveryAttempted = true;
        },
      });
      emailDeliveryCommitted = true;
      providerMessageId = emailMeta.providerMessageId;
      result.sent += 1;

      const bookingMarkedDelivered = await Booking.updateOne(
        {
          _id: booking._id,
          tenant: booking.tenant,
          start: booking.start,
          status: { $ne: "cancelled" },
          "accessCodeDelivery.status": "processing",
          "accessCodeDelivery.claimToken": claimToken,
        },
        {
          $set: {
            "accessCodeDelivery.status": "sent",
            "accessCodeDelivery.leaseExpiresAt": null,
            "accessCodeDelivery.deliveredAt": new Date(),
          },
        },
      ).exec();

      if (bookingMarkedDelivered.modifiedCount !== 1) {
        throw new Error(
          "Access code was delivered after the booking delivery claim changed.",
        );
      }

      const deliveryRecord = {
        tenantId,
        bookingId: booking._id,
        userId: user._id,
        accessCodeId: reservedCode.accessCode._id,
        bookingStart: new Date(booking.start),
        claimToken,
        provider: emailMeta.provider,
        providerMessageId: emailMeta.providerMessageId,
      };
      const markedSent =
        await accessCodeNotificationRepository.markSent(deliveryRecord);

      if (
        !markedSent &&
        !(await accessCodeNotificationRepository.recoverDelivered(
          deliveryRecord,
        ))
      ) {
        throw new Error(
          "Access code delivery could not be finalized because the booking changed.",
        );
      }

      if (!reusedReservation && !reservedCode.reservedExclusiveCode) {
        try {
          await accessCodeRepository.incrementReusableUsage(
            reservedCode.accessCode._id,
          );
        } catch (usageError) {
          logger.warn(
            { err: usageError, bookingId: String(booking._id) },
            "Access code was delivered but reusable usage could not be recorded.",
          );
        }
      }
    } catch (error) {
      if (emailDeliveryCommitted) {
        if (reservedCode) {
          try {
            await accessCodeNotificationRepository.recoverDelivered({
              tenantId,
              bookingId: booking._id,
              userId: booking.createdBy,
              accessCodeId: reservedCode.accessCode._id,
              bookingStart: new Date(booking.start),
              claimToken,
              provider: "postmark",
              providerMessageId,
            });
          } catch (recoveryError) {
            logger.error(
              { err: recoveryError, bookingId: String(booking._id) },
              "Access code was accepted but its terminal delivery record could not be recovered. Provider submission is not retried automatically.",
            );
          }
        }
        logger.warn(
          { err: error, bookingId: String(booking._id) },
          "Access code email was committed; ignored a later delivery-side failure.",
        );
        continue;
      }

      result.failed += 1;
      logger.error(
        { err: error, bookingId: String(booking._id) },
        "Failed to send access code notification.",
      );

      if (
        emailDeliveryAttempted &&
        !["not_sent", "rejected"].includes(
          (error as { deliveryOutcome?: string })?.deliveryOutcome || "",
        )
      ) {
        await Booking.updateOne(
          {
            _id: booking._id,
            tenant: booking.tenant,
            start: booking.start,
            "accessCodeDelivery.status": "processing",
            "accessCodeDelivery.claimToken": claimToken,
          },
          {
            $set: {
              "accessCodeDelivery.status": "delivery_unknown",
              "accessCodeDelivery.claimToken": "",
              "accessCodeDelivery.leaseExpiresAt": null,
              "accessCodeDelivery.deliveredAt": null,
            },
          },
        ).exec();
        await accessCodeNotificationRepository.markDeliveryUnknown({
          tenantId,
          bookingId: booking._id,
          bookingStart: new Date(booking.start),
          claimToken,
          errorMessage: truncateAccessCodeError(error),
        });
        logger.error(
          { bookingId: String(booking._id), tenantId },
          "Access-code email delivery is ambiguous; booking modifications remain locked pending reconciliation.",
        );
        continue;
      }

      await Booking.updateOne(
        {
          _id: booking._id,
          tenant: booking.tenant,
          start: booking.start,
          "accessCodeDelivery.status": "processing",
          "accessCodeDelivery.claimToken": claimToken,
        },
        {
          $set: {
            "accessCodeDelivery.status": "idle",
            "accessCodeDelivery.claimToken": "",
            "accessCodeDelivery.leaseExpiresAt": null,
          },
        },
      ).exec();

      await accessCodeNotificationRepository.markFailed({
        tenantId,
        bookingId: booking._id,
        bookingStart: new Date(booking.start),
        claimToken,
        errorMessage: truncateAccessCodeError(error),
      });
    }
  }

  logger.info(result, "Access code notification run finished.");
  return result;
}
