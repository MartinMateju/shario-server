import mongoose, { Types } from "mongoose";

import nodemailer, { type SentMessageInfo, type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

import { logger } from "@/config/logger.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import {
  resolveConfiguredSmtpEndpoint,
  type ResolvedSmtpEndpoint,
} from "@/modules/registered-sender-email/services/smtp-network-policy.js";
import { decryptEmailPassword } from "@/shared/security/encryption.js";

const CACHE_TTL_MS = Number(process.env.EMAIL_SERVICE_CACHE_TTL_MS || 60_000);
const TRANSPORTER_CACHE_TTL_MS = Number(
  process.env.EMAIL_TRANSPORTER_CACHE_TTL_MS || 5 * 60_000,
);

const DEFAULT_FROM_NAME = process.env.DEFAULT_FROM_NAME || "Shario";

type SenderEmailDocumentInput = {
  _id?: Types.ObjectId | string;
  id?: Types.ObjectId | string;
  tenant?: Types.ObjectId | string;
  email?: string;
  displayName?: string;
  note?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  encryptedSmtpPassword?: string;
  provider?: string;
  isActive?: boolean;
  updatedAt?: Date;
};

type SenderEmailInput = string | SenderEmailDocumentInput | null | undefined;

type NormalizedSender = {
  id: string | null;
  tenantId: string | null;
  email: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  provider: string;
  updatedAt: Date | string | null;
};

type SenderCacheEntry = {
  sender: NormalizedSender;
  expiresAt: number;
};

type TransporterCacheEntry = {
  transporter: Transporter<SentMessageInfo>;
  expiresAt: number;
};

type SenderLookupQuery = {
  tenant: Types.ObjectId;
  isActive: boolean;
  _id?: Types.ObjectId;
  email?: string;
};

export type SendEmailOptions = SMTPTransport.MailOptions & {
  /** Required whenever a registered sender is resolved from the database. */
  tenantId?: string;
  senderEmail?: SenderEmailInput;
  senderEmailId?: string | null;
  registeredSenderEmail?: SenderEmailInput;
  registeredSenderEmailId?: string | null;
  sender?: SenderEmailInput;
};

const senderCache = new Map<string, SenderCacheEntry>();
const transporterCache = new Map<string, TransporterCacheEntry>();

const tlsRejectUnauthorized = !(
  process.env.NODE_ENV !== "production" &&
  process.env.EMAIL_ALLOW_SELF_SIGNED === "true"
);

const normalizeEmail = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase();

const toBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === undefined || value === null || value === "") return fallback;

  return Boolean(value);
};

const toPort = (value: unknown): number | null => {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return port;
};

const escapeHeaderValue = (value: unknown): string =>
  String(value || "")
    .replace(/[\r\n]/g, " ")
    .trim();

const getSenderEmailValue = (senderEmail: SenderEmailInput): string => {
  if (!senderEmail) return "";

  if (typeof senderEmail === "string") {
    return normalizeEmail(senderEmail);
  }

  return normalizeEmail(senderEmail.email);
};

const getSenderIdValue = (value: SenderEmailInput): string | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = value._id || value.id;

  return id ? String(id) : null;
};

const hasPopulatedSenderCredentials = (
  senderEmail: SenderEmailInput,
): senderEmail is SenderEmailDocumentInput => {
  return Boolean(
    senderEmail &&
      typeof senderEmail === "object" &&
      senderEmail.email &&
      senderEmail.smtpHost &&
      senderEmail.smtpPort &&
      senderEmail.smtpUser &&
      senderEmail.encryptedSmtpPassword,
  );
};

function validateSenderDocument(
  sender: SenderEmailInput,
): asserts sender is SenderEmailDocumentInput {
  if (!sender || typeof sender !== "object") {
    throw new Error("sendEmail: sender email was not found.");
  }

  if (sender.isActive === false) {
    throw new Error(
      `sendEmail: sender email ${sender.email || ""} is inactive.`,
    );
  }

  if (!sender.email) {
    throw new Error("sendEmail: sender email address is missing.");
  }

  if (!sender.smtpHost) {
    throw new Error(
      `sendEmail: sender email ${sender.email} is missing smtpHost.`,
    );
  }

  const smtpPort = toPort(sender.smtpPort);

  if (!smtpPort) {
    throw new Error(
      `sendEmail: sender email ${sender.email} has invalid smtpPort.`,
    );
  }

  if (!sender.smtpUser) {
    throw new Error(
      `sendEmail: sender email ${sender.email} is missing smtpUser.`,
    );
  }

  if (!sender.encryptedSmtpPassword) {
    throw new Error(
      `sendEmail: sender email ${sender.email} is missing encrypted SMTP credentials.`,
    );
  }
}

const normalizeSender = (
  sender: SenderEmailInput,
  expectedTenantId?: string,
): NormalizedSender => {
  validateSenderDocument(sender);

  if (
    expectedTenantId &&
    (!sender.tenant || String(sender.tenant) !== String(expectedTenantId))
  ) {
    throw new Error(
      "sendEmail: sender email does not belong to this workspace.",
    );
  }

  const password = decryptEmailPassword(String(sender.encryptedSmtpPassword));

  if (!password) {
    throw new Error(
      `sendEmail: failed to decrypt SMTP password for sender ${sender.email}.`,
    );
  }

  return {
    id: sender._id ? String(sender._id) : null,
    tenantId: sender.tenant ? String(sender.tenant) : null,
    email: normalizeEmail(sender.email),
    displayName: escapeHeaderValue(
      sender.displayName || sender.note || DEFAULT_FROM_NAME,
    ),
    smtpHost: String(sender.smtpHost).trim(),
    smtpPort: toPort(sender.smtpPort) as number,
    smtpSecure: toBoolean(sender.smtpSecure, false),
    smtpUser: String(sender.smtpUser).trim(),
    smtpPassword: password,
    provider: String(sender.provider || "custom")
      .trim()
      .toLowerCase(),
    updatedAt: sender.updatedAt ? String(sender.updatedAt) : null,
  };
};

const getSenderCacheKey = ({
  tenantId,
  senderEmail,
  senderEmailId,
}: {
  tenantId: string;
  senderEmail?: string | null;
  senderEmailId?: string | null;
}): string => {
  if (senderEmailId) {
    return `tenant:${tenantId}:id:${senderEmailId}`;
  }

  return `tenant:${tenantId}:email:${normalizeEmail(senderEmail)}`;
};

const findSenderFromDb = async ({
  tenantId,
  senderEmail,
  senderEmailId,
}: {
  tenantId: string;
  senderEmail?: string | null;
  senderEmailId?: string | null;
}): Promise<SenderEmailDocumentInput | null> => {
  if (!mongoose.Types.ObjectId.isValid(tenantId)) {
    throw new Error(
      "sendEmail: a valid tenantId is required to resolve a sender.",
    );
  }

  const query: SenderLookupQuery = {
    tenant: new Types.ObjectId(tenantId),
    isActive: true,
  };

  if (senderEmailId && mongoose.Types.ObjectId.isValid(senderEmailId)) {
    query._id = new Types.ObjectId(senderEmailId);
  } else {
    const normalizedEmail = normalizeEmail(senderEmail);

    if (!normalizedEmail) {
      throw new Error("sendEmail: missing registered sender email.");
    }

    query.email = normalizedEmail;
  }

  return RegisteredSenderEmailModel.findOne(query)
    .select(
      [
        "+email",
        "+tenant",
        "+displayName",
        "+note",
        "+smtpHost",
        "+smtpPort",
        "+smtpSecure",
        "+smtpUser",
        "+encryptedSmtpPassword",
        "+provider",
        "+isActive",
        "+updatedAt",
      ].join(" "),
    )
    .lean<SenderEmailDocumentInput>()
    .exec();
};

const getSenderCredentials = async ({
  tenantId,
  senderEmail,
  senderEmailId,
}: {
  tenantId?: string;
  senderEmail?: SenderEmailInput;
  senderEmailId?: string | null;
}): Promise<NormalizedSender> => {
  if (hasPopulatedSenderCredentials(senderEmail)) {
    return normalizeSender(senderEmail, tenantId);
  }

  if (!tenantId) {
    throw new Error(
      "sendEmail: tenantId is required to resolve a registered sender.",
    );
  }

  const senderEmailValue = getSenderEmailValue(senderEmail);
  const senderIdValue = senderEmailId || getSenderIdValue(senderEmail);

  const cacheKey = getSenderCacheKey({
    tenantId,
    senderEmail: senderEmailValue,
    senderEmailId: senderIdValue,
  });

  const cached = senderCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.sender;
  }

  const senderDocument = await findSenderFromDb({
    tenantId,
    senderEmail: senderEmailValue,
    senderEmailId: senderIdValue,
  });

  const normalizedSender = normalizeSender(senderDocument, tenantId);

  senderCache.set(cacheKey, {
    sender: normalizedSender,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return normalizedSender;
};

const buildTransporterKey = (sender: NormalizedSender): string => {
  const updatedAt = sender.updatedAt
    ? new Date(sender.updatedAt).getTime()
    : "";

  return [
    sender.id || sender.email,
    sender.tenantId,
    sender.smtpHost,
    sender.smtpPort,
    sender.smtpSecure,
    sender.smtpUser,
    sender.provider,
    `rejectUnauthorized:${tlsRejectUnauthorized}`,
    updatedAt,
  ].join("|");
};

const createTransporter = (
  sender: NormalizedSender,
  endpoint: ResolvedSmtpEndpoint,
): Transporter<SentMessageInfo> => {
  const config: SMTPTransport.Options = {
    // Connect to the validated address so DNS rebinding cannot redirect the
    // socket after the policy check. Keep the original hostname as SNI below.
    host: endpoint.address,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    pool: true,
    maxConnections: Number(process.env.EMAIL_MAX_CONNECTIONS || 3),
    maxMessages: Number(process.env.EMAIL_MAX_MESSAGES || 100),
    connectionTimeout: Number(
      process.env.EMAIL_CONNECTION_TIMEOUT_MS || 15_000,
    ),
    greetingTimeout: Number(process.env.EMAIL_GREETING_TIMEOUT_MS || 10_000),
    socketTimeout: Number(process.env.EMAIL_SOCKET_TIMEOUT_MS || 30_000),
    auth: {
      user: sender.smtpUser,
      pass: sender.smtpPassword,
    },
    tls: {
      rejectUnauthorized: tlsRejectUnauthorized,
      ...(endpoint.servername ? { servername: endpoint.servername } : {}),
    },
  };

  logger.debug(
    {
      host: endpoint.hostname,
      address: endpoint.address,
      port: sender.smtpPort,
      secure: sender.smtpSecure,
      user: sender.smtpUser,
      rejectUnauthorized: tlsRejectUnauthorized,
    },
    "Creating email SMTP transporter.",
  );

  return nodemailer.createTransport(config);
};

const clearExpiredTransporters = (): void => {
  const now = Date.now();

  for (const [key, cached] of transporterCache.entries()) {
    if (cached.expiresAt <= now) {
      cached.transporter.close();
      transporterCache.delete(key);
    }
  }
};

const getTransporter = async (
  sender: NormalizedSender,
): Promise<Transporter<SentMessageInfo>> => {
  clearExpiredTransporters();

  const key = buildTransporterKey(sender);
  const cached = transporterCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.transporter;
  }

  const endpoint = await resolveConfiguredSmtpEndpoint({
    provider: sender.provider,
    hostname: sender.smtpHost,
    port: sender.smtpPort,
  });
  const transporter = createTransporter(sender, endpoint);

  transporterCache.set(key, {
    transporter,
    expiresAt: Date.now() + TRANSPORTER_CACHE_TTL_MS,
  });

  return transporter;
};

const buildFromHeader = (sender: NormalizedSender): string => {
  return `"${sender.displayName.replaceAll('"', '\\"')}" <${sender.email}>`;
};

const validateMailOptions = (mailOptions: SendEmailOptions): void => {
  if (!mailOptions.to) {
    throw new Error("sendEmail: missing 'to'.");
  }

  if (!mailOptions.subject) {
    throw new Error("sendEmail: missing 'subject'.");
  }

  if (!mailOptions.html && !mailOptions.text) {
    throw new Error("sendEmail: missing 'html' or 'text'.");
  }
};

const extractSenderInput = (
  mailOptions: SendEmailOptions,
): {
  senderEmail?: SenderEmailInput;
  senderEmailId?: string | null;
} => {
  return {
    senderEmail:
      mailOptions.senderEmail ||
      mailOptions.registeredSenderEmail ||
      mailOptions.sender ||
      mailOptions.from,
    senderEmailId:
      mailOptions.senderEmailId || mailOptions.registeredSenderEmailId || null,
  };
};

const sanitizeMailOptions = (
  mailOptions: SendEmailOptions,
  sender: NormalizedSender,
): SMTPTransport.MailOptions => {
  const normalized: SendEmailOptions = {
    ...mailOptions,
    from: buildFromHeader(sender),
  };

  delete normalized.senderEmail;
  delete normalized.senderEmailId;
  delete normalized.sender;
  delete normalized.registeredSenderEmail;
  delete normalized.registeredSenderEmailId;
  delete normalized.tenantId;

  return normalized;
};

export const clearEmailServiceCache = (): void => {
  senderCache.clear();

  for (const cached of transporterCache.values()) {
    cached.transporter.close();
  }

  transporterCache.clear();
};

export const sendEmail = async (mailOptions: SendEmailOptions = {}) => {
  validateMailOptions(mailOptions);

  const { senderEmail, senderEmailId } = extractSenderInput(mailOptions);

  const sender = await getSenderCredentials({
    tenantId: mailOptions.tenantId,
    senderEmail,
    senderEmailId,
  });

  const transporter = await getTransporter(sender);
  const normalizedMailOptions = sanitizeMailOptions(mailOptions, sender);

  const info = await transporter.sendMail(normalizedMailOptions);

  return {
    provider: "nodemailer",
    providerMessageId: info?.messageId || null,
    messageId: info?.messageId || null,
    accepted: info?.accepted || [],
    rejected: info?.rejected || [],
    pending: info?.pending || [],
    response: info?.response || null,
    envelope: info?.envelope || null,
  };
};

export const verifySenderEmail = async (
  senderEmailOrId: string,
  tenantId?: string,
) => {
  const isObjectId = mongoose.Types.ObjectId.isValid(senderEmailOrId);

  const sender = await getSenderCredentials({
    tenantId,
    senderEmail: isObjectId ? null : senderEmailOrId,
    senderEmailId: isObjectId ? senderEmailOrId : null,
  });

  const endpoint = await resolveConfiguredSmtpEndpoint({
    provider: sender.provider,
    hostname: sender.smtpHost,
    port: sender.smtpPort,
  });
  const transporter = createTransporter(sender, endpoint);

  try {
    await transporter.verify();

    return {
      ok: true,
      email: sender.email,
      smtpHost: sender.smtpHost,
      smtpPort: sender.smtpPort,
      smtpSecure: sender.smtpSecure,
      tlsRejectUnauthorized,
    };
  } finally {
    transporter.close();
  }
};

export default sendEmail;
