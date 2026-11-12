import type { RegisteredSenderEmailDocument } from "./registered-sender-email.types.js";
import {
  MANAGED_SENDER_PROVISIONING_ERROR_CODE_REGEX,
  MANAGED_SENDER_READINESS,
  REGISTERED_SENDER_PROVIDER,
  type ManagedSenderReadiness,
} from "./registered-sender-email.constants.js";

const managedDomain = () =>
  String(process.env.POSTMARK_FROM_DOMAIN || "notify.shario.io")
    .trim()
    .toLowerCase();

export const getManagedSenderReadiness = (
  value: Record<string, any>,
): ManagedSenderReadiness => {
  if (value.isActive !== true) return MANAGED_SENDER_READINESS.DISABLED;
  if (value.provider !== REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED) {
    return MANAGED_SENDER_READINESS.ERROR;
  }
  if (
    String(value.email || "")
      .split("@")[1]
      ?.toLowerCase() !== managedDomain()
  ) {
    return MANAGED_SENDER_READINESS.ERROR;
  }
  if (value.providerProvisioningStatus === "error") {
    return MANAGED_SENDER_READINESS.ERROR;
  }
  if (
    value.providerProvisioningStatus !== "ready" ||
    !value.providerServerId ||
    !value.providerProvisionedAt
  ) {
    return MANAGED_SENDER_READINESS.PROVISIONING;
  }
  if (!value.replyToEmail || !value.replyToVerifiedAt) {
    return MANAGED_SENDER_READINESS.REPLY_TO_PENDING;
  }
  return MANAGED_SENDER_READINESS.READY;
};

export const sanitizeRegisteredSenderEmail = (
  senderEmail: RegisteredSenderEmailDocument | Record<string, unknown>,
): Record<string, unknown> => {
  const item =
    "toObject" in senderEmail && typeof senderEmail.toObject === "function"
      ? senderEmail.toObject()
      : { ...senderEmail };

  const readiness = getManagedSenderReadiness(item);
  const provisioningErrorCode = String(
    item.providerProvisioningErrorCode || "",
  ).trim();
  item.providerProvisioningErrorCode =
    MANAGED_SENDER_PROVISIONING_ERROR_CODE_REGEX.test(provisioningErrorCode)
      ? provisioningErrorCode
      : "";
  item.providerProvisioningAttemptedAt =
    item.providerProvisioningAttemptedAt || null;

  delete item.encryptedSmtpPassword;
  delete item.encryptedPostmarkServerToken;
  delete item.providerProvisioningError;
  delete item.providerProvisioningAttemptId;
  delete item.lastTestError;
  delete item.lastTestProviderMessageId;
  delete item.lastTestRecipientEmail;
  delete item.managedTestCorrelations;
  delete item.replyToVerificationCodeHash;
  delete item.replyToVerificationExpiresAt;
  delete item.replyToVerificationSentAt;
  delete item.replyToVerificationAttempts;

  item.readiness = readiness;

  return item;
};
