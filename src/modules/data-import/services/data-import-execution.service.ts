import { createHash, randomUUID } from "node:crypto";

import mongoose from "mongoose";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";
import {
  LEGACY_ROLE,
  PLATFORM_ROLE,
  TENANT_ROLE,
} from "@/modules/user/user.constants.js";
import { transitionUserMemberNumber } from "@/modules/user/user-member-number.assignment.service.js";
import {
  allocateUserMemberNumber,
  assertUserMemberNumberAllocationEpoch,
  readUserMemberNumberAllocationEpoch,
  ensureUserMemberNumberCounterAtLeast,
  isValidUserMemberNumber,
  USER_MEMBER_NUMBER_HISTORY_REASON,
} from "@/modules/user/user-member-number.service.js";
import UserModel from "@/modules/user/user.model.js";
import { tenantHasModule } from "@/shared/middleware/tenantFeatures.js";
import { emitImportTerminalNotification } from "@/modules/workspace-notifications/workspace-notification.business-events.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_ROW_STATUS,
  DATA_IMPORT_STATUS,
} from "../data-import.constants.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import DataImportCredentialModel from "../data-import-credential.model.js";
import type { NormalizedCustomerImportRow } from "../data-import.types.js";
import {
  isProtectedWorkspaceUser,
  isSupportedCustomerPasswordHash,
  normalizeImportPhone,
} from "../adapters/customer-import.adapter.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import {
  importMutationOperation,
  recordDataImportMutation,
} from "./data-import-mutation.service.js";
import { completeImportWithRollbackAvailability } from "./data-import-rollback-availability.service.js";
import { assertImportRecordNotRolledBack } from "./data-import-rollback-marker.service.js";
import { assertCommerceImportReady } from "./commerce-import-readiness.service.js";

const CUSTOMER_CREATE_FIELDS = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "memberNumber",
  "memberNumberHistory",
  "isAccessGranted",
  "importMetadata",
] as const;

const LEASE_MS = 5 * 60_000;

const CUSTOMER_MATCH_FIELDS =
  "_id firstname lastname email phone memberNumber updatedAt " +
  "+importMetadata +memberNumberHistory +tenantRole +roles";

type CustomerPhoneIndex = Map<string, any[]>;

const safeErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : "Customer import failed.").slice(
    0,
    1_000,
  );

const assertCustomerExecutionAccess = async (
  tenantId: string,
  actorId: string,
): Promise<void> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database connection is unavailable.");
  const [access, tenant] = await Promise.all([
    resolveWorkspaceAccessForUser({ tenantId, userId: actorId }),
    db
      .collection("tenants")
      .findOne(
        { _id: new mongoose.Types.ObjectId(tenantId) },
        { projection: { modules: 1, plan: 1, planVersion: 1 } },
      ),
    assertCommerceImportReady(DATA_IMPORT_ENTITY.CUSTOMERS),
  ]);
  if (
    !access ||
    access.status !== "active" ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.CUSTOMERS_IMPORT)
  )
    throw new Error(
      "The queued actor no longer has customer import permission.",
    );
  if (!tenant || !tenantHasModule(tenant as never, "customers" as never))
    throw new Error("The customers module is no longer enabled.");
};

const loadCustomerPhoneIndex = async (
  tenantId: string,
): Promise<CustomerPhoneIndex> => {
  const candidates = await UserModel.find({
    tenant: tenantId,
    phone: { $nin: ["", null] },
  })
    .select(CUSTOMER_MATCH_FIELDS)
    .session(null)
    .lean();
  const index: CustomerPhoneIndex = new Map();

  for (const candidate of candidates) {
    const phone = normalizeImportPhone(String(candidate.phone || ""));
    if (!phone) continue;
    index.set(phone, [...(index.get(phone) || []), candidate]);
  }

  return index;
};

const findCurrentMatch = async ({
  tenantId,
  normalized,
  phoneIndex,
  transaction = null,
}: {
  tenantId: string;
  normalized: NormalizedCustomerImportRow;
  phoneIndex: CustomerPhoneIndex;
  transaction?: mongoose.ClientSession | null;
}) => {
  const conditions: Record<string, unknown>[] = [];
  if (normalized.externalId) {
    conditions.push({ "importMetadata.externalId": normalized.externalId });
  }
  if (normalized.email) conditions.push({ email: normalized.email });
  if (normalized.phone) conditions.push({ phone: normalized.phone });
  if (!conditions.length) return { user: null, conflict: false };

  const direct = await UserModel.find({
    tenant: tenantId,
    $or: conditions,
  })
    .select(CUSTOMER_MATCH_FIELDS)
    .session(transaction)
    .lean();

  if (normalized.phone) {
    for (const candidate of phoneIndex.get(normalized.phone) || []) {
      if (!direct.some((user) => String(user._id) === String(candidate._id))) {
        direct.push(candidate as never);
      }
    }
  }
  const byId = new Map(direct.map((user) => [String(user._id), user]));
  if (byId.size > 1) return { user: null, conflict: true };
  return { user: [...byId.values()][0] || null, conflict: false };
};

const protectWorkspaceIdentity = async ({
  tenantId,
  userId,
  transaction = null,
}: {
  tenantId: string;
  userId: mongoose.Types.ObjectId;
  transaction?: mongoose.ClientSession | null;
}) =>
  Boolean(
    await TenantMembershipModel.exists({
      tenant: tenantId,
      user: userId,
    }).session(transaction),
  );

type MemberNumberDisplacement = {
  targetId: mongoose.Types.ObjectId;
  requestedMemberNumber: number;
  replacementMemberNumber: number;
  beforeRecord: unknown;
  afterRecord: unknown;
};

type ImportedMemberNumberPlan = {
  memberNumber?: number;
  applyToExistingCustomer: boolean;
  displacement?: MemberNumberDisplacement;
};

const currentMemberNumberOf = (record: unknown): number | null => {
  const value = Number(
    (record as { memberNumber?: unknown } | null)?.memberNumber,
  );
  return isValidUserMemberNumber(value) ? value : null;
};

const allocateAvailableMemberNumber = async ({
  tenantId,
  minimum,
  transaction,
  expectedEpoch,
}: {
  tenantId: string;
  minimum: number;
  transaction: mongoose.ClientSession;
  expectedEpoch: number;
}): Promise<number> => {
  let floor = minimum;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = await allocateUserMemberNumber({
      tenantId,
      minimum: floor,
      session: transaction,
      expectedEpoch,
    });
    const occupied = await UserModel.exists({
      tenant: tenantId,
      memberNumber: candidate,
    }).session(transaction);
    if (!occupied) return candidate;
    floor = candidate;
  }
  throw new Error("A unique member number could not be allocated.");
};

const planImportedMemberNumber = async ({
  tenantId,
  actorId,
  sessionId,
  preserveImportedMemberNumbers,
  normalized,
  target,
  transaction,
  expectedEpoch,
}: {
  tenantId: string;
  actorId: string;
  sessionId: string;
  preserveImportedMemberNumbers: boolean;
  normalized: NormalizedCustomerImportRow;
  target: any | null;
  transaction: mongoose.ClientSession;
  expectedEpoch: number;
}): Promise<ImportedMemberNumberPlan> => {
  const requestedMemberNumber = Number(normalized.memberNumber);
  if (!isValidUserMemberNumber(requestedMemberNumber)) {
    return { applyToExistingCustomer: false };
  }

  const targetMemberNumber = currentMemberNumberOf(target);
  if (
    target &&
    targetMemberNumber !== null &&
    normalized.memberNumberResolution === "keep_existing"
  ) {
    return { applyToExistingCustomer: false };
  }

  const owner = await UserModel.findOne({
    tenant: tenantId,
    memberNumber: requestedMemberNumber,
  })
    .select("_id memberNumber")
    .session(transaction)
    .lean();
  const targetId = target ? String(target._id) : null;
  if (owner && targetId && String(owner._id) === targetId) {
    await ensureUserMemberNumberCounterAtLeast({
      tenantId,
      minimum: requestedMemberNumber,
      session: transaction,
      expectedEpoch,
    });
    return {
      memberNumber: requestedMemberNumber,
      applyToExistingCustomer: false,
    };
  }

  const displacementWasConfirmed =
    preserveImportedMemberNumbers &&
    normalized.memberNumberResolution === "displace_customer";
  if (owner && displacementWasConfirmed) {
    if (
      !normalized.memberNumberOwnerId ||
      String(owner._id) !== String(normalized.memberNumberOwnerId)
    ) {
      throw new Error(
        "Member-number ownership changed during import execution. Validate again.",
      );
    }
    const replacementMemberNumber = await allocateAvailableMemberNumber({
      tenantId,
      minimum: requestedMemberNumber,
      transaction,
      expectedEpoch,
    });
    const displaced = await transitionUserMemberNumber({
      tenantId,
      userId: owner._id,
      nextMemberNumber: replacementMemberNumber,
      expectedMemberNumber: requestedMemberNumber,
      reason: USER_MEMBER_NUMBER_HISTORY_REASON.CUSTOMER_IMPORT_CONFLICT,
      importSessionId: sessionId,
      changedBy: actorId,
      session: transaction,
      expectedEpoch,
    });
    return {
      memberNumber: requestedMemberNumber,
      applyToExistingCustomer: Boolean(
        target && targetMemberNumber !== requestedMemberNumber,
      ),
      displacement: {
        targetId: owner._id,
        requestedMemberNumber,
        replacementMemberNumber,
        beforeRecord: displaced.beforeRecord,
        afterRecord: displaced.afterRecord,
      },
    };
  }

  if (
    owner &&
    preserveImportedMemberNumbers &&
    normalized.memberNumberResolution !== "allocate_collision"
  ) {
    throw new Error(
      "The requested member number became occupied after validation. Validate again.",
    );
  }

  if (owner || normalized.memberNumberResolution === "allocate_collision") {
    const memberNumber = await allocateAvailableMemberNumber({
      tenantId,
      minimum: requestedMemberNumber,
      transaction,
      expectedEpoch,
    });
    return {
      memberNumber,
      applyToExistingCustomer: Boolean(
        target && targetMemberNumber !== memberNumber,
      ),
    };
  }

  await ensureUserMemberNumberCounterAtLeast({
    tenantId,
    minimum: requestedMemberNumber,
    session: transaction,
    expectedEpoch,
  });
  return {
    memberNumber: requestedMemberNumber,
    applyToExistingCustomer: Boolean(
      target && targetMemberNumber !== requestedMemberNumber,
    ),
  };
};

const createImportedCustomer = async ({
  tenantId,
  actorId,
  sessionId,
  rowNumber,
  fileType,
  normalized,
  memberNumber,
  credentialImportConfirmed,
  transaction,
}: {
  tenantId: string;
  actorId: string;
  sessionId: string;
  rowNumber: number;
  fileType: "csv" | "xlsx";
  normalized: NormalizedCustomerImportRow;
  memberNumber?: number;
  credentialImportConfirmed: boolean;
  transaction: mongoose.ClientSession;
}) => {
  const importKey = sessionId + ":" + rowNumber;
  const existing = await UserModel.findOne({
    tenant: tenantId,
    "importMetadata.importKey": importKey,
  })
    .select("+memberNumberHistory")
    .session(transaction);
  if (existing) return { record: existing, importedPasswordHashDigest: null };

  const created = await UserModel.create(
    [
      {
        tenant: tenantId,
        firstname: normalized.firstname,
        lastname: normalized.lastname,
        ...(normalized.email ? { email: normalized.email } : {}),
        phone: normalized.phone || "",
        ...(memberNumber ? { memberNumber } : {}),
        customId:
          "IMP-" + randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase(),
        tenantRole: TENANT_ROLE.CUSTOMER,
        platformRole: PLATFORM_ROLE.NONE,
        roles: [LEGACY_ROLE.CUSTOMER],
        importMetadata: {
          source: fileType,
          importId: sessionId,
          importKey,
          externalId: normalized.externalId || "",
          importedAt: new Date(),
          importedBy: actorId,
        },
      },
    ],
    { session: transaction },
  );
  if (!normalized.passwordHashProvided)
    return { record: created[0], importedPasswordHashDigest: null };
  if (!credentialImportConfirmed)
    throw new Error("Legacy password hash import was not confirmed.");

  const credential = await DataImportCredentialModel.findOne({
    tenant: tenantId,
    session: sessionId,
    rowNumber,
  })
    .select("+passwordHash")
    .session(transaction)
    .lean();
  const passwordHash = String(credential?.passwordHash || "");
  if (!isSupportedCustomerPasswordHash(passwordHash))
    throw new Error(
      "The staged legacy password hash is unavailable or unsupported.",
    );

  const migrated = await UserModel.findOneAndUpdate(
    {
      _id: created[0]._id,
      tenant: tenantId,
      password: { $exists: false },
    },
    { $set: { password: passwordHash } },
    {
      returnDocument: "after",
      runValidators: true,
      session: transaction,
      timestamps: false,
    },
  ).select("+password +importMetadata +memberNumberHistory");
  if (!migrated)
    throw new Error("The imported customer password could not be initialized.");
  return {
    record: migrated,
    importedPasswordHashDigest: createHash("sha256")
      .update(passwordHash)
      .digest("hex"),
  };
};

const updateImportedCustomer = async ({
  tenantId,
  actorId,
  sessionId,
  fileType,
  userId,
  expectedUpdatedAt,
  normalized,
  nextMemberNumber,
  transaction,
  expectedEpoch,
}: {
  tenantId: string;
  actorId: string;
  sessionId: string;
  fileType: "csv" | "xlsx";
  userId: mongoose.Types.ObjectId;
  expectedUpdatedAt: Date;
  normalized: NormalizedCustomerImportRow;
  nextMemberNumber?: number;
  transaction: mongoose.ClientSession;
  expectedEpoch: number;
}) => {
  const set: Record<string, unknown> = {
    "importMetadata.source": fileType,
    "importMetadata.importId": sessionId,
    "importMetadata.importedAt": new Date(),
    "importMetadata.importedBy": actorId,
  };
  if (normalized.firstname) set.firstname = normalized.firstname;
  if (normalized.lastname) set.lastname = normalized.lastname;
  if (normalized.email) set.email = normalized.email;
  if (normalized.phone) set.phone = normalized.phone;
  if (normalized.externalId) {
    set["importMetadata.externalId"] = normalized.externalId;
  }
  const updated = await UserModel.findOneAndUpdate(
    { _id: userId, tenant: tenantId, updatedAt: expectedUpdatedAt },
    { $set: set },
    { returnDocument: "after", runValidators: true, session: transaction },
  ).select("+importMetadata +memberNumberHistory");
  if (!updated) throw new Error("Customer changed during import execution.");
  const affectedFields = Object.keys(set);
  if (nextMemberNumber && currentMemberNumberOf(updated) !== nextMemberNumber) {
    await transitionUserMemberNumber({
      tenantId,
      userId,
      nextMemberNumber,
      expectedMemberNumber: currentMemberNumberOf(updated),
      reason: USER_MEMBER_NUMBER_HISTORY_REASON.CUSTOMER_IMPORT_ASSIGNMENT,
      importSessionId: sessionId,
      changedBy: actorId,
      session: transaction,
      expectedEpoch,
    });
    affectedFields.push("memberNumber", "memberNumberHistory");
  }
  const record = await UserModel.findOne({ _id: userId, tenant: tenantId })
    .select("+importMetadata +memberNumberHistory")
    .session(transaction);
  if (!record) throw new Error("Customer disappeared during import execution.");
  return { record, affectedFields };
};

const markRow = (
  rowId: mongoose.Types.ObjectId,
  status: string,
  resultUser: any,
  resultMessage: string,
) =>
  DataImportRowModel.updateOne(
    { _id: rowId },
    {
      $set: {
        status,
        resultUser,
        resultMessage,
      },
    },
  );

const recordCustomerMemberNumberDisplacement = async ({
  tenantId,
  sessionId,
  rowId,
  rowNumber,
  actorId,
  importedCustomerId,
  displacement,
  transaction,
}: {
  tenantId: string;
  sessionId: string;
  rowId: mongoose.Types.ObjectId;
  rowNumber: number;
  actorId: string;
  importedCustomerId: mongoose.Types.ObjectId;
  displacement?: MemberNumberDisplacement;
  transaction: mongoose.ClientSession;
}): Promise<void> => {
  if (!displacement) return;
  await recordDataImportMutation({
    tenantId,
    sessionId,
    rowId,
    rowNumber,
    entityType: DATA_IMPORT_ENTITY.CUSTOMERS,
    mutationKey:
      `${sessionId}:${rowNumber}:member-number-displacement:` +
      String(displacement.targetId),
    operation: importMutationOperation.UPDATE,
    importOutcome: "updated",
    importMessage: "Conflicting customer member number reassigned.",
    isCanonicalResult: false,
    targetId: displacement.targetId,
    affectedFields: ["memberNumber", "memberNumberHistory"],
    beforeRecord: displacement.beforeRecord,
    afterRecord: displacement.afterRecord,
    delta: {
      kind: "customer_member_number_displacement",
      importedCustomerId: String(importedCustomerId),
      requestedMemberNumber: displacement.requestedMemberNumber,
      replacementMemberNumber: displacement.replacementMemberNumber,
    },
    actorId,
    transaction,
  });
};

export const processCustomerImportSession = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const claimToken = randomUUID();
  const now = new Date();
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: sessionId,
      tenant: tenantId,
      "lastError.code": {
        $nin: [
          "MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED",
          "MEMBER_NUMBER_ALLOCATION_PAUSED",
        ],
      },
      $or: [
        { status: DATA_IMPORT_STATUS.QUEUED },
        { status: DATA_IMPORT_STATUS.FAILED },
        {
          status: DATA_IMPORT_STATUS.PROCESSING,
          leaseExpiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: DATA_IMPORT_STATUS.PROCESSING,
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        claimToken,
        lastError: null,
      },
    },
    { returnDocument: "after" },
  )
    .select("+claimToken")
    .lean();
  if (!session) return { skipped: true, reason: "not_claimable" };

  try {
    const executionActorId = String(session.queuedBy || session.createdBy);
    await assertCustomerExecutionAccess(tenantId, executionActorId);
    // Explicit imported IDs remain intentional, but one execution must not
    // reuse a pre-repair plan after the allocation namespace changes.
    const expectedEpoch = await readUserMemberNumberAllocationEpoch({
      tenantId,
    });
    const [rows, phoneIndex] = await Promise.all([
      DataImportRowModel.find({
        tenant: tenantId,
        session: session._id,
        status: {
          $in: [
            DATA_IMPORT_ROW_STATUS.VALID,
            DATA_IMPORT_ROW_STATUS.PROCESSING,
          ],
        },
      }).sort({ rowNumber: 1 }),
      loadCustomerPhoneIndex(tenantId),
    ]);

    // Reserve the complete imported range before resolving any collision.
    // Otherwise displacing the owner of #5 could allocate #6 even though a
    // later validated row still needs to preserve imported number #6.
    const maximumRequestedMemberNumber = rows.reduce((maximum, row) => {
      if (
        row.duplicate?.kind === "file" ||
        (row.duplicate?.existingUserId &&
          session.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP)
      ) {
        return maximum;
      }
      const requested = Number(
        (row.normalized as unknown as NormalizedCustomerImportRow | undefined)
          ?.memberNumber,
      );
      return isValidUserMemberNumber(requested)
        ? Math.max(maximum, requested)
        : maximum;
    }, 0);
    if (maximumRequestedMemberNumber > 0) {
      await ensureUserMemberNumberCounterAtLeast({
        tenantId,
        minimum: maximumRequestedMemberNumber,
        expectedEpoch,
      });
    }

    for (let index = 0; index < rows.length; index += 1) {
      await assertUserMemberNumberAllocationEpoch({ tenantId, expectedEpoch });
      if (index === 0 || index % 100 === 0) {
        await assertCustomerExecutionAccess(tenantId, executionActorId);
        const heartbeat = await DataImportSessionModel.updateOne(
          { _id: session._id, tenant: tenantId, claimToken },
          { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
        );
        if (heartbeat.matchedCount !== 1)
          throw new Error("Customer import execution lease was lost.");
      }
      const row = rows[index];
      const claimed = await DataImportRowModel.findOneAndUpdate(
        {
          _id: row._id,
          tenant: tenantId,
          session: session._id,
          status: {
            $in: [
              DATA_IMPORT_ROW_STATUS.VALID,
              DATA_IMPORT_ROW_STATUS.PROCESSING,
            ],
          },
        },
        { $set: { status: DATA_IMPORT_ROW_STATUS.PROCESSING } },
        { returnDocument: "after" },
      );
      if (!claimed) continue;

      try {
        const committed = await DataImportMutationModel.findOne({
          tenant: tenantId,
          session: session._id,
          row: claimed._id,
          isCanonicalResult: true,
        }).lean();
        if (committed) {
          await markRow(
            claimed._id,
            committed.importOutcome === "created"
              ? DATA_IMPORT_ROW_STATUS.CREATED
              : DATA_IMPORT_ROW_STATUS.UPDATED,
            committed.target,
            committed.importMessage,
          );
          continue;
        }
        const normalized =
          claimed.normalized as unknown as NormalizedCustomerImportRow;
        if (claimed.duplicate?.kind === "file") {
          await markRow(
            claimed._id,
            DATA_IMPORT_ROW_STATUS.SKIPPED,
            null,
            "Duplicate row in the uploaded file.",
          );
          continue;
        }

        const match = await findCurrentMatch({
          tenantId,
          normalized,
          phoneIndex,
        });
        assertImportRecordNotRolledBack(match.user);
        if (match.conflict) {
          await markRow(
            claimed._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            "Customer identifiers now match multiple records.",
          );
          continue;
        }
        if (
          match.user &&
          (isProtectedWorkspaceUser(match.user) ||
            (await protectWorkspaceIdentity({
              tenantId,
              userId: match.user._id,
            })))
        ) {
          await markRow(
            claimed._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            "A workspace team account cannot be changed by an import.",
          );
          continue;
        }
        if (
          match.user &&
          session.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
        ) {
          await markRow(
            claimed._id,
            DATA_IMPORT_ROW_STATUS.SKIPPED,
            match.user._id,
            "Existing customer skipped.",
          );
          continue;
        }

        const transaction = await mongoose.startSession();
        try {
          let outcome: {
            action: "created" | "updated";
            recordId: mongoose.Types.ObjectId;
            message: string;
          } | null = null;
          await transaction.withTransaction(async () => {
            await assertUserMemberNumberAllocationEpoch({
              tenantId,
              expectedEpoch,
              session: transaction,
            });
            const current = await findCurrentMatch({
              tenantId,
              normalized,
              phoneIndex,
              transaction,
            });
            if (current.conflict)
              throw new Error("Customer identity changed during execution.");
            assertImportRecordNotRolledBack(current.user);
            if (match.user) {
              if (
                !current.user ||
                String(current.user._id) !== String(match.user._id)
              )
                throw new Error("Customer identity changed during execution.");
              if (
                isProtectedWorkspaceUser(current.user) ||
                (await protectWorkspaceIdentity({
                  tenantId,
                  userId: current.user._id,
                  transaction,
                }))
              )
                throw new Error(
                  "A workspace team account cannot be changed by an import.",
                );
              const memberNumberPlan = await planImportedMemberNumber({
                expectedEpoch,
                tenantId,
                actorId: executionActorId,
                sessionId,
                preserveImportedMemberNumbers: Boolean(
                  session.preserveImportedMemberNumbers,
                ),
                normalized,
                target: current.user,
                transaction,
              });
              const updated = await updateImportedCustomer({
                expectedEpoch,
                tenantId,
                actorId: executionActorId,
                sessionId,
                fileType: session.fileType,
                userId: current.user._id,
                expectedUpdatedAt: new Date(current.user.updatedAt),
                normalized,
                nextMemberNumber: memberNumberPlan.applyToExistingCustomer
                  ? memberNumberPlan.memberNumber
                  : undefined,
                transaction,
              });
              await recordDataImportMutation({
                tenantId,
                sessionId,
                rowId: claimed._id,
                rowNumber: claimed.rowNumber,
                entityType: DATA_IMPORT_ENTITY.CUSTOMERS,
                mutationKey: `${sessionId}:${claimed.rowNumber}`,
                operation: importMutationOperation.UPDATE,
                importOutcome: "updated",
                importMessage: "Existing customer updated.",
                targetId: updated.record._id,
                affectedFields: updated.affectedFields,
                beforeRecord: current.user,
                afterRecord: updated.record,
                actorId: executionActorId,
                transaction,
              });
              await recordCustomerMemberNumberDisplacement({
                tenantId,
                sessionId,
                rowId: claimed._id,
                rowNumber: claimed.rowNumber,
                actorId: executionActorId,
                importedCustomerId: updated.record._id,
                displacement: memberNumberPlan.displacement,
                transaction,
              });
              outcome = {
                action: "updated",
                recordId: updated.record._id,
                message: "Existing customer updated.",
              };
              return;
            }
            if (current.user)
              throw new Error(
                "A matching customer was created after validation. Validate again.",
              );
            const memberNumberPlan = await planImportedMemberNumber({
              expectedEpoch,
              tenantId,
              actorId: executionActorId,
              sessionId,
              preserveImportedMemberNumbers: Boolean(
                session.preserveImportedMemberNumbers,
              ),
              normalized,
              target: null,
              transaction,
            });
            const created = await createImportedCustomer({
              tenantId,
              actorId: executionActorId,
              sessionId,
              rowNumber: claimed.rowNumber,
              fileType: session.fileType,
              normalized,
              memberNumber: memberNumberPlan.memberNumber,
              credentialImportConfirmed: Boolean(
                session.credentialImportConfirmed,
              ),
              transaction,
            });
            await recordDataImportMutation({
              tenantId,
              sessionId,
              rowId: claimed._id,
              rowNumber: claimed.rowNumber,
              entityType: DATA_IMPORT_ENTITY.CUSTOMERS,
              mutationKey: `${sessionId}:${claimed.rowNumber}`,
              operation: importMutationOperation.CREATE,
              importOutcome: "created",
              importMessage: "Customer created.",
              targetId: created.record._id,
              affectedFields: CUSTOMER_CREATE_FIELDS,
              beforeRecord: null,
              afterRecord: created.record,
              delta: created.importedPasswordHashDigest
                ? {
                    importedPasswordHashDigest:
                      created.importedPasswordHashDigest,
                  }
                : null,
              actorId: executionActorId,
              transaction,
            });
            await recordCustomerMemberNumberDisplacement({
              tenantId,
              sessionId,
              rowId: claimed._id,
              rowNumber: claimed.rowNumber,
              actorId: executionActorId,
              importedCustomerId: created.record._id,
              displacement: memberNumberPlan.displacement,
              transaction,
            });
            outcome = {
              action: "created",
              recordId: created.record._id,
              message: "Customer created.",
            };
          });
          if (!outcome) throw new Error("Customer import transaction failed.");
          await markRow(
            claimed._id,
            outcome.action === "created"
              ? DATA_IMPORT_ROW_STATUS.CREATED
              : DATA_IMPORT_ROW_STATUS.UPDATED,
            outcome.recordId,
            outcome.message,
          );
        } finally {
          await transaction.endSession();
        }
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (
          code === "MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED" ||
          code === "MEMBER_NUMBER_ALLOCATION_PAUSED"
        )
          throw error;
        await markRow(
          claimed._id,
          DATA_IMPORT_ROW_STATUS.FAILED,
          null,
          safeErrorMessage(error),
        );
      }

      if ((index + 1) % 100 === 0) {
        await DataImportSessionModel.updateOne(
          { _id: session._id, tenant: tenantId, claimToken },
          { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
        );
      }
    }

    const [created, updated, skipped, failed] = await Promise.all([
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.CREATED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.UPDATED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.SKIPPED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.FAILED,
      }),
    ]);
    await DataImportCredentialModel.deleteMany({
      tenant: tenantId,
      session: session._id,
    });
    await completeImportWithRollbackAvailability({
      tenantId,
      sessionId,
      claimToken,
      summary: { created, updated, skipped, failed },
    });
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId: executionActorId,
      action: "completed",
      metadata: { created, updated, skipped, failed },
    });
    emitImportTerminalNotification({
      tenantId,
      sessionId,
      recipientUserId: executionActorId,
      entityType: DATA_IMPORT_ENTITY.CUSTOMERS,
      status: "completed",
      summary: { created, updated, skipped, failed },
    });
    return { created, updated, skipped, failed };
  } catch (error) {
    const allocationCode = (error as { code?: string })?.code;
    const code =
      allocationCode === "MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED" ||
      allocationCode === "MEMBER_NUMBER_ALLOCATION_PAUSED"
        ? allocationCode
        : "IMPORT_EXECUTION_FAILED";
    await DataImportSessionModel.updateOne(
      { _id: session._id, tenant: tenantId, claimToken },
      {
        $set: {
          status: DATA_IMPORT_STATUS.FAILED,
          leaseExpiresAt: null,
          claimToken: null,
          lastError: {
            code,
            message: safeErrorMessage(error),
          },
        },
      },
    );
    const executionActorId = String(session.queuedBy || session.createdBy);
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId: executionActorId,
      action: "failed",
      metadata: { code },
    });
    throw error;
  }
};
