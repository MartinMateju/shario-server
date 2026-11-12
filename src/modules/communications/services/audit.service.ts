import { CommunicationAuditModel } from "../communications.models.js";

const SENSITIVE_KEY = /password|secret|token|authorization|cookie|api[-_]?key|access[-_]?key|refresh|content|html|transcript|^(text|body|raw|message|payload)$/i;

export const redactAuditPayload = (
  value: unknown,
  seen = new WeakSet<object>(),
): unknown => {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => redactAuditPayload(item, seen));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactAuditPayload(child, seen),
    ]),
  );
};

export const buildRetentionCutoff = (
  days: number,
  now = new Date(),
): Date => new Date(now.getTime() - Math.max(1, Math.trunc(days)) * 86_400_000);

export const recordCommunicationAudit = async ({
  tenantId,
  actorType = "user",
  actorId = null,
  action,
  resourceType,
  resourceId = null,
  conversationId = null,
  locationId = null,
  summary = "",
  before = null,
  after = null,
  metadata = {},
  ipAddress = "",
  userAgent = "",
  retentionDays = 1095,
}: Record<string, any>) =>
  CommunicationAuditModel.create({
    tenantId,
    actorType,
    actorId,
    action,
    resourceType,
    resourceId,
    conversationId,
    locationId,
    summary,
    before: redactAuditPayload(before),
    after: redactAuditPayload(after),
    metadata: redactAuditPayload(metadata),
    ipAddress,
    userAgent,
    expiresAt: new Date(Date.now() + Math.max(30, retentionDays) * 86_400_000),
  });
