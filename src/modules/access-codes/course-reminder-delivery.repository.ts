import {
  COURSE_REMINDER_DELIVERY_STATUS,
  type CourseReminderDeliveryStatus,
} from "./course-reminder-delivery.constants.js";
import CourseReminderDeliveryModel from "./course-reminder-delivery.model.js";
import type {
  CourseReminderDeliveryDocument,
  CreateCourseReminderDeliveryInput,
} from "./course-reminder-delivery.types.js";

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000,
  );

export const courseReminderDeliveryRepository = {
  async upsertPending(
    input: CreateCourseReminderDeliveryInput,
  ): Promise<CourseReminderDeliveryDocument> {
    try {
      const delivery = await CourseReminderDeliveryModel.findOneAndUpdate(
        {
          tenant: input.tenant,
          idempotencyKey: input.idempotencyKey,
        },
        {
          $setOnInsert: {
            ...input,
            status: COURSE_REMINDER_DELIVERY_STATUS.PENDING,
          },
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
        },
      ).exec();
      if (!delivery) {
        throw new Error("Course reminder delivery could not be materialized.");
      }
      return delivery;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const duplicate = await CourseReminderDeliveryModel.findOne({
        tenant: input.tenant,
        idempotencyKey: input.idempotencyKey,
      }).exec();
      if (!duplicate) throw error;
      return duplicate;
    }
  },

  async claimForSending({
    tenant,
    idempotencyKey,
    claimToken,
    now = new Date(),
    leaseUntil,
  }: {
    tenant: unknown;
    idempotencyKey: string;
    claimToken: string;
    now?: Date;
    leaseUntil: Date;
  }): Promise<CourseReminderDeliveryDocument | null> {
    return CourseReminderDeliveryModel.findOneAndUpdate(
      {
        tenant,
        idempotencyKey,
        $expr: { $lt: ["$attempts", "$maxAttempts"] },
        $or: [
          { status: COURSE_REMINDER_DELIVERY_STATUS.PENDING },
          {
            status: COURSE_REMINDER_DELIVERY_STATUS.FAILED,
            $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
          },
        ],
      },
      {
        $set: {
          status: COURSE_REMINDER_DELIVERY_STATUS.SENDING,
          processingStartedAt: now,
          claimToken,
          leaseExpiresAt: leaseUntil,
          providerAttemptStartedAt: null,
          manualReviewRequiredAt: null,
          failureCode: "",
          failureMessage: "",
        },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async beginProviderAttempt({
    tenant,
    deliveryId,
    claimToken,
    now = new Date(),
  }: {
    tenant: unknown;
    deliveryId: unknown;
    claimToken: string;
    now?: Date;
  }): Promise<CourseReminderDeliveryDocument | null> {
    return CourseReminderDeliveryModel.findOneAndUpdate(
      {
        _id: deliveryId,
        tenant,
        status: COURSE_REMINDER_DELIVERY_STATUS.SENDING,
        claimToken,
        leaseExpiresAt: { $gt: now },
        providerAttemptStartedAt: null,
      },
      {
        $set: { providerAttemptStartedAt: now },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async markSent({
    tenant,
    deliveryId,
    claimToken,
    providerMessageId,
    now = new Date(),
  }: {
    tenant: unknown;
    deliveryId: unknown;
    claimToken: string;
    providerMessageId?: string;
    now?: Date;
  }): Promise<boolean> {
    const result = await CourseReminderDeliveryModel.updateOne(
      {
        _id: deliveryId,
        tenant,
        status: COURSE_REMINDER_DELIVERY_STATUS.SENDING,
        claimToken,
      },
      {
        $set: {
          status: COURSE_REMINDER_DELIVERY_STATUS.SENT,
          sentAt: now,
          provider: "smtp",
          providerMessageId: String(providerMessageId || "").slice(0, 500),
          claimToken: "",
          leaseExpiresAt: null,
          nextAttemptAt: null,
          failureCode: "",
          failureMessage: "",
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async markKnownNotSent({
    tenant,
    deliveryId,
    claimToken,
    errorCode,
    errorMessage,
    nextAttemptAt,
    exhausted,
    now = new Date(),
  }: {
    tenant: unknown;
    deliveryId: unknown;
    claimToken: string;
    errorCode: string;
    errorMessage: string;
    nextAttemptAt: Date | null;
    exhausted: boolean;
    now?: Date;
  }): Promise<boolean> {
    const result = await CourseReminderDeliveryModel.updateOne(
      {
        _id: deliveryId,
        tenant,
        status: COURSE_REMINDER_DELIVERY_STATUS.SENDING,
        claimToken,
      },
      {
        $set: {
          status: COURSE_REMINDER_DELIVERY_STATUS.FAILED,
          claimToken: "",
          leaseExpiresAt: null,
          providerAttemptStartedAt: null,
          nextAttemptAt,
          failureCode: errorCode.slice(0, 120),
          failureMessage: errorMessage.slice(0, 3000),
          manualReviewRequiredAt: exhausted ? now : null,
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async markSkipped({
    tenant,
    deliveryId,
    claimToken,
    reason,
    now = new Date(),
  }: {
    tenant: unknown;
    deliveryId: unknown;
    claimToken: string;
    reason: string;
    now?: Date;
  }): Promise<boolean> {
    const result = await CourseReminderDeliveryModel.updateOne(
      {
        _id: deliveryId,
        tenant,
        status: COURSE_REMINDER_DELIVERY_STATUS.SENDING,
        claimToken,
        providerAttemptStartedAt: null,
      },
      {
        $set: {
          status: COURSE_REMINDER_DELIVERY_STATUS.SKIPPED,
          skippedAt: now,
          skipReason: reason.slice(0, 1000),
          processingStartedAt: null,
          claimToken: "",
          leaseExpiresAt: null,
          providerAttemptStartedAt: null,
          nextAttemptAt: null,
          manualReviewRequiredAt: null,
          failureCode: "",
          failureMessage: "",
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async markAmbiguous({
    tenant,
    deliveryId,
    claimToken,
    reason,
    now = new Date(),
  }: {
    tenant: unknown;
    deliveryId: unknown;
    claimToken: string;
    reason: string;
    now?: Date;
  }): Promise<boolean> {
    const result = await CourseReminderDeliveryModel.updateOne(
      {
        _id: deliveryId,
        tenant,
        status: COURSE_REMINDER_DELIVERY_STATUS.SENDING,
        claimToken,
      },
      {
        $set: {
          status: COURSE_REMINDER_DELIVERY_STATUS.AMBIGUOUS,
          claimToken: "",
          leaseExpiresAt: null,
          nextAttemptAt: null,
          manualReviewRequiredAt: now,
          failureCode: "PROVIDER_OUTCOME_UNKNOWN",
          failureMessage: reason.slice(0, 3000),
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async recoverStaleClaims({ now = new Date() }: { now?: Date } = {}): Promise<{
    requeued: number;
    ambiguous: number;
  }> {
    const safe = await CourseReminderDeliveryModel.updateMany(
      {
        status: COURSE_REMINDER_DELIVERY_STATUS.SENDING,
        leaseExpiresAt: { $lte: now },
        providerAttemptStartedAt: null,
      },
      {
        $set: {
          status: COURSE_REMINDER_DELIVERY_STATUS.PENDING,
          processingStartedAt: null,
          claimToken: "",
          leaseExpiresAt: null,
          nextAttemptAt: null,
          failureCode: "",
          failureMessage: "",
        },
      },
    ).exec();
    const uncertain = await CourseReminderDeliveryModel.updateMany(
      {
        status: COURSE_REMINDER_DELIVERY_STATUS.SENDING,
        leaseExpiresAt: { $lte: now },
        providerAttemptStartedAt: { $ne: null },
      },
      {
        $set: {
          status: COURSE_REMINDER_DELIVERY_STATUS.AMBIGUOUS,
          claimToken: "",
          leaseExpiresAt: null,
          nextAttemptAt: null,
          manualReviewRequiredAt: now,
          failureCode: "STALE_PROVIDER_ATTEMPT",
          failureMessage:
            "The SMTP attempt outlived its claim lease. Reconcile the stable message ID with the provider before retrying.",
        },
      },
    ).exec();
    return {
      requeued: safe.modifiedCount,
      ambiguous: uncertain.modifiedCount,
    };
  },

  async areAllCompleted({
    tenant,
    booking,
    idempotencyKeys,
  }: {
    tenant: unknown;
    booking: unknown;
    idempotencyKeys: string[];
  }): Promise<boolean> {
    if (!idempotencyKeys.length) return false;
    const uniqueKeys = [...new Set(idempotencyKeys)];
    const completed = await CourseReminderDeliveryModel.countDocuments({
      tenant,
      booking,
      idempotencyKey: { $in: uniqueKeys },
      status: {
        $in: [
          COURSE_REMINDER_DELIVERY_STATUS.SENT,
          COURSE_REMINDER_DELIVERY_STATUS.SKIPPED,
        ],
      },
    }).exec();
    return completed === uniqueKeys.length;
  },

  terminalStatuses: new Set<CourseReminderDeliveryStatus>([
    COURSE_REMINDER_DELIVERY_STATUS.SENT,
    COURSE_REMINDER_DELIVERY_STATUS.SKIPPED,
    COURSE_REMINDER_DELIVERY_STATUS.AMBIGUOUS,
  ]),
};
