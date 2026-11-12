import { createHash } from "node:crypto";

import mongoose from "mongoose";

import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import UserModel from "@/modules/user/user.model.js";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_LIMITS,
  DATA_IMPORT_ROLLBACK_STATUS,
  DATA_IMPORT_ROW_STATUS,
  DATA_IMPORT_STATUS,
  type DataImportDuplicateStrategy,
} from "../data-import.constants.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import DataImportCredentialModel from "../data-import-credential.model.js";
import type {
  CustomerDuplicate,
  ImportColumnMapping,
  ImportIssue,
  NormalizedCustomerImportRow,
} from "../data-import.types.js";
import {
  CUSTOMER_PASSWORD_HASH_HEADER,
  CUSTOMER_PASSWORD_REDACTED_VALUE,
  isProtectedWorkspaceUser,
  isSupportedCustomerPasswordHash,
  normalizeCustomerImportRow,
  normalizeImportPhone,
  validateCustomerImportRow,
} from "../adapters/customer-import.adapter.js";
import {
  assertValidCustomerColumnMapping,
  normalizeImportHeader,
  suggestBookingColumnMapping,
  suggestCreditColumnMapping,
  suggestCustomerColumnMapping,
  suggestMembershipColumnMapping,
  suggestMembershipPlanColumnMapping,
  suggestProductColumnMapping,
  suggestVoucherColumnMapping,
  suggestVoucherProductColumnMapping,
} from "./import-column-mapping.service.js";
import {
  getImportFileType,
  parseImportFile,
} from "./import-file-parser.service.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import { refreshImportRollbackAvailability } from "./data-import-rollback-availability.service.js";
import {
  isRolledBackImportRecord,
  rolledBackImportIssue,
} from "./data-import-rollback-marker.service.js";

const ensureObjectId = (value: string, code = "IMPORT_NOT_FOUND") => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    notFound({ message: "Import session not found.", code });
  }
  return new mongoose.Types.ObjectId(value);
};

export const serializeImportSession = (session: any) => {
  const reportAvailable = Boolean(
    session.reportAvailableUntil &&
    new Date(session.reportAvailableUntil).getTime() > Date.now(),
  );
  const rollback = session.rollback || {
    status: "unavailable",
    revision: 0,
    counters: {},
  };
  const rollbackReportAvailable = [
    DATA_IMPORT_ROLLBACK_STATUS.COMPLETED,
    DATA_IMPORT_ROLLBACK_STATUS.PARTIAL,
    DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
    DATA_IMPORT_ROLLBACK_STATUS.FAILED,
  ].includes(rollback.status);
  return {
    id: String(session._id),
    entityType: session.entityType,
    status: session.status,
    originalFileName: session.originalFileName,
    fileType: session.fileType,
    sheetName: session.sheetName ?? null,
    headers: session.headers || [],
    suggestedMapping: session.suggestedMapping || {},
    mapping: session.mapping || null,
    validationRevision: session.validationRevision || null,
    credentialRowCount: Number(session.credentialRowCount || 0),
    credentialImportConfirmed: Boolean(session.credentialImportConfirmed),
    preserveImportedMemberNumbers: Boolean(
      session.preserveImportedMemberNumbers,
    ),
    duplicateStrategy: session.duplicateStrategy,
    summary: session.summary || {},
    lastError: session.lastError || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    queuedAt: session.queuedAt || null,
    startedAt: session.startedAt || null,
    completedAt: session.completedAt || null,
    reportAvailable,
    reportAvailableUntil: session.reportAvailableUntil || null,
    rollbackAvailableUntil: session.rollbackAvailableUntil || null,
    rollback: {
      ...rollback,
      reportAvailable: Boolean(
        rollback.requestedAt && rollbackReportAvailable && reportAvailable,
      ),
      reportAvailableUntil: session.reportAvailableUntil || null,
    },
  };
};

const LIVE_IMPORT_ROW_STATUSES = [
  DATA_IMPORT_ROW_STATUS.CREATED,
  DATA_IMPORT_ROW_STATUS.UPDATED,
  DATA_IMPORT_ROW_STATUS.SKIPPED,
  DATA_IMPORT_ROW_STATUS.FAILED,
] as const;

export const getLiveImportExecutionSummary = async (session: any) => {
  if (
    session.status !== DATA_IMPORT_STATUS.QUEUED &&
    session.status !== DATA_IMPORT_STATUS.PROCESSING
  ) {
    return session.summary || {};
  }

  const counts = await DataImportRowModel.aggregate<{
    _id: (typeof LIVE_IMPORT_ROW_STATUSES)[number];
    count: number;
  }>([
    {
      $match: {
        tenant: session.tenant,
        session: session._id,
        status: { $in: [...LIVE_IMPORT_ROW_STATUSES] },
      },
    },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const liveCounts = Object.fromEntries(
    counts.map(({ _id, count }) => [_id, Number(count || 0)]),
  );

  return {
    ...(session.summary || {}),
    created: liveCounts[DATA_IMPORT_ROW_STATUS.CREATED] || 0,
    updated: liveCounts[DATA_IMPORT_ROW_STATUS.UPDATED] || 0,
    skipped: liveCounts[DATA_IMPORT_ROW_STATUS.SKIPPED] || 0,
    failed: liveCounts[DATA_IMPORT_ROW_STATUS.FAILED] || 0,
  };
};

export const getTenantImportSession = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  let session = await DataImportSessionModel.findOne({
    _id: ensureObjectId(sessionId),
    tenant: tenantId,
  }).lean();
  if (!session) {
    notFound({
      message: "Import session not found.",
      code: "IMPORT_NOT_FOUND",
    });
  }
  if (
    session.status === DATA_IMPORT_STATUS.COMPLETED &&
    session.rollback?.status === "unavailable" &&
    !session.rollback?.unavailableReason &&
    !session.rollback?.requestedAt
  ) {
    await refreshImportRollbackAvailability({ tenantId, sessionId });
    session = await DataImportSessionModel.findOne({
      _id: ensureObjectId(sessionId),
      tenant: tenantId,
    }).lean();
    if (!session)
      notFound({
        message: "Import session not found.",
        code: "IMPORT_NOT_FOUND",
      });
  }
  session = {
    ...session,
    summary: await getLiveImportExecutionSummary(session),
  } as typeof session;
  return session;
};

export const createCustomerImportSession = async ({
  tenantId,
  actorId,
  file,
}: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
}) => {
  return createDataImportSession({
    tenantId,
    actorId,
    file,
    entityType: DATA_IMPORT_ENTITY.CUSTOMERS,
  });
};

export const createDataImportSession = async ({
  tenantId,
  actorId,
  file,
  entityType,
}: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
  entityType: (typeof DATA_IMPORT_ENTITY)[keyof typeof DATA_IMPORT_ENTITY];
}) => {
  const parsed = await parseImportFile({
    buffer: file.buffer,
    originalFileName: file.originalname,
    mimeType: file.mimetype,
  });
  const fileType = getImportFileType(file.originalname);
  const suggesters = {
    [DATA_IMPORT_ENTITY.CUSTOMERS]: suggestCustomerColumnMapping,
    [DATA_IMPORT_ENTITY.PRODUCTS]: suggestProductColumnMapping,
    [DATA_IMPORT_ENTITY.BOOKINGS]: suggestBookingColumnMapping,
    [DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS]: suggestMembershipPlanColumnMapping,
    [DATA_IMPORT_ENTITY.MEMBERSHIPS]: suggestMembershipColumnMapping,
    [DATA_IMPORT_ENTITY.CREDITS]: suggestCreditColumnMapping,
    [DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS]: suggestVoucherProductColumnMapping,
    [DATA_IMPORT_ENTITY.VOUCHERS]: suggestVoucherColumnMapping,
  } as const;
  const suggestedMapping = suggesters[entityType](parsed.headers) as unknown;
  const passwordHeader =
    entityType === DATA_IMPORT_ENTITY.CUSTOMERS &&
    parsed.headers.includes(CUSTOMER_PASSWORD_HASH_HEADER)
      ? CUSTOMER_PASSWORD_HASH_HEADER
      : null;
  if (entityType === DATA_IMPORT_ENTITY.CUSTOMERS) {
    const unsupportedPasswordHeaders = parsed.headers.filter((header) => {
      if (header === CUSTOMER_PASSWORD_HASH_HEADER) return false;
      const normalized = normalizeImportHeader(header);
      return (
        normalized.includes("password") ||
        normalized.includes("passwd") ||
        normalized === "pwd" ||
        normalized.includes("heslo")
      );
    });
    const unsafeHeader = unsupportedPasswordHeaders.find((header) =>
      parsed.rows.some((row) => String(row[header] || "").trim()),
    );
    if (unsafeHeader) {
      badRequest({
        message:
          `Password values must use the exact ${CUSTOMER_PASSWORD_HASH_HEADER} column and contain bcrypt hashes only.`,
        code: "IMPORT_PASSWORD_COLUMN_UNSUPPORTED",
      });
    }
  }
  const credentials: Array<{
    tenant: string;
    rowNumber: number;
    sourceHeader: string;
    passwordHash: string;
  }> = [];
  const sanitizedRows = parsed.rows.map((source, index) => {
    const raw = { ...source };
    if (!passwordHeader) return raw;
    const passwordHash = String(source[passwordHeader] || "").trim();
    if (!passwordHash) return raw;
    if (!isSupportedCustomerPasswordHash(passwordHash)) {
      badRequest({
        message: `Row ${index + 2} contains an invalid or unsupported bcrypt password hash.`,
        code: "IMPORT_PASSWORD_HASH_INVALID",
      });
    }
    credentials.push({
      tenant: tenantId,
      rowNumber: index + 2,
      sourceHeader: passwordHeader,
      passwordHash,
    });
    raw[passwordHeader] = CUSTOMER_PASSWORD_REDACTED_VALUE;
    return raw;
  });
  const retentionUntil = new Date(
    Date.now() + DATA_IMPORT_LIMITS.ROW_RETENTION_DAYS * 86_400_000,
  );
  const session = await DataImportSessionModel.create({
    tenant: tenantId,
    entityType,
    status: DATA_IMPORT_STATUS.UPLOADED,
    createdBy: actorId,
    originalFileName: file.originalname.slice(0, 255),
    fileType,
    fileHash: createHash("sha256").update(file.buffer).digest("hex"),
    sheetName: parsed.sheetName,
    headers: parsed.headers,
    suggestedMapping,
    credentialRowCount: credentials.length,
    summary: { total: parsed.rows.length },
    reportAvailableUntil: retentionUntil,
    rollbackAvailableUntil: retentionUntil,
  });

  const expiresAt = retentionUntil;
  const documents = sanitizedRows.map((raw, index) => ({
    tenant: tenantId,
    session: session._id,
    rowNumber: index + 2,
    raw,
    status: DATA_IMPORT_ROW_STATUS.PENDING,
    expiresAt,
  }));
  try {
    for (let index = 0; index < documents.length; index += 500) {
      await DataImportRowModel.insertMany(
        documents.slice(index, index + 500) as any[],
        { ordered: true },
      );
    }
    if (credentials.length) {
      await DataImportCredentialModel.insertMany(
        credentials.map((credential) => ({
          ...credential,
          session: session._id,
        })),
        { ordered: true },
      );
    }
  } catch (error) {
    await Promise.allSettled([
      DataImportSessionModel.deleteOne({ _id: session._id }),
      DataImportRowModel.deleteMany({ session: session._id }),
      DataImportCredentialModel.deleteMany({ session: session._id }),
    ]);
    throw error;
  }

  await recordDataImportAudit({
    tenantId,
    sessionId: String(session._id),
    actorId,
    action: "uploaded",
    metadata: {
      entityType,
      fileType,
      rows: parsed.rows.length,
      credentialRows: credentials.length,
    },
  });

  return {
    ...serializeImportSession(session.toObject()),
    totalRows: parsed.rows.length,
    sampleRows: sanitizedRows.slice(0, 5),
  };
};

export const listTenantImportSessions = async ({
  tenantId,
  entityType = DATA_IMPORT_ENTITY.CUSTOMERS,
  page = 1,
  limit = 20,
  status,
  rollbackStatus,
  createdFrom,
  createdTo,
  search,
}: {
  tenantId: string;
  entityType?: (typeof DATA_IMPORT_ENTITY)[keyof typeof DATA_IMPORT_ENTITY];
  page?: number;
  limit?: number;
  status?: string;
  rollbackStatus?: string;
  createdFrom?: string;
  createdTo?: string;
  search?: string;
}) => {
  const boundedPage = Math.max(1, Math.floor(Number(page) || 1));
  const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  if (status && !Object.values(DATA_IMPORT_STATUS).includes(status as any))
    badRequest({
      message: "Import status filter is invalid.",
      code: "IMPORT_STATUS_FILTER_INVALID",
    });
  if (
    rollbackStatus &&
    !Object.values(DATA_IMPORT_ROLLBACK_STATUS).includes(rollbackStatus as any)
  )
    badRequest({
      message: "Rollback status filter is invalid.",
      code: "IMPORT_ROLLBACK_STATUS_FILTER_INVALID",
    });
  const parseDate = (
    value: string | undefined,
    code: string,
    upperBound = false,
  ) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
      badRequest({ message: "Import date filter is invalid.", code });
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (upperBound && dateOnly)
      return {
        value: new Date(parsed.getTime() + 86_400_000),
        exclusive: true,
      };
    return { value: parsed, exclusive: false };
  };
  const from = parseDate(createdFrom, "IMPORT_CREATED_FROM_INVALID");
  const to = parseDate(createdTo, "IMPORT_CREATED_TO_INVALID", true);
  if (from && to && from.value.getTime() >= to.value.getTime())
    badRequest({
      message: "Import date range is invalid.",
      code: "IMPORT_DATE_RANGE_INVALID",
    });
  const normalizedSearch = String(search || "")
    .trim()
    .slice(0, 100);
  const escapeRegex = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter: Record<string, unknown> = {
    tenant: tenantId,
    entityType,
    ...(status ? { status } : {}),
    ...(rollbackStatus ? { "rollback.status": rollbackStatus } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { $gte: from.value } : {}),
            ...(to
              ? to.exclusive
                ? { $lt: to.value }
                : { $lte: to.value }
              : {}),
          },
        }
      : {}),
    ...(normalizedSearch
      ? {
          originalFileName: {
            $regex: escapeRegex(normalizedSearch),
            $options: "i",
          },
        }
      : {}),
  };
  let [sessions, total] = await Promise.all([
    DataImportSessionModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((boundedPage - 1) * boundedLimit)
      .limit(boundedLimit)
      .lean(),
    DataImportSessionModel.countDocuments(filter),
  ]);
  const stale = sessions.filter(
    (session: any) =>
      session.status === DATA_IMPORT_STATUS.COMPLETED &&
      session.rollback?.status === DATA_IMPORT_ROLLBACK_STATUS.UNAVAILABLE &&
      !session.rollback?.unavailableReason &&
      !session.rollback?.requestedAt,
  );
  if (stale.length) {
    await Promise.all(
      stale.map((session: any) =>
        refreshImportRollbackAvailability({
          tenantId,
          sessionId: String(session._id),
        }),
      ),
    );
    const refreshed = await DataImportSessionModel.find({
      tenant: tenantId,
      _id: { $in: sessions.map((session: any) => session._id) },
    }).lean();
    const byId = new Map(
      refreshed.map((session: any) => [String(session._id), session]),
    );
    sessions = sessions.map(
      (session: any) => byId.get(String(session._id)) || session,
    ) as any;
  }
  return {
    items: sessions.map(serializeImportSession),
    pagination: {
      page: boundedPage,
      limit: boundedLimit,
      total,
      totalPages: total ? Math.ceil(total / boundedLimit) : 0,
    },
  };
};

export type ExistingCustomer = {
  _id: mongoose.Types.ObjectId;
  email?: string;
  phone?: string;
  memberNumber?: number;
  updatedAt?: Date;
  tenantRole?: string;
  roles?: string[];
  importMetadata?: {
    externalId?: string;
    rolledBackAt?: Date;
    rollbackMutationKey?: string;
  };
};

export const buildExistingIndexes = (users: ExistingCustomer[]) => {
  const externalIds = new Map<string, ExistingCustomer[]>();
  const emails = new Map<string, ExistingCustomer>();
  const phones = new Map<string, ExistingCustomer[]>();
  const memberNumbers = new Map<number, ExistingCustomer>();
  for (const user of users) {
    const externalId = String(user.importMetadata?.externalId || "").trim();
    const email = String(user.email || "")
      .trim()
      .toLocaleLowerCase();
    const phone = normalizeImportPhone(String(user.phone || ""));
    const memberNumber = Number(user.memberNumber);
    if (externalId) {
      externalIds.set(externalId, [
        ...(externalIds.get(externalId) || []),
        user,
      ]);
    }
    if (email) emails.set(email, user);
    if (phone) phones.set(phone, [...(phones.get(phone) || []), user]);
    if (Number.isSafeInteger(memberNumber) && memberNumber > 0) {
      memberNumbers.set(memberNumber, user);
    }
  }
  return { externalIds, emails, phones, memberNumbers };
};

export const findExistingDuplicate = (
  row: NormalizedCustomerImportRow,
  indexes: ReturnType<typeof buildExistingIndexes>,
): { duplicate: CustomerDuplicate | null; conflict: boolean } => {
  const matches = new Map<
    string,
    { user: ExistingCustomer; kind: CustomerDuplicate["kind"] }
  >();
  const add = (
    user: ExistingCustomer | undefined,
    kind: CustomerDuplicate["kind"],
  ) => {
    if (user && !matches.has(String(user._id))) {
      matches.set(String(user._id), { user, kind });
    }
  };
  if (row.externalId) {
    const externalIdMatches = indexes.externalIds.get(row.externalId) || [];
    if (externalIdMatches.length > 1) {
      return { duplicate: null, conflict: true };
    }
    add(externalIdMatches[0], "externalId");
  }
  if (row.email) add(indexes.emails.get(row.email), "email");
  if (row.phone) {
    const phoneMatches = indexes.phones.get(row.phone) || [];
    if (phoneMatches.length > 1) return { duplicate: null, conflict: true };
    add(phoneMatches[0], "phone");
  }
  if (matches.size > 1) return { duplicate: null, conflict: true };
  const match = [...matches.values()][0];
  return match
    ? {
        duplicate: {
          kind: match.kind,
          existingUserId: match.user._id,
        },
        conflict: false,
      }
    : { duplicate: null, conflict: false };
};

export const duplicateFileKey = (
  row: NormalizedCustomerImportRow,
): { kind: CustomerDuplicate["kind"]; value: string } | null => {
  return customerFileIdentityKeys(row)[0] || null;
};

export const customerFileIdentityKeys = (
  row: NormalizedCustomerImportRow,
): Array<{ kind: CustomerDuplicate["kind"]; value: string }> => [
  ...(row.externalId
    ? [{ kind: "externalId" as const, value: row.externalId }]
    : []),
  ...(row.email ? [{ kind: "email" as const, value: row.email }] : []),
  ...(row.phone ? [{ kind: "phone" as const, value: row.phone }] : []),
];

export const validateCustomerImportSession = async ({
  tenantId,
  sessionId,
  mapping: mappingInput,
  duplicateStrategy,
  actorId,
  confirmPasswordHashImport = false,
  preserveImportedMemberNumbers = false,
}: {
  tenantId: string;
  sessionId: string;
  mapping: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  confirmPasswordHashImport?: boolean;
  preserveImportedMemberNumbers?: boolean;
}) => {
  if (
    !Object.values(DATA_IMPORT_DUPLICATE_STRATEGY).includes(duplicateStrategy)
  ) {
    badRequest({
      message: "Duplicate strategy must be skip or update.",
      code: "IMPORT_DUPLICATE_STRATEGY_INVALID",
    });
  }
  const current = await getTenantImportSession({ tenantId, sessionId });
  const validationReadyStatuses = new Set<string>([
    DATA_IMPORT_STATUS.UPLOADED,
    DATA_IMPORT_STATUS.VALIDATED,
    DATA_IMPORT_STATUS.FAILED,
  ]);
  if (
    current.entityType !== DATA_IMPORT_ENTITY.CUSTOMERS ||
    !validationReadyStatuses.has(String(current.status))
  ) {
    conflict({
      message: "This import can no longer be validated.",
      code: "IMPORT_STATE_INVALID",
      details: { status: current.status },
    });
  }
  // Reject bad mappings before taking the validation claim. Otherwise a
  // client typo would leave the session permanently stuck in `validating`.
  const mapping: ImportColumnMapping = assertValidCustomerColumnMapping(
    current.headers,
    mappingInput,
  );
  if (
    mapping.passwordHash &&
    mapping.passwordHash !== CUSTOMER_PASSWORD_HASH_HEADER
  ) {
    badRequest({
      message:
        `Legacy password hashes can only be mapped from the exact ${CUSTOMER_PASSWORD_HASH_HEADER} column.`,
      code: "IMPORT_PASSWORD_MAPPING_INVALID",
    });
  }
  const sessionObjectId = current._id;
  const credentialRows = mapping.passwordHash
    ? await DataImportCredentialModel.find({
        tenant: tenantId,
        session: sessionObjectId,
        sourceHeader: mapping.passwordHash,
      })
        .select("rowNumber sourceHeader")
        .lean()
    : [];
  if (credentialRows.length && !confirmPasswordHashImport) {
    badRequest({
      message:
        "Confirm that the legacy password column contains securely exported bcrypt hashes.",
      code: "IMPORT_PASSWORD_HASH_CONFIRMATION_REQUIRED",
    });
  }
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: sessionObjectId,
      tenant: tenantId,
      entityType: DATA_IMPORT_ENTITY.CUSTOMERS,
      status: {
        $in: [
          DATA_IMPORT_STATUS.UPLOADED,
          DATA_IMPORT_STATUS.VALIDATED,
          DATA_IMPORT_STATUS.FAILED,
        ],
      },
    },
    {
      $set: {
        status: DATA_IMPORT_STATUS.VALIDATING,
        lastError: null,
        completedAt: null,
      },
    },
    { returnDocument: "after" },
  ).lean();
  if (!session) {
    const existing = await getTenantImportSession({ tenantId, sessionId });
    conflict({
      message: "This import can no longer be validated.",
      code: "IMPORT_STATE_INVALID",
      details: { status: existing.status },
    });
  }

  try {
    const rows = await DataImportRowModel.find({
      tenant: tenantId,
      session: sessionObjectId,
    })
      .sort({ rowNumber: 1 })
      .lean();
    const existingUsers = (await UserModel.find({ tenant: tenantId })
      .select(
        "_id email phone memberNumber updatedAt +importMetadata +tenantRole +roles",
      )
      .lean()) as ExistingCustomer[];
    const protectedMemberships = await TenantMembershipModel.find({
      tenant: tenantId,
      user: { $in: existingUsers.map((user) => user._id) },
    })
      .select("user")
      .lean();
    const protectedIds = new Set([
      ...protectedMemberships.map((membership: any) => String(membership.user)),
      ...existingUsers
        .filter(isProtectedWorkspaceUser)
        .map((user) => String(user._id)),
    ]);
    const indexes = buildExistingIndexes(existingUsers);
    const fileKeys = new Map<string, number>();
    const fileMemberNumbers = new Map<number, number>();
    const credentialRowNumbers = new Set(
      credentialRows.map((credential) => Number(credential.rowNumber)),
    );
    const operations: any[] = [];
    const summary = {
      total: rows.length,
      valid: 0,
      warnings: 0,
      invalid: 0,
      duplicates: 0,
      toCreate: 0,
      toUpdate: 0,
      toSkip: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      memberNumberCollisions: 0,
      memberNumberReassignments: 0,
    };

    for (const row of rows) {
      const normalized = normalizeCustomerImportRow(
        row.raw as Record<string, string>,
        mapping,
      );
      const passwordHashRedacted = Boolean(
        mapping.passwordHash &&
          row.raw?.[mapping.passwordHash] === CUSTOMER_PASSWORD_REDACTED_VALUE,
      );
      normalized.passwordHashProvided =
        passwordHashRedacted && credentialRowNumbers.has(row.rowNumber);
      const issues: ImportIssue[] = validateCustomerImportRow(normalized);
      if (passwordHashRedacted && !normalized.passwordHashProvided) {
        issues.push({
          code: "CUSTOMER_PASSWORD_HASH_EXPIRED",
          field: "passwordHash",
          severity: "error",
          message:
            "The staged legacy password hash expired. Upload the file again.",
        });
      }
      let duplicate: CustomerDuplicate | null = null;

      const existing = findExistingDuplicate(normalized, indexes);
      const existingUser = existing.duplicate?.existingUserId
        ? existingUsers.find(
            (user) =>
              String(user._id) === String(existing.duplicate?.existingUserId),
          )
        : null;
      if (isRolledBackImportRecord(existingUser))
        issues.push({ ...rolledBackImportIssue });
      if (existing.conflict) {
        issues.push({
          code: "CUSTOMER_IDENTITY_CONFLICT",
          severity: "error",
          message: "The identifiers match different or ambiguous customers.",
        });
      }

      const fileIdentityKeys = customerFileIdentityKeys(normalized);
      const initiallyInvalid = issues.some(
        (issue) => issue.severity === "error",
      );
      if (!initiallyInvalid && fileIdentityKeys.length) {
        const earlierRows = new Set(
          fileIdentityKeys
            .map((key) => fileKeys.get(key.kind + ":" + key.value))
            .filter((value): value is number => value !== undefined),
        );
        if (earlierRows.size > 1) {
          issues.push({
            code: "CUSTOMER_IDENTITY_CONFLICT",
            severity: "error",
            message: "The identifiers match different customers in this file.",
          });
        } else if (earlierRows.size === 1) {
          duplicate = { kind: "file", rowNumber: [...earlierRows][0] };
          issues.push({
            code: "CUSTOMER_DUPLICATE_IN_FILE",
            severity: "warning",
            message: "This customer already appears earlier in the file.",
          });
        }
        if (earlierRows.size <= 1) {
          const identityRow = duplicate?.rowNumber || row.rowNumber;
          for (const key of fileIdentityKeys) {
            const composite = key.kind + ":" + key.value;
            if (!fileKeys.has(composite)) fileKeys.set(composite, identityRow);
          }
        }
      }

      if (!duplicate && !existing.conflict) {
        duplicate = existing.duplicate;
      }
      if (
        existing.duplicate?.existingUserId &&
        protectedIds.has(String(existing.duplicate.existingUserId))
      ) {
        issues.push({
          code: "CUSTOMER_WORKSPACE_ACCOUNT_PROTECTED",
          severity: "error",
          message: "A workspace team account cannot be changed by an import.",
        });
      }
      if (existing.duplicate?.existingUserId && normalized.passwordHashProvided) {
        issues.push({
          code: "CUSTOMER_PASSWORD_HASH_SKIPPED_EXISTING",
          field: "passwordHash",
          severity: "warning",
          message:
            "The existing customer's password will not be changed by this import.",
        });
      }

      const memberNumberRowWillBeSkipped = Boolean(
        duplicate?.kind === "file" ||
          (existing.duplicate?.existingUserId &&
            duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP),
      );
      const memberNumberRowIsExecutable =
        !memberNumberRowWillBeSkipped &&
        !issues.some((issue) => issue.severity === "error");
      if (normalized.memberNumber && memberNumberRowIsExecutable) {
        const earlierMemberNumberRow = fileMemberNumbers.get(
          normalized.memberNumber,
        );
        if (earlierMemberNumberRow !== undefined) {
          issues.push({
            code: "CUSTOMER_MEMBER_NUMBER_DUPLICATE_IN_FILE",
            field: "memberNumber",
            severity: "error",
            message: `Member number ${normalized.memberNumber} is already requested by row ${earlierMemberNumberRow}.`,
          });
        } else {
          fileMemberNumbers.set(normalized.memberNumber, row.rowNumber);

          const targetId = existing.duplicate?.existingUserId
            ? String(existing.duplicate.existingUserId)
            : null;
          const target = targetId
            ? existingUsers.find((user) => String(user._id) === targetId)
            : null;
          const owner = indexes.memberNumbers.get(normalized.memberNumber);
          const ownerId = owner ? String(owner._id) : null;
          const targetOwnsRequestedNumber = Boolean(
            ownerId && targetId && ownerId === targetId,
          );

          if (
            target &&
            Number.isSafeInteger(Number(target.memberNumber)) &&
            Number(target.memberNumber) > 0 &&
            !preserveImportedMemberNumbers
          ) {
            normalized.memberNumberResolution = "keep_existing";
            if (Number(target.memberNumber) !== normalized.memberNumber) {
              issues.push({
                code: "CUSTOMER_MEMBER_NUMBER_KEPT_EXISTING",
                field: "memberNumber",
                severity: "warning",
                message:
                  "The existing customer keeps their current member number unless preservation mode is enabled.",
              });
            }
          } else if (!owner || targetOwnsRequestedNumber) {
            normalized.memberNumberResolution = "requested";
          } else {
            summary.memberNumberCollisions += 1;
            normalized.memberNumberOwnerId = ownerId || undefined;
            normalized.memberNumberOwnerUpdatedAt = owner?.updatedAt
              ? new Date(owner.updatedAt).toISOString()
              : undefined;
            const ownerIsProtected = Boolean(
              ownerId && protectedIds.has(ownerId),
            );
            if (preserveImportedMemberNumbers && !ownerIsProtected) {
              normalized.memberNumberResolution = "displace_customer";
              summary.memberNumberReassignments += 1;
              issues.push({
                code: "CUSTOMER_MEMBER_NUMBER_OWNER_WILL_BE_REASSIGNED",
                field: "memberNumber",
                severity: "warning",
                message:
                  "Another customer currently owns this member number and will receive the next available number.",
              });
            } else {
              normalized.memberNumberResolution = "allocate_collision";
              issues.push({
                code: ownerIsProtected
                  ? "CUSTOMER_MEMBER_NUMBER_PROTECTED_OWNER"
                  : "CUSTOMER_MEMBER_NUMBER_COLLISION",
                field: "memberNumber",
                severity: "warning",
                message: ownerIsProtected
                  ? "This number belongs to a workspace account and cannot be reassigned; the imported customer will receive the next available number."
                  : "This number already belongs to another customer; the imported customer will receive the next available number.",
              });
            }
          }
        }
      }

      const invalid = issues.some((issue) => issue.severity === "error");
      if (invalid) summary.invalid += 1;
      else summary.valid += 1;
      if (issues.some((issue) => issue.severity === "warning"))
        summary.warnings += 1;
      if (duplicate) {
        summary.duplicates += 1;
        if (
          duplicate.kind === "file" ||
          duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
        ) {
          summary.toSkip += Number(!invalid);
        } else {
          summary.toUpdate += Number(!invalid);
        }
      } else {
        summary.toCreate += Number(!invalid);
      }

      operations.push({
        updateOne: {
          filter: { _id: row._id, tenant: tenantId, session: sessionObjectId },
          update: {
            $set: {
              normalized,
              issues,
              duplicate,
              status: invalid
                ? DATA_IMPORT_ROW_STATUS.INVALID
                : DATA_IMPORT_ROW_STATUS.VALID,
              resultUser: null,
              resultMessage: null,
            },
          },
        },
      });
    }
    if (operations.length) {
      await DataImportRowModel.bulkWrite(operations, { ordered: false });
    }

    const validationRevision = createHash("sha256")
      .update(
        JSON.stringify({
          fileHash: session.fileHash,
          mapping,
          duplicateStrategy,
          credentialImportConfirmed: credentialRows.length > 0,
          preserveImportedMemberNumbers,
        }),
      )
      .digest("hex");
    const updated = await DataImportSessionModel.findOneAndUpdate(
      {
        _id: sessionObjectId,
        tenant: tenantId,
        status: DATA_IMPORT_STATUS.VALIDATING,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.VALIDATED,
          mapping,
          duplicateStrategy,
          validationRevision,
          credentialImportConfirmed: credentialRows.length > 0,
          credentialImportConfirmedBy: credentialRows.length ? actorId : null,
          credentialImportConfirmedAt: credentialRows.length
            ? new Date()
            : null,
          preserveImportedMemberNumbers,
          summary,
        },
      },
      { returnDocument: "after" },
    ).lean();
    if (!updated) {
      conflict({
        message: "Import validation state changed unexpectedly.",
        code: "IMPORT_STATE_CONFLICT",
      });
    }
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "validated",
      metadata: {
        duplicateStrategy,
        valid: summary.valid,
        invalid: summary.invalid,
        duplicates: summary.duplicates,
        preserveImportedMemberNumbers,
        memberNumberCollisions: summary.memberNumberCollisions,
        memberNumberReassignments: summary.memberNumberReassignments,
      },
    });
    return serializeImportSession(updated);
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : "Import validation failed."
    ).slice(0, 1_000);
    await DataImportSessionModel.updateOne(
      {
        _id: sessionObjectId,
        tenant: tenantId,
        status: DATA_IMPORT_STATUS.VALIDATING,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.FAILED,
          lastError: {
            code: "IMPORT_VALIDATION_FAILED",
            message,
          },
        },
      },
    );
    throw error;
  }
};

export const listImportRows = async ({
  tenantId,
  sessionId,
  page = 1,
  limit = DATA_IMPORT_LIMITS.PREVIEW_ROWS,
}: {
  tenantId: string;
  sessionId: string;
  page?: number;
  limit?: number;
}) => {
  const session = await getTenantImportSession({ tenantId, sessionId });
  const boundedPage = Math.max(1, Number(page) || 1);
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const filter = {
    tenant: tenantId,
    session: ensureObjectId(sessionId),
  };
  const [rows, total] = await Promise.all([
    DataImportRowModel.find(filter)
      .sort({ rowNumber: 1 })
      .skip((boundedPage - 1) * boundedLimit)
      .limit(boundedLimit)
      .lean(),
    DataImportRowModel.countDocuments(filter),
  ]);
  return {
    session: serializeImportSession(session),
    rows: rows.map((row: any) => ({
      id: String(row._id),
      rowNumber: row.rowNumber,
      raw: row.raw,
      normalized: row.normalized,
      issues: row.issues || [],
      duplicate: row.duplicate || null,
      status: row.status,
      resultMessage: row.resultMessage || null,
    })),
    pagination: {
      page: boundedPage,
      limit: boundedLimit,
      total,
      pages: Math.max(1, Math.ceil(total / boundedLimit)),
    },
  };
};
