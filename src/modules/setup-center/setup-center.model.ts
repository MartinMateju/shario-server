import mongoose, { Schema } from "mongoose";

import {
  SETUP_CENTER_DEFINITION_VERSION,
  SETUP_LAUNCH_EVENTS,
  SETUP_LAUNCH_EVENT_SOURCES,
  SETUP_PRACTICE_ACTIONS,
  SETUP_PRACTICE_STATUS,
  SETUP_PUBLICATION_STATUS,
  SETUP_STEPS,
} from "./setup-center.constants.js";

const setupLaunchStepMetricSchema = new Schema(
  {
    opened: { type: Number, min: 0, default: 0 },
    completed: { type: Number, min: 0, default: 0 },
    firstOpenedAt: { type: Date, default: undefined },
    lastOpenedAt: { type: Date, default: undefined },
    firstCompletedAt: { type: Date, default: undefined },
    lastCompletedAt: { type: Date, default: undefined },
  },
  { _id: false, strict: true },
);

const setupLaunchStepMetricsSchema = new Schema(
  Object.fromEntries(
    SETUP_STEPS.map((stepId) => [
      stepId,
      { type: setupLaunchStepMetricSchema, default: () => ({}) },
    ]),
  ),
  { _id: false, strict: true },
);

const setupLaunchAnalyticsSchema = new Schema(
  {
    firstSeenAt: { type: Date, default: undefined },
    lastActivityAt: { type: Date, default: undefined },
    firstPublishedOfferAt: { type: Date, default: undefined },
    firstPublishedAt: { type: Date, default: undefined },
    completedAt: { type: Date, default: undefined },
    lastStepId: { type: String, enum: SETUP_STEPS, default: undefined },
    eventCounts: {
      launchCenterViewed: { type: Number, min: 0, default: 0 },
      studioReady: { type: Number, min: 0, default: 0 },
      publicSiteOpened: { type: Number, min: 0, default: 0 },
      testBookingOpened: { type: Number, min: 0, default: 0 },
      productTourStarted: { type: Number, min: 0, default: 0 },
      productTourCompleted: { type: Number, min: 0, default: 0 },
      productTourSkipped: { type: Number, min: 0, default: 0 },
      productTourLaunchCenterOpened: {
        type: Number,
        min: 0,
        default: 0,
      },
    },
    steps: { type: setupLaunchStepMetricsSchema, default: () => ({}) },
  },
  { _id: false, strict: true },
);

const practiceArtifactSchema = new Schema(
  {
    kind: {
      type: String,
      enum: [
        "booking",
        "invoice",
        "confirmation",
        "membership",
        "check_in",
        "cancellation",
      ],
      required: true,
    },
    title: { type: String, trim: true, required: true, maxlength: 180 },
    summary: { type: String, trim: true, required: true, maxlength: 1_000 },
    amountMinor: { type: Number, min: 0, default: null },
    currency: { type: String, trim: true, uppercase: true, maxlength: 3 },
    createdAt: { type: Date, required: true },
  },
  { _id: false, strict: true },
);

const setupPracticeRunSchema = new Schema(
  {
    runId: { type: String, required: true, trim: true, maxlength: 80 },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: Object.values(SETUP_PRACTICE_STATUS),
      default: SETUP_PRACTICE_STATUS.IN_PROGRESS,
      required: true,
    },
    locationId: { type: Schema.Types.ObjectId, ref: "Location", default: null },
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    readinessFingerprint: {
      type: String,
      trim: true,
      required: true,
      maxlength: 128,
    },
    completedActions: {
      type: [String],
      enum: SETUP_PRACTICE_ACTIONS,
      default: [],
    },
    artifacts: { type: [practiceArtifactSchema], default: [] },
    startedAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { _id: false, strict: true },
);

interface SetupPracticeConfirmation {
  confirmedAt: Date;
  confirmedBy: mongoose.Types.ObjectId;
  readinessFingerprint: string;
}

// Explicitly bound the new subdocument's type inference; the parent schema
// already contains several independently typed nested structures.
const setupPracticeConfirmationSchema = new Schema<SetupPracticeConfirmation>(
  {
    confirmedAt: { type: Date, required: true },
    confirmedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    readinessFingerprint: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
  },
  { _id: false, strict: true },
);

export const setupCenterStateSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      unique: true,
      immutable: true,
    },
    definitionVersion: {
      type: Number,
      required: true,
      min: 1,
      default: SETUP_CENTER_DEFINITION_VERSION,
    },
    publication: {
      status: {
        type: String,
        enum: Object.values(SETUP_PUBLICATION_STATUS),
        default: SETUP_PUBLICATION_STATUS.DRAFT,
        required: true,
      },
      publishedAt: { type: Date, default: null },
      publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      unpublishedAt: { type: Date, default: null },
      unpublishedBy: {
        type: Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
    },
    practice: {
      type: setupPracticeRunSchema,
      default: null,
    },
    // A staff attestation is separate from the simulated Practice Mode run.
    // It must never manufacture completed actions or preview artifacts.
    practiceConfirmation: {
      type: setupPracticeConfirmationSchema,
      default: null,
    },
    analytics: {
      type: setupLaunchAnalyticsSchema,
      default: () => ({}),
    },
  },
  { timestamps: true, strict: true },
);

setupCenterStateSchema.index({
  "publication.status": 1,
  updatedAt: -1,
});

export const SetupCenterStateModel =
  (mongoose.models.SetupCenterState as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("SetupCenterState", setupCenterStateSchema);

const setupAuditEventSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    actor: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    event: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true,
    },
    stepId: { type: String, trim: true, maxlength: 80, default: "" },
    practiceRunId: { type: String, trim: true, maxlength: 80, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, strict: true },
);

setupAuditEventSchema.index({ tenant: 1, createdAt: -1 });

export const SetupAuditEventModel =
  (mongoose.models.SetupAuditEvent as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("SetupAuditEvent", setupAuditEventSchema);

const SETUP_LAUNCH_EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;

/**
 * Short-lived product analytics are intentionally separated from the durable
 * setup audit log. The TTL bounds storage while aggregate counters and launch
 * milestones remain on SetupCenterState.
 */
const setupLaunchEventSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },
    actor: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    eventId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      match:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    sessionId: {
      type: String,
      required: true,
      trim: true,
      minlength: 8,
      maxlength: 80,
      match: /^[A-Za-z0-9_-]+$/,
    },
    event: {
      type: String,
      enum: SETUP_LAUNCH_EVENTS,
      required: true,
    },
    stepId: {
      type: String,
      enum: SETUP_STEPS,
      default: undefined,
    },
    source: {
      type: String,
      enum: SETUP_LAUNCH_EVENT_SOURCES,
      default: undefined,
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + SETUP_LAUNCH_EVENT_RETENTION_MS),
    },
  },
  { timestamps: true, strict: true },
);

setupLaunchEventSchema.index({ tenant: 1, eventId: 1 }, { unique: true });
setupLaunchEventSchema.index(
  { tenant: 1, sessionId: 1, event: 1, stepId: 1 },
  { unique: true },
);
setupLaunchEventSchema.index({ tenant: 1, event: 1, stepId: 1, createdAt: -1 });
setupLaunchEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SetupLaunchEventModel =
  (mongoose.models.SetupLaunchEvent as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("SetupLaunchEvent", setupLaunchEventSchema);
