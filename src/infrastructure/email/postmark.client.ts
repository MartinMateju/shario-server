import {
  isPostmarkProvisioningAttemptId,
  POSTMARK_PROVISIONING_TOKEN_HEADER,
} from "./postmark-webhook-provisioning.js";

export type PostmarkServerBinding = {
  serverId: number;
  serverToken: string;
  serverName: string;
};

export type PostmarkHeader = {
  Name: string;
  Value: string;
};

export type PostmarkAttachment = {
  Name: string;
  Content: string;
  ContentType: "application/pdf";
};

export const POSTMARK_ATTACHMENT_LIMIT_BYTES = 6 * 1024 * 1024;
// Leave headroom below Postmark's 10 MB message limit after base64 encoding.
const POSTMARK_MESSAGE_LIMIT_BYTES = 9_000_000;

export type PostmarkSendInput = {
  serverToken: string;
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  headers?: PostmarkHeader[];
  metadata?: Record<string, string>;
  messageStream?: string;
  attachments?: PostmarkAttachment[];
};

export type PostmarkSendResult = {
  provider: "postmark";
  providerMessageId: string;
  status: "sent";
};

export type PostmarkWebhookVerificationResult = {
  triggerType: string;
  success: boolean;
  statusCode: number;
};

export type PostmarkWebhookBinding = {
  webhookId: number;
  url: string;
  messageStream: string;
  status: "verified";
};

export class PostmarkRequestError extends Error {
  code: string;
  permanent: boolean;
  deliveryOutcome?: "not_sent";
  httpStatus?: number;
  verificationResults?: PostmarkWebhookVerificationResult[];

  constructor(
    message: string,
    options: {
      code: string;
      permanent?: boolean;
      deliveryOutcome?: "not_sent";
      httpStatus?: number;
      verificationResults?: PostmarkWebhookVerificationResult[];
    },
  ) {
    super(message);
    this.name = "PostmarkRequestError";
    this.code = options.code;
    this.permanent = options.permanent ?? false;
    this.deliveryOutcome = options.deliveryOutcome;
    this.httpStatus = options.httpStatus;
    this.verificationResults = options.verificationResults;
  }
}

const apiBaseUrl = () =>
  String(process.env.POSTMARK_API_URL || "https://api.postmarkapp.com")
    .trim()
    .replace(/\/$/, "");

const requestTimeoutMs = () =>
  Math.max(
    3_000,
    Math.min(60_000, Number(process.env.POSTMARK_REQUEST_TIMEOUT_MS || 15_000)),
  );

const parsePayload = async (
  response: Response,
): Promise<Record<string, any>> => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { Message: text.slice(0, 500) };
  }
};

const providerError = (
  response: Response,
  payload: Record<string, any>,
): PostmarkRequestError => {
  const providerCode = Number(
    payload.ErrorCode ||
      response.headers.get("x-pm-apierrorcode") ||
      response.headers.get("x-postmark-apierrorcode") ||
      0,
  );
  const code = providerCode
    ? `POSTMARK_${providerCode}`
    : `POSTMARK_HTTP_${response.status}`;
  const verificationResults = (
    Array.isArray(payload.Results) ? payload.Results : []
  )
    .map((result: Record<string, any>) => ({
      triggerType: String(result.TriggerType || "").slice(0, 100),
      success: result.Success === true,
      statusCode: Number(result.StatusCode || 0),
    }))
    .filter(
      (result: PostmarkWebhookVerificationResult) =>
        Boolean(result.triggerType) && Number.isFinite(result.statusCode),
    );
  return new PostmarkRequestError(
    String(payload.Message || `Postmark returned HTTP ${response.status}.`),
    {
      code,
      permanent:
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429,
      // A received error response (including a Postmark ErrorCode on 200)
      // means the provider did not accept the email. Only transport failures
      // after dispatch remain ambiguous.
      deliveryOutcome: "not_sent",
      httpStatus: response.status,
      ...(verificationResults.length ? { verificationResults } : {}),
    },
  );
};

const request = async ({
  path,
  method = "GET",
  token,
  tokenKind,
  body,
}: {
  path: string;
  method?: "GET" | "POST" | "PUT";
  token: string;
  tokenKind: "account" | "server";
  body?: Record<string, unknown>;
}): Promise<Record<string, any>> => {
  if (!token.trim()) {
    throw new PostmarkRequestError("Postmark credentials are not configured.", {
      code: "POSTMARK_NOT_CONFIGURED",
      permanent: true,
      deliveryOutcome: "not_sent",
    });
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        [tokenKind === "account"
          ? "X-Postmark-Account-Token"
          : "X-Postmark-Server-Token"]: token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
  } catch (error) {
    throw new PostmarkRequestError(
      error instanceof Error
        ? `Postmark request outcome is unknown: ${error.message}`
        : "Postmark request outcome is unknown.",
      { code: "POSTMARK_OUTCOME_UNKNOWN" },
    );
  }

  const payload = await parsePayload(response);
  const providerCode = Number(
    payload.ErrorCode ||
      response.headers.get("x-pm-apierrorcode") ||
      response.headers.get("x-postmark-apierrorcode") ||
      0,
  );
  if (!response.ok || providerCode !== 0) {
    throw providerError(response, payload);
  }
  return payload;
};

const readServerBinding = (
  payload: Record<string, any>,
): PostmarkServerBinding | null => {
  const serverId = Number(payload.ID || 0);
  const serverToken = String(payload.ApiTokens?.[0] || "").trim();
  const serverName = String(payload.Name || "").trim();
  return serverId > 0 && serverToken && serverName
    ? { serverId, serverToken, serverName }
    : null;
};

const findPostmarkServer = async (
  serverName: string,
  accountToken: string,
): Promise<PostmarkServerBinding | null> => {
  const params = new URLSearchParams({
    count: "100",
    offset: "0",
    name: serverName,
  });
  const existing = await request({
    path: `/servers?${params.toString()}`,
    token: accountToken,
    tokenKind: "account",
  });
  const exact = (Array.isArray(existing.Servers) ? existing.Servers : []).find(
    (server: Record<string, any>) => String(server.Name || "") === serverName,
  );
  return exact ? readServerBinding(exact) : null;
};

export const provisionPostmarkServer = async (
  serverName: string,
): Promise<PostmarkServerBinding> => {
  const accountToken = String(process.env.POSTMARK_ACCOUNT_TOKEN || "").trim();
  const existingBinding = await findPostmarkServer(serverName, accountToken);
  if (existingBinding) return existingBinding;

  let created: Record<string, any>;
  try {
    created = await request({
      path: "/servers",
      method: "POST",
      token: accountToken,
      tokenKind: "account",
      body: {
        Name: serverName,
        Color: "Turquoise",
        SmtpApiActivated: false,
        RawEmailEnabled: false,
      },
    });
  } catch (error) {
    // Concurrent retries can both miss the initial lookup. If another request
    // created the deterministic Server first, converge on that binding.
    if (error instanceof PostmarkRequestError && error.code === "POSTMARK_603") {
      const concurrentBinding = await findPostmarkServer(
        serverName,
        accountToken,
      );
      if (concurrentBinding) return concurrentBinding;
    }
    throw error;
  }
  const binding = readServerBinding(created);
  if (!binding) {
    throw new PostmarkRequestError(
      "Postmark created a server without returning a usable API token.",
      {
        code: "POSTMARK_INVALID_SERVER_RESPONSE",
        permanent: true,
      },
    );
  }
  return binding;
};

const outboundWebhookConfiguration = () => {
  const url = String(process.env.POSTMARK_OUTBOUND_WEBHOOK_URL || "").trim();
  const username = String(
    process.env.POSTMARK_OUTBOUND_WEBHOOK_USERNAME || "",
  ).trim();
  const password = String(process.env.POSTMARK_OUTBOUND_WEBHOOK_PASSWORD || "");
  const messageStream = String(
    process.env.POSTMARK_MESSAGE_STREAM || "outbound",
  ).trim();
  if (!url || !username || !password) {
    throw new PostmarkRequestError(
      "Postmark outbound webhook credentials are not configured.",
      {
        code: "POSTMARK_WEBHOOK_NOT_CONFIGURED",
        permanent: true,
        deliveryOutcome: "not_sent",
      },
    );
  }
  return { url, username, password, messageStream };
};

const outboundWebhookBody = (
  {
    url,
    username,
    password,
    messageStream,
  }: ReturnType<typeof outboundWebhookConfiguration>,
  includeMessageStream: boolean,
  provisioningAttemptId: string,
) => ({
  Url: url,
  Verify: true,
  ...(includeMessageStream ? { MessageStream: messageStream } : {}),
  HttpAuth: { Username: username, Password: password },
  HttpHeaders: [
    { Name: POSTMARK_PROVISIONING_TOKEN_HEADER, Value: provisioningAttemptId },
  ],
  Triggers: {
    Open: { Enabled: false, PostFirstOpenOnly: false },
    Click: { Enabled: false },
    Delivery: { Enabled: true },
    Bounce: { Enabled: true, IncludeContent: false },
    SpamComplaint: { Enabled: true, IncludeContent: false },
    SubscriptionChange: { Enabled: false },
  },
});

const isPostmarkWebhookVerified = (payload: Record<string, any>): boolean => {
  const aggregateStatus = String(payload.Status ?? "").trim().toLowerCase();
  if (aggregateStatus && aggregateStatus !== "verified") return false;

  // Postmark can return verification on each trigger without an aggregate
  // Status. Keep accepting the aggregate-only response documented by the API.
  if (!Object.prototype.hasOwnProperty.call(payload, "Triggers")) {
    return aggregateStatus === "verified";
  }
  const triggers = payload.Triggers;
  if (!triggers || typeof triggers !== "object" || Array.isArray(triggers)) {
    return false;
  }
  const requiredTriggers = ["Delivery", "Bounce", "SpamComplaint"].map(
    (name) => triggers[name],
  );
  if (
    requiredTriggers.some(
      (trigger) =>
        !trigger ||
        typeof trigger !== "object" ||
        Array.isArray(trigger) ||
        trigger.Enabled !== true,
    )
  ) {
    return false;
  }

  // An aggregate success must not hide a partial or failed trigger result.
  const hasTriggerStatuses = requiredTriggers.some((trigger) =>
    Object.prototype.hasOwnProperty.call(trigger, "Status"),
  );
  if (!hasTriggerStatuses) return aggregateStatus === "verified";
  return requiredTriggers.every(
    (trigger) =>
      typeof trigger.Status === "string" &&
      trigger.Status.trim().toLowerCase() === "verified",
  );
};

/**
 * Converges a tenant Server on the single outbound status webhook used by
 * shario.io. Re-applying the configuration is intentional: Postmark does not
 * return a safely comparable plaintext password from every list response.
 */
export const configurePostmarkOutboundWebhook = async (
  serverToken: string,
  provisioningAttemptId: string,
): Promise<PostmarkWebhookBinding> => {
  if (!isPostmarkProvisioningAttemptId(provisioningAttemptId)) {
    throw new PostmarkRequestError("A valid webhook setup attempt is required.", {
      code: "POSTMARK_PROVISIONING_ATTEMPT_INVALID",
      permanent: true,
    });
  }
  const configuration = outboundWebhookConfiguration();
  const query = new URLSearchParams({
    MessageStream: configuration.messageStream,
  });
  const listed = await request({
    path: `/webhooks?${query.toString()}`,
    token: serverToken,
    tokenKind: "server",
  });
  const existing = (Array.isArray(listed.Webhooks) ? listed.Webhooks : []).find(
    (webhook: Record<string, any>) =>
      String(webhook.Url || "").replace(/\/+$/, "") ===
        configuration.url.replace(/\/+$/, "") &&
      String(webhook.MessageStream || "") === configuration.messageStream,
  );
  const existingId = Number(existing?.ID || 0);
  const body = outboundWebhookBody(
    configuration,
    existingId <= 0,
    provisioningAttemptId,
  );
  const saved = await request({
    path: existingId > 0 ? `/webhooks/${existingId}` : "/webhooks",
    method: existingId > 0 ? "PUT" : "POST",
    token: serverToken,
    tokenKind: "server",
    body,
  });
  const webhookId = Number(saved.ID || existingId || 0);
  if (webhookId <= 0) {
    throw new PostmarkRequestError(
      "Postmark configured the outbound webhook without returning an ID.",
      {
        code: "POSTMARK_INVALID_WEBHOOK_RESPONSE",
        permanent: true,
      },
    );
  }
  if (!isPostmarkWebhookVerified(saved)) {
    throw new PostmarkRequestError(
      "Postmark saved the outbound webhook without verifying every trigger.",
      {
        code: "POSTMARK_WEBHOOK_NOT_VERIFIED",
        permanent: true,
      },
    );
  }
  return {
    webhookId,
    url: configuration.url,
    messageStream: configuration.messageStream,
    status: "verified",
  };
};

const invalidAttachment = (): never => {
  throw new PostmarkRequestError(
    "Email attachments must be in-memory PDF files with safe filenames.",
    {
      code: "EMAIL_ATTACHMENT_INVALID",
      permanent: true,
      deliveryOutcome: "not_sent",
    },
  );
};

const attachmentSizeExceeded = (): never => {
  throw new PostmarkRequestError("Email attachments exceed the 6 MiB limit.", {
    code: "EMAIL_ATTACHMENTS_TOO_LARGE",
    permanent: true,
    deliveryOutcome: "not_sent",
  });
};

const safePdfFilename = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 4 &&
  value.length <= 240 &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f/\\]/.test(value) &&
  /\.pdf$/i.test(value);

/**
 * Snapshot bounded PDF bytes before a durable provider-send fence. No attachment
 * option can cause filesystem reads, URL fetches, or stream consumption.
 */
export const preparePostmarkAttachments = (
  attachments: unknown,
): PostmarkAttachment[] => {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments) || attachments.length > 20) {
    return invalidAttachment();
  }
  let totalBytes = 0;
  return attachments.map((attachment: unknown) => {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      Array.isArray(attachment) ||
      Object.keys(attachment).some(
        (key) => !["filename", "content", "contentType"].includes(key),
      )
    ) {
      return invalidAttachment();
    }
    const { filename, content, contentType } = attachment as Record<
      string,
      unknown
    >;
    if (
      !safePdfFilename(filename) ||
      !Buffer.isBuffer(content) ||
      !content.length ||
      (contentType !== undefined && contentType !== "application/pdf")
    ) {
      return invalidAttachment();
    }
    totalBytes += content.length;
    if (totalBytes > POSTMARK_ATTACHMENT_LIMIT_BYTES) {
      return attachmentSizeExceeded();
    }
    return {
      Name: filename,
      Content: content.toString("base64"),
      ContentType: "application/pdf",
    };
  });
};

/** Validate the complete provider payload before a caller claims submission. */
export const preparePostmarkEmailBody = (
  input: PostmarkSendInput,
): Record<string, unknown> => {
  if (!input.text?.trim() && !input.html?.trim()) {
    throw new PostmarkRequestError("Email content is missing.", {
      code: "EMAIL_CONTENT_MISSING",
      permanent: true,
      deliveryOutcome: "not_sent",
    });
  }
  if (input.metadata !== undefined) {
    const entries = Object.entries(input.metadata || {});
    if (
      !input.metadata ||
      typeof input.metadata !== "object" ||
      Array.isArray(input.metadata) ||
      entries.length > 10 ||
      new Set(entries.map(([name]) => name.toLowerCase())).size !==
        entries.length ||
      entries.some(
        ([name, value]) =>
          name.length > 20 || typeof value !== "string" || value.length > 80,
      )
    ) {
      throw new PostmarkRequestError(
        "Email metadata allows up to 10 distinct names of at most 20 characters and string values of at most 80 characters.",
        {
          code: "EMAIL_METADATA_INVALID",
          permanent: true,
          deliveryOutcome: "not_sent",
        },
      );
    }
  }
  let attachmentBytes = 0;
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 20) {
      return invalidAttachment();
    }
    for (const attachment of input.attachments) {
      if (
        !attachment ||
        !safePdfFilename(attachment.Name) ||
        attachment.ContentType !== "application/pdf" ||
        typeof attachment.Content !== "string" ||
        !attachment.Content ||
        attachment.Content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.Content)
      ) {
        return invalidAttachment();
      }
      attachmentBytes +=
        (attachment.Content.length / 4) * 3 -
        (attachment.Content.endsWith("==")
          ? 2
          : attachment.Content.endsWith("=")
            ? 1
            : 0);
      if (attachmentBytes > POSTMARK_ATTACHMENT_LIMIT_BYTES) {
        return attachmentSizeExceeded();
      }
    }
  }
  const to = Array.isArray(input.to) ? input.to.join(",") : input.to;
  const body = {
    From: input.from,
    To: to,
    Subject: input.subject,
    ...(input.text ? { TextBody: input.text } : {}),
    ...(input.html ? { HtmlBody: input.html } : {}),
    ...(input.replyTo ? { ReplyTo: input.replyTo } : {}),
    ...(input.headers?.length ? { Headers: input.headers } : {}),
    ...(input.metadata ? { Metadata: input.metadata } : {}),
    ...(input.attachments?.length
      ? {
          Attachments: input.attachments.map(
            ({ Name, Content, ContentType }) => ({
              Name,
              Content,
              ContentType,
            }),
          ),
        }
      : {}),
    TrackOpens: false,
    TrackLinks: "None",
    MessageStream:
      input.messageStream || process.env.POSTMARK_MESSAGE_STREAM || "outbound",
  };
  if (
    Buffer.byteLength(input.text || "") > 5_000_000 ||
    Buffer.byteLength(input.html || "") > 5_000_000 ||
    Buffer.byteLength(JSON.stringify(body)) > POSTMARK_MESSAGE_LIMIT_BYTES
  ) {
    throw new PostmarkRequestError("Email exceeds the encoded message limit.", {
      code: "EMAIL_MESSAGE_TOO_LARGE",
      permanent: true,
      deliveryOutcome: "not_sent",
    });
  }
  return body;
};

export const sendPostmarkEmail = async (
  input: PostmarkSendInput,
): Promise<PostmarkSendResult> => {
  const body = preparePostmarkEmailBody(input);
  const payload = await request({
    path: "/email",
    method: "POST",
    token: input.serverToken,
    tokenKind: "server",
    body,
  });
  const providerMessageId = String(payload.MessageID || "").trim();
  if (!providerMessageId) {
    throw new PostmarkRequestError(
      "Postmark accepted the request without returning a MessageID.",
      { code: "POSTMARK_MESSAGE_ID_MISSING" },
    );
  }
  return { provider: "postmark", providerMessageId, status: "sent" };
};
