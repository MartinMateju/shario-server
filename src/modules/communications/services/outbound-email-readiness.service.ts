import {
  resolveManagedSender,
  type ResolvedManagedSender,
} from "@/modules/registered-sender-email/services/managed-sender-resolver.service.js";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";

import {
  COMMUNICATION_CHANNEL,
  type CommunicationChannel,
} from "../communications.constants.js";

export const assertOutboundEmailContentSupported = ({
  channel,
  attachments,
}: {
  channel: CommunicationChannel;
  attachments?: unknown[];
}): void => {
  if (channel === COMMUNICATION_CHANNEL.EMAIL && attachments?.length) {
    badRequest({
      message: "Attachments are not enabled for managed email yet.",
      code: "ATTACHMENTS_NOT_SUPPORTED",
    });
  }
};

export const resolveOutboundComposeSender = async ({
  tenantId,
  channel,
}: {
  tenantId: string;
  channel: CommunicationChannel;
}): Promise<ResolvedManagedSender | null> => {
  if (channel !== COMMUNICATION_CHANNEL.EMAIL) return null;
  try {
    return await resolveManagedSender({ tenantId });
  } catch (error: any) {
    if (error?.deliveryOutcome === "not_sent" && error?.code) {
      conflict({
        message: String(error.message || "Managed email is not ready."),
        code: String(error.code),
      });
    }
    throw error;
  }
};
