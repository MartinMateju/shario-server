import mongoose, { type ClientSession } from "mongoose";

import { REGISTERED_SENDER_PROVIDER } from "@/modules/registered-sender-email/registered-sender-email.constants.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";

import { COMMUNICATION_AUTOMATION_STATUS } from "./communication-automation.constants.js";
import { CommunicationAutomation } from "./communication-automation.model.js";
import { buildCommunicationAutomationListQuery } from "./communication-automation.queries.js";
import type {
  CommunicationAutomationDocument,
  CommunicationAutomationListFilters,
} from "./communication-automation.types.js";
import {
  buildActivationPatch,
  toObjectId,
} from "./communication-automation.utils.js";
import type {
  CreateCommunicationAutomationInput,
  UpdateCommunicationAutomationInput,
} from "./communication-automation.validators.js";

const populateSenderEmail = "email displayName note isActive lastTestStatus";

const mapRecipients = (
  recipients?: Array<
    { user?: string | mongoose.Types.ObjectId | null } & Record<string, unknown>
  >,
) => {
  if (!recipients) return undefined;

  return recipients.map((recipient) => ({
    ...recipient,
    user: recipient.user ? toObjectId(String(recipient.user)) : null,
  }));
};

export const communicationAutomationRepository = {
  async countForTenant(
    tenantId: string,
    {
      session,
      activeOnly = false,
    }: { session?: ClientSession; activeOnly?: boolean } = {},
  ): Promise<number> {
    const query = CommunicationAutomation.countDocuments({
      tenant: toObjectId(tenantId),
      ...(activeOnly ? { isActive: true } : {}),
    });

    if (session) query.session(session);
    return query.exec();
  },

  async list(
    filters: CommunicationAutomationListFilters,
  ): Promise<CommunicationAutomationDocument[]> {
    const page = Math.max(Number(filters.page || 1), 1);
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);
    const skip = (page - 1) * limit;

    return CommunicationAutomation.find(
      buildCommunicationAutomationListQuery(filters),
    )
      .populate("senderEmail", populateSenderEmail)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  },

  async count(filters: CommunicationAutomationListFilters): Promise<number> {
    return CommunicationAutomation.countDocuments(
      buildCommunicationAutomationListQuery(filters),
    ).exec();
  },

  async findByIdForTenant(
    tenantId: string,
    automationId: string,
    { session }: { session?: ClientSession } = {},
  ): Promise<CommunicationAutomationDocument | null> {
    const query = CommunicationAutomation.findOne({
      _id: toObjectId(automationId),
      tenant: toObjectId(tenantId),
    }).populate("senderEmail", populateSenderEmail);

    if (session) query.session(session);
    return query.exec();
  },

  async activeSenderEmailExists(
    tenantId: string,
    senderEmailId: string,
  ): Promise<boolean> {
    const sender = await RegisteredSenderEmailModel.exists({
      _id: toObjectId(senderEmailId),
      tenant: toObjectId(tenantId),
      isActive: true,
    });

    return Boolean(sender);
  },

  async readySenderEmailExists(
    tenantId: string,
    senderEmailId: string,
  ): Promise<boolean> {
    const sender = await RegisteredSenderEmailModel.exists({
      _id: toObjectId(senderEmailId),
      tenant: toObjectId(tenantId),
      isActive: true,
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
      providerProvisioningStatus: "ready",
      providerServerId: { $ne: null },
      providerProvisionedAt: { $ne: null },
      encryptedPostmarkServerToken: { $nin: ["", null] },
      replyToEmail: { $nin: ["", null] },
      replyToVerifiedAt: { $ne: null },
      lastTestStatus: "success",
    });
    return Boolean(sender);
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateCommunicationAutomationInput,
    { session }: { session?: ClientSession } = {},
  ): Promise<CommunicationAutomationDocument> {
    const automation = new CommunicationAutomation({
      ...input,
      tenant: toObjectId(tenantId),
      createdBy: toObjectId(createdBy),
      senderEmail: toObjectId(input.senderEmail),
      location: input.location ? toObjectId(input.location) : null,
      recipients: mapRecipients(input.recipients) || [],
      isActive: false,
      automationStatus: COMMUNICATION_AUTOMATION_STATUS.WAITING_TO_ACTIVATE,
      activatedAt: null,
      nextRunAt: null,
    });

    return automation.save(session ? { session } : undefined);
  },

  async listRunnable() {
    return CommunicationAutomation.find({
      isActive: true,
      automationStatus: COMMUNICATION_AUTOMATION_STATUS.ACTIVE,
      purpose: { $ne: "marketing" },
    })
      .sort({ _id: 1 })
      .exec();
  },

  async listRunnablePage({
    afterId,
    limit = 500,
  }: {
    afterId?: string;
    limit?: number;
  } = {}) {
    return CommunicationAutomation.find({
      isActive: true,
      automationStatus: COMMUNICATION_AUTOMATION_STATUS.ACTIVE,
      purpose: { $ne: "marketing" },
      ...(afterId ? { _id: { $gt: toObjectId(afterId) } } : {}),
    })
      .sort({ _id: 1 })
      .limit(Math.min(Math.max(limit, 1), 1_000))
      .exec();
  },

  async initializeNextRun(id: string, nextRunAt: Date) {
    return CommunicationAutomation.findOneAndUpdate(
      { _id: toObjectId(id), nextRunAt: null, isActive: true },
      { $set: { nextRunAt } },
      { returnDocument: "after" },
    ).exec();
  },

  async rescheduleNextRun(
    id: string,
    expectedNextRunAt: Date,
    nextRunAt: Date,
  ) {
    return CommunicationAutomation.findOneAndUpdate(
      {
        _id: toObjectId(id),
        nextRunAt: expectedNextRunAt,
        isActive: true,
      },
      { $set: { nextRunAt } },
      { returnDocument: "after" },
    ).exec();
  },

  async claimRun({
    id,
    scheduledFor,
    claimToken,
    now,
    claimUntil,
  }: {
    id: string;
    scheduledFor: Date;
    claimToken: string;
    now: Date;
    claimUntil: Date;
  }) {
    return CommunicationAutomation.findOneAndUpdate(
      {
        _id: toObjectId(id),
        isActive: true,
        automationStatus: COMMUNICATION_AUTOMATION_STATUS.ACTIVE,
        nextRunAt: scheduledFor,
        $or: [
          { runClaimedUntil: null },
          { runClaimedUntil: { $exists: false } },
          { runClaimedUntil: { $lte: now } },
        ],
      },
      {
        $set: { runClaimedUntil: claimUntil, runClaimToken: claimToken },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async completeRun({
    id,
    claimToken,
    scheduledFor,
    nextRunAt,
    deactivate = false,
  }: {
    id: string;
    claimToken: string;
    scheduledFor: Date;
    nextRunAt: Date | null;
    deactivate?: boolean;
  }) {
    return CommunicationAutomation.findOneAndUpdate(
      { _id: toObjectId(id), runClaimToken: claimToken },
      {
        $set: {
          lastRunAt: new Date(),
          lastScheduledFor: scheduledFor,
          nextRunAt,
          runClaimedUntil: null,
          runClaimToken: "",
          errorMessage: "",
          ...(deactivate
            ? {
                isActive: false,
                automationStatus: COMMUNICATION_AUTOMATION_STATUS.INACTIVE,
                deactivatedAt: new Date(),
              }
            : {}),
        },
        $inc: { runSequence: 1 },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async releaseRun(id: string, claimToken: string, errorMessage = "") {
    return CommunicationAutomation.findOneAndUpdate(
      { _id: toObjectId(id), runClaimToken: claimToken },
      {
        $set: {
          runClaimedUntil: null,
          runClaimToken: "",
          errorMessage: errorMessage.slice(0, 2000),
        },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async claimEventScan({
    id,
    claimToken,
    now,
    claimUntil,
  }: {
    id: string;
    claimToken: string;
    now: Date;
    claimUntil: Date;
  }) {
    return CommunicationAutomation.findOneAndUpdate(
      {
        _id: toObjectId(id),
        isActive: true,
        automationStatus: COMMUNICATION_AUTOMATION_STATUS.ACTIVE,
        $or: [
          { runClaimedUntil: null },
          { runClaimedUntil: { $exists: false } },
          { runClaimedUntil: { $lte: now } },
        ],
      },
      {
        $set: { runClaimedUntil: claimUntil, runClaimToken: claimToken },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async completeEventScan({
    id,
    claimToken,
    scannedThrough,
  }: {
    id: string;
    claimToken: string;
    scannedThrough: Date;
  }) {
    return CommunicationAutomation.findOneAndUpdate(
      { _id: toObjectId(id), runClaimToken: claimToken },
      {
        $max: { lastRunAt: scannedThrough },
        $set: {
          runClaimedUntil: null,
          runClaimToken: "",
          errorMessage: "",
        },
        $inc: { runSequence: 1 },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async markRunQueued(id: string) {
    return CommunicationAutomation.findByIdAndUpdate(
      id,
      {
        $set: {
          lastRunAt: new Date(),
          errorMessage: "",
        },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async markRunFailed(id: string, errorMessage: string) {
    return CommunicationAutomation.findByIdAndUpdate(
      id,
      {
        $set: {
          automationStatus: COMMUNICATION_AUTOMATION_STATUS.FAILED,
          failedAt: new Date(),
          errorMessage: errorMessage.slice(0, 2000),
        },
      },
      { returnDocument: "after" },
    ).exec();
  },

  buildUpdatePatch(
    input: UpdateCommunicationAutomationInput,
    existing: CommunicationAutomationDocument,
  ): Record<string, unknown> {
    const {
      id: _id,
      recipients,
      senderEmail,
      location,
      locationId: _locationId,
      ...rest
    } = input as UpdateCommunicationAutomationInput & { locationId?: unknown };

    const patch: Record<string, unknown> = {
      ...rest,
      ...buildActivationPatch(input, existing.isActive),
    };

    if (senderEmail) {
      patch.senderEmail = toObjectId(senderEmail);
    }

    if (location !== undefined) {
      patch.location = location ? toObjectId(location) : null;
    }

    if (recipients !== undefined) {
      patch.recipients = mapRecipients(recipients);
    }

    if (input.sendToAllRecipients === true) {
      patch.recipients = [];
    }

    return patch;
  },

  async update(
    tenantId: string,
    input: UpdateCommunicationAutomationInput,
    {
      session,
      existing,
    }: {
      session?: ClientSession;
      existing?: CommunicationAutomationDocument;
    } = {},
  ): Promise<CommunicationAutomationDocument | null> {
    const current =
      existing ??
      (await this.findByIdForTenant(tenantId, input.id, { session }));

    if (!current) return null;

    const patch = this.buildUpdatePatch(input, current);

    const query = CommunicationAutomation.findOneAndUpdate(
      {
        _id: toObjectId(input.id),
        tenant: toObjectId(tenantId),
      },
      { $set: patch },
      { returnDocument: "after", runValidators: true },
    ).populate("senderEmail", populateSenderEmail);

    if (session) query.session(session);
    return query.exec();
  },

  async delete(
    tenantId: string,
    automationId: string,
  ): Promise<CommunicationAutomationDocument | null> {
    return CommunicationAutomation.findOneAndDelete({
      _id: toObjectId(automationId),
      tenant: toObjectId(tenantId),
    }).exec();
  },

  async markFailed(
    tenantId: string,
    automationId: string,
    errorMessage: string,
  ): Promise<CommunicationAutomationDocument | null> {
    return CommunicationAutomation.findOneAndUpdate(
      {
        _id: toObjectId(automationId),
        tenant: toObjectId(tenantId),
      },
      {
        $set: {
          isActive: false,
          automationStatus: COMMUNICATION_AUTOMATION_STATUS.FAILED,
          failedAt: new Date(),
          errorMessage: errorMessage.slice(0, 2000),
        },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
  },
};

