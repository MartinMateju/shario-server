import {
  AI_ANALYSIS_STATUS,
  COMMUNICATION_CHANNELS,
  CONSENT_PURPOSES,
  CONSENT_STATUSES,
  CONVERSATION_CATEGORIES,
  CONVERSATION_PRIORITIES,
  CONVERSATION_STATUSES,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  DEFAULT_RETENTION_DAYS,
  DELIVERY_STATUSES,
  KNOWLEDGE_ARTICLE_AUDIENCES,
  KNOWLEDGE_ARTICLE_STATUSES,
  KNOWLEDGE_ARTICLE_TYPES,
  KNOWLEDGE_EMBEDDING_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_KINDS,
  ROUTING_MATCH_OPERATORS,
} from "./communications.constants.js";
import mongoose, { Schema } from "mongoose";
import { randomBytes } from "node:crypto";
import { getYouTubeVideoId, normalizeYouTubeUrl } from "./knowledge-youtube.js";

const objectId = Schema.Types.ObjectId;

const contactIdentitySchema = new Schema(
  {
    name: { type: String, trim: true, default: "", maxlength: 180 },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      maxlength: 254,
    },
    phone: { type: String, trim: true, default: "", maxlength: 50 },
    whatsappId: { type: String, trim: true, default: "", maxlength: 160 },
    instagramScopedId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
    },
    instagramUsername: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
    },
    externalId: { type: String, trim: true, default: "", maxlength: 240 },
  },
  { _id: false },
);

const attachmentSchema = new Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 240 },
    contentType: {
      type: String,
      trim: true,
      default: "application/octet-stream",
      maxlength: 160,
    },
    size: { type: Number, min: 0, default: 0 },
    url: { type: String, trim: true, required: true, maxlength: 3000 },
    checksum: { type: String, trim: true, default: "", maxlength: 128 },
  },
  { _id: true },
);

const relatedEntitySchema = new Schema(
  {
    type: {
      type: String,
      trim: true,
      required: true,
      enum: [
        "booking",
        "course",
        "order",
        "invoice",
        "payment",


        "membership",
        "task",
        "other",
      ],
    },
    id: { type: objectId, required: true },
    label: { type: String, trim: true, default: "", maxlength: 240 },
  },
  { _id: false },
);

const actionSuggestionSchema = new Schema(
  {
    key: { type: String, trim: true, required: true, maxlength: 80 },
    label: { type: String, trim: true, required: true, maxlength: 180 },
    entityType: { type: String, trim: true, default: "", maxlength: 80 },
    entityId: { type: objectId, default: null },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    requiresConfirmation: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["suggested", "approved", "dismissed", "completed", "failed"],
      default: "suggested",
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    decidedBy: { type: objectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { _id: true },
);

const aiAnalysisSchema = new Schema(
  {
    status: {
      type: String,
      enum: Object.values(AI_ANALYSIS_STATUS),
      default: AI_ANALYSIS_STATUS.PENDING,
    },
    category: {
      type: String,
      enum: CONVERSATION_CATEGORIES,
      default: "general",
    },
    priority: {
      type: String,
      enum: CONVERSATION_PRIORITIES,
      default: "normal",
    },
    language: { type: String, trim: true, default: "", maxlength: 24 },
    sentiment: {
      type: String,
      enum: ["positive", "neutral", "negative", "urgent"],
      default: "neutral",
    },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    summary: { type: String, trim: true, default: "", maxlength: 3000 },
    suggestedReply: { type: String, default: "", maxlength: 12000 },
    provider: {
      type: String,
      trim: true,
      default: "deterministic",
      maxlength: 80,
    },
    model: { type: String, trim: true, default: "rules-v1", maxlength: 120 },
    version: { type: String, trim: true, default: "1", maxlength: 40 },
    processedAt: { type: Date, default: null },
    actions: { type: [actionSuggestionSchema], default: [] },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    subject: {
      type: String,
      trim: true,
      default: "New conversation",
      maxlength: 300,
    },
    status: {
      type: String,
      enum: CONVERSATION_STATUSES,
      default: "open",
      index: true,
    },
    priority: {
      type: String,
      enum: CONVERSATION_PRIORITIES,
      default: "normal",
      index: true,
    },
    category: {
      type: String,
      enum: CONVERSATION_CATEGORIES,
      default: "general",
      index: true,
    },
    language: { type: String, trim: true, default: "", maxlength: 24 },
    channels: { type: [String], enum: COMMUNICATION_CHANNELS, default: [] },
    customerId: { type: objectId, ref: "User", default: null, index: true },
    contact: { type: contactIdentitySchema, default: () => ({}) },
    customerMatch: {
      status: {
        type: String,
        enum: ["matched", "suggested", "unmatched", "ignored"],
        default: "unmatched",
      },
      confidence: { type: Number, min: 0, max: 1, default: 0 },
      candidates: [
        {
          customerId: { type: objectId, ref: "User" },
          score: Number,
          reasons: [String],
        },
      ],
      reviewedBy: { type: objectId, ref: "User", default: null },
      reviewedAt: { type: Date, default: null },
    },
    locationId: { type: objectId, ref: "Location", default: null, index: true },
    assignedTo: { type: objectId, ref: "User", default: null, index: true },
    assignedTeam: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
      index: true,
    },
    followerIds: { type: [objectId], ref: "User", default: [] },
    restricted: { type: Boolean, default: false, index: true },
    allowedUserIds: { type: [objectId], ref: "User", default: [] },
    externalThreads: [
      {
        channel: { type: String, enum: COMMUNICATION_CHANNELS },
        provider: String,
        threadId: String,
      },
    ],
    relatedEntities: { type: [relatedEntitySchema], default: [] },
    ai: { type: aiAnalysisSchema, default: () => ({}) },
    source: { type: String, trim: true, default: "manual", maxlength: 80 },
    unreadCount: { type: Number, min: 0, default: 0 },
    lastMessagePreview: {
      type: String,
      trim: true,
      default: "",
      maxlength: 300,
    },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessageDirection: {
      type: String,
      enum: MESSAGE_DIRECTIONS,
      default: undefined,
    },
    firstResponseAt: { type: Date, default: null },
    snoozedUntil: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: objectId, ref: "User", default: null },
    absenceReplyKey: { type: String, trim: true, default: "", maxlength: 160 },
    tags: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: objectId, ref: "User", default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
conversationSchema.index({ tenantId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({
  tenantId: 1,
  lastMessageDirection: 1,
  lastMessageAt: -1,
});
conversationSchema.index({
  tenantId: 1,
  locationId: 1,
  status: 1,
  lastMessageAt: -1,
});
conversationSchema.index({
  tenantId: 1,
  assignedTo: 1,
  status: 1,
  lastMessageAt: -1,
});
conversationSchema.index({ tenantId: 1, customerId: 1, lastMessageAt: -1 });
conversationSchema.index({ tenantId: 1, "contact.email": 1, status: 1 });
conversationSchema.index({ tenantId: 1, "contact.whatsappId": 1, status: 1 });
conversationSchema.index({
  tenantId: 1,
  "contact.instagramScopedId": 1,
  status: 1,
});
conversationSchema.index({
  tenantId: 1,
  subject: "text",
  lastMessagePreview: "text",
});

const instagramMessageContextSchema = new Schema(
  {
    sourceType: {
      type: String,
      enum: ["dm", "story_reply", "story_mention", "postback"],
      default: "dm",
    },
    isStoryReply: { type: Boolean, default: false },
    isStoryMention: { type: Boolean, default: false },
    storyId: { type: String, trim: true, default: "", maxlength: 300 },
    repliedToMessageId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 300,
    },
    postbackPayload: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    conversationId: {
      type: objectId,
      ref: "CommunicationConversation",
      required: true,
      index: true,
    },
    direction: {
      type: String,
      enum: MESSAGE_DIRECTIONS,
      required: true,
      index: true,
    },
    channel: {
      type: String,
      enum: COMMUNICATION_CHANNELS,
      required: true,
      index: true,
    },
    kind: { type: String, enum: MESSAGE_KINDS, default: "text" },
    sender: { type: contactIdentitySchema, default: () => ({}) },
    recipients: { type: [contactIdentitySchema], default: [] },
    subject: { type: String, trim: true, default: "", maxlength: 300 },
    text: { type: String, default: "", maxlength: 50000 },
    html: { type: String, default: "", maxlength: 250000 },
    attachments: { type: [attachmentSchema], default: [] },
    whatsappTemplate: {
      name: { type: String, trim: true, default: "", maxlength: 512 },
      languageCode: { type: String, trim: true, default: "", maxlength: 35 },
      components: { type: [Schema.Types.Mixed], default: [] },
    },
    instagram: { type: instagramMessageContextSchema, default: undefined },
    replyToMessageId: {
      type: objectId,
      ref: "CommunicationMessage",
      default: null,
    },
    provider: { type: String, trim: true, default: "local", maxlength: 80 },
    providerMessageId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 300,
    },
    providerThreadId: { type: String, trim: true, default: "", maxlength: 300 },
    idempotencyKey: { type: String, trim: true, default: "", maxlength: 300 },
    headers: { type: Schema.Types.Mixed, default: {} },
    language: { type: String, trim: true, default: "", maxlength: 24 },
    translations: { type: Map, of: String, default: {} },
    transcript: { type: String, default: "", maxlength: 50000 },
    ai: { type: aiAnalysisSchema, default: () => ({}) },
    isInternal: { type: Boolean, default: false, index: true },
    createdBy: { type: objectId, ref: "User", default: null },
    approvedBy: { type: objectId, ref: "User", default: null },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
messageSchema.index({ tenantId: 1, conversationId: 1, createdAt: 1 });
messageSchema.index(
  { tenantId: 1, channel: 1, provider: 1, providerMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerMessageId: { $type: "string", $gt: "" },
    },
  },
);
messageSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
  },
);

const deliverySchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    conversationId: {
      type: objectId,
      ref: "CommunicationConversation",
      required: true,
      index: true,
    },
    messageId: {
      type: objectId,
      ref: "CommunicationMessage",
      required: true,
      index: true,
    },
    channel: { type: String, enum: COMMUNICATION_CHANNELS, required: true },
    purpose: { type: String, enum: CONSENT_PURPOSES, default: "support" },
    provider: { type: String, trim: true, default: "local", maxlength: 80 },
    providerMessageId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 300,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    status: {
      type: String,
      enum: DELIVERY_STATUSES,
      default: "queued",
      index: true,
    },
    attempts: { type: Number, min: 0, default: 0 },
    maxAttempts: {
      type: Number,
      min: 1,
      max: 8,
      default: DEFAULT_MAX_DELIVERY_ATTEMPTS,
    },
    lastAttemptAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null, index: true },
    claimToken: { type: String, trim: true, default: "", maxlength: 80 },
    leaseExpiresAt: { type: Date, default: null },
    providerAttemptStartedAt: { type: Date, default: null },
    manualReviewRequiredAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failure: {
      code: { type: String, trim: true, default: "", maxlength: 120 },
      message: { type: String, trim: true, default: "", maxlength: 2000 },
      permanent: { type: Boolean, default: false },
    },
    fallbackFromDeliveryId: {
      type: objectId,
      ref: "CommunicationDelivery",
      default: null,
    },
    eventHistory: [
      {
        status: { type: String, enum: DELIVERY_STATUSES },
        at: Date,
        payload: Schema.Types.Mixed,
      },
    ],
  },
  { timestamps: true },
);
deliverySchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
deliverySchema.index({ provider: 1, providerMessageId: 1 });
deliverySchema.index({ status: 1, nextAttemptAt: 1 });
deliverySchema.index({ status: 1, leaseExpiresAt: 1 });

const knowledgeQuestionSchema = new Schema(
  {
    question: { type: String, trim: true, required: true, maxlength: 500 },
    answer: { type: String, trim: true, required: true, maxlength: 10_000 },
  },
  { _id: false },
);

const knowledgeArticleSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    type: {
      type: String,
      enum: KNOWLEDGE_ARTICLE_TYPES,
      default: "guide",
      required: true,
      index: true,
    },
    title: { type: String, trim: true, required: true, maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 1_000 },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      maxlength: 160,
    },
    category: {
      type: String,
      trim: true,
      default: "general",
      maxlength: 100,
      index: true,
    },
    audience: {
      type: String,
      enum: KNOWLEDGE_ARTICLE_AUDIENCES,
      default: "staff",
      required: true,
      index: true,
    },
    language: { type: String, trim: true, default: "cs", maxlength: 24 },
    content: { type: String, trim: true, default: "", maxlength: 100000 },
    transcript: { type: String, trim: true, default: "", maxlength: 100000 },
    customQuestions: { type: [knowledgeQuestionSchema], default: [] },
    translations: { type: Map, of: String, default: {} },
    status: {
      type: String,
      enum: KNOWLEDGE_ARTICLE_STATUSES,
      default: "draft",
      index: true,
    },
    sourceUrl: { type: String, trim: true, default: "", maxlength: 3000 },
    videoUrl: { type: String, trim: true, default: "", maxlength: 3000 },
    youtubeVideoId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 11,
      select: true,
    },
    fileUrl: { type: String, trim: true, default: "", maxlength: 3000 },
    tags: { type: [String], default: [] },
    locationIds: { type: [objectId], ref: "Location", default: [] },
    targetCourseIds: { type: [objectId], ref: "Product", default: [] },
    targetMembershipIds: {
      type: [objectId],
      ref: "MembershipPlan",
      default: [],
    },
    featured: { type: Boolean, default: false, index: true },
    aiEnabled: { type: Boolean, default: true, index: true },
    effectiveFrom: { type: Date, default: null, index: true },
    effectiveUntil: { type: Date, default: null, index: true },
    embeddingStatus: {
      type: String,
      enum: KNOWLEDGE_EMBEDDING_STATUSES,
      default: "pending",
      index: true,
    },
    embeddingModel: { type: String, trim: true, default: "", maxlength: 160 },
    embeddingIndexVersion: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
    },
    embeddingVector: { type: [Number], default: undefined, select: false },
    embeddedAt: { type: Date, default: null },
    contentHash: { type: String, trim: true, default: "", maxlength: 128 },
    embeddingError: { type: String, default: "", maxlength: 1_000 },
    embeddingAttempts: { type: Number, min: 0, default: 0 },
    embeddingRetryable: { type: Boolean, default: true },
    nextEmbeddingAttemptAt: { type: Date, default: null, index: true },
    approvedBy: { type: objectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    createdBy: { type: objectId, ref: "User", required: true },
    updatedBy: { type: objectId, ref: "User", required: true },
    version: { type: Number, min: 1, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

knowledgeArticleSchema.pre("validate", function validateKnowledgeArticle() {
  const article = this as any;
  const courseTargets = article.targetCourseIds || [];
  const membershipTargets = article.targetMembershipIds || [];
  if (article.audience === "course" && courseTargets.length === 0) {
    article.invalidate(
      "targetCourseIds",
      "At least one course is required for the course audience.",
    );
  }
  if (article.audience !== "course" && courseTargets.length > 0) {
    article.invalidate(
      "targetCourseIds",
      "Course targets are only valid for the course audience.",
    );
  }
  if (article.audience !== "member" && membershipTargets.length > 0) {
    article.invalidate(
      "targetMembershipIds",
      "Membership targets are only valid for the member audience.",
    );
  }

  if (article.videoUrl) {
    const youtubeVideoId = getYouTubeVideoId(article.videoUrl);
    if (!youtubeVideoId) {
      article.invalidate(
        "videoUrl",
        "A valid HTTPS YouTube video URL is required.",
      );
    } else {
      article.videoUrl = normalizeYouTubeUrl(article.videoUrl);
      article.youtubeVideoId = youtubeVideoId;
    }
  } else {
    article.youtubeVideoId = "";
  }
});

knowledgeArticleSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
knowledgeArticleSchema.index({ tenantId: 1, status: 1, category: 1 });
knowledgeArticleSchema.index({
  tenantId: 1,
  deletedAt: 1,
  status: 1,
  audience: 1,
  language: 1,
  updatedAt: -1,
});
knowledgeArticleSchema.index({
  tenantId: 1,
  audience: 1,
  status: 1,
  effectiveFrom: 1,
  effectiveUntil: 1,
});
knowledgeArticleSchema.index({
  tenantId: 1,
  status: 1,
  audience: 1,
  deletedAt: 1,
  targetCourseIds: 1,
});
knowledgeArticleSchema.index({
  tenantId: 1,
  status: 1,
  audience: 1,
  deletedAt: 1,
  targetMembershipIds: 1,
});
// The text index is managed by ensureKnowledgeTextIndex before API readiness.
// Declaring it here races Mongoose autoIndex against the deployed index repair.

const routingRuleSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    name: { type: String, trim: true, required: true, maxlength: 160 },
    description: { type: String, trim: true, default: "", maxlength: 1000 },
    enabled: { type: Boolean, default: true, index: true },
    order: { type: Number, min: 0, default: 100, index: true },
    matchOperator: {
      type: String,
      enum: ROUTING_MATCH_OPERATORS,
      default: "all",
    },
    conditions: {
      categories: {
        type: [String],
        enum: CONVERSATION_CATEGORIES,
        default: [],
      },
      channels: { type: [String], enum: COMMUNICATION_CHANNELS, default: [] },
      priorities: {
        type: [String],
        enum: CONVERSATION_PRIORITIES,
        default: [],
      },
      languages: { type: [String], default: [] },
      locationIds: { type: [objectId], ref: "Location", default: [] },
      keywords: { type: [String], default: [] },
      unmatchedOnly: { type: Boolean, default: false },
      outsideBusinessHours: { type: Boolean, default: false },
    },
    action: {
      assignTo: { type: objectId, ref: "User", default: null },
      assignTeam: { type: String, trim: true, default: "", maxlength: 120 },
      locationId: { type: objectId, ref: "Location", default: null },
      priority: { type: String, enum: CONVERSATION_PRIORITIES, default: null },
      addTags: { type: [String], default: [] },
      notifyOwner: { type: Boolean, default: false },
    },
    createdBy: { type: objectId, ref: "User", required: true },
    updatedBy: { type: objectId, ref: "User", required: true },
  },
  { timestamps: true },
);
routingRuleSchema.index({ tenantId: 1, enabled: 1, order: 1 });

const businessIntervalSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    open: {
      type: String,
      default: "09:00",
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
    close: {
      type: String,
      default: "17:00",
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
  },
  { _id: false },
);

const communicationSettingsSchema: Schema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, unique: true },
    tenantKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => randomBytes(24).toString("hex"),
    },
    inbox: {
      forwardingLocalPart: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
        maxlength: 120,
      },
      senderName: { type: String, trim: true, default: "", maxlength: 180 },
      senderEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
        maxlength: 254,
      },
      replyToEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
        maxlength: 254,
      },
      defaultAssignee: { type: objectId, ref: "User", default: null },
      ownerCanViewAll: { type: Boolean, default: true, immutable: true },
    },
    channels: {
      email: {
        enabled: { type: Boolean, default: true },
        provider: {
          type: String,
          trim: true,
          default: "postmark",
          maxlength: 80,
        },
        inboundEnabled: { type: Boolean, default: false },
      },
      whatsapp: {
        enabled: { type: Boolean, default: false },
        provider: { type: String, trim: true, default: "meta", maxlength: 80 },
        phoneNumberId: {
          type: String,
          trim: true,
          default: "",
          maxlength: 160,
        },
        businessAccountId: {
          type: String,
          trim: true,
          default: "",
          maxlength: 160,
        },
        encryptedAccessToken: { type: String, default: "", select: false },
      },
      instagram: {
        enabled: { type: Boolean, default: false },
        provider: { type: String, trim: true, default: "meta", maxlength: 80 },
        instagramAccountId: {
          type: String,
          trim: true,
          default: "",
          maxlength: 160,
        },
        username: { type: String, trim: true, default: "", maxlength: 160 },
        encryptedAccessToken: { type: String, default: "", select: false },
        tokenExpiresAt: { type: Date, default: null },
        connectedAt: { type: Date, default: null },
        lastTokenRefreshAt: { type: Date, default: null },
        tokenRefreshFailedAt: { type: Date, default: null },
        tokenRefreshError: {
          type: String,
          trim: true,
          default: "",
          maxlength: 500,
        },
        oauthStateHash: {
          type: String,
          default: "",
          select: false,
          maxlength: 128,
        },
        oauthStateExpiresAt: { type: Date, default: null, select: false },
        oauthInitiatedBy: {
          type: objectId,
          ref: "User",
          default: null,
          select: false,
        },
      },
      inApp: { enabled: { type: Boolean, default: true } },
    },
    ai: {
      enabled: { type: Boolean, default: true },
      autoCategorize: { type: Boolean, default: true },
      autoRoute: { type: Boolean, default: true },
      draftReplies: { type: Boolean, default: true },
      autoApplyConfidence: { type: Number, min: 0.5, max: 1, default: 0.9 },
      preferredStaffLanguage: {
        type: String,
        trim: true,
        default: "cs",
        maxlength: 24,
      },
    },
    businessHours: {
      timezone: {
        type: String,
        trim: true,
        default: "Europe/Prague",
        maxlength: 100,
      },
      monday: {
        type: businessIntervalSchema,
        default: () => ({ enabled: true }),
      },
      tuesday: {
        type: businessIntervalSchema,
        default: () => ({ enabled: true }),
      },
      wednesday: {
        type: businessIntervalSchema,
        default: () => ({ enabled: true }),
      },
      thursday: {
        type: businessIntervalSchema,
        default: () => ({ enabled: true }),
      },
      friday: {
        type: businessIntervalSchema,
        default: () => ({ enabled: true }),
      },
      saturday: {
        type: businessIntervalSchema,
        default: () => ({ enabled: false }),
      },
      sunday: {
        type: businessIntervalSchema,
        default: () => ({ enabled: false }),
      },
      holidays: { type: [String], default: [] },
    },
    businessHoursConfiguredAt: { type: Date, default: null },
    absence: {
      enabled: { type: Boolean, default: false },
      message: {
        type: String,
        default:
          "Thank you for your message. We will reply during our business hours.",
        maxlength: 5000,
      },
      repeatAfterHours: { type: Number, min: 1, max: 168, default: 24 },
    },
    quietHours: {
      enabled: { type: Boolean, default: true },
      start: {
        type: String,
        default: "21:00",
        match: /^([01]\d|2[0-3]):[0-5]\d$/,
      },
      end: {
        type: String,
        default: "08:00",
        match: /^([01]\d|2[0-3]):[0-5]\d$/,
      },
      allowUrgent: { type: Boolean, default: true },
    },
    delivery: {
      maxAttempts: {
        type: Number,
        min: 1,
        max: 8,
        default: DEFAULT_MAX_DELIVERY_ATTEMPTS,
      },
      retryBaseSeconds: { type: Number, min: 5, max: 86400, default: 60 },
      fallbackOrder: {
        type: [String],
        enum: COMMUNICATION_CHANNELS,
        default: ["email", "in_app"],
      },
    },
    retention: {
      days: {
        type: Number,
        min: 30,
        max: 3650,
        default: DEFAULT_RETENTION_DAYS,
      },
      redactInsteadOfDelete: { type: Boolean, default: true },
      retainAuditDays: { type: Number, min: 30, max: 3650, default: 1095 },
    },
    satisfaction: {
      enabled: { type: Boolean, default: true },
      sendForCategories: {
        type: [String],
        enum: CONVERSATION_CATEGORIES,
        default: [],
      },
      cooldownDays: { type: Number, min: 1, max: 365, default: 30 },
    },
    updatedBy: { type: objectId, ref: "User", default: null },
  } as any,
  { timestamps: true },
);
communicationSettingsSchema.index(
  { "channels.instagram.instagramAccountId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "channels.instagram.instagramAccountId": { $type: "string", $gt: "" },
    },
  },
);

const consentSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    customerId: { type: objectId, ref: "User", required: true, index: true },
    channel: { type: String, enum: COMMUNICATION_CHANNELS, required: true },
    purpose: { type: String, enum: CONSENT_PURPOSES, required: true },
    status: { type: String, enum: CONSENT_STATUSES, default: "unknown" },
    source: { type: String, trim: true, default: "manual", maxlength: 120 },
    evidence: { type: String, trim: true, default: "", maxlength: 3000 },
    capturedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    updatedBy: { type: objectId, ref: "User", default: null },
    history: [
      {
        status: { type: String, enum: CONSENT_STATUSES },
        at: Date,
        source: String,
        actorId: { type: objectId, ref: "User" },
      },
    ],
  },
  { timestamps: true },
);
consentSchema.index(
  { tenantId: 1, customerId: 1, channel: 1, purpose: 1 },
  { unique: true },
);

const suppressionSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    channel: { type: String, enum: COMMUNICATION_CHANNELS, required: true },
    identity: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      maxlength: 254,
    },
    reason: {
      type: String,
      enum: ["hard_bounce", "spam_complaint", "invalid_recipient", "manual"],
      required: true,
    },
    provider: { type: String, trim: true, default: "", maxlength: 80 },
    providerEventId: { type: String, trim: true, default: "", maxlength: 300 },
    active: { type: Boolean, default: true },
    createdBy: { type: objectId, ref: "User", default: null },
  },
  { timestamps: true },
);
suppressionSchema.index(
  { tenantId: 1, channel: 1, identity: 1 },
  { unique: true },
);

const auditSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    actorType: {
      type: String,
      enum: ["user", "customer", "system", "ai", "provider"],
      required: true,
    },
    actorId: { type: objectId, ref: "User", default: null },
    action: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
      index: true,
    },
    resourceType: {
      type: String,
      trim: true,
      required: true,
      maxlength: 100,
      index: true,
    },
    resourceId: { type: objectId, default: null, index: true },
    conversationId: {
      type: objectId,
      ref: "CommunicationConversation",
      default: null,
      index: true,
    },
    locationId: { type: objectId, ref: "Location", default: null },
    ipAddress: { type: String, trim: true, default: "", maxlength: 100 },
    userAgent: { type: String, trim: true, default: "", maxlength: 1000 },
    summary: { type: String, trim: true, default: "", maxlength: 1000 },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ tenantId: 1, createdAt: -1 });
auditSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const inboundEventSchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    channel: { type: String, enum: COMMUNICATION_CHANNELS, required: true },
    provider: { type: String, trim: true, required: true, maxlength: 80 },
    eventId: { type: String, trim: true, required: true, maxlength: 300 },
    eventType: { type: String, trim: true, required: true, maxlength: 120 },
    payloadHash: { type: String, trim: true, required: true, maxlength: 128 },
    processedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["received", "processed", "ignored", "failed"],
      default: "received",
    },
    error: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  { timestamps: true },
);
inboundEventSchema.index(
  { tenantId: 1, channel: 1, provider: 1, eventId: 1 },
  { unique: true },
);

const satisfactionSurveySchema = new Schema(
  {
    tenantId: { type: objectId, ref: "Tenant", required: true, index: true },
    conversationId: {
      type: objectId,
      ref: "CommunicationConversation",
      required: true,
      index: true,
    },
    customerId: { type: objectId, ref: "User", default: null, index: true },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
      maxlength: 128,
    },
    status: {
      type: String,
      enum: ["pending", "responded", "expired", "cancelled"],
      default: "pending",
    },
    score: { type: Number, min: 1, max: 5, default: null },
    comment: { type: String, trim: true, default: "", maxlength: 3000 },
    sentAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
    channel: { type: String, enum: COMMUNICATION_CHANNELS, default: "email" },
  },
  { timestamps: true },
);
satisfactionSurveySchema.index(
  { tenantId: 1, conversationId: 1 },
  { unique: true },
);

export const CommunicationConversationModel: mongoose.Model<any> =
  (mongoose.models.CommunicationConversation as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationConversation", conversationSchema);
export const CommunicationMessageModel: mongoose.Model<any> =
  (mongoose.models.CommunicationMessage as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationMessage", messageSchema);
export const CommunicationDeliveryModel: mongoose.Model<any> =
  (mongoose.models.CommunicationDelivery as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationDelivery", deliverySchema);
export const CommunicationKnowledgeArticleModel: mongoose.Model<any> =
  (mongoose.models.CommunicationKnowledgeArticle as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationKnowledgeArticle", knowledgeArticleSchema);
export const CommunicationRoutingRuleModel: mongoose.Model<any> =
  (mongoose.models.CommunicationRoutingRule as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationRoutingRule", routingRuleSchema);
export const CommunicationSettingsModel: mongoose.Model<any> =
  (mongoose.models.CommunicationSettings as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationSettings", communicationSettingsSchema);
export const CommunicationConsentModel: mongoose.Model<any> =
  (mongoose.models.CommunicationConsent as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationConsent", consentSchema);
export const CommunicationAuditModel: mongoose.Model<any> =
  (mongoose.models.CommunicationAudit as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationAudit", auditSchema);
export const CommunicationSuppressionModel: mongoose.Model<any> =
  (mongoose.models.CommunicationSuppression as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationSuppression", suppressionSchema);
export const CommunicationInboundEventModel: mongoose.Model<any> =
  (mongoose.models.CommunicationInboundEvent as mongoose.Model<any>) ||
  mongoose.model<any>("CommunicationInboundEvent", inboundEventSchema);
export const CommunicationSatisfactionSurveyModel: mongoose.Model<any> =
  (mongoose.models.CommunicationSatisfactionSurvey as mongoose.Model<any>) ||
  mongoose.model<any>(
    "CommunicationSatisfactionSurvey",
    satisfactionSurveySchema,
  );

export {
  conversationSchema,
  messageSchema,
  deliverySchema,
  knowledgeArticleSchema,
  routingRuleSchema,
  communicationSettingsSchema,
  consentSchema,
  suppressionSchema,
  auditSchema,
  inboundEventSchema,
  satisfactionSurveySchema,
};
