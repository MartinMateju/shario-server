import type { HydratedDocument, InferSchemaType, Types } from "mongoose";

import type {
  accessCodeAuditEventSchema,
  accessCodeNotificationSchema,
  accessCodePoolSchema,
  accessCodeSchema,
} from "./access-code.schema.js";
import type {
  AccessCodeAuditAction,
  AccessCodeEffectiveStatus,
  AccessCodeNotificationChannel,
  AccessCodeNotificationStatus,
  AccessCodeProvider,
  AccessCodeStatus,
  AccessCodeType,
} from "./access-code.constants.js";

export type AccessCode = InferSchemaType<typeof accessCodeSchema>;
export type AccessCodeDocument = HydratedDocument<AccessCode>;
export type AccessCodePool = InferSchemaType<typeof accessCodePoolSchema>;
export type AccessCodePoolDocument = HydratedDocument<AccessCodePool>;
export type AccessCodeAuditEvent = InferSchemaType<
  typeof accessCodeAuditEventSchema
>;
export type AccessCodeAuditEventDocument =
  HydratedDocument<AccessCodeAuditEvent>;

export type AccessCodeNotification = InferSchemaType<
  typeof accessCodeNotificationSchema
>;
export type AccessCodeNotificationDocument =
  HydratedDocument<AccessCodeNotification>;

export type AccessCodeId = string;
export type TenantId = string;
export type BookingId = string;
export type UserId = string;

export type AccessCodeLean = {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  isUsed: boolean;
  usedCount: number;
  entryCode: string;
  expiresAt: Date | null;
  canBeRepeated: boolean;
  location: Types.ObjectId;
  pool?: Types.ObjectId | null;
  codeFingerprint?: string;
  codeHint?: string;
  type?: AccessCodeType;
  status?: AccessCodeStatus;
  validFrom?: Date | null;
  validUntil?: Date | null;
  verifiedAt?: Date | null;
  verifiedBy?: Types.ObjectId | null;
  retiredAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type AccessCodeNotificationLean = {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  booking: Types.ObjectId;
  accessCode: Types.ObjectId;
  user: Types.ObjectId;
  channel: AccessCodeNotificationChannel;
  bookingStart: Date | null;
  claimToken: string;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date | null;
  providerAttemptStartedAt?: Date | null;
  status: AccessCodeNotificationStatus;
  attempt: number;
  provider: AccessCodeProvider | "";
  providerMessageId: string;
  recipientEmail?: string;
  providerDeliveryStatus?: "" | "delivered" | "bounced" | "complained";
  providerStatusAt?: Date | null;
  providerEventKey?: string;
  deliveryHistory?: AccessCodeDeliveryHistory[];
  sentAt: Date | null;
  failedAt: Date | null;
  errorMessage: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export type AccessCodeDeliveryHistory = {
  transitionId: string;
  archivedAt: Date;
  bookingStart: Date | null;
  accessCode: Types.ObjectId;
  status: AccessCodeNotificationStatus;
  attempt: number;
  claimToken: string;
  provider: AccessCodeProvider | "";
  providerAttemptStartedAt: Date | null;
  recipientEmail: string;
  providerMessageId: string;
  providerDeliveryStatus: "" | "delivered" | "bounced" | "complained";
  providerStatusAt: Date | null;
  providerEventKey: string;
  sentAt: Date | null;
};

export type CreateAccessCodeInput = {
  tenantId: string;
  entryCode: string;
  expiresAt: Date;
  locationId: string;
  canBeRepeated?: boolean;
};

export type ReservedAccessCode = {
  accessCode: AccessCodeLean;
  reservedExclusiveCode: boolean;
};

export type AccessCodeNotificationResult = {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
};

export type AccessCodeAuditContext = {
  actorId: string;
  ipAddress?: string;
  userAgent?: string;
};

export type SerializedAccessCode = {
  id: string;
  poolId: string;
  locationId: string;
  type: AccessCodeType;
  status: AccessCodeStatus;
  effectiveStatus: AccessCodeEffectiveStatus;
  maskedCode: string;
  label: string;
  notes: string;
  validFrom: string | null;
  validUntil: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  programmedAndTested: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SerializedAccessCodeAuditEvent = {
  id: string;
  poolId: string;
  locationId: string;
  accessCodeId: string | null;
  actorId: string;
  actor: {
    name: string | null;
    email: string | null;
  } | null;
  action: AccessCodeAuditAction;
  metadata: Record<string, unknown>;
  createdAt: string;
};
