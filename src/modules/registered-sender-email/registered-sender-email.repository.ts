import mongoose from "mongoose";

import {
  ACTIVE_AUTOMATION_STATUSES,
  REGISTERED_SENDER_PROVIDER,
} from "./registered-sender-email.constants.js";
import { RegisteredSenderEmailModel } from "./registered-sender-email.model.js";
import type {
  RegisteredSenderEmailDocument,
  SenderEmailListFilters,
} from "./registered-sender-email.types.js";
import type {
  CreateRegisteredSenderEmailInput,
  UpdateRegisteredSenderEmailInput,
} from "./registered-sender-email.validators.js";

const toObjectId = (value: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(value);

const publicProjection = [
  "-encryptedSmtpPassword",
  "-encryptedPostmarkServerToken",
  "-providerProvisioningError",
  "-lastTestError",
  "-replyToVerificationCodeHash",
  "-replyToVerificationExpiresAt",
  "-replyToVerificationSentAt",
  "-replyToVerificationAttempts",
].join(" ");

const secretProjection = [
  "+encryptedPostmarkServerToken",
  "+providerProvisioningError",
  "+providerProvisioningAttemptId",
  "+replyToVerificationCodeHash",
  "+replyToVerificationExpiresAt",
  "+replyToVerificationSentAt",
  "+replyToVerificationAttempts",
  "+lastTestProviderMessageId",
  "+lastTestRecipientEmail",
  "+managedTestCorrelations",
].join(" ");

const getCommunicationAutomationModel = () => {
  if (!mongoose.models.CommunicationAutomation) {
    throw new Error("CommunicationAutomation model is not registered.");
  }
  return mongoose.models.CommunicationAutomation;
};

const managedQuery = (tenantId: string) => ({
  tenant: toObjectId(tenantId),
  provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
});

export const registeredSenderEmailRepository = {
  async list(filters: SenderEmailListFilters) {
    const query: Record<string, unknown> = managedQuery(filters.tenantId);
    if (filters.search) {
      query.$or = [
        { email: { $regex: filters.search, $options: "i" } },
        { replyToEmail: { $regex: filters.search, $options: "i" } },
        { pendingReplyToEmail: { $regex: filters.search, $options: "i" } },
        { displayName: { $regex: filters.search, $options: "i" } },
      ];
    }
    if (typeof filters.isActive === "boolean")
      query.isActive = filters.isActive;
    return RegisteredSenderEmailModel.find(query)
      .select(publicProjection)
      .sort({ isActive: -1, createdAt: -1 })
      .lean()
      .exec();
  },

  async findByIdForTenant(tenantId: string, id: string) {
    return RegisteredSenderEmailModel.findOne({
      ...managedQuery(tenantId),
      _id: toObjectId(id),
    })
      .select(publicProjection)
      .lean()
      .exec();
  },

  async findByIdWithSecrets(
    tenantId: string,
    id: string,
  ): Promise<RegisteredSenderEmailDocument | null> {
    return RegisteredSenderEmailModel.findOne({
      ...managedQuery(tenantId),
      _id: toObjectId(id),
    })
      .select(secretProjection)
      .exec();
  },

  async findManagedWithSecrets(
    tenantId: string,
  ): Promise<RegisteredSenderEmailDocument | null> {
    return RegisteredSenderEmailModel.findOne(managedQuery(tenantId))
      .select(secretProjection)
      .sort({ isActive: -1, createdAt: -1 })
      .exec();
  },

  async findManagedForResolution(tenantId: string, senderEmailId?: string) {
    return RegisteredSenderEmailModel.findOne({
      ...managedQuery(tenantId),
      isActive: true,
      ...(senderEmailId ? { _id: toObjectId(senderEmailId) } : {}),
    })
      .select(secretProjection)
      .sort({ isDefault: -1, createdAt: -1 })
      .exec();
  },

  async createManagedProvisioning(
    tenantId: string,
    createdBy: string,
    email: string,
    input: CreateRegisteredSenderEmailInput,
  ) {
    await RegisteredSenderEmailModel.updateMany(
      { tenant: toObjectId(tenantId), isDefault: true },
      { $set: { isDefault: false } },
    ).exec();
    return RegisteredSenderEmailModel.create({
      tenant: toObjectId(tenantId),
      createdBy: toObjectId(createdBy),
      email,
      displayName: input.displayName,
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
      pendingReplyToEmail: input.replyToEmail,
      replyToEmail: "",
      replyToVerifiedAt: null,
      note: input.note,
      isDefault: true,
      isActive: true,
      providerServerId: null,
      providerProvisionedAt: null,
      providerProvisioningStatus: "pending",
      providerProvisioningError: "",
      providerProvisioningErrorCode: "",
      providerProvisioningAttemptedAt: null,
      providerProvisioningAttemptId: "",
    });
  },

  async beginPostmarkProvisioning(
    document: RegisteredSenderEmailDocument,
    attempt: { id: string; at: Date },
  ): Promise<RegisteredSenderEmailDocument | null> {
    return RegisteredSenderEmailModel.findOneAndUpdate(
      {
        _id: document._id,
        tenant: document.tenant,
        provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
      },
      {
        $set: {
          providerProvisionedAt: null,
          providerProvisioningStatus: "pending",
          providerProvisioningError: "",
          providerProvisioningErrorCode: "",
          providerProvisioningAttemptedAt: attempt.at,
          providerProvisioningAttemptId: attempt.id,
        },
      },
      { returnDocument: "after" },
    )
      .select(secretProjection)
      .exec();
  },

  async bindPostmarkServerPending(
    document: RegisteredSenderEmailDocument,
    attemptId: string,
    binding: {
      providerServerId: number;
      encryptedPostmarkServerToken: string;
    },
  ): Promise<RegisteredSenderEmailDocument | null> {
    return RegisteredSenderEmailModel.findOneAndUpdate(
      {
        _id: document._id,
        tenant: document.tenant,
        provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
        providerProvisioningStatus: "pending",
        providerProvisioningAttemptId: attemptId,
      },
      {
        $set: {
          providerServerId: binding.providerServerId,
          encryptedPostmarkServerToken:
            binding.encryptedPostmarkServerToken,
          providerProvisionedAt: null,
        },
      },
      { returnDocument: "after" },
    )
      .select(secretProjection)
      .exec();
  },

  async markPostmarkServerReady(
    document: RegisteredSenderEmailDocument,
    attemptId: string,
    provisionedAt = new Date(),
  ): Promise<RegisteredSenderEmailDocument | null> {
    return RegisteredSenderEmailModel.findOneAndUpdate(
      {
        _id: document._id,
        tenant: document.tenant,
        provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
        providerProvisioningStatus: "pending",
        providerProvisioningAttemptId: attemptId,
      },
      {
        $set: {
          providerProvisionedAt: provisionedAt,
          providerProvisioningStatus: "ready",
          providerProvisioningError: "",
          providerProvisioningErrorCode: "",
          providerProvisioningAttemptId: "",
        },
      },
      { returnDocument: "after" },
    )
      .select(secretProjection)
      .exec();
  },

  async markProvisioningFailure(
    tenantId: string,
    id: string,
    attemptId: string,
    failure: {
      message: string;
      code: string;
      attemptedAt: Date;
    },
  ) {
    return RegisteredSenderEmailModel.updateOne(
      {
        ...managedQuery(tenantId),
        _id: toObjectId(id),
        providerProvisioningStatus: "pending",
        providerProvisioningAttemptId: attemptId,
      },
      {
        $set: {
          providerProvisioningError: failure.message.slice(0, 500),
          providerProvisioningErrorCode: failure.code.slice(0, 80),
          providerProvisioningAttemptedAt: failure.attemptedAt,
          providerProvisionedAt: null,
          providerProvisioningStatus: "error",
          providerProvisioningAttemptId: "",
        },
      },
    ).exec();
  },

  async updateManaged(
    document: RegisteredSenderEmailDocument,
    input: UpdateRegisteredSenderEmailInput,
  ) {
    if (input.displayName !== undefined)
      document.displayName = input.displayName;
    if (input.note !== undefined) document.note = input.note;
    if (input.replyToEmail !== undefined) {
      const requested = input.replyToEmail.trim().toLowerCase();
      if (requested === String(document.replyToEmail || "").toLowerCase()) {
        document.pendingReplyToEmail = "";
        document.replyToVerificationCodeHash = "";
        document.replyToVerificationExpiresAt = null;
        document.replyToVerificationSentAt = null;
        document.replyToVerificationAttempts = 0;
      } else if (
        requested !== String(document.pendingReplyToEmail || "").toLowerCase()
      ) {
        // Keep the old verified Reply-To live until the replacement is proven.
        document.pendingReplyToEmail = requested;
        document.replyToVerificationCodeHash = "";
        document.replyToVerificationExpiresAt = null;
        document.replyToVerificationSentAt = null;
        document.replyToVerificationAttempts = 0;
      }
    }
    return document.save();
  },

  async reactivateManaged(document: RegisteredSenderEmailDocument) {
    await RegisteredSenderEmailModel.updateMany(
      { tenant: document.tenant, _id: { $ne: document._id }, isDefault: true },
      { $set: { isDefault: false } },
    ).exec();
    document.isActive = true;
    document.isDefault = true;
    return document.save();
  },

  async armReplyToVerification({
    tenantId,
    id,
    pendingReplyToEmail,
    codeHash,
    sentAt,
    expiresAt,
    notSentAfter,
  }: {
    tenantId: string;
    id: string;
    pendingReplyToEmail: string;
    codeHash: string;
    sentAt: Date;
    expiresAt: Date;
    notSentAfter: Date;
  }) {
    return RegisteredSenderEmailModel.findOneAndUpdate(
      {
        ...managedQuery(tenantId),
        _id: toObjectId(id),
        isActive: true,
        pendingReplyToEmail,
        $or: [
          { replyToVerificationSentAt: null },
          { replyToVerificationSentAt: { $lte: notSentAfter } },
        ],
      },
      {
        $set: {
          replyToVerificationCodeHash: codeHash,
          replyToVerificationSentAt: sentAt,
          replyToVerificationExpiresAt: expiresAt,
          replyToVerificationAttempts: 0,
        },
      },
      { returnDocument: "after" },
    )
      .select(secretProjection)
      .exec();
  },

  async recordFailedReplyToVerification({
    tenantId,
    id,
    pendingReplyToEmail,
    codeHash,
    maximumAttempts,
  }: {
    tenantId: string;
    id: string;
    pendingReplyToEmail: string;
    codeHash: string;
    maximumAttempts: number;
  }) {
    return RegisteredSenderEmailModel.findOneAndUpdate(
      {
        ...managedQuery(tenantId),
        _id: toObjectId(id),
        pendingReplyToEmail,
        replyToVerificationCodeHash: codeHash,
        replyToVerificationAttempts: { $lt: maximumAttempts },
      },
      { $inc: { replyToVerificationAttempts: 1 } },
      { returnDocument: "after" },
    )
      .select(secretProjection)
      .exec();
  },

  async clearReplyToVerification(
    tenantId: string,
    id: string,
    codeHash: string,
  ) {
    return RegisteredSenderEmailModel.updateOne(
      {
        ...managedQuery(tenantId),
        _id: toObjectId(id),
        replyToVerificationCodeHash: codeHash,
      },
      {
        $set: {
          replyToVerificationCodeHash: "",
          replyToVerificationExpiresAt: null,
          replyToVerificationSentAt: null,
          replyToVerificationAttempts: 0,
        },
      },
    ).exec();
  },

  async consumeReplyToVerification({
    tenantId,
    id,
    pendingReplyToEmail,
    codeHash,
    maximumAttempts,
    now,
  }: {
    tenantId: string;
    id: string;
    pendingReplyToEmail: string;
    codeHash: string;
    maximumAttempts: number;
    now: Date;
  }) {
    return RegisteredSenderEmailModel.findOneAndUpdate(
      {
        ...managedQuery(tenantId),
        _id: toObjectId(id),
        isActive: true,
        pendingReplyToEmail,
        replyToVerificationCodeHash: codeHash,
        replyToVerificationExpiresAt: { $gt: now },
        replyToVerificationAttempts: { $lt: maximumAttempts },
      },
      {
        $set: {
          replyToEmail: pendingReplyToEmail,
          replyToVerifiedAt: now,
          pendingReplyToEmail: "",
          replyToVerificationCodeHash: "",
          replyToVerificationExpiresAt: null,
          replyToVerificationSentAt: null,
          replyToVerificationAttempts: 0,
        },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async deactivate(tenantId: string, id: string) {
    return RegisteredSenderEmailModel.findOneAndUpdate(
      { ...managedQuery(tenantId), _id: toObjectId(id) },
      { $set: { isActive: false, isDefault: false } },
      { returnDocument: "after" },
    )
      .select(publicProjection)
      .lean()
      .exec();
  },

  async recordManagedTestAccepted({
    tenantId,
    id,
    recipientEmail,
    providerMessageId,
    acceptedAt,
  }: {
    tenantId: string;
    id: string;
    recipientEmail: string;
    providerMessageId: string;
    acceptedAt: Date;
  }) {
    return RegisteredSenderEmailModel.findOneAndUpdate(
      {
        ...managedQuery(tenantId),
        _id: toObjectId(id),
      },
      {
        $set: {
          lastTestedAt: acceptedAt,
          lastTestStatus: "pending",
          lastTestError: "",
          lastTestProviderMessageId: providerMessageId,
          lastTestRecipientEmail: recipientEmail,
        },
        $push: {
          managedTestCorrelations: {
            $each: [
              {
                providerMessageId,
                recipientEmail,
                status: "accepted",
                eventKey: "",
                eventAt: null,
                error: "",
                acceptedAt,
                updatedAt: acceptedAt,
              },
            ],
            $slice: -20,
          },
        },
      },
      { returnDocument: "after" },
    )
      .select(secretProjection)
      .exec();
  },

  async countActiveAutomationBindings(tenantId: string, senderEmailId: string) {
    return getCommunicationAutomationModel()
      .countDocuments({
        tenant: toObjectId(tenantId),
        senderEmail: toObjectId(senderEmailId),
        $or: [
          { isActive: true },
          { automationStatus: { $in: ACTIVE_AUTOMATION_STATUSES } },
        ],
      })
      .exec();
  },

  async rebindTenantAutomationsToManaged(
    tenantId: string,
    senderEmailId: string,
  ) {
    const CommunicationAutomation = getCommunicationAutomationModel();
    const paused = await CommunicationAutomation.updateMany(
      {
        tenant: toObjectId(tenantId),
        $or: [
          { isActive: true },
          { automationStatus: { $in: ACTIVE_AUTOMATION_STATUSES } },
        ],
      },
      {
        $set: {
          senderEmail: toObjectId(senderEmailId),
          isActive: false,
          automationStatus: "waiting_to_activate",
        },
      },
    ).exec();
    const rebound = await CommunicationAutomation.updateMany(
      {
        tenant: toObjectId(tenantId),
        senderEmail: { $ne: toObjectId(senderEmailId) },
      },
      { $set: { senderEmail: toObjectId(senderEmailId) } },
    ).exec();
    return { paused, rebound };
  },

  async getAutomationCountMap(
    tenantId: string,
    emailIds: mongoose.Types.ObjectId[],
  ) {
    if (!emailIds.length) return {};
    const bindings = await getCommunicationAutomationModel()
      .aggregate([
        {
          $match: {
            tenant: toObjectId(tenantId),
            senderEmail: { $in: emailIds },
            $or: [
              { isActive: true },
              { automationStatus: { $in: ACTIVE_AUTOMATION_STATUSES } },
            ],
          },
        },
        { $group: { _id: "$senderEmail", count: { $sum: 1 } } },
      ])
      .exec();
    return bindings.reduce<Record<string, number>>((acc, item) => {
      acc[String(item._id)] = item.count;
      return acc;
    }, {});
  },

  async listActiveAutomationBindings(tenantId: string, senderEmailId: string) {
    return getCommunicationAutomationModel()
      .find({
        tenant: toObjectId(tenantId),
        senderEmail: toObjectId(senderEmailId),
        $or: [
          { isActive: true },
          { automationStatus: { $in: ACTIVE_AUTOMATION_STATUSES } },
        ],
      })
      .select(
        "name scheduleType subject isActive automationStatus location createdAt",
      )
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  },
};
