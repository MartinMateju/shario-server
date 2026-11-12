import { createHash, randomBytes } from "node:crypto";

import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import {
  getObjectBufferFromR2,
  getPresignedR2Url,
} from "@/infrastructure/storage/r2.client.js";
import { staffTaskService } from "@/modules/staff/services/staff-task.service.js";
import { createStaffTaskSchema } from "@/modules/staff/staff.validators.js";
import LocationModel from "@/modules/location/location.model.js";
import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
  WORKSPACE_PERMISSION,
  WORKSPACE_ROLE,
  type AllowedWorkspaceLocationIds,
  type ResolvedWorkspaceAccess,
  type WorkspaceRole,
} from "@/modules/tenant-access/index.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import type { ResolvedManagedSender } from "@/modules/registered-sender-email/services/managed-sender-resolver.service.js";
import UserModel from "@/modules/user/user.model.js";
import { TENANT_ROLE } from "@/modules/user/user.constants.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";

import {
  buildConversationVisibilityFilter,
  canViewRestrictedConversation,
} from "../communication.access.js";
import { canonicalizeCustomerComposeRecipient } from "../communications.recipient.js";
import {
  AI_AUTO_APPLY_CONFIDENCE,
  AUDIT_ACTION,
  COMMUNICATION_CHANNEL,
  CONSENT_STATUS,
  CONVERSATION_STATUS,
  DELIVERY_STATUS,
  MESSAGE_DIRECTION,
} from "../communications.constants.js";
import {
  CommunicationAuditModel,
  CommunicationConsentModel,
  CommunicationConversationModel,
  CommunicationDeliveryModel,
  CommunicationKnowledgeArticleModel,
  CommunicationMessageModel,
  CommunicationRoutingRuleModel,
  CommunicationSatisfactionSurveyModel,
  CommunicationSettingsModel,
} from "../communications.models.js";
import { recordCommunicationAudit } from "./audit.service.js";
import {
  analyzeCommunicationText,
  draftCommunicationReply,
  transcribeCommunicationAudio,
  translateCommunicationText,
} from "./ai.service.js";
import { buildDeliveryIdempotencyKey } from "./delivery.service.js";
import {
  fallbackCommunicationDelivery,
  processCommunicationDelivery,
  retryCommunicationDelivery,
} from "./delivery-processing.service.js";
import {
  assertOutboundEmailContentSupported,
  resolveOutboundComposeSender,
} from "./outbound-email-readiness.service.js";
import { toOutboundOnlyCommunicationSettings } from "./outbound-communication-settings.service.js";
import { hydrateOutboundConversationHistory } from "./outbound-conversation-history.service.js";
import {
  calculateSatisfactionSummary,
  createSatisfactionToken,
  hashSatisfactionToken,
  validateSatisfactionScore,
} from "./satisfaction.service.js";
import { getOwnedCommunicationR2Key } from "./private-media.service.js";
import {
  indexKnowledgeArticle,
  retrieveKnowledge,
} from "@/modules/ai/services/knowledge-retrieval.service.js";
import {
  createConversationTaskSchema,
  knowledgeArticleSchema,
} from "../communications.validators.js";
import { AI_AUDIENCE } from "@/modules/ai/ai.constants.js";
import type { AiRequestContext } from "@/modules/ai/ai.types.js";
import {
  assertKnowledgeTargetOwnership,
  canManageAllKnowledgeLocations,
} from "./knowledge-access.service.js";

export type CommunicationContext = {
  tenantId: string;
  userId: string;
  role?: WorkspaceRole | null;
  access?: ResolvedWorkspaceAccess | null;
  allowedLocationIds?: AllowedWorkspaceLocationIds;
  ipAddress?: string;
  userAgent?: string;
};

const id = (value: unknown) => String(value ?? "").trim();
const objectId = (value: unknown) => new mongoose.Types.ObjectId(id(value));

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const communicationAiContext = (
  context: CommunicationContext,
  locationId?: unknown,
  locale?: string,
): AiRequestContext => ({
  tenantId: context.tenantId,
  userId: context.userId,
  audience: AI_AUDIENCE.WORKSPACE,
  access: context.access,
  allowedLocationIds: context.allowedLocationIds,
  locationId: id(locationId) || null,
  locale,
  ipAddress: context.ipAddress,
  userAgent: context.userAgent,
});

const safeThreadHeader = (value: unknown) =>
  String(value || "")
    .replace(/[\r\n]/g, "")
    .trim()
    .slice(0, 2000);

const threadReferences = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values.flatMap((entry) =>
        (safeThreadHeader(entry).match(/<[^<>\s]+>/g) || []).slice(0, 50),
      ),
    ),
  ];
};

const withPrivateMediaUrls = async (tenantId: string, message: any) => ({
  ...message,
  attachments: await Promise.all(
    (message.attachments || []).map(async (attachment: any) => {
      const key = getOwnedCommunicationR2Key(tenantId, attachment.url);
      if (!key) {
        const internalProviderPlaceholder =
          /^(?:instagram|whatsapp)-media:\/\//.test(
            String(attachment.url || ""),
          );
        return String(attachment.url || "").startsWith("r2://") ||
          internalProviderPlaceholder
          ? {
              ...attachment,
              url: "",
              unavailable: true,
              private: true,
            }
          : attachment;
      }
      try {
        const configuredTtl = Number(
          process.env.COMMUNICATION_PRIVATE_MEDIA_URL_TTL_SECONDS || 300,
        );
        const expiresInSeconds = Number.isFinite(configuredTtl)
          ? Math.min(Math.max(Math.floor(configuredTtl), 30), 900)
          : 300;
        return {
          ...attachment,
          url: await getPresignedR2Url({ key, expiresInSeconds }),
          urlExpiresAt: new Date(Date.now() + expiresInSeconds * 1000),
          private: true,
        };
      } catch {
        // Keep inbox reads usable if private storage is temporarily down, but
        // never leak the internal R2 key to the browser.
        return {
          ...attachment,
          url: "",
          unavailable: true,
          private: true,
        };
      }
    }),
  ),
});

const withConversationReplyEligibility = (conversation: any) => {
  const instagram = conversation?.metadata?.instagram;
  const scopedId = String(
    conversation?.contact?.instagramScopedId || instagram?.scopedId || "",
  ).trim();
  const expiresAt = instagram?.replyWindowExpiresAt
    ? new Date(instagram.replyWindowExpiresAt)
    : null;
  const validExpiry = Boolean(
    expiresAt && Number.isFinite(expiresAt.getTime()),
  );
  const canReply = Boolean(
    scopedId && validExpiry && expiresAt!.getTime() > Date.now(),
  );
  return {
    ...conversation,
    replyEligibility: {
      ...(conversation?.replyEligibility || {}),
      instagram: {
        canReply,
        replyOnly: true,
        windowExpiresAt: validExpiry ? expiresAt : null,
        reason: !scopedId
          ? "identity_missing"
          : !validExpiry || !canReply
            ? "reply_window_closed"
            : "customer_window_open",
      },
    },
  };
};

const slugify = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150) || `article-${Date.now()}`;

const assertLocationScope = (
  locationId: unknown,
  allowedLocationIds: AllowedWorkspaceLocationIds = null,
) => {
  if (!locationId || allowedLocationIds === null) return;
  if (!allowedLocationIds.map(String).includes(id(locationId))) {
    notFound({
      message: "Location not found.",
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
  }
};

const assertTenantLocation = async (
  tenantId: string,
  locationId: unknown,
  allowedLocationIds: AllowedWorkspaceLocationIds = null,
) => {
  if (!locationId) return null;
  assertLocationScope(locationId, allowedLocationIds);
  const exists = await LocationModel.exists({
    _id: locationId,
    tenant: tenantId,
  });
  if (!exists) {
    notFound({
      message: "Location not found.",
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
  }
  return id(locationId);
};

const assertTenantLocations = async (
  tenantId: string,
  locationIds: readonly unknown[],
  allowedLocationIds: AllowedWorkspaceLocationIds = null,
) => {
  for (const locationId of locationIds) {
    await assertTenantLocation(tenantId, locationId, allowedLocationIds);
  }
};

const requireKnowledgePublishPermission = async (
  context: CommunicationContext,
): Promise<void> => {
  const access = await resolveWorkspaceAccessForUser({
    tenantId: context.tenantId,
    userId: context.userId,
  });
  if (!hasWorkspacePermission(access, WORKSPACE_PERMISSION.KNOWLEDGE_PUBLISH)) {
    forbidden({
      message: "Knowledge publishing permission is required.",
      code: "WORKSPACE_PERMISSION_REQUIRED",
      details: {
        requiredPermissions: [WORKSPACE_PERMISSION.KNOWLEDGE_PUBLISH],
      },
    });
  }
};

const assertOwnerKnowledgeAudience = (
  context: CommunicationContext,
  audience: unknown,
) => {
  if (audience === "owner" && context.role !== WORKSPACE_ROLE.OWNER) {
    forbidden(
      "Owner-only knowledge can only be managed by the workspace owner.",
    );
  }
};

const knowledgeArticleInput = (value: Record<string, any>) => {
  // `targetOwnerIds` is a frontend compatibility placeholder. Owner visibility
  // is role-based and individual owner targeting is intentionally unsupported.
  const { targetOwnerIds: _targetOwnerIds, ...input } = value;
  return input;
};

const queueKnowledgeIndex = (articleId: string): void => {
  void indexKnowledgeArticle(articleId).catch((error) => {
    logger.warn(
      { err: error, articleId },
      "Knowledge article could not be indexed immediately.",
    );
  });
};

const getSettings = async (tenantId: string, userId?: string) => {
  let settings = await CommunicationSettingsModel.findOne({ tenantId });
  if (settings) return settings;
  const tenant = await TenantModel.findById(tenantId)
    .select("name slug settings.timezone")
    .lean();
  settings = await CommunicationSettingsModel.create({
    tenantId,
    businessHours: { timezone: tenant?.settings?.timezone || "Europe/Prague" },
    updatedBy: userId || null,
  });
  return settings;
};

const getVisibleConversation = async (
  context: CommunicationContext,
  conversationId: string,
  lean = false,
) => {
  const filter = buildConversationVisibilityFilter({
    tenantId: context.tenantId,
    userId: context.userId,
    role: context.role,
    allowedLocationIds: context.allowedLocationIds ?? null,
    view: "all",
  });
  const query = CommunicationConversationModel.findOne({
    $and: [filter, { _id: conversationId }],
  });
  const conversation = lean ? await query.lean() : await query;
  if (!conversation) notFound("Conversation not found.");
  return conversation;
};

const assertTenantCustomer = async (tenantId: string, customerId: unknown) => {
  if (!customerId) return null;
  const customer = await UserModel.findOne({
    _id: customerId,
    tenant: tenantId,
  })
    .select("firstname lastname email phone customId")
    .lean();
  if (!customer) notFound("Customer not found.");
  return customer;
};

const assertTenantUser = async (tenantId: string, userId: unknown) => {
  if (!userId) return null;
  const user = await UserModel.findOne({ _id: userId, tenant: tenantId })
    .select("_id")
    .lean();
  if (!user) notFound("Workspace user not found.");
  return user;
};

const assertTenantUsers = async (
  tenantId: string,
  userIds: readonly unknown[],
) => {
  const normalized = [...new Set(userIds.map(id).filter(Boolean))];
  if (!normalized.length) return;
  const count = await UserModel.countDocuments({
    _id: { $in: normalized },
    tenant: tenantId,
  });
  if (count !== normalized.length)
    notFound("One or more workspace users were not found.");
};

const customerContact = (customer: any) => ({
  name: [customer?.firstname, customer?.lastname].filter(Boolean).join(" "),
  email: customer?.email || "",
  phone: customer?.phone || "",
  whatsappId: customer?.phone || "",
  instagramScopedId: "",
  instagramUsername: "",
  externalId: customer?.customId || "",
});

const assertInstagramReplyEligibility = async ({
  tenantId,
  conversationId,
  instagramScopedId,
  replyWindowExpiresAt,
}: {
  tenantId: string;
  conversationId: unknown;
  instagramScopedId: unknown;
  replyWindowExpiresAt: unknown;
}) => {
  const recipient = String(instagramScopedId || "").trim();
  if (!recipient) {
    badRequest({
      message: "Customer Instagram identity is missing.",
      code: "INSTAGRAM_RECIPIENT_MISSING",
    });
  }
  const expiresAt = new Date(String(replyWindowExpiresAt || ""));
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    badRequest({
      message:
        "Instagram is reply-only and the 24-hour customer reply window is closed.",
      code: "INSTAGRAM_REPLY_WINDOW_CLOSED",
    });
  }
  const latestIncoming = await CommunicationMessageModel.findOne({
    tenantId,
    conversationId,
    channel: COMMUNICATION_CHANNEL.INSTAGRAM,
    direction: MESSAGE_DIRECTION.INCOMING,
    "sender.instagramScopedId": recipient,
    "headers.providerOccurredAt": {
      $gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
    deletedAt: null,
  })
    .sort({ createdAt: -1 })
    .select("_id")
    .lean();
  if (!latestIncoming) {
    badRequest({
      message:
        "Instagram is reply-only and the 24-hour customer reply window is closed.",
      code: "INSTAGRAM_REPLY_WINDOW_CLOSED",
    });
  }
};

const audit = (
  context: CommunicationContext,
  values: Record<string, unknown>,
) =>
  recordCommunicationAudit({
    tenantId: context.tenantId,
    actorType: "user",
    actorId: context.userId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    ...values,
  });

const createDelivery = async ({
  tenantId,
  conversationId,
  messageId,
  channel,
  purpose,
  requestedIdempotencyKey,
  settings,
  sendAt,
}: Record<string, any>) => {
  const idempotencyKey =
    requestedIdempotencyKey ||
    buildDeliveryIdempotencyKey({ tenantId, messageId, channel, purpose });
  const delivery = await CommunicationDeliveryModel.findOneAndUpdate(
    { tenantId, idempotencyKey },
    {
      $setOnInsert: {
        tenantId,
        conversationId,
        messageId,
        channel,
        purpose,
        idempotencyKey,
        status: DELIVERY_STATUS.QUEUED,
        attempts: 0,
        maxAttempts: settings?.delivery?.maxAttempts || 4,
        nextAttemptAt: sendAt || new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (!sendAt || new Date(sendAt).getTime() <= Date.now()) {
    return processCommunicationDelivery(delivery._id);
  }
  return delivery;
};

const issueSatisfactionSurveyAtomic = async ({
  tenantId,
  conversation,
  channel,
}: {
  tenantId: string;
  conversation: any;
  channel: string;
}) => {
  const now = new Date();
  const { token, tokenHash } = createSatisfactionToken();
  const values = {
    tenantId,
    conversationId: conversation._id,
    customerId: conversation.customerId,
    tokenHash,
    status: "pending",
    score: null,
    comment: "",
    respondedAt: null,
    channel,
    expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    sentAt: now,
  };

  if (
    typeof (CommunicationSatisfactionSurveyModel as any).create === "function"
  ) {
    try {
      const survey = await CommunicationSatisfactionSurveyModel.create(values);
      return { survey, token, tokenHash, issued: true };
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      // Only one resolver can rotate an expired/cancelled survey because the
      // conditional filter stops matching immediately after the first update.
      const rotated =
        await CommunicationSatisfactionSurveyModel.findOneAndUpdate(
          {
            tenantId,
            conversationId: conversation._id,
            $or: [
              { status: { $in: ["expired", "cancelled"] } },
              { expiresAt: { $lte: now } },
            ],
          },
          { $set: values },
          { returnDocument: "after" },
        );
      if (rotated) return { survey: rotated, token, tokenHash, issued: true };
      const existing = await CommunicationSatisfactionSurveyModel.findOne({
        tenantId,
        conversationId: conversation._id,
      });
      return {
        survey: existing,
        token: null,
        tokenHash: existing?.tokenHash,
        issued: false,
      };
    }
  }

  // Adapter-test compatibility: an upsert still remains safe because the raw
  // token is returned only when its hash matches the persisted winner.
  const survey = await CommunicationSatisfactionSurveyModel.findOneAndUpdate(
    { tenantId, conversationId: conversation._id },
    { $setOnInsert: values },
    { upsert: true, returnDocument: "after" },
  );
  const issued = survey?.tokenHash === tokenHash;
  return {
    survey,
    token: issued ? token : null,
    tokenHash: survey?.tokenHash,
    issued,
  };
};

export const communicationService = {
  async overview(
    context: CommunicationContext,
    input: { locationId?: string } = {},
  ) {
    if (input.locationId) {
      await assertTenantLocation(
        context.tenantId,
        input.locationId,
        context.allowedLocationIds ?? null,
      );
    }
    const baseVisibility = buildConversationVisibilityFilter({
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.role,
      allowedLocationIds: context.allowedLocationIds ?? null,
      view: "all",
    });
    const visibility = input.locationId
      ? { $and: [baseVisibility, { locationId: input.locationId }] }
      : baseVisibility;
    const visibleConversationIds =
      await CommunicationConversationModel.find(visibility).distinct("_id");
    const [
      open,
      unread,
      urgent,
      unassigned,
      needsReview,
      unmatched,
      failedDeliveries,
      response,
    ] = await Promise.all([
      CommunicationConversationModel.countDocuments({
        $and: [visibility, { status: { $ne: "closed" } }],
      }),
      CommunicationConversationModel.countDocuments({
        $and: [visibility, { unreadCount: { $gt: 0 } }],
      }),
      CommunicationConversationModel.countDocuments({
        $and: [visibility, { priority: "urgent", status: { $ne: "closed" } }],
      }),
      CommunicationConversationModel.countDocuments({
        $and: [visibility, { assignedTo: null, status: { $ne: "closed" } }],
      }),
      CommunicationConversationModel.countDocuments({
        $and: [visibility, { "ai.status": "needs_review" }],
      }),
      CommunicationConversationModel.countDocuments({
        $and: [visibility, { "customerMatch.status": "unmatched" }],
      }),
      CommunicationDeliveryModel.countDocuments({
        tenantId: context.tenantId,
        conversationId: { $in: visibleConversationIds },
        status: { $in: ["failed", "bounced", "complained", "rejected"] },
      }),
      CommunicationConversationModel.aggregate([
        { $match: visibility },
        { $match: { firstResponseAt: { $ne: null } } },
        {
          $project: {
            responseMs: { $subtract: ["$firstResponseAt", "$createdAt"] },
          },
        },
        { $group: { _id: null, averageMs: { $avg: "$responseMs" } } },
      ]),
    ]);
    const [memberships, locations] = await Promise.all([
      TenantMembershipModel.find({ tenant: context.tenantId, status: "active" })
        .populate({
          path: "user",
          select: "firstname lastname email isAccessGranted",
        })
        .select("user role locationAccess")
        .lean(),
      LocationModel.find({ tenant: context.tenantId, isActive: { $ne: false } })
        .select("name slug code")
        .sort({ name: 1 })
        .lean(),
    ]);
    const assignees = memberships
      .map((membership: any) => membership.user)
      .filter((user: any) => user && user.isAccessGranted !== false)
      .map((user: any) => ({
        id: id(user._id),
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
      }));
    return {
      counts: {
        open,
        unread,
        urgent,
        unassigned,
        needsReview,
        unmatched,
        failedDeliveries,
      },
      averageFirstResponseMinutes: response[0]?.averageMs
        ? Math.round(response[0].averageMs / 60000)
        : null,
      assignees,
      staff: assignees,
      locations,
    };
  },

  async listConversations(context: CommunicationContext, input: any) {
    const visibility = buildConversationVisibilityFilter({
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.role,
      allowedLocationIds: context.allowedLocationIds ?? null,
      view: input.view,
      includeRestricted: input.includeRestricted,
    });
    const filters: Record<string, unknown>[] = [visibility];
    if (input.direction === "outbound") {
      filters.push({ lastMessageDirection: MESSAGE_DIRECTION.OUTGOING });
      filters.push({ channels: COMMUNICATION_CHANNEL.EMAIL });
    }
    if (input.status) filters.push({ status: input.status });
    if (input.category) filters.push({ category: input.category });
    if (input.priority) filters.push({ priority: input.priority });
    if (input.channel) filters.push({ channels: input.channel });
    if (input.locationId) {
      await assertTenantLocation(
        context.tenantId,
        input.locationId,
        context.allowedLocationIds ?? null,
      );
      filters.push({ locationId: input.locationId });
    }
    if (input.assignedTo) filters.push({ assignedTo: input.assignedTo });
    if (input.customerId) filters.push({ customerId: input.customerId });
    if (input.unreadOnly) filters.push({ unreadCount: { $gt: 0 } });
    if (input.search) {
      const escaped = input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filters.push({
        $or: [
          { subject: { $regex: escaped, $options: "i" } },
          { lastMessagePreview: { $regex: escaped, $options: "i" } },
          { "contact.name": { $regex: escaped, $options: "i" } },
          { "contact.email": { $regex: escaped, $options: "i" } },
        ],
      });
    }
    const filter = { $and: filters };
    const skip = (input.page - 1) * input.limit;
    const [items, total] = await Promise.all([
      CommunicationConversationModel.find(filter)
        .populate("customerId", "firstname lastname email phone customId")
        .populate("assignedTo", "firstname lastname email")
        .populate(
          "customerMatch.candidates.customerId",
          "firstname lastname email phone customId",
        )
        .populate("locationId", "name slug code")
        .sort({ priority: -1, lastMessageAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .lean(),
      CommunicationConversationModel.countDocuments(filter),
    ]);
    const visibleItems = items.map(withConversationReplyEligibility);
    const responseItems =
      input.direction === "outbound"
        ? await hydrateOutboundConversationHistory({
            tenantId: context.tenantId,
            items: visibleItems,
          })
        : visibleItems;
    return {
      items: responseItems,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.ceil(total / input.limit),
      },
    };
  },

  async getConversation(context: CommunicationContext, conversationId: string) {
    let conversation = await getVisibleConversation(
      context,
      conversationId,
      true,
    );
    if (
      typeof (CommunicationConversationModel as any).populate === "function"
    ) {
      conversation = await CommunicationConversationModel.populate(
        conversation,
        [
          {
            path: "customerId",
            select: "firstname lastname email phone customId",
          },
          {
            path: "customerMatch.candidates.customerId",
            select: "firstname lastname email phone customId",
          },
          { path: "assignedTo", select: "firstname lastname email" },
          { path: "locationId", select: "name slug code" },
        ],
      );
    }
    await CommunicationConversationModel.updateOne(
      { _id: conversationId, tenantId: context.tenantId },
      { $set: { unreadCount: 0 } },
    );
    return withConversationReplyEligibility(conversation);
  },

  async createConversation(context: CommunicationContext, input: any) {
    await assertTenantLocation(
      context.tenantId,
      input.locationId,
      context.allowedLocationIds ?? null,
    );
    const [customer] = await Promise.all([
      assertTenantCustomer(context.tenantId, input.customerId),
      assertTenantUser(context.tenantId, input.assignedTo),
      assertTenantUsers(context.tenantId, input.allowedUserIds || []),
    ]);
    const conversation = await CommunicationConversationModel.create({
      tenantId: context.tenantId,
      subject: input.subject,
      channels: [input.channel],
      customerId: customer?._id || null,
      contact: customer ? customerContact(customer) : input.contact || {},
      customerMatch: customer
        ? { status: "matched", confidence: 1, candidates: [] }
        : { status: "unmatched", confidence: 0, candidates: [] },
      locationId: input.locationId,
      assignedTo: input.assignedTo,
      assignedTeam: input.assignedTeam,
      priority: input.priority,
      category: input.category,
      language: input.language,
      restricted: input.restricted,
      allowedUserIds: input.allowedUserIds,
      relatedEntities: input.relatedEntities,
      tags: input.tags,
      createdBy: context.userId,
    });
    await audit(context, {
      action: AUDIT_ACTION.CREATED,
      resourceType: "conversation",
      resourceId: conversation._id,
      conversationId: conversation._id,
      locationId: conversation.locationId,
      summary: "Conversation created.",
    });
    return conversation;
  },

  async updateConversation(
    context: CommunicationContext,
    conversationId: string,
    input: any,
  ) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
    );
    const before = conversation.toObject();
    if (input.locationId !== undefined) {
      await assertTenantLocation(
        context.tenantId,
        input.locationId,
        context.allowedLocationIds ?? null,
      );
    }
    if (input.customerId !== undefined) {
      const customer = await assertTenantCustomer(
        context.tenantId,
        input.customerId,
      );
      conversation.customerId = customer?._id || null;
      if (customer) {
        // Preserve provider-scoped identities collected from inbound social
        // messages when a staff member links the conversation to a customer.
        conversation.contact = {
          ...customerContact(customer),
          instagramScopedId: conversation.contact?.instagramScopedId || "",
          instagramUsername: conversation.contact?.instagramUsername || "",
        };
        conversation.customerMatch = {
          status: "matched",
          confidence: 1,
          candidates: [],
          reviewedBy: context.userId,
          reviewedAt: new Date(),
        };
      } else {
        conversation.customerMatch.status = "unmatched";
        conversation.customerMatch.confidence = 0;
      }
    }
    if (input.assignedTo !== undefined)
      await assertTenantUser(context.tenantId, input.assignedTo);
    if (input.allowedUserIds !== undefined) {
      await assertTenantUsers(context.tenantId, input.allowedUserIds);
    }
    for (const field of [
      "subject",
      "status",
      "priority",
      "category",
      "language",
      "locationId",
      "assignedTo",
      "assignedTeam",
      "restricted",
      "allowedUserIds",
      "tags",
      "snoozedUntil",
      "relatedEntities",
    ]) {
      if (input[field] !== undefined && field !== "customerId")
        conversation[field] = input[field];
    }
    if (input.status === "closed") {
      conversation.resolvedAt = new Date();
      conversation.resolvedBy = context.userId;
    } else if (input.status && input.status !== "closed") {
      conversation.resolvedAt = null;
      conversation.resolvedBy = null;
    }
    await conversation.save();
    await audit(context, {
      action: AUDIT_ACTION.UPDATED,
      resourceType: "conversation",
      resourceId: conversation._id,
      conversationId: conversation._id,
      locationId: conversation.locationId,
      before,
      after: conversation.toObject(),
      summary: "Conversation updated.",
    });
    return conversation;
  },

  async listMessages(
    context: CommunicationContext,
    conversationId: string,
    input: any,
  ) {
    await getVisibleConversation(context, conversationId, true);
    const filter: Record<string, unknown> = {
      tenantId: context.tenantId,
      conversationId,
      deletedAt: null,
    };
    if (!input.includeInternal) filter.isInternal = false;
    if (input.before) filter.createdAt = { $lt: input.before };
    if (input.after)
      filter.createdAt = { ...(filter.createdAt as object), $gt: input.after };
    const items = await CommunicationMessageModel.find(filter)
      .populate("createdBy", "firstname lastname email")
      .sort({ createdAt: -1 })
      .limit(input.limit)
      .lean();
    const deliveries = await CommunicationDeliveryModel.find({
      tenantId: context.tenantId,
      conversationId,
      messageId: { $in: items.map((item) => item._id) },
    })
      .sort({ createdAt: -1 })
      .lean();
    const byMessage = new Map<string, any[]>();
    for (const delivery of deliveries) {
      const key = id(delivery.messageId);
      byMessage.set(key, [...(byMessage.get(key) || []), delivery]);
    }
    return {
      items: await Promise.all(
        items.reverse().map(async (message) => {
          const messageDeliveries = byMessage.get(id(message._id)) || [];
          const visibleMessage = await withPrivateMediaUrls(
            context.tenantId,
            message,
          );
          return {
            ...visibleMessage,
            deliveries: messageDeliveries,
            delivery: messageDeliveries[0] || null,
            deliveryStatus: messageDeliveries[0]?.status || null,
          };
        }),
      ),
    };
  },

  async compose(context: CommunicationContext, input: any) {
    if (
      [
        COMMUNICATION_CHANNEL.WHATSAPP,
        COMMUNICATION_CHANNEL.INSTAGRAM,
      ].includes(input.channel)
    ) {
      badRequest({
        message: `${input.channel} delivery is not available yet.`,
        code: "CHANNEL_RETIRED",
      });
    }
    assertOutboundEmailContentSupported({
      channel: input.channel,
      attachments: input.attachments,
    });
    const linkedCustomer = await assertTenantCustomer(
      context.tenantId,
      input.customerId,
    );
    if (linkedCustomer) {
      input.to = [
        canonicalizeCustomerComposeRecipient({
          channel: input.channel,
          customer: linkedCustomer,
          requestedRecipient: input.to?.[0],
        }),
      ];
    }
    if (input.idempotencyKey) {
      const existingMessageQuery: any = CommunicationMessageModel.findOne({
        tenantId: context.tenantId,
        idempotencyKey: input.idempotencyKey,
      });
      const existingMessage: any =
        typeof existingMessageQuery?.lean === "function"
          ? await existingMessageQuery.lean()
          : await existingMessageQuery;
      if (existingMessage) {
        const conversation: any = await getVisibleConversation(
          context,
          id(existingMessage.conversationId),
          true,
        );
        const existingRecipients = (existingMessage.recipients || []).map(
          (recipient: any) => ({
            email: String(recipient.email || "")
              .trim()
              .toLowerCase(),
            whatsappId: String(
              recipient.whatsappId || recipient.phone || "",
            ).replace(/\D/g, ""),
            instagramScopedId: String(recipient.instagramScopedId || "").trim(),
          }),
        );
        const requestedRecipients = (input.to || []).map((recipient: any) => ({
          email: String(recipient.email || "")
            .trim()
            .toLowerCase(),
          whatsappId: String(
            recipient.whatsappId || recipient.phone || "",
          ).replace(/\D/g, ""),
          instagramScopedId: String(recipient.instagramScopedId || "").trim(),
        }));
        const samePayload =
          (existingMessage.channel === undefined ||
            existingMessage.channel === input.channel) &&
          (existingMessage.subject === undefined ||
            String(existingMessage.subject || "") ===
              String(input.subject || "")) &&
          (existingMessage.text === undefined ||
            String(existingMessage.text || "") === String(input.text || "")) &&
          (!existingRecipients.length ||
            JSON.stringify(existingRecipients) ===
              JSON.stringify(requestedRecipients));
        if (!samePayload) {
          conflict({
            message:
              "Idempotency key was already used for a different message.",
            code: "COMMUNICATION_IDEMPOTENCY_CONFLICT",
          });
        }
        const delivery = await CommunicationDeliveryModel.findOne({
          tenantId: context.tenantId,
          messageId: existingMessage._id,
        });
        return {
          conversation,
          message: existingMessage,
          delivery,
          idempotentReplay: true,
        };
      }
    }
    let managedSender: ResolvedManagedSender | null = null;
    if (input.channel === COMMUNICATION_CHANNEL.EMAIL) {
      // Gate manual sends before creating a conversation, message or delivery.
      // The delivery worker resolves again immediately before provider contact
      // so a sender disabled between these points still fails closed.
      managedSender = await resolveOutboundComposeSender({
        tenantId: context.tenantId,
        channel: input.channel,
      });
    }
    if (!input.conversationId) {
      await assertTenantLocation(
        context.tenantId,
        input.locationId,
        context.allowedLocationIds ?? null,
      );
    }
    const settings: any = await getSettings(context.tenantId, context.userId);
    let conversation: any;
    if (input.conversationId) {
      conversation = await getVisibleConversation(
        context,
        input.conversationId,
      );
    } else {
      const customer = linkedCustomer;
      conversation = await CommunicationConversationModel.create({
        tenantId: context.tenantId,
        subject: input.subject || "New message",
        channels: [input.channel],
        customerId: customer?._id || null,
        contact: customer ? customerContact(customer) : input.to[0] || {},
        customerMatch: customer
          ? { status: "matched", confidence: 1 }
          : { status: "unmatched", confidence: 0 },
        locationId: input.locationId,
        category: input.category,
        priority: input.priority,
        language: input.language,
        createdBy: context.userId,
      });
    }
    assertLocationScope(
      conversation.locationId,
      context.allowedLocationIds ?? null,
    );
    if (input.conversationId) {
      const contact = conversation.contact || {};
      const requested = input.to?.[0] || {};
      const canonical =
        input.channel === COMMUNICATION_CHANNEL.EMAIL
          ? { name: contact.name || "", email: contact.email || "" }
          : input.channel === COMMUNICATION_CHANNEL.WHATSAPP
            ? {
                name: contact.name || "",
                phone: contact.phone || "",
                whatsappId: contact.whatsappId || contact.phone || "",
              }
            : input.channel === COMMUNICATION_CHANNEL.INSTAGRAM
              ? {
                  name: contact.name || "",
                  instagramScopedId: contact.instagramScopedId || "",
                  instagramUsername: contact.instagramUsername || "",
                  externalId: contact.instagramScopedId || "",
                }
              : {
                  name: contact.name || "",
                  externalId: contact.externalId || id(conversation.customerId),
                };
      const requestedIdentity =
        input.channel === COMMUNICATION_CHANNEL.EMAIL
          ? String(requested.email || "")
              .trim()
              .toLowerCase()
          : input.channel === COMMUNICATION_CHANNEL.WHATSAPP
            ? String(requested.whatsappId || requested.phone || "").replace(
                /\D/g,
                "",
              )
            : input.channel === COMMUNICATION_CHANNEL.INSTAGRAM
              ? String(requested.instagramScopedId || "").trim()
              : String(requested.externalId || "").trim();
      const canonicalIdentity =
        input.channel === COMMUNICATION_CHANNEL.EMAIL
          ? String((canonical as any).email || "")
              .trim()
              .toLowerCase()
          : input.channel === COMMUNICATION_CHANNEL.WHATSAPP
            ? String(
                (canonical as any).whatsappId || (canonical as any).phone || "",
              ).replace(/\D/g, "")
            : input.channel === COMMUNICATION_CHANNEL.INSTAGRAM
              ? String((canonical as any).instagramScopedId || "").trim()
              : String((canonical as any).externalId || "").trim();
      if (!canonicalIdentity || requestedIdentity !== canonicalIdentity) {
        badRequest({
          message:
            "Conversation messages must use the customer's channel identity from the conversation.",
          code: "COMMUNICATION_RECIPIENT_MISMATCH",
        });
      }
      input.to = [canonical];
    }
    if (input.channel === COMMUNICATION_CHANNEL.INSTAGRAM) {
      const recipient = input.to?.[0]?.instagramScopedId;
      if (
        String(recipient || "") !==
        String(conversation.contact?.instagramScopedId || "")
      ) {
        badRequest({
          message:
            "Instagram replies must use the identity from the inbound conversation.",
          code: "INSTAGRAM_RECIPIENT_MISMATCH",
        });
      }
      await assertInstagramReplyEligibility({
        tenantId: context.tenantId,
        conversationId: conversation._id,
        instagramScopedId: recipient,
        replyWindowExpiresAt:
          conversation.metadata?.instagram?.replyWindowExpiresAt,
      });
    }
    let replyToMessage: any = null;
    if (input.replyToMessageId) {
      let replyQuery: any = CommunicationMessageModel.findOne({
        _id: input.replyToMessageId,
        tenantId: context.tenantId,
        conversationId: conversation._id,
        deletedAt: null,
      });
      if (typeof replyQuery?.select === "function") {
        replyQuery = replyQuery.select(
          "channel providerMessageId headers conversationId",
        );
      }
      replyToMessage =
        typeof replyQuery?.lean === "function"
          ? await replyQuery.lean()
          : await replyQuery;
      if (!replyToMessage) notFound("Reply-to message not found.");
    }
    const messageObjectId = new mongoose.Types.ObjectId();
    const priorMessageId =
      input.channel === COMMUNICATION_CHANNEL.EMAIL &&
      replyToMessage?.channel === COMMUNICATION_CHANNEL.EMAIL
        ? safeThreadHeader(
            replyToMessage.headers?.messageId ||
              replyToMessage.providerMessageId,
          )
        : "";
    const references = priorMessageId
      ? [
          ...new Set([
            ...threadReferences(replyToMessage?.headers?.references),
            priorMessageId,
          ]),
        ].slice(-50)
      : [];
    const message = await CommunicationMessageModel.create({
      _id: messageObjectId,
      tenantId: context.tenantId,
      conversationId: conversation._id,
      direction: MESSAGE_DIRECTION.OUTGOING,
      channel: input.channel,
      kind: input.html && !input.text ? "html" : "text",
      sender: {
        name: managedSender?.displayName || "Studio",
        email: managedSender?.fromEmail || "",
      },
      recipients: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
      whatsappTemplate: input.whatsappTemplate || {},
      replyToMessageId: input.replyToMessageId || null,
      idempotencyKey: input.idempotencyKey || "",
      headers:
        input.channel === COMMUNICATION_CHANNEL.EMAIL
          ? {
              messageId: `<shario.${messageObjectId}.${context.tenantId}@${
                process.env.POSTMARK_FROM_DOMAIN || "notify.shario.io"
              }>`,
              inReplyTo: priorMessageId,
              references,
            }
          : {},
      language: input.language,
      createdBy: context.userId,
      approvedBy: context.userId,
    });
    conversation.channels = [
      ...new Set([...(conversation.channels || []), input.channel]),
    ];
    conversation.lastMessageAt = new Date();
    conversation.lastMessageDirection = MESSAGE_DIRECTION.OUTGOING;
    conversation.lastMessagePreview =
      input.text || input.subject || "Attachment";
    if (!conversation.firstResponseAt)
      conversation.firstResponseAt = new Date();
    await conversation.save();
    const delivery = await createDelivery({
      tenantId: context.tenantId,
      conversationId: conversation._id,
      messageId: message._id,
      channel: input.channel,
      purpose: input.purpose,
      requestedIdempotencyKey: input.idempotencyKey,
      settings,
      sendAt: input.sendAt,
    });
    await audit(context, {
      action: AUDIT_ACTION.MESSAGE_SENT,
      resourceType: "message",
      resourceId: message._id,
      conversationId: conversation._id,
      locationId: conversation.locationId,
      summary: `Message queued through ${input.channel}.`,
      metadata: { purpose: input.purpose, deliveryId: delivery?._id },
    });
    return { conversation, message, delivery, idempotentReplay: false };
  },

  async reply(
    context: CommunicationContext,
    conversationId: string,
    input: any,
  ) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
    );
    const contact = conversation.contact || {};
    let replyToMessageId = input.replyToMessageId || null;
    if (input.channel === COMMUNICATION_CHANNEL.EMAIL && !replyToMessageId) {
      let latestIncomingQuery: any = CommunicationMessageModel.findOne({
        tenantId: context.tenantId,
        conversationId,
        channel: COMMUNICATION_CHANNEL.EMAIL,
        direction: MESSAGE_DIRECTION.INCOMING,
        deletedAt: null,
      });
      if (typeof latestIncomingQuery?.sort === "function") {
        latestIncomingQuery = latestIncomingQuery.sort({ createdAt: -1 });
      }
      if (typeof latestIncomingQuery?.select === "function") {
        latestIncomingQuery = latestIncomingQuery.select("_id");
      }
      const latestIncoming =
        typeof latestIncomingQuery?.lean === "function"
          ? await latestIncomingQuery.lean()
          : await latestIncomingQuery;
      replyToMessageId = latestIncoming?._id || null;
    }
    const recipient =
      input.channel === "email"
        ? { name: contact.name || "", email: contact.email || "" }
        : input.channel === "whatsapp"
          ? {
              name: contact.name || "",
              phone: contact.phone || "",
              whatsappId: contact.whatsappId || contact.phone || "",
            }
          : input.channel === "instagram"
            ? {
                name: contact.name || "",
                instagramScopedId: contact.instagramScopedId || "",
                instagramUsername: contact.instagramUsername || "",
                externalId: contact.instagramScopedId || "",
              }
            : {
                name: contact.name || "",
                externalId: id(conversation.customerId),
              };
    if (input.channel === "email" && !recipient.email)
      badRequest("Customer email address is missing.");
    if (input.channel === "whatsapp" && !(recipient as any).whatsappId)
      badRequest("Customer WhatsApp number is missing.");
    if (input.channel === "instagram" && !(recipient as any).instagramScopedId)
      badRequest("Customer Instagram identity is missing.");
    return this.compose(context, {
      ...input,
      conversationId,
      replyToMessageId,
      customerId: id(conversation.customerId) || null,
      to: [recipient],
      locationId: id(conversation.locationId) || null,
      category: conversation.category,
      priority: conversation.priority,
      language: conversation.language,
      subject: input.subject || `Re: ${conversation.subject}`,
    });
  },

  async addNote(
    context: CommunicationContext,
    conversationId: string,
    input: any,
  ) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
    );
    const message = await CommunicationMessageModel.create({
      tenantId: context.tenantId,
      conversationId,
      direction: MESSAGE_DIRECTION.INTERNAL,
      channel: COMMUNICATION_CHANNEL.IN_APP,
      kind: "note",
      text: input.text,
      isInternal: true,
      createdBy: context.userId,
      headers: { mentions: input.mentions },
    });
    await audit(context, {
      action: AUDIT_ACTION.NOTE_ADDED,
      resourceType: "message",
      resourceId: message._id,
      conversationId,
      locationId: conversation.locationId,
      summary: "Internal note added.",
    });
    return message;
  },

  async assign(
    context: CommunicationContext,
    conversationId: string,
    input: any,
  ) {
    await assertTenantUser(context.tenantId, input.assignedTo);
    return this.updateConversation(context, conversationId, input);
  },

  async resolve(
    context: CommunicationContext,
    conversationId: string,
    input: any,
  ) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
    );
    conversation.status = CONVERSATION_STATUS.CLOSED;
    conversation.resolvedAt = new Date();
    conversation.resolvedBy = context.userId;
    await conversation.save();
    if (input.resolutionNote) {
      await this.addNote(context, conversationId, {
        text: input.resolutionNote,
        mentions: [],
      });
    }
    let satisfaction: any = null;
    if (input.sendSatisfactionSurvey) {
      const settings = await getSettings(context.tenantId, context.userId);
      if (settings.satisfaction?.enabled !== false) {
        const categories = settings.satisfaction?.sendForCategories || [];
        if (categories.length && !categories.includes(conversation.category)) {
          satisfaction = { skipped: true, reason: "category_not_enabled" };
        } else {
          {
            const cooldownSince = new Date(
              Date.now() -
                (settings.satisfaction?.cooldownDays || 30) * 86_400_000,
            );
            const recentSurvey =
              conversation.customerId &&
              typeof (CommunicationSatisfactionSurveyModel as any).exists ===
                "function"
                ? await CommunicationSatisfactionSurveyModel.exists({
                    tenantId: context.tenantId,
                    customerId: conversation.customerId,
                    sentAt: { $gte: cooldownSince },
                    conversationId: { $ne: conversationId },
                  })
                : null;
            if (recentSurvey) {
              satisfaction = { skipped: true, reason: "customer_cooldown" };
            } else {
              const instagramWindowExpiresAt = new Date(
                conversation.metadata?.instagram?.replyWindowExpiresAt || 0,
              ).getTime();
              let surveyChannel = input.satisfactionChannel;
              if (
                surveyChannel === "instagram" &&
                (!conversation.contact?.instagramScopedId ||
                  !Number.isFinite(instagramWindowExpiresAt) ||
                  instagramWindowExpiresAt <= Date.now())
              ) {
                surveyChannel = conversation.contact?.email ? "email" : null;
              }
              if (
                surveyChannel === "whatsapp" &&
                !conversation.contact?.whatsappId &&
                !conversation.contact?.phone
              ) {
                surveyChannel = conversation.contact?.email ? "email" : null;
              }
              const hasRecipient =
                (surveyChannel === "email" && conversation.contact?.email) ||
                (surveyChannel === "whatsapp" &&
                  (conversation.contact?.whatsappId ||
                    conversation.contact?.phone)) ||
                (surveyChannel === "instagram" &&
                  conversation.contact?.instagramScopedId) ||
                surveyChannel === "in_app";
              if (!surveyChannel || !hasRecipient) {
                satisfaction = {
                  skipped: true,
                  reason:
                    input.satisfactionChannel === "instagram"
                      ? "instagram_reply_window_closed"
                      : "recipient_missing",
                };
              } else {
                const issuedSurvey = await issueSatisfactionSurveyAtomic({
                  tenantId: context.tenantId,
                  conversation,
                  channel: surveyChannel,
                });
                const survey = issuedSurvey.survey;
                const safeToken = issuedSurvey.token;
                const url = safeToken
                  ? `${process.env.CLIENT_URL || ""}/satisfaction/${safeToken}`
                  : null;
                let deliveryResult: any = null;
                if (
                  url &&
                  ((surveyChannel === "email" && conversation.contact?.email) ||
                    (surveyChannel === "whatsapp" &&
                      (conversation.contact?.whatsappId ||
                        conversation.contact?.phone)) ||
                    (surveyChannel === "instagram" &&
                      conversation.contact?.instagramScopedId) ||
                    surveyChannel === "in_app")
                ) {
                  deliveryResult = await this.reply(context, conversationId, {
                    channel: surveyChannel,
                    subject: "How was your experience?",
                    text: `Thank you for contacting us. Please rate your experience: ${url}`,
                    html: "",
                    attachments: [],
                    purpose:
                      surveyChannel === "instagram"
                        ? "support"
                        : "transactional",
                    idempotencyKey: `csat-${survey._id}`,
                    replyToMessageId: null,
                  });
                }
                satisfaction = {
                  survey,
                  token: safeToken,
                  url,
                  alreadySent: !issuedSurvey.issued,
                  delivery: deliveryResult?.delivery || null,
                };
              }
            }
          }
        }
      }
    }
    return { conversation, satisfaction };
  },

  async createTask(
    context: CommunicationContext,
    conversationId: string,
    input: any,
  ) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
      true,
    );
    await assertTenantUser(context.tenantId, input.assignedTo);
    const locationId = conversation.locationId || null;
    const appliesToAllLocations =
      input.appliesToAllLocations ??
      (!locationId &&
        (context.allowedLocationIds === null ||
          context.allowedLocationIds === undefined));
    if (
      appliesToAllLocations &&
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined
    ) {
      forbidden(
        "You cannot create an all-location task with location-limited access.",
      );
    }
    const taskInput = createStaffTaskSchema.parse({
      title: input.title || `Follow up: ${conversation.subject}`,
      description: input.description || "",
      locationId: appliesToAllLocations ? null : locationId,
      appliesToAllLocations,
      assignedTo: input.assignedTo,
      dueDate: input.dueDate,
      priority: input.priority,
      category: "customer-support",
      status: "todo",
    });
    const task = await staffTaskService.create(
      {
        tenantId: context.tenantId,
        id: context.userId,
        allowedLocationIds: context.allowedLocationIds,
      },
      taskInput,
      {
        source: "communication",
        communicationConversationId: conversationId,
      },
    );
    await CommunicationConversationModel.updateOne(
      { _id: conversationId, tenantId: context.tenantId },
      {
        $addToSet: {
          relatedEntities: { type: "task", id: task._id, label: task.title },
        },
      },
    );
    await audit(context, {
      action: AUDIT_ACTION.TASK_CREATED,
      resourceType: "task",
      resourceId: task._id,
      conversationId,
      locationId,
      summary: "Conversation converted to a task.",
    });
    return task;
  },

  async analyze(context: CommunicationContext, conversationId: string) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
    );
    const messages = await CommunicationMessageModel.find({
      tenantId: context.tenantId,
      conversationId,
      isInternal: false,
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .select("direction text transcript")
      .lean();
    const text = messages
      .map((message) => message.transcript || message.text || "")
      .filter(Boolean)
      .join("\n");
    const analysis = await analyzeCommunicationText(text, {
      aiContext: communicationAiContext(
        context,
        conversation.locationId,
        conversation.language || undefined,
      ),
      idempotencyKey: `communication-analysis:${conversationId}:${stableHash(text)}`,
    });
    conversation.ai = analysis;
    if (analysis.confidence >= AI_AUTO_APPLY_CONFIDENCE) {
      conversation.category = analysis.category;
      conversation.priority = analysis.priority;
      conversation.language = analysis.language;
    }
    await conversation.save();
    await audit(context, {
      action: AUDIT_ACTION.AI_ANALYZED,
      actorType: "ai",
      resourceType: "conversation",
      resourceId: conversation._id,
      conversationId,
      locationId: conversation.locationId,
      summary: `AI categorized the conversation as ${analysis.category}.`,
      metadata: { confidence: analysis.confidence, model: analysis.model },
    });
    return analysis;
  },

  async draft(
    context: CommunicationContext,
    conversationId: string,
    input: any,
  ) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
      true,
    );
    const messages = await CommunicationMessageModel.find({
      tenantId: context.tenantId,
      conversationId,
      isInternal: false,
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .select("direction channel text transcript createdAt")
      .lean();
    const lastIncomingText = [...messages]
      .reverse()
      .find((message: any) => message.direction === "incoming");
    const knowledgeRetrieval = await retrieveKnowledge({
      context: communicationAiContext(
        context,
        conversation.locationId,
        input.language || conversation.language || "en",
      ),
      query: String(
        lastIncomingText?.transcript ||
          lastIncomingText?.text ||
          conversation.subject ||
          "",
      ),
      limit: 12,
      retrievalId: `communication-draft:${conversationId}:${Date.now()}`,
    });
    const knowledge = knowledgeRetrieval.sources;
    const result = await draftCommunicationReply({
      conversation,
      messages,
      knowledge,
      knowledgeCoverage: knowledgeRetrieval.coverage,
      instructions: input.instructions,
      tone: input.tone,
      language: input.language || conversation.language || "en",
      aiContext: communicationAiContext(
        context,
        conversation.locationId,
        input.language || conversation.language || "en",
      ),
      idempotencyKey: `communication-draft:${conversationId}:${stableHash({
        messages,
        knowledge: knowledge.map((article: any) => ({
          id: article.id,
          resourceId: article.resourceId,
          version: article.version,
          contentHash: article.contentHash,
          updatedAt: article.updatedAt,
        })),
        knowledgeCoverage: {
          status: knowledgeRetrieval.coverage.status,
          mode: knowledgeRetrieval.coverage.mode,
          confidence: knowledgeRetrieval.coverage.confidence,
          retrievedAt: knowledgeRetrieval.coverage.retrievedAt,
        },
        instructions: input.instructions,
        tone: input.tone,
        language: input.language || conversation.language || "en",
      })}`,
    });
    await audit(context, {
      action: AUDIT_ACTION.AI_DRAFTED,
      actorType: "ai",
      resourceType: "conversation",
      resourceId: conversationId,
      conversationId,
      locationId: conversation.locationId,
      summary: "AI prepared a reply draft.",
      metadata: {
        provider: result.provider,
        knowledgeSources: result.knowledgeSources,
      },
    });
    return result;
  },

  async translate(
    context: CommunicationContext,
    messageId: string,
    input: any,
  ) {
    const message: any = await CommunicationMessageModel.findOne({
      _id: messageId,
      tenantId: context.tenantId,
    });
    if (!message) notFound("Message not found.");
    const conversation: any = await getVisibleConversation(
      context,
      id(message.conversationId),
      true,
    );
    const sourceText = message.transcript || message.text || "";
    const result = await translateCommunicationText(
      sourceText,
      input.targetLanguage,
      {
        aiContext: communicationAiContext(
          context,
          conversation.locationId,
          input.targetLanguage,
        ),
        idempotencyKey: `communication-translation:${messageId}:${input.targetLanguage}:${stableHash(sourceText)}`,
      },
    );
    message.translations.set(input.targetLanguage, result.text);
    await message.save();
    return result;
  },

  async transcribe(
    context: CommunicationContext,
    messageId: string,
    input: any,
  ) {
    const message: any = await CommunicationMessageModel.findOne({
      _id: messageId,
      tenantId: context.tenantId,
    });
    if (!message) notFound("Message not found.");
    const conversation: any = await getVisibleConversation(
      context,
      id(message.conversationId),
      true,
    );
    if (
      message.kind !== "voice" &&
      !message.attachments?.some((attachment: any) =>
        String(attachment.contentType).startsWith("audio/"),
      )
    ) {
      badRequest("Message does not contain a voice recording.");
    }
    const audioAttachment = message.attachments?.find((attachment: any) =>
      String(attachment.contentType).startsWith("audio/"),
    );
    const audioUrl = audioAttachment?.url;
    const r2Key = getOwnedCommunicationR2Key(context.tenantId, audioUrl);
    const audioBuffer = r2Key
      ? await getObjectBufferFromR2({ key: r2Key })
      : null;
    const result = await transcribeCommunicationAudio({
      audioUrl: audioBuffer ? undefined : audioUrl,
      audioBase64: audioBuffer?.toString("base64"),
      contentType: audioAttachment?.contentType,
      transcriptHint: input.transcriptHint,
      languageHint: input.languageHint,
      aiContext: communicationAiContext(
        context,
        conversation.locationId,
        input.languageHint,
      ),
      idempotencyKey: `communication-transcription:${messageId}:${
        audioAttachment?.checksum || audioAttachment?.size || "audio"
      }`,
    });
    message.transcript = result.text;
    if (result.language) message.language = result.language;
    await message.save();
    return result;
  },

  async decideAction(
    context: CommunicationContext,
    conversationId: string,
    actionId: string,
    input: any,
  ) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
    );
    const action = conversation.ai?.actions?.id(actionId);
    if (!action) notFound("Suggested action not found.");
    if (action.status !== "suggested")
      conflict("Suggested action has already been decided.");

    const decidedAt = new Date();

    if (input.decision === "dismiss") {
      const dismissed = await CommunicationConversationModel.findOneAndUpdate(
        {
          _id: conversationId,
          tenantId: context.tenantId,
          "ai.actions": {
            $elemMatch: { _id: actionId, status: "suggested" },
          },
        },
        {
          $set: {
            "ai.actions.$.status": "dismissed",
            "ai.actions.$.decidedBy": context.userId,
            "ai.actions.$.decidedAt": decidedAt,
          },
        },
        { returnDocument: "after" },
      );

      if (!dismissed) {
        conflict("Suggested action has already been decided.");
      }

      const dismissedAction = dismissed.ai?.actions?.id(actionId);
      return { action: dismissedAction, result: null, navigationTarget: null };
    }

    /*
     * Action authorization is deliberately checked in the executor, not only
     * on the route. New AI action keys can require different permissions and
     * a route-level communications permission must never become a blanket
     * authorization to mutate another workspace domain.
     */
    if (action.key === "create_task") {
      const access = await resolveWorkspaceAccessForUser({
        tenantId: context.tenantId,
        userId: context.userId,
      });

      if (!hasWorkspacePermission(access, WORKSPACE_PERMISSION.TASKS_MANAGE)) {
        // This check happens before the atomic claim so an unauthorized attempt
        // leaves the suggestion available for an authorized colleague.
        forbidden({
          message:
            "Task management permission is required to approve this action.",
          code: "WORKSPACE_PERMISSION_REQUIRED",
          details: { requiredPermissions: [WORKSPACE_PERMISSION.TASKS_MANAGE] },
        });
      }
    }

    const claimed = await CommunicationConversationModel.findOneAndUpdate(
      {
        _id: conversationId,
        tenantId: context.tenantId,
        "ai.actions": {
          $elemMatch: { _id: actionId, status: "suggested" },
        },
      },
      {
        $set: {
          "ai.actions.$.status": "approved",
          "ai.actions.$.decidedBy": context.userId,
          "ai.actions.$.decidedAt": decidedAt,
        },
      },
      { returnDocument: "after" },
    );

    if (!claimed) {
      conflict("Suggested action has already been decided.");
    }

    const claimedAction = claimed.ai?.actions?.id(actionId);
    let result: any = null;
    if (claimedAction.key === "create_task") {
      /*
       * The execution payload comes exclusively from the stored suggestion.
       * The approval request cannot replace it with attacker-controlled data.
       */
      const storedMetadata =
        claimedAction.metadata && typeof claimedAction.metadata === "object"
          ? claimedAction.metadata
          : {};
      const storedPayload =
        storedMetadata.payload && typeof storedMetadata.payload === "object"
          ? storedMetadata.payload
          : storedMetadata;
      const taskInput = createConversationTaskSchema.parse({
        ...storedPayload,
        title:
          typeof storedPayload.title === "string" && storedPayload.title.trim()
            ? storedPayload.title
            : `Follow up: ${claimed.subject}`,
        priority: storedPayload.priority || claimed.priority,
      });

      try {
        result = await this.createTask(context, conversationId, taskInput);
        claimedAction.status = "completed";
      } catch (error) {
        claimedAction.status = "failed";
        await claimed.save();
        throw error;
      }
    }
    await claimed.save();
    return {
      action: claimedAction,
      result,
      navigationTarget: claimedAction.key.includes("booking")
        ? "/app/bookings"
        : claimedAction.key.includes("payment") ||
              claimedAction.key.includes("invoice")
            ? "/app/payments"
            : null,
    };
  },

  async createCustomer(context: CommunicationContext, conversationId: string) {
    const conversation: any = await getVisibleConversation(
      context,
      conversationId,
    );
    if (conversation.customerId)
      conflict("Conversation is already linked to a customer.");
    const email = String(conversation.contact?.email || "")
      .trim()
      .toLowerCase();
    if (!email)
      badRequest(
        "An email address is required to create a customer from this conversation.",
      );
    const parts = String(conversation.contact?.name || "Customer")
      .trim()
      .split(/\s+/);
    const customer = await UserModel.create({
      tenant: context.tenantId,
      firstname: parts.shift() || "Customer",
      lastname: parts.join(" ") || "Contact",
      email,
      phone: conversation.contact?.phone || "",
      password: randomBytes(32).toString("base64url"),
      tenantRole: TENANT_ROLE.CUSTOMER,
      customId: `comm-${Date.now()}-${randomBytes(4).toString("hex")}`,
      isAccessGranted: true,
      isEmailVerified: false,
    });
    conversation.customerId = customer._id;
    conversation.customerMatch = {
      status: "matched",
      confidence: 1,
      candidates: [],
      reviewedBy: context.userId,
      reviewedAt: new Date(),
    };
    await conversation.save();
    return customer;
  },

  async timeline(context: CommunicationContext, customerId: string) {
    await assertTenantCustomer(context.tenantId, customerId);
    const visibility = buildConversationVisibilityFilter({
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.role,
      allowedLocationIds: context.allowedLocationIds ?? null,
      view: "all",
    });
    const conversations = await CommunicationConversationModel.find({
      $and: [visibility, { customerId }],
    })
      .select("_id subject category status channels locationId lastMessageAt")
      .lean();
    const conversationIds = conversations.map((item) => item._id);
    const messages = await CommunicationMessageModel.find({
      tenantId: context.tenantId,
      conversationId: { $in: conversationIds },
      isInternal: false,
      deletedAt: null,
    })
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();
    return {
      conversations,
      messages: await Promise.all(
        messages.map((message) =>
          withPrivateMediaUrls(context.tenantId, message),
        ),
      ),
    };
  },

  retryDelivery: retryCommunicationDelivery,
  fallbackDelivery: fallbackCommunicationDelivery,
};

export const communicationManagementService = {
  async listKnowledge(context: CommunicationContext, input: any) {
    const filter: Record<string, any> = {
      tenantId: context.tenantId,
      deletedAt: null,
    };
    if (input.status) filter.status = input.status;
    if (input.category) filter.category = input.category;
    if (input.audience) filter.audience = input.audience;
    if (input.type) filter.type = input.type;
    if (input.language) filter.language = input.language;
    if (input.search) filter.$text = { $search: input.search };
    if (context.role !== WORKSPACE_ROLE.OWNER) {
      filter.audience = input.audience ? input.audience : { $ne: "owner" };
      if (input.audience === "owner") {
        return {
          items: [],
          pagination: {
            page: input.page,
            limit: input.limit,
            total: 0,
            pages: 0,
          },
        };
      }
    }
    if (
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined
    ) {
      filter.$or = [
        { locationIds: { $size: 0 } },
        { locationIds: { $exists: false } },
        { locationIds: { $in: context.allowedLocationIds } },
      ];
    }
    const [items, total] = await Promise.all([
      CommunicationKnowledgeArticleModel.find(filter)
        .sort({ updatedAt: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .lean(),
      CommunicationKnowledgeArticleModel.countDocuments(filter),
    ]);
    return {
      items,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.ceil(total / input.limit),
      },
    };
  },

  async getKnowledge(context: CommunicationContext, articleId: string) {
    const filter: Record<string, any> = {
      _id: articleId,
      tenantId: context.tenantId,
      deletedAt: null,
    };
    if (context.role !== WORKSPACE_ROLE.OWNER) {
      filter.audience = { $ne: "owner" };
    }
    if (
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined
    ) {
      filter.$or = [
        { locationIds: { $size: 0 } },
        { locationIds: { $exists: false } },
        { locationIds: { $in: context.allowedLocationIds } },
      ];
    }
    const article =
      await CommunicationKnowledgeArticleModel.findOne(filter).lean();
    if (!article) notFound("Knowledge article not found.");
    return article;
  },

  async createKnowledge(context: CommunicationContext, input: any) {
    const parsed = knowledgeArticleSchema.parse(input);
    const normalizedInput = knowledgeArticleInput(parsed);
    assertOwnerKnowledgeAudience(context, normalizedInput.audience);
    if (normalizedInput.status === "published") {
      await requireKnowledgePublishPermission(context);
    }
    if (
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined &&
      !(normalizedInput.locationIds || []).length
    ) {
      forbidden(
        "Location-limited members cannot create all-location knowledge.",
      );
    }
    await assertTenantLocations(
      context.tenantId,
      normalizedInput.locationIds || [],
      context.allowedLocationIds ?? null,
    );
    await assertKnowledgeTargetOwnership({
      tenantId: context.tenantId,
      audience: normalizedInput.audience,
      targetCourseIds: normalizedInput.targetCourseIds,
      targetMembershipIds: normalizedInput.targetMembershipIds,
    });
    const article = await CommunicationKnowledgeArticleModel.create({
      ...normalizedInput,
      tenantId: context.tenantId,
      slug: normalizedInput.slug || slugify(normalizedInput.title),
      approvedBy:
        normalizedInput.status === "published" ? context.userId : null,
      approvedAt: normalizedInput.status === "published" ? new Date() : null,
      createdBy: context.userId,
      updatedBy: context.userId,
      embeddingStatus: "pending",
    });
    queueKnowledgeIndex(String(article._id));
    return article;
  },

  async updateKnowledge(
    context: CommunicationContext,
    articleId: string,
    input: any,
  ) {
    const article = await CommunicationKnowledgeArticleModel.findOne({
      _id: articleId,
      tenantId: context.tenantId,
      deletedAt: null,
    });
    if (!article) notFound("Knowledge article not found.");
    assertOwnerKnowledgeAudience(context, article.audience);
    if (
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined &&
      article.locationIds?.length &&
      !article.locationIds.some((locationId: unknown) =>
        context.allowedLocationIds?.includes(String(locationId)),
      )
    ) {
      notFound("Knowledge article not found.");
    }
    const current = article.toObject({ flattenMaps: true });
    const parsed = knowledgeArticleSchema.parse({
      ...current,
      ...input,
      slug: input.slug ?? article.slug,
      locationIds: input.locationIds ?? (article.locationIds || []).map(String),
      targetCourseIds:
        input.targetCourseIds ?? (article.targetCourseIds || []).map(String),
      targetMembershipIds:
        input.targetMembershipIds ??
        (article.targetMembershipIds || []).map(String),
      targetOwnerIds: input.targetOwnerIds ?? [],
    });
    const normalizedInput = knowledgeArticleInput(parsed);
    assertOwnerKnowledgeAudience(context, normalizedInput.audience);
    const nextLocationIds = normalizedInput.locationIds;
    if (
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined &&
      (!article.locationIds?.length || !nextLocationIds.length)
    ) {
      forbidden(
        "Location-limited members cannot manage all-location knowledge.",
      );
    }
    const nextStatus = normalizedInput.status;
    if (article.status === "published" || nextStatus === "published") {
      await requireKnowledgePublishPermission(context);
    }
    await assertTenantLocations(
      context.tenantId,
      nextLocationIds,
      context.allowedLocationIds ?? null,
    );
    await assertKnowledgeTargetOwnership({
      tenantId: context.tenantId,
      audience: normalizedInput.audience,
      targetCourseIds: normalizedInput.targetCourseIds,
      targetMembershipIds: normalizedInput.targetMembershipIds,
    });
    Object.assign(article, normalizedInput, {
      updatedBy: context.userId,
      version: article.version + 1,
      embeddingStatus: "pending",
      embeddingModel: "",
      embeddingIndexVersion: "",
      embeddingVector: undefined,
      embeddedAt: null,
      contentHash: "",
      embeddingAttempts: 0,
      embeddingRetryable: true,
      nextEmbeddingAttemptAt: null,
      ...(nextStatus === "published"
        ? { approvedBy: context.userId, approvedAt: new Date() }
        : {}),
    });
    const saved = await article.save();
    queueKnowledgeIndex(String(saved._id));
    return saved;
  },

  async deleteKnowledge(context: CommunicationContext, articleId: string) {
    const visibility: Record<string, unknown> = {
      _id: articleId,
      tenantId: context.tenantId,
      deletedAt: null,
    };
    const existing = await CommunicationKnowledgeArticleModel.findOne(
      visibility,
    ).select("status audience locationIds");
    if (!existing) notFound("Knowledge article not found.");
    assertOwnerKnowledgeAudience(context, existing.audience);
    if (
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined
    ) {
      const scopedLocations = (existing.locationIds || []).map(String);
      if (
        !canManageAllKnowledgeLocations(
          scopedLocations,
          context.allowedLocationIds,
        )
      ) {
        notFound("Knowledge article not found.");
      }
    }
    if (existing.status === "published") {
      await requireKnowledgePublishPermission(context);
    }
    // Pin the authorization-relevant state so a concurrent audience, status,
    // or location change cannot turn the second write into a TOCTOU bypass.
    visibility.status = existing.status;
    visibility.audience = existing.audience;
    visibility.locationIds = existing.locationIds;
    const article = await CommunicationKnowledgeArticleModel.findOneAndUpdate(
      visibility,
      {
        $set: {
          deletedAt: new Date(),
          status: "archived",
          updatedBy: context.userId,
          embeddingStatus: "skipped",
          embeddingError: "Article is not published.",
          embeddedAt: null,
          embeddingRetryable: false,
          nextEmbeddingAttemptAt: null,
        },
        $unset: { embeddingVector: 1 },
      },
      { returnDocument: "after" },
    );
    if (!article) notFound("Knowledge article not found.");
    return { deleted: true };
  },

  listRoutingRules(context: CommunicationContext) {
    return CommunicationRoutingRuleModel.find({ tenantId: context.tenantId })
      .sort({ order: 1, createdAt: 1 })
      .lean();
  },

  async createRoutingRule(context: CommunicationContext, input: any) {
    if (input.action.assignTo)
      await assertTenantUser(context.tenantId, input.action.assignTo);
    await assertTenantLocations(
      context.tenantId,
      [...(input.conditions.locationIds || []), input.action.locationId].filter(
        Boolean,
      ),
      context.allowedLocationIds ?? null,
    );
    return CommunicationRoutingRuleModel.create({
      ...input,
      tenantId: context.tenantId,
      createdBy: context.userId,
      updatedBy: context.userId,
    });
  },

  async updateRoutingRule(
    context: CommunicationContext,
    ruleId: string,
    input: any,
  ) {
    const rule = await CommunicationRoutingRuleModel.findOne({
      _id: ruleId,
      tenantId: context.tenantId,
    });
    if (!rule) notFound("Routing rule not found.");
    if (input.action?.assignTo)
      await assertTenantUser(context.tenantId, input.action.assignTo);
    await assertTenantLocations(
      context.tenantId,
      [
        ...(input.conditions?.locationIds || []),
        input.action?.locationId,
      ].filter(Boolean),
      context.allowedLocationIds ?? null,
    );
    Object.assign(rule, input, { updatedBy: context.userId });
    return rule.save();
  },

  async deleteRoutingRule(context: CommunicationContext, ruleId: string) {
    const result = await CommunicationRoutingRuleModel.deleteOne({
      _id: ruleId,
      tenantId: context.tenantId,
    });
    if (!result.deletedCount) notFound("Routing rule not found.");
    return { deleted: true };
  },

  async getSettings(context: CommunicationContext) {
    const settings: any = await getSettings(context.tenantId, context.userId);
    return toOutboundOnlyCommunicationSettings(settings);
  },

  async updateSettings(context: CommunicationContext, input: any) {
    const settings: any = await getSettings(context.tenantId, context.userId);
    if (input.inbox?.defaultAssignee) {
      await assertTenantUser(context.tenantId, input.inbox.defaultAssignee);
    }
    const merge = (target: any, patch: any) => {
      for (const [key, value] of Object.entries(patch || {})) {
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          !(value instanceof Date)
        ) {
          if (!target[key]) target[key] = {};
          merge(target[key], value);
        } else if (value !== undefined) target[key] = value;
      }
    };
    merge(settings, input);
    settings.channels.email.provider = "postmark";
    settings.channels.email.inboundEnabled = false;
    settings.channels.whatsapp.enabled = false;
    settings.channels.instagram.enabled = false;
    if (input.businessHours) {
      settings.businessHoursConfiguredAt = new Date();
    }
    settings.inbox.ownerCanViewAll = true;
    settings.updatedBy = context.userId;
    await settings.save();
    return this.getSettings(context);
  },

  async getConsents(context: CommunicationContext, customerId: string) {
    await assertTenantCustomer(context.tenantId, customerId);
    return CommunicationConsentModel.find({
      tenantId: context.tenantId,
      customerId,
    })
      .sort({ channel: 1, purpose: 1 })
      .lean();
  },

  async updateConsents(
    context: CommunicationContext,
    customerId: string,
    input: any,
  ) {
    await assertTenantCustomer(context.tenantId, customerId);
    const now = new Date();
    const items = [];
    for (const preference of input.preferences) {
      const update = {
        status: preference.status,
        source: preference.source,
        evidence: preference.evidence,
        expiresAt: preference.expiresAt,
        capturedAt: preference.status === CONSENT_STATUS.GRANTED ? now : null,
        revokedAt: preference.status === CONSENT_STATUS.REVOKED ? now : null,
        updatedBy: context.userId,
      };
      const item = await CommunicationConsentModel.findOneAndUpdate(
        {
          tenantId: context.tenantId,
          customerId,
          channel: preference.channel,
          purpose: preference.purpose,
        },
        {
          $set: update,
          $push: {
            history: {
              status: preference.status,
              at: now,
              source: preference.source,
              actorId: context.userId,
            },
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      items.push(item);
    }
    await audit(context, {
      action: AUDIT_ACTION.CONSENT_CHANGED,
      resourceType: "customer",
      resourceId: customerId,
      summary: "Communication preferences updated.",
      metadata: { count: items.length },
    });
    return items;
  },

  async listAudit(context: CommunicationContext, input: any) {
    const filter: Record<string, any> = { tenantId: context.tenantId };
    if (input.action) filter.action = input.action;
    if (input.resourceType) filter.resourceType = input.resourceType;
    if (input.conversationId) filter.conversationId = input.conversationId;
    if (input.actorId) filter.actorId = input.actorId;
    if (input.from || input.to)
      filter.createdAt = {
        ...(input.from ? { $gte: input.from } : {}),
        ...(input.to ? { $lte: input.to } : {}),
      };
    if (
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined
    ) {
      filter.$or = [
        { locationId: { $in: context.allowedLocationIds } },
        { locationId: null },
      ];
    }
    const [items, total] = await Promise.all([
      CommunicationAuditModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .lean(),
      CommunicationAuditModel.countDocuments(filter),
    ]);
    return {
      items,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.ceil(total / input.limit),
      },
    };
  },

  async satisfaction(context: CommunicationContext, input: any) {
    const conversationFilter: Record<string, any> = {
      tenantId: context.tenantId,
    };
    if (input.locationId) conversationFilter.locationId = input.locationId;
    if (input.category) conversationFilter.category = input.category;
    if (
      context.allowedLocationIds !== null &&
      context.allowedLocationIds !== undefined
    ) {
      conversationFilter.locationId = { $in: context.allowedLocationIds };
    }
    const conversationIds =
      await CommunicationConversationModel.find(conversationFilter).distinct(
        "_id",
      );
    const filter: Record<string, any> = {
      tenantId: context.tenantId,
      conversationId: { $in: conversationIds },
    };
    if (input.from || input.to) {
      filter.sentAt = {
        ...(input.from ? { $gte: input.from } : {}),
        ...(input.to ? { $lte: input.to } : {}),
      };
    }
    const surveys = await CommunicationSatisfactionSurveyModel.find(filter)
      .select("status score comment sentAt respondedAt conversationId")
      .lean();
    const responses = surveys.filter((survey) => survey.status === "responded");
    const metrics = calculateSatisfactionSummary(responses);
    return {
      summary: {
        ...metrics,
        sent: surveys.length,
        responseRate: surveys.length
          ? Number((responses.length / surveys.length).toFixed(4))
          : null,
      },
      responses,
    };
  },
};

export const submitSatisfactionResponse = async (token: string, input: any) => {
  const tokenHash = hashSatisfactionToken(token);
  const score = validateSatisfactionScore(input.score);
  const survey = await CommunicationSatisfactionSurveyModel.findOneAndUpdate(
    {
      tokenHash,
      status: "pending",
      expiresAt: { $gt: new Date() },
    },
    {
      $set: {
        score,
        comment: input.comment,
        status: "responded",
        respondedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  if (!survey) {
    notFound("Satisfaction survey was not found or has expired.");
  }
  await recordCommunicationAudit({
    tenantId: survey.tenantId,
    actorType: "customer",
    actorId: survey.customerId,
    action: AUDIT_ACTION.CSAT_RECEIVED,
    resourceType: "satisfaction_survey",
    resourceId: survey._id,
    conversationId: survey.conversationId,
    summary: "Customer satisfaction response received.",
    metadata: { score: survey.score },
  });
  return { accepted: true };
};
