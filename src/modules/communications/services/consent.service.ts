import type {
  CommunicationChannel,
  ConsentPurpose,
} from "../communications.constants.js";

export type ConsentRecord = {
  status?: "granted" | "revoked" | "unknown" | string;
  expiresAt?: Date | string | null;
};

export const isCommunicationAllowed = ({
  channel,
  purpose,
  consent,
  customerInitiated = false,
  serviceWindowOpen = false,
  suppressed = false,
  now = new Date(),
}: {
  channel: CommunicationChannel | string;
  purpose: ConsentPurpose | string;
  consent?: ConsentRecord | null;
  customerInitiated?: boolean;
  serviceWindowOpen?: boolean;
  suppressed?: boolean;
  now?: Date;
}): { allowed: boolean; reason: string } => {
  if (suppressed) return { allowed: false, reason: "recipient_suppressed" };

  if (
    consent?.expiresAt &&
    new Date(consent.expiresAt).getTime() <= now.getTime()
  ) {
    return { allowed: false, reason: "consent_expired" };
  }

  if (consent?.status === "revoked") {
    return { allowed: false, reason: "consent_revoked" };
  }

  if (purpose === "security") {
    return { allowed: true, reason: "security_necessity" };
  }

  if (purpose === "support" && customerInitiated) {
    if (!["whatsapp", "instagram"].includes(channel) || serviceWindowOpen) {
      return { allowed: true, reason: "customer_initiated_support" };
    }
  }

  if (purpose === "transactional" && !["whatsapp", "instagram"].includes(channel)) {
    return consent?.status === "revoked"
      ? { allowed: false, reason: "consent_revoked" }
      : { allowed: true, reason: "transactional_necessity" };
  }

  if (consent?.status === "granted") {
    return { allowed: true, reason: "consent_granted" };
  }

  return {
    allowed: false,
    reason:
      purpose === "marketing" ? "marketing_opt_in_required" : "consent_required",
  };
};
