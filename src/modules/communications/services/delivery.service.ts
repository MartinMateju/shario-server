import { createHash } from "node:crypto";

import {
  DELIVERY_STATUS,
  type CommunicationChannel,
} from "../communications.constants.js";
import type { ConsentRecord } from "./consent.service.js";
import { isCommunicationAllowed } from "./consent.service.js";

export const buildDeliveryIdempotencyKey = ({
  tenantId,
  messageId,
  channel,
  purpose = "support",
  generation = 0,
}: {
  tenantId: unknown;
  messageId: unknown;
  channel: unknown;
  purpose?: unknown;
  generation?: number;
}): string =>
  `comm_${createHash("sha256")
    .update(
      [tenantId, messageId, channel, purpose, generation].map(String).join(":"),
    )
    .digest("hex")}`;

export const getDeliveryRetryDecision = ({
  status,
  attempts,
  maxAttempts,
  permanent = false,
  baseSeconds = 60,
  now = new Date(),
}: {
  status: string;
  attempts: number;
  maxAttempts: number;
  permanent?: boolean;
  baseSeconds?: number;
  now?: Date;
}): { retry: boolean; nextAttemptAt: Date | null; reason: string } => {
  if (
    permanent ||
    status === DELIVERY_STATUS.BOUNCED ||
    status === DELIVERY_STATUS.REJECTED
  ) {
    return { retry: false, nextAttemptAt: null, reason: "permanent_failure" };
  }
  if (
    [
      DELIVERY_STATUS.AMBIGUOUS,
      DELIVERY_STATUS.SENT,
      DELIVERY_STATUS.DELIVERED,
      DELIVERY_STATUS.READ,
      DELIVERY_STATUS.CANCELLED,
    ].includes(status as never)
  ) {
    return { retry: false, nextAttemptAt: null, reason: "terminal_status" };
  }
  if (attempts >= maxAttempts) {
    return {
      retry: false,
      nextAttemptAt: null,
      reason: "attempt_limit_reached",
    };
  }

  const exponent = Math.max(0, attempts - 1);
  const delaySeconds = Math.min(
    86_400,
    Math.max(5, baseSeconds) * 2 ** exponent,
  );
  return {
    retry: true,
    nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
    reason: "retry_scheduled",
  };
};

export const selectFallbackChannel = ({
  failedChannel,
  order,
  available,
  consents = {},
  serviceWindows = {},
  purpose = "support",
}: {
  failedChannel: CommunicationChannel | string;
  order: readonly (CommunicationChannel | string)[];
  available: readonly (CommunicationChannel | string)[];
  consents?: Partial<Record<string, ConsentRecord | null>>;
  serviceWindows?: Partial<Record<string, boolean>>;
  purpose?: string;
}): CommunicationChannel | null => {
  const availableSet = new Set(available);
  for (const candidate of order) {
    if (candidate === failedChannel || !availableSet.has(candidate)) continue;
    const allowed = isCommunicationAllowed({
      channel: candidate,
      purpose,
      consent: consents[candidate],
      customerInitiated: purpose === "support",
      serviceWindowOpen:
        serviceWindows[String(candidate)] ??
        !["whatsapp", "instagram"].includes(String(candidate)),
    });
    if (allowed.allowed) return candidate as CommunicationChannel;
  }
  return null;
};
