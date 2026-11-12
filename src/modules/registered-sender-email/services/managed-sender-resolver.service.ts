import { decryptSecret } from "@/shared/security/encryption.js";

import { REGISTERED_SENDER_PROVIDER } from "../registered-sender-email.constants.js";
import { registeredSenderEmailRepository } from "../registered-sender-email.repository.js";

export class ManagedSenderNotReadyError extends Error {
  code: string;
  permanent = true;
  deliveryOutcome = "not_sent" as const;

  constructor(message: string, code = "MANAGED_SENDER_NOT_READY") {
    super(message);
    this.name = "ManagedSenderNotReadyError";
    this.code = code;
  }
}

const fromDomain = () =>
  String(process.env.POSTMARK_FROM_DOMAIN || "notify.shario.io")
    .trim()
    .toLowerCase();

const fail = (message: string, code?: string): never => {
  throw new ManagedSenderNotReadyError(message, code);
};

export type ResolvedManagedSender = {
  id: string;
  tenantId: string;
  fromEmail: string;
  displayName: string;
  replyToEmail: string;
  postmarkServerToken: string;
  providerServerId: number;
};

export const resolveManagedSender = async ({
  tenantId,
  senderEmailId,
}: {
  tenantId: string;
  senderEmailId?: string;
}): Promise<ResolvedManagedSender> => {
  const sender = await registeredSenderEmailRepository.findManagedForResolution(
    tenantId,
    senderEmailId,
  );
  if (!sender) {
    fail(
      senderEmailId
        ? "The selected managed sender is unavailable."
        : "Managed email is not configured for this workspace.",
      "MANAGED_SENDER_NOT_CONFIGURED",
    );
  }
  if (
    sender.provider !== REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED ||
    sender.isActive !== true
  ) {
    fail("The selected sender is not an active managed identity.");
  }
  const fromEmail = String(sender.email || "")
    .trim()
    .toLowerCase();
  if (fromEmail.split("@")[1] !== fromDomain()) {
    fail(
      "The managed From address does not belong to the configured domain.",
      "MANAGED_FROM_DOMAIN_INVALID",
    );
  }
  const replyToEmail = String(sender.replyToEmail || "")
    .trim()
    .toLowerCase();
  if (!replyToEmail || !sender.replyToVerifiedAt) {
    fail(
      "Verify the Reply-To address before sending email.",
      "REPLY_TO_NOT_VERIFIED",
    );
  }
  if (
    !sender.providerServerId ||
    !sender.providerProvisionedAt ||
    sender.providerProvisioningStatus !== "ready" ||
    !sender.encryptedPostmarkServerToken
  ) {
    fail(
      "The isolated Postmark Server is not provisioned.",
      "POSTMARK_SERVER_NOT_PROVISIONED",
    );
  }
  let postmarkServerToken: string;
  try {
    postmarkServerToken = decryptSecret(sender.encryptedPostmarkServerToken);
  } catch {
    fail(
      "The isolated Postmark Server credential is invalid.",
      "POSTMARK_SERVER_CREDENTIAL_INVALID",
    );
  }
  if (!postmarkServerToken.trim()) {
    fail(
      "The isolated Postmark Server credential is missing.",
      "POSTMARK_SERVER_CREDENTIAL_INVALID",
    );
  }
  return {
    id: String(sender._id),
    tenantId,
    fromEmail,
    displayName: String(sender.displayName || "").trim(),
    replyToEmail,
    postmarkServerToken,
    providerServerId: Number(sender.providerServerId),
  };
};
