import type { HydratedDocument, InferSchemaType, Types } from "mongoose";

import type { registeredSenderEmailSchema } from "./registered-sender-email.schema.js";

export type RegisteredSenderEmail = InferSchemaType<
  typeof registeredSenderEmailSchema
>;

export type RegisteredSenderEmailDocument =
  HydratedDocument<RegisteredSenderEmail>;

export type RegisteredSenderEmailSafe = Omit<
  RegisteredSenderEmail,
  | "encryptedSmtpPassword"
  | "encryptedPostmarkServerToken"
  | "providerProvisioningError"
  | "providerProvisioningAttemptId"
  | "lastTestError"
  | "replyToVerificationCodeHash"
  | "replyToVerificationExpiresAt"
  | "replyToVerificationSentAt"
  | "replyToVerificationAttempts"
  | "lastTestProviderMessageId"
  | "lastTestRecipientEmail"
  | "managedTestCorrelations"
> & {
  _id: Types.ObjectId;
  automationCount?: number;
  readiness?:
    "provisioning" | "reply_to_pending" | "ready" | "disabled" | "error";
};

export type SenderEmailListFilters = {
  tenantId: string;
  search?: string;
  isActive?: boolean;
};
