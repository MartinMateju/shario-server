import mongoose from "mongoose";

import User from "@/modules/user/user.model.js";
import { CommunicationEmailLogModel } from "./communication-email-log.model.js";
import type {
  CommunicationEmailLogDocument,
  CommunicationEmailLogListFilters,
  CreateCommunicationEmailLogInput,
} from "./communication-email-log.types.js";

type EmailLogQuery = Record<string, unknown>;

const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

const hasValidObjectId = (value?: string): value is string => {
  return Boolean(value && mongoose.Types.ObjectId.isValid(value));
};

const escapeRegex = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const buildBaseQuery = async (
  filters: CommunicationEmailLogListFilters,
): Promise<EmailLogQuery> => {
  const query: EmailLogQuery = {
    tenant: toObjectId(filters.tenantId),
  };

  if (
    filters.allowedLocationIds !== null &&
    filters.allowedLocationIds !== undefined
  ) {
    query.location = { $in: filters.allowedLocationIds.map(toObjectId) };
    query.appliesToAllLocations = false;
  }

  if (filters.status && filters.status !== "all") {
    query.status = filters.status;
  }

  if (filters.emailType && filters.emailType !== "all") {
    query.emailType = filters.emailType;
  }

  if (hasValidObjectId(filters.automationId)) {
    query.automation = toObjectId(filters.automationId);
  }

  if (hasValidObjectId(filters.userId)) {
    query.user = toObjectId(filters.userId);
  }

  if (hasValidObjectId(filters.relatedEntityId)) {
    query.relatedEntityId = toObjectId(filters.relatedEntityId);
  }
  if (hasValidObjectId(filters.firingId)) {
    query.relatedEntityId = toObjectId(filters.firingId);
    query.relatedEntityType = "firing";
    query.emailType = "firingReady";
  }

  if (filters.recipientEmail) {
    query.recipientEmail = filters.recipientEmail.toLowerCase().trim();
  }

  const search = String(filters.search || "").trim();

  if (search) {
    const escapedSearch = escapeRegex(search);

    const matchingUsers = await User.find({
      tenant: toObjectId(filters.tenantId),
      $or: [
        { customId: { $regex: escapedSearch, $options: "i" } },
        { email: { $regex: escapedSearch, $options: "i" } },
        { firstname: { $regex: escapedSearch, $options: "i" } },
        { lastname: { $regex: escapedSearch, $options: "i" } },
      ],
    })
      .select("_id")
      .lean()
      .exec();

    query.$or = [
      { recipientEmail: { $regex: escapedSearch, $options: "i" } },
      { recipientName: { $regex: escapedSearch, $options: "i" } },
      { subject: { $regex: escapedSearch, $options: "i" } },
      { user: { $in: matchingUsers.map((user) => user._id) } },
    ];
  }

  return query;
};

export const communicationEmailLogRepository = {
  async list(
    filters: CommunicationEmailLogListFilters,
  ): Promise<CommunicationEmailLogDocument[]> {
    const page = Math.max(Number(filters.page || 1), 1);
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 200);
    const skip = (page - 1) * limit;
    const query = await buildBaseQuery(filters);

    return CommunicationEmailLogModel.find(query)
      .populate({
        path: "automation",
        select:
          "name scheduleType connectedProductType subject htmlContent location senderEmail appliesToAllLocations",
        populate: {
          path: "senderEmail",
          select: "email note isActive displayName",
        },
      })
      .populate("user", "firstname lastname email customId")
      .populate("senderEmail", "email note isActive displayName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  },

  async count(filters: CommunicationEmailLogListFilters): Promise<number> {
    const query = await buildBaseQuery(filters);

    return CommunicationEmailLogModel.countDocuments(query).exec();
  },

  async create(
    input: CreateCommunicationEmailLogInput,
  ): Promise<CommunicationEmailLogDocument> {
    const log = new CommunicationEmailLogModel(input);

    return log.save();
  },

  async upsertScheduled(
    input: CreateCommunicationEmailLogInput,
  ): Promise<{ log: CommunicationEmailLogDocument; created: boolean }> {
    const existing = await CommunicationEmailLogModel.findOne({
      tenant: input.tenant,
      deduplicationKey: input.deduplicationKey,
    }).exec();
    if (existing) return { log: existing, created: false };

    try {
      const log = await CommunicationEmailLogModel.create({
        ...input,
        status: input.status || "scheduled",
      });
      return { log, created: true };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 11000
      ) {
        const duplicate = await CommunicationEmailLogModel.findOne({
          tenant: input.tenant,
          deduplicationKey: input.deduplicationKey,
        }).exec();
        if (duplicate) return { log: duplicate, created: false };
      }
      throw error;
    }
  },

  async markQueued(tenantId: string, logId: string): Promise<boolean> {
    const now = new Date();
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: { $in: ["scheduled", "failed", "queued"] },
        retryable: { $ne: false },
      },
      {
        $set: {
          status: "queued",
          queuedAt: now,
          failedAt: null,
          errorMessage: "",
          nextQueueRecoveryAt: new Date(now.getTime() + 5 * 60_000),
          queueRecoveryAttempts: 0,
          queueRecoveryClaimToken: "",
          queueRecoveryLeaseExpiresAt: null,
        },
      },
    ).exec();
    return result.matchedCount > 0;
  },

  async claimForSending({
    tenantId,
    logId,
    jobId,
    claimToken,
    now = new Date(),
    leaseUntil = new Date(
      now.getTime() +
        Math.max(
          60_000,
          Number(process.env.COMMUNICATION_EMAIL_CLAIM_LEASE_MS || 5 * 60_000),
        ),
    ),
  }: {
    tenantId: string;
    logId: string;
    jobId: string;
    claimToken: string;
    now?: Date;
    leaseUntil?: Date;
  }): Promise<CommunicationEmailLogDocument | null> {
    return CommunicationEmailLogModel.findOneAndUpdate(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        retryable: { $ne: false },
        $or: [
          {
            status: "scheduled",
            $or: [{ scheduledFor: null }, { scheduledFor: { $lte: now } }],
          },
          { status: { $in: ["queued", "pending", "failed"] } },
        ],
      },
      {
        $set: {
          status: "sending",
          processingStartedAt: now,
          processingJobId: jobId,
          processingClaimToken: claimToken,
          processingLeaseExpiresAt: leaseUntil,
          providerAttemptStartedAt: null,
          manualReviewRequiredAt: null,
          queueRecoveryClaimToken: "",
          queueRecoveryLeaseExpiresAt: null,
          failedAt: null,
          errorMessage: "",
        },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async beginProviderAttempt({
    tenantId,
    logId,
    jobId,
    claimToken,
    now = new Date(),
    leaseUntil = new Date(now.getTime() + 5 * 60_000),
  }: {
    tenantId: string;
    logId: string;
    jobId: string;
    claimToken: string;
    now?: Date;
    leaseUntil?: Date;
  }): Promise<CommunicationEmailLogDocument | null> {
    return CommunicationEmailLogModel.findOneAndUpdate(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: "sending",
        processingJobId: jobId,
        processingClaimToken: claimToken,
        processingLeaseExpiresAt: { $gt: now },
        providerAttemptStartedAt: null,
      },
      {
        $set: {
          providerAttemptStartedAt: now,
          processingLeaseExpiresAt: leaseUntil,
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async defer(
    tenantId: string,
    logId: string,
    scheduledFor: Date,
    reason: string,
    claimToken: string,
  ): Promise<boolean> {
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: "sending",
        processingClaimToken: claimToken,
      },
      {
        $set: {
          status: "scheduled",
          scheduledFor,
          processingStartedAt: null,
          processingJobId: "",
          processingClaimToken: "",
          processingLeaseExpiresAt: null,
          providerAttemptStartedAt: null,
          errorMessage: reason.slice(0, 3000),
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async markSent(
    tenantId: string,
    logId: string,
    providerMessageId: string | undefined,
    provider: string,
    claimToken: string,
  ): Promise<boolean> {
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: "sending",
        processingClaimToken: claimToken,
      },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          failedAt: null,
          errorMessage: "",
          provider,
          processingStartedAt: null,
          processingJobId: "",
          processingClaimToken: "",
          processingLeaseExpiresAt: null,
          ...(providerMessageId ? { providerMessageId } : {}),
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async markFailed(
    tenantId: string,
    logId: string,
    errorMessage: string,
    claimToken: string,
    providerOutcomeKnownNotSent = false,
    options: { retryable?: boolean; countAttempt?: boolean } = {},
  ): Promise<boolean> {
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: "sending",
        processingClaimToken: claimToken,
        ...(providerOutcomeKnownNotSent
          ? {}
          : { providerAttemptStartedAt: null }),
      },
      {
        $set: {
          status: "failed",
          failedAt: new Date(),
          errorMessage: errorMessage.slice(0, 3000),
          processingStartedAt: null,
          processingJobId: "",
          processingClaimToken: "",
          processingLeaseExpiresAt: null,
          providerAttemptStartedAt: null,
          ...(options.retryable === undefined
            ? {}
            : { retryable: options.retryable }),
        },
        ...(options.countAttempt ? { $inc: { attempts: 1 } } : {}),
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async markAmbiguous(
    tenantId: string,
    logId: string,
    errorMessage: string,
    claimToken: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: "sending",
        processingClaimToken: claimToken,
      },
      {
        $set: {
          status: "ambiguous",
          failedAt: now,
          manualReviewRequiredAt: now,
          errorMessage: errorMessage.slice(0, 3000),
          processingLeaseExpiresAt: null,
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async recoverStaleSending({
    now = new Date(),
    limit = 200,
  }: {
    now?: Date;
    limit?: number;
  } = {}): Promise<{
    requeued: Array<Record<string, any>>;
    ambiguous: number;
  }> {
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const legacyCutoff = new Date(
      now.getTime() -
        Math.max(
          60_000,
          Number(process.env.COMMUNICATION_EMAIL_CLAIM_LEASE_MS || 5 * 60_000),
        ),
    );
    const stale = await CommunicationEmailLogModel.find({
      status: "sending",
      $or: [
        { processingLeaseExpiresAt: { $lte: now } },
        {
          $and: [
            {
              $or: [
                { processingLeaseExpiresAt: null },
                { processingLeaseExpiresAt: { $exists: false } },
              ],
            },
            { processingStartedAt: { $lte: legacyCutoff } },
          ],
        },
      ],
    })
      .sort({ processingStartedAt: 1, _id: 1 })
      .limit(boundedLimit)
      .select(
        "_id tenant automation user relatedEntityId deduplicationKey emailType purpose allowanceClass status processingClaimToken processingLeaseExpiresAt providerAttemptStartedAt processingStartedAt",
      )
      .lean();
    if (!stale.length) return { requeued: [], ambiguous: 0 };

    const safelyRequeueable = stale.filter(
      (log: any) =>
        Boolean(log.processingClaimToken) &&
        log.processingLeaseExpiresAt &&
        new Date(log.processingLeaseExpiresAt).getTime() <= now.getTime() &&
        !log.providerAttemptStartedAt,
    );
    const safeIds = new Set(
      safelyRequeueable.map((log: any) => String(log._id)),
    );
    const ambiguous = stale.filter((log: any) => !safeIds.has(String(log._id)));

    let requeued: Array<Record<string, any>> = [];
    if (safelyRequeueable.length) {
      const ids = safelyRequeueable.map((log: any) => log._id);
      await CommunicationEmailLogModel.updateMany(
        {
          _id: { $in: ids },
          status: "sending",
          processingClaimToken: { $type: "string", $gt: "" },
          processingLeaseExpiresAt: { $lte: now },
          providerAttemptStartedAt: null,
        },
        {
          $set: {
            status: "queued",
            queuedAt: now,
            processingStartedAt: null,
            processingJobId: "",
            processingClaimToken: "",
            processingLeaseExpiresAt: null,
            errorMessage:
              "Delivery claim expired before provider submission; safely requeued.",
          },
        },
      ).exec();
      requeued = await CommunicationEmailLogModel.find({
        _id: { $in: ids },
        status: "queued",
      })
        .select(
          "_id tenant automation user relatedEntityId deduplicationKey emailType purpose allowanceClass status",
        )
        .lean();
    }

    let ambiguousCount = 0;
    if (ambiguous.length) {
      const ids = ambiguous.map((log: any) => log._id);
      const result = await CommunicationEmailLogModel.updateMany(
        {
          _id: { $in: ids },
          status: "sending",
          $or: [
            { processingLeaseExpiresAt: { $lte: now } },
            {
              $and: [
                {
                  $or: [
                    { processingLeaseExpiresAt: null },
                    { processingLeaseExpiresAt: { $exists: false } },
                  ],
                },
                { processingStartedAt: { $lte: legacyCutoff } },
              ],
            },
          ],
        },
        {
          $set: {
            status: "ambiguous",
            failedAt: now,
            manualReviewRequiredAt: now,
            processingLeaseExpiresAt: null,
            errorMessage:
              "Provider delivery outcome is unknown after the worker lease expired. Reconcile with the provider before retrying.",
          },
        },
      ).exec();
      ambiguousCount = result.modifiedCount;
    }
    return { requeued, ambiguous: ambiguousCount };
  },

  async markQueueStateAmbiguous(
    tenantId: string,
    logId: string,
    queueState: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: { $in: ["pending", "scheduled", "queued", "failed"] },
        retryable: { $ne: false },
      },
      {
        $set: {
          status: "ambiguous",
          failedAt: now,
          manualReviewRequiredAt: now,
          errorMessage:
            `BullMQ job is ${queueState}; delivery state must be reconciled before retrying.`.slice(
              0,
              3000,
            ),
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async listQueueReconciliationCandidates({
    now = new Date(),
    limit = 200,
  }: {
    now?: Date;
    limit?: number;
  } = {}): Promise<Array<Record<string, any>>> {
    return CommunicationEmailLogModel.find({
      manualReviewRequiredAt: null,
      retryable: { $ne: false },
      $and: [
        {
          $or: [
            { nextQueueRecoveryAt: null },
            { nextQueueRecoveryAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { status: { $in: ["queued", "failed"] } },
            {
              status: "scheduled",
              $or: [{ scheduledFor: null }, { scheduledFor: { $lte: now } }],
            },
          ],
        },
      ],
    })
      .sort({ nextQueueRecoveryAt: 1, scheduledFor: 1, _id: 1 })
      .limit(Math.min(Math.max(limit, 1), 1_000))
      .select(
        "_id tenant automation user relatedEntityId deduplicationKey emailType purpose allowanceClass status attempts queueRecoveryAttempts",
      )
      .lean();
  },

  async claimQueueReconciliation({
    tenantId,
    logId,
    claimToken,
    now = new Date(),
    leaseUntil = new Date(now.getTime() + 5 * 60_000),
  }: {
    tenantId: string;
    logId: string;
    claimToken: string;
    now?: Date;
    leaseUntil?: Date;
  }): Promise<CommunicationEmailLogDocument | null> {
    return CommunicationEmailLogModel.findOneAndUpdate(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        manualReviewRequiredAt: null,
        retryable: { $ne: false },
        $and: [
          {
            $or: [
              { nextQueueRecoveryAt: null },
              { nextQueueRecoveryAt: { $lte: now } },
            ],
          },
          {
            $or: [
              { status: { $in: ["queued", "failed"] } },
              {
                status: "scheduled",
                $or: [{ scheduledFor: null }, { scheduledFor: { $lte: now } }],
              },
            ],
          },
          {
            $or: [
              { queueRecoveryLeaseExpiresAt: null },
              { queueRecoveryLeaseExpiresAt: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          queueRecoveryClaimToken: claimToken,
          queueRecoveryLeaseExpiresAt: leaseUntil,
        },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async markReconciledQueued(
    tenantId: string,
    logId: string,
    claimToken: string,
    now = new Date(),
  ): Promise<boolean> {
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: { $in: ["scheduled", "queued", "failed"] },
        queueRecoveryClaimToken: claimToken,
      },
      {
        $set: {
          status: "queued",
          queuedAt: now,
          failedAt: null,
          errorMessage: "",
          queueRecoveryAttempts: 0,
          nextQueueRecoveryAt: new Date(now.getTime() + 5 * 60_000),
          queueRecoveryClaimToken: "",
          queueRecoveryLeaseExpiresAt: null,
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async markReconciliationAmbiguous(
    tenantId: string,
    logId: string,
    claimToken: string,
    queueState: string,
  ): Promise<boolean> {
    const now = new Date();
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: { $in: ["scheduled", "queued", "failed"] },
        queueRecoveryClaimToken: claimToken,
      },
      {
        $set: {
          status: "ambiguous",
          failedAt: now,
          manualReviewRequiredAt: now,
          queueRecoveryClaimToken: "",
          queueRecoveryLeaseExpiresAt: null,
          errorMessage:
            `Queue reconciliation stopped in ${queueState}; review delivery state before retrying.`.slice(
              0,
              3000,
            ),
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async deferQueueReconciliation(
    tenantId: string,
    logId: string,
    claimToken: string,
    errorMessage: string,
    now = new Date(),
  ): Promise<boolean> {
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: { $in: ["scheduled", "queued", "failed"] },
        manualReviewRequiredAt: null,
        queueRecoveryClaimToken: claimToken,
      },
      {
        $set: {
          nextQueueRecoveryAt: new Date(now.getTime() + 5 * 60_000),
          errorMessage: errorMessage.slice(0, 3000),
          queueRecoveryClaimToken: "",
          queueRecoveryLeaseExpiresAt: null,
        },
        $inc: { queueRecoveryAttempts: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async markCanceled(
    tenantId: string,
    logId: string,
    reason: string,
    status: "canceled" | "suppressed",
    claimToken: string,
  ): Promise<boolean> {
    const result = await CommunicationEmailLogModel.updateOne(
      {
        _id: toObjectId(logId),
        tenant: toObjectId(tenantId),
        status: "sending",
        processingClaimToken: claimToken,
      },
      {
        $set: {
          status,
          canceledAt: new Date(),
          cancelReason: reason.slice(0, 500),
          processingStartedAt: null,
          processingJobId: "",
          processingClaimToken: "",
          processingLeaseExpiresAt: null,
          providerAttemptStartedAt: null,
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  },

  async cancelPendingForAutomation(
    tenantId: string,
    automationId: string,
    reason: string,
  ): Promise<number> {
    const result = await CommunicationEmailLogModel.updateMany(
      {
        tenant: toObjectId(tenantId),
        automation: toObjectId(automationId),
        status: { $in: ["pending", "scheduled", "queued", "failed"] },
      },
      {
        $set: {
          status: "canceled",
          canceledAt: new Date(),
          cancelReason: reason.slice(0, 500),
          processingStartedAt: null,
          processingJobId: "",
          processingClaimToken: "",
          processingLeaseExpiresAt: null,
          providerAttemptStartedAt: null,
        },
      },
    ).exec();
    return result.modifiedCount;
  },
};
