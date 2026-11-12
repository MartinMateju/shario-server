import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { sendManagedTenantEmail } from "@/infrastructure/email/managed-email.service.js";
import { decryptSecret, encryptSecret } from "@/shared/security/encryption.js";

import type { CommunicationChannel } from "../communications.constants.js";
import { CommunicationSettingsModel } from "../communications.models.js";

export type OutboundProviderMessage = {
  tenantId: string;
  channel: CommunicationChannel;
  senderName?: string;
  senderEmail?: string;
  senderEmailId?: string;
  replyToEmail?: string;
  phoneNumberId?: string;
  to: Array<{
    email?: string;
    phone?: string;
    whatsappId?: string;
    instagramScopedId?: string;
    instagramUsername?: string;
    name?: string;
  }>;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: Array<{ name?: string; url?: string; contentType?: string }>;
  emailHeaders?: {
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
  };
  whatsappTemplate?: {
    name: string;
    languageCode: string;
    components?: unknown[];
  } | null;
  instagramReplyWindowOpen?: boolean;
  idempotencyKey: string;
  deliveryId?: string;
  messageId?: string;
};

export type ProviderSendResult = {
  provider: string;
  providerMessageId: string;
  status: "sent" | "delivered";
};

const isLiveDelivery = () =>
  process.env.NODE_ENV === "production" ||
  process.env.COMMUNICATION_DELIVERY_MODE === "live";

const attachmentHosts = () => {
  const configured = [
    process.env.R2_PUBLIC_URL || "",
    ...(process.env.COMMUNICATION_ATTACHMENT_HOSTS || "").split(","),
  ];
  return new Set(
    configured
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(
            value.includes("://") ? value : `https://${value}`,
          ).hostname.toLowerCase();
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
};

const safeEmailAttachments = (
  attachments: OutboundProviderMessage["attachments"],
) => {
  const allowedHosts = attachmentHosts();
  return (attachments || []).map((attachment) => {
    let url: URL;
    try {
      url = new URL(String(attachment.url || ""));
    } catch {
      throw Object.assign(new Error("Attachment URL is invalid."), {
        permanent: true,
        code: "ATTACHMENT_URL_INVALID",
      });
    }
    const protocolAllowed =
      url.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" && url.protocol === "http:");
    if (
      !protocolAllowed ||
      url.username ||
      url.password ||
      !allowedHosts.has(url.hostname.toLowerCase())
    ) {
      throw Object.assign(
        new Error("Attachment host is not approved for outbound delivery."),
        { permanent: true, code: "ATTACHMENT_HOST_NOT_ALLOWED" },
      );
    }
    return {
      filename: String(attachment.name || "attachment")
        .replace(/[\r\n\\/]/g, "_")
        .slice(0, 240),
      path: url.toString(),
      contentType: attachment.contentType || "application/octet-stream",
    };
  });
};

const safeHeader = (value: unknown, maxLength = 2000) =>
  String(value || "")
    .replace(/[\r\n]/g, "")
    .trim()
    .slice(0, maxLength);

const getWhatsAppProviderConfig = async (
  tenantId: string,
  phoneNumberIdOverride?: string,
) => {
  const tenantSettings = await CommunicationSettingsModel.findOne({ tenantId })
    .select(
      "+channels.whatsapp.encryptedAccessToken channels.whatsapp.phoneNumberId",
    )
    .lean();
  const encryptedToken =
    tenantSettings?.channels?.whatsapp?.encryptedAccessToken;
  let tenantToken = "";
  if (encryptedToken) {
    try {
      tenantToken = decryptSecret(encryptedToken);
    } catch {
      throw Object.assign(
        new Error("Stored WhatsApp credentials could not be decrypted."),
        { permanent: true, code: "PROVIDER_CREDENTIAL_INVALID" },
      );
    }
  }
  const allowPlatformToken =
    process.env.NODE_ENV !== "production" ||
    process.env.COMMUNICATION_ALLOW_PLATFORM_WHATSAPP_TOKEN === "true";
  return {
    token:
      tenantToken ||
      (allowPlatformToken
        ? process.env.WHATSAPP_ACCESS_TOKEN?.trim() || ""
        : ""),
    phoneNumberId:
      phoneNumberIdOverride ||
      tenantSettings?.channels?.whatsapp?.phoneNumberId ||
      (allowPlatformToken
        ? process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || ""
        : ""),
    baseUrl:
      process.env.WHATSAPP_API_URL?.trim() ||
      "https://graph.facebook.com/v25.0",
  };
};

const instagramGraphBaseUrl = () =>
  process.env.INSTAGRAM_GRAPH_API_URL?.trim() ||
  "https://graph.instagram.com/v25.0";

export const getInstagramTokenState = (
  expiresAt: Date | string | null | undefined,
  now = new Date(),
): "unknown" | "valid" | "expiring" | "expired" => {
  if (!expiresAt) return "unknown";
  const expires = new Date(expiresAt).getTime();
  if (!Number.isFinite(expires) || expires <= now.getTime()) return "expired";
  return expires - now.getTime() <= 7 * 86_400_000 ? "expiring" : "valid";
};

export const refreshInstagramLongLivedToken = async (
  accessToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> => {
  const endpoint =
    process.env.INSTAGRAM_TOKEN_REFRESH_URL?.trim() ||
    "https://graph.instagram.com/refresh_access_token";
  const url = new URL(endpoint);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    any
  >;
  if (!response.ok || !payload.access_token) {
    throw Object.assign(
      new Error(
        String(
          payload?.error?.message ||
            `Instagram token refresh returned ${response.status}.`,
        ),
      ),
      {
        permanent: response.status >= 400 && response.status < 500,
        code: "INSTAGRAM_RECONNECT_REQUIRED",
      },
    );
  }
  const expiresIn = Math.max(60, Number(payload.expires_in || 60 * 86_400));
  return {
    accessToken: String(payload.access_token),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
};

const getInstagramProviderConfig = async (tenantId: string) => {
  let tenantSettings: any = await CommunicationSettingsModel.findOne({
    tenantId,
  }).select(
    "+channels.instagram.encryptedAccessToken channels.instagram.enabled channels.instagram.instagramAccountId channels.instagram.tokenExpiresAt",
  );
  const instagram = tenantSettings?.channels?.instagram;
  if (instagram?.enabled !== true) {
    throw Object.assign(new Error("Instagram channel is disabled."), {
      permanent: true,
      code: "CHANNEL_DISABLED",
    });
  }
  let encryptedToken = String(instagram?.encryptedAccessToken || "");
  let token = "";
  if (encryptedToken) {
    try {
      token = decryptSecret(encryptedToken);
    } catch {
      throw Object.assign(
        new Error("Stored Instagram credentials could not be decrypted."),
        { permanent: true, code: "PROVIDER_CREDENTIAL_INVALID" },
      );
    }
  }
  const allowPlatformToken =
    process.env.NODE_ENV !== "production" ||
    process.env.COMMUNICATION_ALLOW_PLATFORM_INSTAGRAM_TOKEN === "true";
  token =
    token ||
    (allowPlatformToken
      ? process.env.INSTAGRAM_ACCESS_TOKEN?.trim() || ""
      : "");
  const instagramAccountId =
    String(instagram?.instagramAccountId || "") ||
    (allowPlatformToken ? process.env.INSTAGRAM_ACCOUNT_ID?.trim() || "" : "");

  const tokenState = getInstagramTokenState(instagram?.tokenExpiresAt);
  if (token && encryptedToken && ["expiring", "expired"].includes(tokenState)) {
    try {
      const refreshed = await refreshInstagramLongLivedToken(token);
      const nextEncryptedToken = encryptSecret(refreshed.accessToken);
      await CommunicationSettingsModel.updateOne(
        {
          _id: tenantSettings._id,
          "channels.instagram.encryptedAccessToken": encryptedToken,
        },
        {
          $set: {
            "channels.instagram.encryptedAccessToken": nextEncryptedToken,
            "channels.instagram.tokenExpiresAt": refreshed.expiresAt,
            "channels.instagram.lastTokenRefreshAt": new Date(),
            "channels.instagram.tokenRefreshFailedAt": null,
            "channels.instagram.tokenRefreshError": "",
          },
        },
      );
      token = refreshed.accessToken;
      encryptedToken = nextEncryptedToken;
    } catch (error: any) {
      await CommunicationSettingsModel.updateOne(
        { _id: tenantSettings._id },
        {
          $set: {
            "channels.instagram.tokenRefreshFailedAt": new Date(),
            "channels.instagram.tokenRefreshError": String(
              error?.message || "Instagram token refresh failed.",
            ).slice(0, 500),
          },
        },
      );
      if (tokenState === "expired") {
        throw Object.assign(
          new Error(
            "Instagram must be reconnected before messages can be sent.",
          ),
          { permanent: true, code: "INSTAGRAM_RECONNECT_REQUIRED" },
        );
      }
    }
  }

  return {
    token,
    instagramAccountId,
    baseUrl: instagramGraphBaseUrl(),
  };
};

const sendEmail = async (
  message: OutboundProviderMessage,
): Promise<ProviderSendResult> => {
  const to = message.to
    .map((recipient) => recipient.email)
    .filter(Boolean) as string[];
  if (!to.length)
    throw Object.assign(new Error("Email recipient is missing."), {
      permanent: true,
      code: "RECIPIENT_MISSING",
    });

  if (message.attachments?.length) {
    throw Object.assign(
      new Error("Attachments are not enabled for managed email yet."),
      {
        permanent: true,
        code: "ATTACHMENTS_NOT_SUPPORTED",
        deliveryOutcome: "not_sent",
      },
    );
  }

  if (!isLiveDelivery()) {
    return {
      provider: "local",
      providerMessageId: `local-email-${message.idempotencyKey}`,
      status: "sent",
    };
  }

  return sendManagedTenantEmail({
    tenantId: message.tenantId,
    senderEmailId: message.senderEmailId,
    to,
    subject: message.subject || "Message from your studio",
    text: message.text,
    html: message.html,
    idempotencyKey: message.idempotencyKey,
    deliveryId: message.deliveryId,
    messageId: message.messageId,
    headers: {
      "Message-ID": safeHeader(message.emailHeaders?.messageId) || undefined,
      "In-Reply-To": safeHeader(message.emailHeaders?.inReplyTo) || undefined,
      References:
        (message.emailHeaders?.references || [])
          .map((reference) => safeHeader(reference))
          .filter(Boolean)
          .join(" ") || undefined,
      "X-Shario-Idempotency-Key": message.idempotencyKey,
    },
  });
};

const sendWhatsApp = async (
  message: OutboundProviderMessage,
): Promise<ProviderSendResult> => {
  const recipient = message.to.find((item) => item.whatsappId || item.phone);
  const to = String(recipient?.whatsappId || recipient?.phone || "").replace(
    /[^0-9]/g,
    "",
  );
  if (!to)
    throw Object.assign(new Error("WhatsApp recipient is missing."), {
      permanent: true,
      code: "RECIPIENT_MISSING",
    });

  if (!isLiveDelivery()) {
    return {
      provider: "local",
      providerMessageId: `local-whatsapp-${message.idempotencyKey}`,
      status: "sent",
    };
  }

  const { token, phoneNumberId, baseUrl } = await getWhatsAppProviderConfig(
    message.tenantId,
    message.phoneNumberId,
  );
  if (!token || !phoneNumberId) {
    throw Object.assign(new Error("WhatsApp provider is not configured."), {
      permanent: true,
      code: "PROVIDER_NOT_CONFIGURED",
    });
  }
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify(
        message.whatsappTemplate?.name
          ? {
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to,
              type: "template",
              template: {
                name: message.whatsappTemplate.name,
                language: { code: message.whatsappTemplate.languageCode },
                components: message.whatsappTemplate.components || [],
              },
            }
          : {
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to,
              type: "text",
              text: { preview_url: false, body: message.text || "" },
            },
      ),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    any
  >;
  if (!response.ok) {
    throw Object.assign(
      new Error(
        String(
          payload?.error?.message || `WhatsApp returned ${response.status}.`,
        ),
      ),
      {
        permanent: response.status >= 400 && response.status < 500,
        code: String(payload?.error?.code || `HTTP_${response.status}`),
        ...(response.status >= 400 && response.status < 500
          ? { deliveryOutcome: "not_sent" }
          : {}),
      },
    );
  }
  return {
    provider: "meta",
    providerMessageId: String(
      payload?.messages?.[0]?.id || message.idempotencyKey,
    ),
    status: "sent",
  };
};

const sendInstagram = async (
  message: OutboundProviderMessage,
): Promise<ProviderSendResult> => {
  const recipient = message.to.find((item) => item.instagramScopedId);
  const to = String(recipient?.instagramScopedId || "").trim();
  if (!to) {
    throw Object.assign(new Error("Instagram recipient is missing."), {
      permanent: true,
      code: "RECIPIENT_MISSING",
    });
  }
  if (message.instagramReplyWindowOpen !== true) {
    throw Object.assign(
      new Error(
        "Instagram replies are allowed only within 24 hours of the customer's message.",
      ),
      { permanent: true, code: "INSTAGRAM_REPLY_WINDOW_CLOSED" },
    );
  }
  if (!String(message.text || "").trim()) {
    throw Object.assign(
      new Error("Instagram currently requires a text reply."),
      { permanent: true, code: "INSTAGRAM_TEXT_REQUIRED" },
    );
  }
  if (message.attachments?.length) {
    throw Object.assign(
      new Error("Outbound Instagram media is not enabled for this provider."),
      { permanent: true, code: "INSTAGRAM_OUTBOUND_MEDIA_UNSUPPORTED" },
    );
  }

  if (!isLiveDelivery()) {
    return {
      provider: "local",
      providerMessageId: `local-instagram-${message.idempotencyKey}`,
      status: "sent",
    };
  }

  const { token, instagramAccountId, baseUrl } =
    await getInstagramProviderConfig(message.tenantId);
  if (!token || !instagramAccountId) {
    throw Object.assign(new Error("Instagram provider is not configured."), {
      permanent: true,
      code: "PROVIDER_NOT_CONFIGURED",
    });
  }
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(instagramAccountId)}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({
        recipient: { id: to },
        message: { text: String(message.text).trim() },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    any
  >;
  if (!response.ok) {
    const code = String(payload?.error?.code || `HTTP_${response.status}`);
    const reconnectRequired = [190, "190"].includes(payload?.error?.code);
    throw Object.assign(
      new Error(
        String(
          payload?.error?.message || `Instagram returned ${response.status}.`,
        ),
      ),
      {
        permanent:
          reconnectRequired ||
          (response.status >= 400 && response.status < 500),
        code: reconnectRequired ? "INSTAGRAM_RECONNECT_REQUIRED" : code,
        ...(response.status >= 400 && response.status < 500
          ? { deliveryOutcome: "not_sent" }
          : {}),
      },
    );
  }
  return {
    provider: "meta",
    providerMessageId: String(
      payload?.message_id ||
        payload?.messages?.[0]?.id ||
        message.idempotencyKey,
    ),
    status: "sent",
  };
};

const allowedInstagramMediaHost = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  const configured = (process.env.INSTAGRAM_MEDIA_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [
    "cdninstagram.com",
    "fbcdn.net",
    "instagram.com",
    "lookaside.fbsbx.com",
    ...configured,
  ].some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
};

const decodeInstagramMediaUri = (mediaUri: string) => {
  const encoded = mediaUri.match(/^instagram-media:\/\/(.+)$/)?.[1];
  if (!encoded) return null;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
};

const readResponseBodyWithLimit = async (
  response: Response,
  maxBytes: number,
) => {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel("media size limit exceeded").catch(() => undefined);
        throw Object.assign(
          new Error("Instagram media exceeds the 25 MB limit."),
          { permanent: true, code: "MEDIA_TOO_LARGE" },
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

export const downloadInstagramMedia = async ({
  mediaUri,
}: {
  tenantId: string;
  mediaUri: string;
}): Promise<{ base64: string; contentType: string } | null> => {
  const decodedUrl = decodeInstagramMediaUri(mediaUri);
  if (!decodedUrl || !isLiveDelivery()) return null;
  let url: URL;
  try {
    url = new URL(decodedUrl);
  } catch {
    throw Object.assign(new Error("Instagram media URL is invalid."), {
      permanent: true,
      code: "MEDIA_URL_INVALID",
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedInstagramMediaHost(url.hostname)
  ) {
    throw Object.assign(
      new Error("Instagram media host is not an approved Meta host."),
      { permanent: true, code: "MEDIA_HOST_NOT_ALLOWED" },
    );
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw Object.assign(
      new Error(`Instagram media download returned ${response.status}.`),
      {
        permanent: response.status >= 400 && response.status < 500,
        code: `HTTP_${response.status}`,
      },
    );
  }
  const advertisedSize = Number(response.headers.get("content-length") || 0);
  if (advertisedSize > 25_000_000) {
    throw Object.assign(new Error("Instagram media exceeds the 25 MB limit."), {
      permanent: true,
      code: "MEDIA_TOO_LARGE",
    });
  }
  const contentType = String(
    response.headers.get("content-type") || "application/octet-stream",
  )
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (
    !/^(audio|image|video)\/[a-z0-9.+-]+$/.test(contentType) &&
    contentType !== "application/octet-stream"
  ) {
    throw Object.assign(
      new Error("Instagram media returned an unexpected content type."),
      { permanent: true, code: "MEDIA_CONTENT_TYPE_INVALID" },
    );
  }
  const buffer = await readResponseBodyWithLimit(response, 25_000_000);
  return { base64: buffer.toString("base64"), contentType };
};

export const downloadWhatsAppMedia = async ({
  tenantId,
  mediaUri,
}: {
  tenantId: string;
  mediaUri: string;
}): Promise<{ base64: string; contentType: string } | null> => {
  const mediaId = String(mediaUri).match(/^whatsapp-media:\/\/(.+)$/)?.[1];
  if (!mediaId || !isLiveDelivery()) return null;
  const { token, baseUrl } = await getWhatsAppProviderConfig(tenantId);
  if (!token) {
    throw Object.assign(new Error("WhatsApp provider is not configured."), {
      permanent: true,
      code: "PROVIDER_NOT_CONFIGURED",
    });
  }
  const metadataResponse = await fetch(
    `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(mediaId)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!metadataResponse.ok) {
    throw new Error(
      `WhatsApp media metadata returned ${metadataResponse.status}.`,
    );
  }
  const metadata = (await metadataResponse.json()) as Record<string, unknown>;
  if (!metadata.url) throw new Error("WhatsApp media URL was missing.");
  const mediaResponse = await fetch(String(metadata.url), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!mediaResponse.ok) {
    throw new Error(
      `WhatsApp media download returned ${mediaResponse.status}.`,
    );
  }
  const advertisedSize = Number(
    mediaResponse.headers.get("content-length") || 0,
  );
  if (advertisedSize > 25_000_000) {
    throw Object.assign(new Error("WhatsApp media exceeds the 25 MB limit."), {
      permanent: true,
      code: "MEDIA_TOO_LARGE",
    });
  }
  const buffer = Buffer.from(await mediaResponse.arrayBuffer());
  if (buffer.byteLength > 25_000_000) {
    throw Object.assign(new Error("WhatsApp media exceeds the 25 MB limit."), {
      permanent: true,
      code: "MEDIA_TOO_LARGE",
    });
  }
  return {
    base64: buffer.toString("base64"),
    contentType:
      mediaResponse.headers.get("content-type") ||
      String(metadata.mime_type || "audio/ogg"),
  };
};

export const sendThroughCommunicationProvider = async (
  message: OutboundProviderMessage,
): Promise<ProviderSendResult> => {
  try {
    if (message.channel === "email") return await sendEmail(message);
    if (["whatsapp", "instagram"].includes(message.channel)) {
      throw Object.assign(
        new Error(`${message.channel} delivery is not available yet.`),
        { permanent: true, code: "CHANNEL_RETIRED" },
      );
    }
    return {
      provider: "in_app",
      providerMessageId: `in-app-${message.idempotencyKey}`,
      status: "delivered",
    };
  } catch (error: any) {
    const knownPreProviderCodes = new Set([
      "ATTACHMENT_URL_INVALID",
      "ATTACHMENT_HOST_NOT_ALLOWED",
      "ATTACHMENTS_NOT_SUPPORTED",
      "CHANNEL_RETIRED",
      "CHANNEL_DISABLED",
      "INSTAGRAM_OUTBOUND_MEDIA_UNSUPPORTED",
      "INSTAGRAM_RECONNECT_REQUIRED",
      "INSTAGRAM_REPLY_WINDOW_CLOSED",
      "INSTAGRAM_TEXT_REQUIRED",
      "PROVIDER_CREDENTIAL_INVALID",
      "PROVIDER_NOT_CONFIGURED",
      "RECIPIENT_MISSING",
    ]);
    if (knownPreProviderCodes.has(String(error?.code || ""))) {
      error.deliveryOutcome = "not_sent";
    }
    throw error;
  }
};

const signatureSecret = (channel: string) =>
  channel === "whatsapp"
    ? process.env.WHATSAPP_WEBHOOK_SECRET ||
      process.env.COMMUNICATION_WEBHOOK_SECRET
    : channel === "instagram"
      ? process.env.INSTAGRAM_WEBHOOK_SECRET ||
        process.env.INSTAGRAM_APP_SECRET ||
        process.env.META_APP_SECRET ||
        ""
      : process.env.EMAIL_INBOUND_WEBHOOK_SECRET ||
        process.env.COMMUNICATION_WEBHOOK_SECRET;

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const verifyCommunicationWebhookSignature = ({
  channel,
  body,
  rawBody,
  signature,
  timestamp,
  now = Date.now(),
}: {
  channel: string;
  body: unknown;
  rawBody?: Buffer | string | null;
  signature?: string | null;
  timestamp?: string | null;
  now?: number;
}): boolean => {
  const secret = signatureSecret(channel)?.trim();
  if (!secret) {
    // Meta webhooks are always internet-facing and must remain signed even in
    // staging/development. Email's local provider harness retains its legacy
    // non-production convenience behavior.
    return channel === "instagram"
      ? false
      : process.env.NODE_ENV !== "production";
  }
  if (!signature) return false;

  const normalizedSignature = signature
    .replace(/^sha256=/, "")
    .trim()
    .toLowerCase();
  const raw = rawBody
    ? Buffer.from(rawBody)
    : Buffer.from(JSON.stringify(body ?? {}));

  if (timestamp) {
    const timestampMs = Number(timestamp) * 1000;
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(now - timestampMs) > 5 * 60_000
    )
      return false;
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(raw)
      .digest("hex");
    return safeEqual(expected, normalizedSignature);
  }

  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqual(expected, normalizedSignature);
};

export const normalizeProviderWebhook = (
  channel: CommunicationChannel,
  raw: any,
): Record<string, unknown>[] => {
  if (raw?.eventType && raw?.eventId) return [{ ...raw, raw }];

  if (channel === "instagram") {
    const stableId = (prefix: string, value: unknown) =>
      `${prefix}:${createHash("sha256")
        .update(JSON.stringify(value ?? null))
        .digest("hex")}`;
    const eventDate = (value: unknown) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return new Date();
      return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    };
    const mediaUri = (value: unknown) => {
      const url = String(value || "").trim();
      if (!url) return "";
      const encoded = Buffer.from(url, "utf8").toString("base64url");
      return encoded.length <= 2_950 ? `instagram-media://${encoded}` : "";
    };
    const contentTypeFor = (type: unknown) => {
      const normalized = String(type || "").toLowerCase();
      if (["audio", "voice"].includes(normalized)) return "audio/ogg";
      if (
        ["image", "story_mention", "story_reply", "share"].includes(normalized)
      )
        return "image/jpeg";
      if (["video", "reel"].includes(normalized)) return "video/mp4";
      return "application/octet-stream";
    };
    const normalizeAttachment = (attachment: any, index: number) => {
      const type = String(attachment?.type || "file").toLowerCase();
      const uri = mediaUri(
        attachment?.payload?.url || attachment?.url || attachment?.payload_url,
      );
      if (!uri) return null;
      const extension = ["audio", "voice"].includes(type)
        ? "ogg"
        : ["video", "reel"].includes(type)
          ? "mp4"
          : ["image", "story_mention", "story_reply", "share"].includes(type)
            ? "jpg"
            : "bin";
      return {
        name: `instagram-${type}-${index + 1}.${extension}`,
        contentType: String(
          attachment?.payload?.mime_type ||
            attachment?.mime_type ||
            contentTypeFor(type),
        ),
        size: 0,
        url: uri,
        checksum: "",
      };
    };
    const entries = Array.isArray(raw?.entry) ? raw.entry : [];
    return entries.flatMap((entry: any) => {
      const accountId = String(entry?.id || "").trim();
      const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      const changeEvents = changes.flatMap((change: any) => {
        if (change?.field === "messages" && change?.value) {
          return [{ ...change.value, _changeField: change.field }];
        }
        if (
          ["mentions", "story_mentions"].includes(String(change?.field)) &&
          change?.value
        ) {
          return [
            {
              sender: {
                id:
                  change.value.sender_id ||
                  change.value.from?.id ||
                  change.value.user_id ||
                  "",
                username:
                  change.value.username || change.value.from?.username || "",
              },
              recipient: { id: accountId },
              timestamp: entry?.time,
              message: {
                mid:
                  change.value.id ||
                  change.value.media_id ||
                  stableId("mention", change.value),
                text: change.value.text || change.value.caption || "",
                attachments: change.value.media_url
                  ? [
                      {
                        type: "story_mention",
                        payload: { url: change.value.media_url },
                      },
                    ]
                  : [],
                story_mention: true,
              },
              _changeField: change.field,
            },
          ];
        }
        return [];
      });
      return [...messaging, ...changeEvents].flatMap((event: any) => {
        const providerAccountId = String(
          accountId || event?.recipient?.id || event?.sender?.id || "",
        );
        const senderId = String(event?.sender?.id || "");
        const sender = {
          name: String(event?.sender?.name || event?.sender?.username || ""),
          email: "",
          phone: "",
          whatsappId: "",
          instagramScopedId: senderId,
          instagramUsername: String(event?.sender?.username || ""),
          externalId: senderId,
        };
        const occurredAt = eventDate(event?.timestamp || entry?.time);
        const message = event?.message;
        if (message) {
          const mid = String(
            message?.mid || message?.id || stableId("message", event),
          );
          if (message?.is_echo === true) {
            return [
              {
                provider: "meta",
                eventId: `echo:${mid}`,
                eventType: "delivery.sent",
                providerMessageId: mid,
                providerThreadId: senderId,
                providerAccountId,
                occurredAt,
                sender,
                recipients: [],
                deliveryStatus: "sent",
                providerContext: { isEcho: true },
                raw: event,
              },
            ];
          }
          const attachments = (
            Array.isArray(message?.attachments) ? message.attachments : []
          )
            .map(normalizeAttachment)
            .filter(Boolean);
          const attachmentTypes = (message?.attachments || []).map(
            (attachment: any) => String(attachment?.type || "").toLowerCase(),
          );
          const isStoryReply = Boolean(
            message?.reply_to?.story ||
            message?.story_reply ||
            attachmentTypes.includes("story_reply"),
          );
          const isStoryMention = Boolean(
            message?.story_mention ||
            event?._changeField === "mentions" ||
            event?._changeField === "story_mentions" ||
            attachmentTypes.includes("story_mention"),
          );
          const isVoice = attachmentTypes.some((type: string) =>
            ["audio", "voice"].includes(type),
          );
          return [
            {
              provider: "meta",
              eventId: `message:${mid}`,
              eventType: "message.received",
              providerMessageId: mid,
              // Instagram does not expose a conventional thread id. The
              // app-scoped sender id is stable for this business account.
              providerThreadId: senderId,
              providerAccountId,
              occurredAt,
              sender,
              recipients: [],
              subject: isStoryMention
                ? "Instagram story mention"
                : isStoryReply
                  ? "Instagram story reply"
                  : "Instagram message",
              text: String(message?.text || ""),
              html: "",
              kind: isVoice ? "voice" : "text",
              attachments,
              providerContext: {
                sourceType: isStoryMention
                  ? "story_mention"
                  : isStoryReply
                    ? "story_reply"
                    : "dm",
                isStoryReply,
                isStoryMention,
                repliedToMessageId: String(message?.reply_to?.mid || ""),
                storyId: String(
                  message?.reply_to?.story?.id || message?.story?.id || "",
                ),
              },
              raw: event,
            },
          ];
        }
        if (event?.postback) {
          const postbackId = String(
            event.postback.mid || stableId("postback", event),
          );
          return [
            {
              provider: "meta",
              eventId: `postback:${postbackId}`,
              eventType: "message.received",
              providerMessageId: postbackId,
              providerThreadId: senderId,
              providerAccountId,
              occurredAt,
              sender,
              recipients: [],
              subject: "Instagram postback",
              text: String(
                event.postback.title || event.postback.payload || "",
              ),
              kind: "text",
              attachments: [],
              providerContext: {
                sourceType: "postback",
                postbackPayload: String(event.postback.payload || ""),
              },
              raw: event,
            },
          ];
        }
        if (event?.delivery) {
          const mids = Array.isArray(event.delivery.mids)
            ? event.delivery.mids
            : event.delivery.mid
              ? [event.delivery.mid]
              : [];
          return mids.map((midValue: unknown) => {
            const mid = String(midValue);
            return {
              provider: "meta",
              eventId: `status:${mid}:delivered:${event.delivery.watermark || ""}`,
              eventType: "delivery.delivered",
              providerMessageId: mid,
              providerThreadId: senderId,
              providerAccountId,
              occurredAt: eventDate(
                event.delivery.watermark || event.timestamp || entry?.time,
              ),
              sender,
              recipients: [],
              deliveryStatus: "delivered",
              providerContext: {
                watermark: Number(event.delivery.watermark || 0),
              },
              raw: event,
            };
          });
        }
        if (event?.read) {
          const watermark = Number(
            event.read.watermark || event.timestamp || entry?.time || 0,
          );
          const mid = String(event.read.mid || "");
          return [
            {
              provider: "meta",
              eventId: mid
                ? `status:${mid}:read:${watermark}`
                : `read:${providerAccountId}:${senderId}:${watermark}`,
              eventType: "delivery.read",
              providerMessageId: mid,
              providerThreadId: senderId,
              providerAccountId,
              occurredAt: eventDate(watermark),
              sender,
              recipients: [],
              deliveryStatus: "read",
              providerContext: { watermark },
              raw: event,
            },
          ];
        }
        return [];
      });
    });
  }

  if (channel === "whatsapp") {
    const values = Array.isArray(raw?.entry)
      ? raw.entry.flatMap((entry: any) =>
          Array.isArray(entry?.changes)
            ? entry.changes.map((change: any) => change?.value).filter(Boolean)
            : [],
        )
      : [raw];
    return values.flatMap((value: any) => {
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      const contacts = value?.contacts ?? [];
      return [
        ...messages.map((message: any) => ({
          provider: "meta",
          eventId: `message:${message.id}`,
          eventType: "message.received",
          providerMessageId: message.id,
          providerThreadId: message.context?.id || "",
          occurredAt: new Date(
            Number(message.timestamp || Date.now() / 1000) * 1000,
          ),
          sender: {
            name: contacts?.[0]?.profile?.name || "",
            email: "",
            phone: message.from || "",
            whatsappId: message.from || "",
            externalId: message.from || "",
          },
          recipients: [],
          subject: "WhatsApp message",
          text: message.text?.body || message.button?.text || "",
          html: "",
          kind:
            message.type === "audio" || message.type === "voice"
              ? "voice"
              : "text",
          attachments: message.audio?.id
            ? [
                {
                  name: "voice-message.ogg",
                  contentType: message.audio.mime_type || "audio/ogg",
                  size: 0,
                  url: `whatsapp-media://${message.audio.id}`,
                  checksum: "",
                },
              ]
            : [],
          raw: message,
        })),
        ...statuses.map((status: any) => ({
          provider: "meta",
          eventId: `status:${status.id}:${status.status}:${status.timestamp || ""}`,
          eventType: `delivery.${status.status === "read" ? "read" : status.status === "delivered" ? "delivered" : status.status === "sent" ? "sent" : "failed"}`,
          providerMessageId: status.id,
          occurredAt: new Date(
            Number(status.timestamp || Date.now() / 1000) * 1000,
          ),
          sender: {},
          recipients: [],
          deliveryStatus:
            status.status === "read"
              ? "read"
              : status.status === "delivered"
                ? "delivered"
                : status.status === "sent"
                  ? "sent"
                  : "failed",
          failure: status.errors?.[0]
            ? {
                code: String(status.errors[0].code || "META_ERROR"),
                message: String(
                  status.errors[0].title ||
                    status.errors[0].message ||
                    "Delivery failed",
                ),
                permanent: true,
              }
            : undefined,
          raw: status,
        })),
      ];
    });
  }

  const sanitizeInboundHtml = (value: unknown) =>
    String(value ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript\s*:/gi, "");

  const normalizedHeaders = Object.fromEntries(
    Object.entries(raw?.headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  ) as Record<string, unknown>;
  const messageIdHeader = safeHeader(
    normalizedHeaders["message-id"] || raw?.messageId,
  );
  const threadHeader = safeHeader(
    raw?.providerThreadId ||
      raw?.threadId ||
      normalizedHeaders.references ||
      normalizedHeaders["in-reply-to"],
  );

  const stableEmailIdentity = JSON.stringify({
    provider: raw?.provider || "email",
    from: raw?.sender || raw?.from || null,
    to: raw?.recipients || raw?.to || null,
    subject: raw?.subject || "",
    text: raw?.text || raw?.textBody || "",
    occurredAt: raw?.occurredAt || raw?.date || "",
  });
  const eventId = String(
    raw?.eventId ||
      raw?.id ||
      raw?.messageId ||
      messageIdHeader ||
      `derived:${createHash("sha256").update(stableEmailIdentity).digest("hex")}`,
  );
  return [
    {
      provider: String(raw?.provider || "email"),
      eventId,
      eventType: String(raw?.eventType || "message.received"),
      providerMessageId: String(
        raw?.providerMessageId || messageIdHeader || eventId,
      ),
      providerThreadId: threadHeader,
      occurredAt: raw?.occurredAt || new Date(),
      sender: raw?.sender || raw?.from || {},
      recipients: raw?.recipients || (raw?.to ? [raw.to] : []),
      subject: raw?.subject || "Email message",
      text: raw?.text || raw?.textBody || "",
      html: sanitizeInboundHtml(raw?.html || raw?.htmlBody || ""),
      kind: raw?.html && !raw?.text ? "html" : "text",
      attachments: raw?.attachments || [],
      raw,
    },
  ];
};
