import type { HydratedDocument, InferSchemaType, Model, Types } from "mongoose";

import type { communicationEmailLogSchema } from "./communication-email-log.schema.js";
import type {
  CommunicationEmailAllowanceClass,
  CommunicationEmailLogStatus,
  CommunicationEmailType,
} from "./communication-email-log.constants.js";

export type CommunicationEmailLog = InferSchemaType<
  typeof communicationEmailLogSchema
>;
export type CommunicationEmailLogDocument =
  HydratedDocument<CommunicationEmailLog>;
export type CommunicationEmailLogMongooseModel = Model<CommunicationEmailLog>;

export type CommunicationEmailLogListFilters = {
  tenantId: string;
  allowedLocationIds?: readonly string[] | null;
  status?: CommunicationEmailLogStatus | "all";
  emailType?: CommunicationEmailType | "all";
  search?: string;
  automationId?: string;
  userId?: string;
  recipientEmail?: string;
  relatedEntityId?: string;
  firingId?: string;
  page?: number;
  limit?: number;
};

export type CreateCommunicationEmailLogInput = {
  tenant: Types.ObjectId;
  automation?: Types.ObjectId | null;
  user?: Types.ObjectId | null;
  recipientEmail: string;
  recipientName?: string;
  subject: string;
  htmlContent?: string;
  body?: string;
  contentFormat?: "html" | "plain";
  emailType: CommunicationEmailType;
  status?: CommunicationEmailLogStatus;
  scheduledFor?: Date | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  bouncedAt?: Date | null;
  complainedAt?: Date | null;
  failedAt?: Date | null;
  errorMessage?: string;
  location?: Types.ObjectId | null;
  appliesToAllLocations?: boolean;
  relatedEntityId?: Types.ObjectId | null;
  relatedEntityType?: string;
  senderEmail?: Types.ObjectId | null;
  deduplicationKey: string;
  occurrenceKey: string;
  locale?: "cs" | "en";
  purpose?: "transactional" | "marketing" | "security";
  allowanceClass?: CommunicationEmailAllowanceClass;
  provider?: string;
  providerMessageId?: string;
  attempts?: number;
  retryCycleStartAttempt?: number;
  manualRetryCount?: number;
  lastManualRetryAt?: Date | null;
  lastManualRetryBy?: Types.ObjectId | null;
  retryable?: boolean;
  queuedAt?: Date | null;
  processingStartedAt?: Date | null;
  processingJobId?: string;
  processingClaimToken?: string;
  processingLeaseExpiresAt?: Date | null;
  providerAttemptStartedAt?: Date | null;
  manualReviewRequiredAt?: Date | null;
  queueRecoveryAttempts?: number;
  nextQueueRecoveryAt?: Date | null;
  queueRecoveryClaimToken?: string;
  queueRecoveryLeaseExpiresAt?: Date | null;
  canceledAt?: Date | null;
  cancelReason?: string;
  sourceScheduledAt?: Date | null;
  sourceOrderId?: Types.ObjectId | null;
  sourceFiringItemId?: Types.ObjectId | null;
};
