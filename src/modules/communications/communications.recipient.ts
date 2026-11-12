import { badRequest } from "@/shared/http/httpErrors.js";

type CustomerRecipientChannel = "email" | "whatsapp" | "instagram" | "in_app";

const normalizeEmail = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const normalizePhone = (value: unknown): string =>
  String(value ?? "").replace(/\D/g, "");

const normalizeExternalId = (value: unknown): string =>
  String(value ?? "").trim();

const recipientIdentity = (
  channel: CustomerRecipientChannel,
  recipient: Record<string, unknown>,
): string => {
  if (channel === "email") return normalizeEmail(recipient.email);
  if (channel === "whatsapp") {
    return normalizePhone(recipient.whatsappId || recipient.phone);
  }
  if (channel === "instagram") {
    return normalizeExternalId(recipient.instagramScopedId);
  }
  return normalizeExternalId(recipient.externalId);
};

/**
 * Resolves a customer-linked compose recipient from the tenant-owned customer
 * record. Caller-provided identity is only a consistency assertion; it can
 * never redirect delivery away from the stored customer.
 */
export const canonicalizeCustomerComposeRecipient = ({
  channel,
  customer,
  requestedRecipient,
}: {
  channel: CustomerRecipientChannel;
  customer: Record<string, unknown>;
  requestedRecipient?: Record<string, unknown> | null;
}) => {
  const name = [customer.firstname, customer.lastname]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");

  const canonical =
    channel === "email"
      ? { name, email: normalizeEmail(customer.email) }
      : channel === "whatsapp"
        ? {
            name,
            phone: String(customer.phone ?? "").trim(),
            whatsappId: String(customer.phone ?? "").trim(),
          }
        : channel === "in_app"
          ? { name, externalId: normalizeExternalId(customer.customId) }
          : { name, instagramScopedId: "", instagramUsername: "" };

  const canonicalIdentity = recipientIdentity(channel, canonical);
  if (!canonicalIdentity) {
    badRequest({
      message: "The customer does not have an identity for this channel.",
      code: "COMMUNICATION_CUSTOMER_CHANNEL_IDENTITY_MISSING",
      details: { channel },
    });
  }

  const requestedIdentity = requestedRecipient
    ? recipientIdentity(channel, requestedRecipient)
    : "";
  if (requestedIdentity && requestedIdentity !== canonicalIdentity) {
    badRequest({
      message: "The recipient does not match the selected customer.",
      code: "COMMUNICATION_CUSTOMER_RECIPIENT_MISMATCH",
      details: { channel },
    });
  }

  return canonical;
};
