import {
  ACCESS_CODE_EFFECTIVE_STATUS,
  ACCESS_CODE_STATUS,
  ACCESS_CODE_TYPE,
  type AccessCodeEffectiveStatus,
  type AccessCodeStatus,
  type AccessCodeType,
} from "./access-code.constants.js";
import type {
  SerializedAccessCode,
  SerializedAccessCodeAuditEvent,
} from "./access-code.types.js";

const id = (value: unknown): string => String(value ?? "").trim();
const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const plain = (value: any): Record<string, any> =>
  typeof value?.toObject === "function" ? value.toObject() : value || {};

export const getEffectiveAccessCodeStatus = (
  code: { status?: string; validUntil?: Date | string | null },
  now = new Date(),
): AccessCodeEffectiveStatus => {
  const status = (code.status || ACCESS_CODE_STATUS.DRAFT) as AccessCodeStatus;
  const validUntil = code.validUntil ? new Date(code.validUntil) : null;

  if (
    status !== ACCESS_CODE_STATUS.RETIRED &&
    validUntil &&
    !Number.isNaN(validUntil.getTime()) &&
    validUntil.getTime() <= now.getTime()
  ) {
    return ACCESS_CODE_EFFECTIVE_STATUS.EXPIRED;
  }

  return status;
};

export const isAccessCodeCurrentlyAvailable = (
  code: {
    status?: string;
    validFrom?: Date | string | null;
    validUntil?: Date | string | null;
    verifiedAt?: Date | string | null;
  },
  now = new Date(),
): boolean => {
  if (code.status !== ACCESS_CODE_STATUS.AVAILABLE || !code.verifiedAt) {
    return false;
  }
  const from = code.validFrom ? new Date(code.validFrom).getTime() : null;
  const until = code.validUntil ? new Date(code.validUntil).getTime() : null;
  return (
    (from === null || (!Number.isNaN(from) && from <= now.getTime())) &&
    (until === null || (!Number.isNaN(until) && until > now.getTime()))
  );
};

export const serializeAccessCode = (
  value: any,
  now = new Date(),
): SerializedAccessCode => {
  const code = plain(value);
  return {
    id: id(code._id),
    poolId: id(code.pool),
    locationId: id(code.location),
    type: (code.type || ACCESS_CODE_TYPE.SINGLE_BOOKING) as AccessCodeType,
    status: (code.status || ACCESS_CODE_STATUS.DRAFT) as AccessCodeStatus,
    effectiveStatus: getEffectiveAccessCodeStatus(code, now),
    maskedCode: String(code.codeHint || "••••"),
    label: String(code.label || ""),
    notes: String(code.notes || ""),
    validFrom: iso(code.validFrom),
    validUntil: iso(code.validUntil),
    verifiedAt: iso(code.verifiedAt),
    verifiedBy: id(code.verifiedBy) || null,
    programmedAndTested: Boolean(code.verifiedAt),
    createdAt: iso(code.createdAt),
    updatedAt: iso(code.updatedAt),
  };
};

export const serializeAccessCodePool = (value: any) => {
  const pool = plain(value);
  return {
    id: id(pool._id),
    locationId: id(pool.location),
    name: String(pool.name || ""),
    lowStockThreshold: Math.max(0, Number(pool.lowStockThreshold || 0)),
    isActive: pool.isActive !== false,
    archivedAt: iso(pool.archivedAt),
    createdAt: iso(pool.createdAt),
    updatedAt: iso(pool.updatedAt),
  };
};

export const serializeAccessCodeAuditEvent = (
  value: any,
): SerializedAccessCodeAuditEvent => {
  const event = plain(value);
  const actorIdentity = plain(event.actorIdentity);
  const actorName = [actorIdentity.firstname, actorIdentity.lastname]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const actorEmail = String(actorIdentity.email || "").trim() || null;

  return {
    id: id(event._id),
    poolId: id(event.pool),
    locationId: id(event.location),
    accessCodeId: id(event.accessCode) || null,
    actorId: id(event.actor),
    actor:
      actorName || actorEmail
        ? {
            name: actorName || null,
            email: actorEmail,
          }
        : null,
    action: event.action,
    metadata:
      event.metadata && typeof event.metadata === "object"
        ? event.metadata
        : {},
    createdAt: iso(event.createdAt) || new Date(0).toISOString(),
  };
};
