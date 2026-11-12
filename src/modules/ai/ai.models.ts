import mongoose, { Schema } from "mongoose";

import {
  AI_ACTION_EVENT,
  AI_ACTION_RISK,
  AI_ACTION_SCHEMA_VERSION,
  AI_ACTION_STATUS,
  AI_AUDIENCES,
  AI_CONVERSATION_STATUS,
  AI_FEATURES,
  AI_FEEDBACK_RATING,
  AI_RUN_STATUS,
  AI_USAGE_STATUS,
} from "./ai.constants.js";
import { AI_LOCALES } from "./ai-locale.js";
import {
  BUSINESS_ADVISOR_CATEGORY,
  BUSINESS_ADVISOR_CONFIDENCE,
  BUSINESS_ADVISOR_EFFORT,
  BUSINESS_ADVISOR_KIND,
  BUSINESS_ADVISOR_PRIORITY,
  BUSINESS_ADVISOR_SCHEMA_VERSION,
  BUSINESS_ADVISOR_STATUS,
} from "./business-advisor.types.js";

const objectId = Schema.Types.ObjectId;

const providerUsageSchema = new Schema(
  {
    inputTokens: { type: Number, min: 0, default: 0 },
    outputTokens: { type: Number, min: 0, default: 0 },
    totalTokens: { type: Number, min: 0, default: 0 },
    reservedCredits: { type: Number, min: 0, default: 0 },
    settledCredits: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

const aiRunSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    actor: { type: objectId, ref: "User", default: null, index: true },
    audience: { type: String, enum: AI_AUDIENCES, required: true, index: true },
    feature: { type: String, enum: AI_FEATURES, required: true, index: true },
    status: {
      type: String,
      enum: Object.values(AI_RUN_STATUS),
      default: AI_RUN_STATUS.PENDING,
      index: true,
    },
    promptVersion: { type: String, trim: true, required: true, maxlength: 120 },
    provider: { type: String, trim: true, default: "openai", maxlength: 80 },
    model: { type: String, trim: true, default: "", maxlength: 160 },
    providerResponseId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 240,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      required: true,
      maxlength: 300,
    },
    locationId: { type: objectId, ref: "Location", default: null, index: true },
    sourceIds: { type: [String], default: [] },
    toolCalls: { type: [Schema.Types.Mixed], default: [] },
    outputSummary: { type: String, default: "", maxlength: 4_000 },
    structuredResult: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
    },
    refusal: { type: String, default: "", maxlength: 2_000 },
    errorCode: { type: String, trim: true, default: "", maxlength: 120 },
    errorMessage: { type: String, default: "", maxlength: 2_000 },
    usage: { type: providerUsageSchema, default: () => ({}) },
    completedAt: { type: Date, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, strict: true },
);
aiRunSchema.index({ tenant: 1, idempotencyKey: 1 }, { unique: true });
aiRunSchema.index({ tenant: 1, createdAt: -1 });
aiRunSchema.index({ tenant: 1, feature: 1, createdAt: -1 });
aiRunSchema.index({ tenant: 1, feature: 1, completedAt: -1 });

const aiUsagePeriodSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true },
    periodKey: { type: String, required: true, trim: true, maxlength: 80 },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    limit: { type: Number, min: 0, required: true },
    reserved: { type: Number, min: 0, default: 0 },
    consumed: { type: Number, min: 0, default: 0 },
    reconciliationVersion: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true, strict: true },
);
aiUsagePeriodSchema.index({ tenant: 1, periodKey: 1 }, { unique: true });

const aiUsageLedgerSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    periodKey: { type: String, required: true, trim: true, maxlength: 80 },
    feature: { type: String, enum: AI_FEATURES, required: true, index: true },
    actor: { type: objectId, ref: "User", default: null },
    run: { type: objectId, ref: "AiRun", default: null },
    idempotencyKey: {
      type: String,
      trim: true,
      required: true,
      maxlength: 300,
    },
    status: {
      type: String,
      enum: Object.values(AI_USAGE_STATUS),
      default: AI_USAGE_STATUS.RESERVED,
      index: true,
    },
    reservedCredits: { type: Number, min: 0, required: true },
    settledCredits: { type: Number, min: 0, default: 0 },
    inputTokens: { type: Number, min: 0, default: 0 },
    outputTokens: { type: Number, min: 0, default: 0 },
    totalTokens: { type: Number, min: 0, default: 0 },
    model: { type: String, trim: true, default: "", maxlength: 160 },
    settledAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true },
);
aiUsageLedgerSchema.index({ tenant: 1, idempotencyKey: 1 }, { unique: true });
aiUsageLedgerSchema.index({ tenant: 1, periodKey: 1, createdAt: -1 });

const aiConversationSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    user: { type: objectId, ref: "User", default: null, index: true },
    audience: { type: String, enum: AI_AUDIENCES, required: true, index: true },
    status: {
      type: String,
      enum: Object.values(AI_CONVERSATION_STATUS),
      default: AI_CONVERSATION_STATUS.ACTIVE,
    },
    title: {
      type: String,
      trim: true,
      default: "New conversation",
      maxlength: 200,
    },
    locale: { type: String, trim: true, default: "en", maxlength: 24 },
    locationId: { type: objectId, ref: "Location", default: null, index: true },
    workspaceAccessVersion: { type: Number, min: 1, default: null },
    publicSessionHash: {
      type: String,
      default: "",
      select: false,
      maxlength: 128,
    },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true },
);
aiConversationSchema.index({
  tenant: 1,
  user: 1,
  audience: 1,
  workspaceAccessVersion: 1,
  lastMessageAt: -1,
});
aiConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const citationSchema = new Schema(
  {
    sourceId: { type: String, required: true, maxlength: 100 },
    resourceId: { type: String, default: "", maxlength: 100 },
    title: { type: String, required: true, maxlength: 240 },
    audience: { type: String, default: "", maxlength: 40 },
    type: { type: String, default: "", maxlength: 40 },
    category: { type: String, default: "", maxlength: 100 },
    sourceUrl: { type: String, default: "", maxlength: 3000 },
    sourceHref: { type: String, default: "", maxlength: 500 },
    version: { type: Number, min: 1, default: 1 },
    contentHash: { type: String, default: "", maxlength: 64 },
    locale: { type: String, enum: ["", ...AI_LOCALES], default: "" },
    excerpt: { type: String, default: "", maxlength: 1_000 },
    updatedAt: { type: Date, default: null },
    retrievedAt: { type: Date, default: null },
  },
  { _id: false, strict: true },
);

const assistantGroundingSchema = new Schema(
  {
    status: {
      type: String,
      enum: [
        "grounded",
        "workspace_facts",
        "general_knowledge",
        "unavailable",
        "insufficient",
      ],
      required: true,
    },
    basis: {
      type: String,
      enum: [
        "workspace_facts",
        // Legacy customer concierge messages may retain this value. New
        // provider output cannot produce it under the current policy.
        "customer_facts",
        "public_facts",
        "knowledge",
        "mixed",
        "general_knowledge",
        "insufficient",
      ],
      required: true,
    },
    insufficientEvidence: { type: Boolean, required: true },
    knowledgeStatus: {
      type: String,
      enum: [
        "matched",
        "no_match",
        "disabled",
        "unavailable",
        "not_applicable",
      ],
      required: true,
    },
    retrievalMode: {
      type: String,
      enum: ["", "hybrid", "lexical"],
      default: "",
    },
    confidence: {
      type: String,
      enum: ["", "high", "medium", "insufficient"],
      default: "",
    },
    sourceCount: { type: Number, min: 0, max: 20, default: 0 },
    candidateCount: { type: Number, min: 0, default: 0 },
    retrievedAt: { type: Date, default: null },
  },
  { _id: false, strict: true },
);

const aiEvidenceContextSchema = new Schema(
  {
    basis: { type: String, required: true, maxlength: 80 },
    freshnessAt: { type: Date, default: null },
    sourceCount: { type: Number, min: 0, max: 500, required: true },
    candidateCount: { type: Number, min: 0, default: undefined },
    complete: { type: Boolean, default: undefined },
    truncated: { type: Boolean, required: true, default: false },
  },
  { _id: false, strict: true },
);

const aiEvidenceSourceSchema = new Schema(
  {
    id: { type: String, required: true, maxlength: 100 },
    resourceId: { type: String, default: "", maxlength: 100 },
    title: { type: String, required: true, maxlength: 240 },
    type: { type: String, default: "", maxlength: 40 },
    category: { type: String, default: "", maxlength: 100 },
    audience: { type: String, default: "", maxlength: 40 },
    locale: { type: String, default: "", maxlength: 10 },
    version: { type: Number, min: 1, default: undefined },
    href: { type: String, default: "", maxlength: 3_000 },
    excerpt: { type: String, default: "", maxlength: 1_000 },
    updatedAt: { type: Date, default: null },
    retrievedAt: { type: Date, default: null },
  },
  { _id: false, strict: true },
);

const aiEvidenceWarningSchema = new Schema(
  {
    code: { type: String, required: true, maxlength: 120 },
    label: { type: String, default: "", maxlength: 300 },
    question: { type: String, default: "", maxlength: 500 },
    category: { type: String, default: "", maxlength: 100 },
  },
  { _id: false, strict: true },
);

const aiEvidenceSchema = new Schema(
  {
    generatedAt: { type: Date, default: null },
    context: { type: aiEvidenceContextSchema, required: true },
    sources: { type: [aiEvidenceSourceSchema], default: [] },
    warnings: { type: [aiEvidenceWarningSchema], default: [] },
  },
  { _id: false, strict: true },
);

const assistantNavigationSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ["setup_step", "booking_composer"],
      default: "setup_step",
      required: true,
    },
    stepId: { type: String, trim: true, default: "", maxlength: 80 },
    label: { type: String, required: true, trim: true, maxlength: 200 },
    href: { type: String, required: true, trim: true, maxlength: 300 },
  },
  { _id: false, strict: true },
);

const aiMessageSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    conversation: {
      type: objectId,
      ref: "AiConversation",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true,
    },
    content: { type: String, required: true, maxlength: 50_000 },
    contextPolicyVersion: {
      type: Number,
      min: 1,
      default: null,
    },
    run: { type: objectId, ref: "AiRun", default: null },
    citations: { type: [citationSchema], default: [] },
    grounding: { type: assistantGroundingSchema, default: null },
    evidence: { type: aiEvidenceSchema, default: null },
    suggestedReplies: {
      type: [{ type: String, trim: true, maxlength: 240 }],
      default: [],
      validate: {
        validator: (value: string[]) => value.length <= 4,
        message:
          "Assistant messages may include at most four suggested replies.",
      },
    },
    navigation: { type: [assistantNavigationSchema], default: [] },
    actionIds: { type: [objectId], ref: "AiAction", default: [] },
    provider: { type: String, default: "", maxlength: 80 },
    model: { type: String, default: "", maxlength: 160 },
    // Public concierge messages share their conversation expiry so the TTL
    // cleanup does not leave permanent orphan rows. Authenticated messages use null.
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true },
);
aiMessageSchema.index({ tenant: 1, conversation: 1, createdAt: 1 });
aiMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const aiActionSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    conversation: {
      type: objectId,
      ref: "AiConversation",
      required: true,
      index: true,
    },
    requestedBy: { type: objectId, ref: "User", required: true, index: true },
    sourceMessage: {
      type: objectId,
      ref: "AiMessage",
      default: null,
      index: true,
    },
    run: { type: objectId, ref: "AiRun", default: null, index: true },
    key: { type: String, required: true, trim: true, maxlength: 80 },
    label: { type: String, required: true, trim: true, maxlength: 200 },
    schemaVersion: {
      type: String,
      required: true,
      default: AI_ACTION_SCHEMA_VERSION,
      maxlength: 80,
    },
    idempotencyKey: { type: String, trim: true, default: "", maxlength: 300 },
    payload: { type: Schema.Types.Mixed, required: true, select: false },
    payloadHash: { type: String, trim: true, default: "", maxlength: 128 },
    preview: { type: Schema.Types.Mixed, required: true, default: {} },
    targetSnapshot: { type: Schema.Types.Mixed, default: null, select: false },
    requiredPermission: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    requiredModule: { type: String, trim: true, default: "", maxlength: 100 },
    riskLevel: {
      type: String,
      enum: Object.values(AI_ACTION_RISK),
      default: AI_ACTION_RISK.LOW,
    },
    locationId: { type: objectId, ref: "Location", default: null },
    status: {
      type: String,
      enum: Object.values(AI_ACTION_STATUS),
      default: AI_ACTION_STATUS.SUGGESTED,
      index: true,
    },
    result: { type: Schema.Types.Mixed, default: null },
    errorCode: { type: String, trim: true, default: "", maxlength: 120 },
    error: { type: String, default: "", maxlength: 2_000, select: false },
    decidedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    leaseExpiresAt: { type: Date, default: null },
    executionAttempts: { type: Number, min: 0, default: 0 },
    executionVersion: { type: Number, min: 0, default: 0 },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true, strict: true },
);
aiActionSchema.index({ tenant: 1, conversation: 1, createdAt: -1 });
aiActionSchema.index({ tenant: 1, requestedBy: 1, createdAt: -1 });
aiActionSchema.index({ tenant: 1, status: 1, createdAt: -1 });
aiActionSchema.index(
  { tenant: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $gt: "" } },
  },
);

const aiActionEventSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    action: { type: objectId, ref: "AiAction", required: true, index: true },
    conversation: {
      type: objectId,
      ref: "AiConversation",
      required: true,
      index: true,
    },
    actor: { type: objectId, ref: "User", required: true, index: true },
    eventKey: { type: String, required: true, trim: true, maxlength: 160 },
    type: {
      type: String,
      enum: Object.values(AI_ACTION_EVENT),
      required: true,
      index: true,
    },
    fromStatus: { type: String, default: "", maxlength: 40 },
    toStatus: { type: String, default: "", maxlength: 40 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, strict: true },
);
aiActionEventSchema.index({ tenant: 1, action: 1, createdAt: 1 });
aiActionEventSchema.index({ tenant: 1, createdAt: -1 });
aiActionEventSchema.index(
  { tenant: 1, action: 1, eventKey: 1 },
  {
    unique: true,
    partialFilterExpression: { eventKey: { $gt: "" } },
  },
);

const aiBriefingSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    user: { type: objectId, ref: "User", required: true, index: true },
    dateKey: { type: String, required: true, trim: true, maxlength: 20 },
    scopeKey: { type: String, required: true, trim: true, maxlength: 200 },
    schemaVersion: {
      type: String,
      default: "daily-studio-briefing-v2",
      maxlength: 80,
    },
    contextVersion: { type: String, default: "", maxlength: 80 },
    accessFingerprint: { type: String, default: "", maxlength: 128 },
    snapshotHash: { type: String, default: "", maxlength: 128 },
    locale: { type: String, default: "en", maxlength: 24 },
    timezone: { type: String, default: "UTC", maxlength: 120 },
    headline: { type: String, required: true, maxlength: 300 },
    summary: { type: String, required: true, maxlength: 8_000 },
    priorities: { type: [String], default: [] },
    metrics: { type: Schema.Types.Mixed, default: {} },
    attention: { type: [Schema.Types.Mixed], default: [] },
    suggestedActions: { type: [Schema.Types.Mixed], default: [] },
    coverage: { type: Schema.Types.Mixed, default: {} },
    provenance: { type: Schema.Types.Mixed, default: {} },
    run: { type: objectId, ref: "AiRun", default: null },
    dataAsOf: { type: Date, default: Date.now },
    generatedAt: { type: Date, default: Date.now },
    refreshAfter: { type: Date, default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 45 * 24 * 60 * 60 * 1_000),
    },
  },
  { timestamps: true, strict: true },
);
aiBriefingSchema.index(
  { tenant: 1, user: 1, dateKey: 1, scopeKey: 1 },
  { unique: true },
);
aiBriefingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const advisorEvidencePeriodSchema = new Schema(
  {
    from: { type: String, required: true, maxlength: 10 },
    to: { type: String, required: true, maxlength: 10 },
  },
  { _id: false, strict: true },
);

const advisorEvidenceSchema = new Schema(
  {
    id: { type: String, required: true, maxlength: 40 },
    source: { type: String, required: true, maxlength: 80 },
    metric: { type: String, required: true, maxlength: 160 },
    label: { type: String, required: true, maxlength: 240 },
    value: { type: Number, default: null },
    previousValue: { type: Number, default: null },
    changePercent: { type: Number, default: null },
    unit: {
      type: String,
      enum: ["count", "percent", "minor_currency", "hours"],
      required: true,
    },
    currency: { type: String, default: null, maxlength: 3 },
    period: { type: advisorEvidencePeriodSchema, default: null },
  },
  { _id: false, strict: true },
);

const advisorRecommendationSchema = new Schema(
  {
    id: {
      type: String,
      required: true,
      match: /^adv_[a-f0-9]{24}$/,
      maxlength: 28,
    },
    key: { type: String, required: true, maxlength: 200 },
    category: {
      type: String,
      enum: Object.values(BUSINESS_ADVISOR_CATEGORY),
      required: true,
    },
    kind: {
      type: String,
      enum: Object.values(BUSINESS_ADVISOR_KIND),
      required: true,
    },
    priority: {
      type: String,
      enum: Object.values(BUSINESS_ADVISOR_PRIORITY),
      required: true,
    },
    impact: {
      type: String,
      enum: Object.values(BUSINESS_ADVISOR_PRIORITY),
      required: true,
    },
    effort: {
      type: String,
      enum: Object.values(BUSINESS_ADVISOR_EFFORT),
      required: true,
    },
    confidence: {
      type: String,
      enum: Object.values(BUSINESS_ADVISOR_CONFIDENCE),
      required: true,
    },
    title: { type: String, required: true, maxlength: 300 },
    rationale: { type: String, required: true, maxlength: 2_000 },
    nextStep: { type: String, required: true, maxlength: 2_000 },
    evidence: { type: [advisorEvidenceSchema], default: [] },
    href: {
      type: String,
      required: true,
      match: /^\/app(?:[/?#]|$)/,
      maxlength: 500,
    },
    assistantIntent: { type: String, required: true, maxlength: 160 },
  },
  { _id: false, strict: true },
);

const advisorCoverageUnavailableSchema = new Schema(
  {
    source: { type: String, required: true, maxlength: 120 },
    reason: { type: String, required: true, maxlength: 120 },
  },
  { _id: false, strict: true },
);

const advisorCoverageSchema = new Schema(
  {
    available: { type: [String], default: [] },
    unavailable: { type: [advisorCoverageUnavailableSchema], default: [] },
    limitations: { type: [String], default: [] },
    complete: { type: Boolean, required: true },
  },
  { _id: false, strict: true },
);

const advisorPeriodSchema = new Schema(
  {
    from: { type: String, required: true, maxlength: 10 },
    to: { type: String, required: true, maxlength: 10 },
    comparisonPeriod: { type: advisorEvidencePeriodSchema, default: null },
    timezone: { type: String, required: true, maxlength: 120 },
    currency: { type: String, required: true, maxlength: 3 },
    locationId: { type: String, default: null, maxlength: 100 },
  },
  { _id: false, strict: true },
);

const aiAdvisorSnapshotSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    user: { type: objectId, ref: "User", required: true, index: true },
    scopeKey: { type: String, required: true, maxlength: 200 },
    schemaVersion: {
      type: String,
      default: BUSINESS_ADVISOR_SCHEMA_VERSION,
      maxlength: 80,
    },
    accessFingerprint: { type: String, required: true, maxlength: 128 },
    snapshotHash: { type: String, required: true, maxlength: 128 },
    locale: { type: String, enum: AI_LOCALES, required: true },
    timezone: { type: String, required: true, maxlength: 120 },
    locationId: { type: objectId, ref: "Location", default: null, index: true },
    status: {
      type: String,
      enum: Object.values(BUSINESS_ADVISOR_STATUS),
      required: true,
      index: true,
    },
    headline: { type: String, required: true, maxlength: 300 },
    summary: { type: String, required: true, maxlength: 4_000 },
    recommendations: { type: [advisorRecommendationSchema], default: [] },
    period: { type: advisorPeriodSchema, required: true },
    coverage: { type: advisorCoverageSchema, required: true },
    provenance: { type: Schema.Types.Mixed, default: {} },
    run: { type: objectId, ref: "AiRun", default: null },
    dataAsOf: { type: Date, required: true },
    generatedAt: { type: Date, required: true, index: true },
    refreshAfter: { type: Date, required: true },
    adviceExpiresAt: { type: Date, required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, strict: true },
);
aiAdvisorSnapshotSchema.index(
  { tenant: 1, user: 1, scopeKey: 1 },
  { unique: true },
);
aiAdvisorSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const aiSettingsSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, unique: true },
    enabled: { type: Boolean, default: true },
    communicationsCopilotEnabled: { type: Boolean, default: true },
    assistantEnabled: { type: Boolean, default: true },
    dailyBriefingEnabled: { type: Boolean, default: true },
    businessAdvisorEnabled: { type: Boolean, default: true },
    reportInsightsEnabled: { type: Boolean, default: true },
    staffPlanningEnabled: { type: Boolean, default: true },
    customerConciergeEnabled: { type: Boolean, default: true },
    publicConciergeEnabled: { type: Boolean, default: false },
    publicConciergeHandoffEnabled: { type: Boolean, default: true },
    firingIntelligenceEnabled: { type: Boolean, default: false },
    knowledgeBaseEnabled: { type: Boolean, default: true },
    moderationEnabled: { type: Boolean, default: true },
    defaultLocale: { type: String, default: "en", maxlength: 24 },
    briefingTime: {
      type: String,
      default: "07:30",
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
    updatedBy: { type: objectId, ref: "User", default: null },
  },
  { timestamps: true, strict: true },
);

const aiFeedbackSchema = new Schema(
  {
    tenant: { type: objectId, ref: "Tenant", required: true, index: true },
    user: { type: objectId, ref: "User", required: true, index: true },
    run: { type: objectId, ref: "AiRun", default: null, index: true },
    conversation: { type: objectId, ref: "AiConversation", default: null },
    rating: {
      type: String,
      enum: Object.values(AI_FEEDBACK_RATING),
      required: true,
    },
    comment: { type: String, trim: true, default: "", maxlength: 2_000 },
  },
  { timestamps: true, strict: true },
);
aiFeedbackSchema.index({ tenant: 1, rating: 1, createdAt: -1 });
aiFeedbackSchema.index(
  { tenant: 1, user: 1, run: 1 },
  { unique: true, partialFilterExpression: { run: { $type: "objectId" } } },
);
aiFeedbackSchema.index(
  { tenant: 1, user: 1, conversation: 1 },
  {
    unique: true,
    partialFilterExpression: {
      conversation: { $type: "objectId" },
      run: null,
    },
  },
);

export const AiRunModel: mongoose.Model<any> =
  (mongoose.models.AiRun as mongoose.Model<any>) ||
  mongoose.model<any>("AiRun", aiRunSchema);
export const AiUsagePeriodModel: mongoose.Model<any> =
  (mongoose.models.AiUsagePeriod as mongoose.Model<any>) ||
  mongoose.model<any>("AiUsagePeriod", aiUsagePeriodSchema);
export const AiUsageLedgerModel: mongoose.Model<any> =
  (mongoose.models.AiUsageLedger as mongoose.Model<any>) ||
  mongoose.model<any>("AiUsageLedger", aiUsageLedgerSchema);
export const AiConversationModel: mongoose.Model<any> =
  (mongoose.models.AiConversation as mongoose.Model<any>) ||
  mongoose.model<any>("AiConversation", aiConversationSchema);
export const AiMessageModel: mongoose.Model<any> =
  (mongoose.models.AiMessage as mongoose.Model<any>) ||
  mongoose.model<any>("AiMessage", aiMessageSchema);
export const AiActionModel: mongoose.Model<any> =
  (mongoose.models.AiAction as mongoose.Model<any>) ||
  mongoose.model<any>("AiAction", aiActionSchema);
export const AiActionEventModel: mongoose.Model<any> =
  (mongoose.models.AiActionEvent as mongoose.Model<any>) ||
  mongoose.model<any>("AiActionEvent", aiActionEventSchema);
export const AiBriefingModel: mongoose.Model<any> =
  (mongoose.models.AiBriefing as mongoose.Model<any>) ||
  mongoose.model<any>("AiBriefing", aiBriefingSchema);
export const AiAdvisorSnapshotModel: mongoose.Model<any> =
  (mongoose.models.AiAdvisorSnapshot as mongoose.Model<any>) ||
  mongoose.model<any>("AiAdvisorSnapshot", aiAdvisorSnapshotSchema);
export const AiSettingsModel: mongoose.Model<any> =
  (mongoose.models.AiSettings as mongoose.Model<any>) ||
  mongoose.model<any>("AiSettings", aiSettingsSchema);
export const AiFeedbackModel: mongoose.Model<any> =
  (mongoose.models.AiFeedback as mongoose.Model<any>) ||
  mongoose.model<any>("AiFeedback", aiFeedbackSchema);

export {
  aiActionSchema,
  aiActionEventSchema,
  aiBriefingSchema,
  aiAdvisorSnapshotSchema,
  aiConversationSchema,
  aiFeedbackSchema,
  aiMessageSchema,
  aiRunSchema,
  aiSettingsSchema,
  aiUsageLedgerSchema,
  aiUsagePeriodSchema,
};
