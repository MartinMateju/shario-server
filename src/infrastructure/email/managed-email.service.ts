import { createHash } from "node:crypto";

import {
  PostmarkRequestError,
  preparePostmarkAttachments,
  preparePostmarkEmailBody,
  sendPostmarkEmail,
  type PostmarkHeader,
  type PostmarkSendInput,
  type PostmarkSendResult,
} from "./postmark.client.js";
import { resolveManagedSender } from "@/modules/registered-sender-email/services/managed-sender-resolver.service.js";
import { applyTenantEmailLayout } from "./tenant-email-layout.service.js";

const safeMailboxName = (value: string): string =>
  value
    .replace(/[\r\n]/g, " ")
    .replace(/["\\]/g, "")
    .trim()
    .slice(0, 180);

const mailbox = (name: string, email: string): string => {
  const safeName = safeMailboxName(name);
  return safeName ? `"${safeName}" <${email}>` : email;
};

const toPostmarkHeaders = (
  headers: Record<string, string | undefined> | undefined,
): PostmarkHeader[] =>
  Object.entries(headers || {})
    .filter(([, value]) => Boolean(value))
    .map(([Name, value]) => ({
      Name: Name.replace(/[\r\n]/g, "").slice(0, 200),
      Value: String(value)
        .replace(/[\r\n]/g, "")
        .slice(0, 2_000),
    }));

export type ManagedEmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

export type ManagedTenantEmailInput = {
  tenantId: string;
  senderEmailId?: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** Voucher rendering already applies the same saved workspace layout. */
  layoutApplied?: boolean;
  headers?: Record<string, string | undefined>;
  attachments?: unknown[];
  idempotencyKey?: string;
  deliveryId?: string;
  messageId?: string;
  emailLogId?: string;
  automationId?: string;
  orderId?: string;
  accessCodeBookingId?: string;
  beforeSend?: () => Promise<void>;
};

export const sendManagedTenantEmail = async (
  input: ManagedTenantEmailInput,
): Promise<PostmarkSendResult> => {
  const attachments = preparePostmarkAttachments(input.attachments);
  const sender = await resolveManagedSender({
    tenantId: input.tenantId,
    senderEmailId: input.senderEmailId,
  });
  const postmarkInput: PostmarkSendInput = {
    serverToken: sender.postmarkServerToken,
    from: mailbox(sender.displayName, sender.fromEmail),
    replyTo: sender.replyToEmail,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.layoutApplied
      ? input.html
      : await applyTenantEmailLayout({
          tenantId: input.tenantId,
          html: input.html,
          text: input.text,
          brandName: sender.displayName,
          replyTo: sender.replyToEmail,
        }),
    attachments,
    headers: toPostmarkHeaders(input.headers),
    metadata: Object.fromEntries(
      Object.entries({
        tenantId: input.tenantId,
        managedSenderId: sender.id,
        idempotencyKey: input.idempotencyKey,
        deliveryId: input.deliveryId,
        // RFC Message-IDs can exceed Postmark's 80-character metadata limit.
        // Keep the full ID in the email header and a stable diagnostic hash
        // here; identifiers used for webhook lookups must remain unchanged.
        ...(input.messageId && input.messageId.length > 80
          ? {
              messageIdHash: createHash("sha256")
                .update(input.messageId)
                .digest("hex"),
            }
          : { messageId: input.messageId }),
        emailLogId: input.emailLogId,
        automationId: input.automationId,
        orderId: input.orderId,
        accessCodeBookingId: input.accessCodeBookingId,
      }).filter((entry): entry is [string, string] => Boolean(entry[1])),
    ),
  };
  // Resolve credentials and validate the encoded payload before claiming a
  // submission. Preparation errors have not crossed the provider boundary.
  preparePostmarkEmailBody(postmarkInput);
  await input.beforeSend?.();
  return sendPostmarkEmail(postmarkInput);
};

export const sendSystemPostmarkEmail = async ({
  to,
  subject,
  text,
  html,
  metadata,
}: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  metadata?: Record<string, string>;
}): Promise<PostmarkSendResult> => {
  const serverToken = String(
    process.env.POSTMARK_SYSTEM_SERVER_TOKEN || "",
  ).trim();
  const fromEmail = String(process.env.POSTMARK_SYSTEM_FROM_EMAIL || "")
    .trim()
    .toLowerCase();
  if (!serverToken || !fromEmail) {
    throw new PostmarkRequestError("System Postmark email is not configured.", {
      code: "POSTMARK_SYSTEM_NOT_CONFIGURED",
      permanent: true,
      deliveryOutcome: "not_sent",
    });
  }
  return sendPostmarkEmail({
    serverToken,
    from: mailbox(
      String(process.env.POSTMARK_SYSTEM_FROM_NAME || "shario.io"),
      fromEmail,
    ),
    to,
    subject,
    text,
    html,
    metadata,
  });
};
