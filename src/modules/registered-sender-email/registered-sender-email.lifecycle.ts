import type {
  CreateRegisteredSenderEmailInput,
  UpdateRegisteredSenderEmailInput,
} from "./registered-sender-email.validators.js";

export const hasRegisteredSenderTransportChanges = (
  existing: Record<string, any>,
  input: UpdateRegisteredSenderEmailInput | CreateRegisteredSenderEmailInput,
): boolean =>
  input.replyToEmail !== undefined &&
  input.replyToEmail.toLowerCase() !==
    String(
      existing.pendingReplyToEmail || existing.replyToEmail || "",
    ).toLowerCase();
