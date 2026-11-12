import mongoose, { Schema } from "mongoose";

export const STRIPE_WEBHOOK_EVENT_STATUS = {
  PROCESSING: "processing",
  PROCESSED: "processed",
  FAILED: "failed",
} as const;

export type StripeWebhookEventStatus =
  (typeof STRIPE_WEBHOOK_EVENT_STATUS)[keyof typeof STRIPE_WEBHOOK_EVENT_STATUS];

export type StripeWebhookEvent = {
  eventId: string;
  type: string;
  stripeCreatedAt: number;
  status: StripeWebhookEventStatus;
  attempts: number;
  processedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
};

const stripeWebhookEventSchema = new Schema<StripeWebhookEvent>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
    },
    stripeCreatedAt: {
      type: Number,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: Object.values(STRIPE_WEBHOOK_EVENT_STATUS),
      required: true,
      default: STRIPE_WEBHOOK_EVENT_STATUS.PROCESSING,
    },
    attempts: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    processedAt: Date,
    lastError: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
  },
  {
    timestamps: true,
    strict: true,
  },
);

stripeWebhookEventSchema.index({ status: 1, updatedAt: 1 });
stripeWebhookEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 180 * 24 * 60 * 60 },
);

export const StripeWebhookEventModel =
  (mongoose.models.StripeWebhookEvent as
    | mongoose.Model<StripeWebhookEvent>
    | undefined) ??
  mongoose.model<StripeWebhookEvent>(
    "StripeWebhookEvent",
    stripeWebhookEventSchema,
  );

export default StripeWebhookEventModel;
