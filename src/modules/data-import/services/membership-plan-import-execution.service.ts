import mongoose from "mongoose";

import MembershipPlanModel from "@/modules/membership/membership-plan.model.js";
import MembershipPlanVersionModel from "@/modules/membership/membership-plan-version.model.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
} from "../data-import.constants.js";
import type { NormalizedMembershipPlanImportRow } from "../data-import.types.js";
import {
  canImportLocation,
  importMetadata,
  importObjectId,
  isImportDuplicateKey,
  loadCommerceImportGuard,
} from "./commerce-import-execution.utils.js";
import { processStagedImportSession } from "./staged-import-execution.service.js";
import {
  importMutationOperation,
  recordDataImportMutation,
} from "./data-import-mutation.service.js";
import { assertImportRecordNotRolledBack } from "./data-import-rollback-marker.service.js";

const PLAN_FIELDS = [
  "status",
  "currentPublishedVersion",
  "currentDraftVersion",
  "versionCounter",
  "sortOrder",
  "updatedBy",
  "publishedAt",
  "archivedAt",
  "importMetadata",
] as const;
const PLAN_VERSION_FIELDS = [
  "plan",
  "version",
  "status",
  "name",
  "description",
  "terms",
  "prices",
  "billing",
  "locationScope",
  "benefits",
] as const;

const exactInsensitive = (value: string) => ({
  $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  $options: "i",
});

const findPlan = async ({
  tenantId,
  normalized,
  existingRecordId,
  importKey,
  session = null,
}: {
  tenantId: string;
  normalized: NormalizedMembershipPlanImportRow;
  existingRecordId?: unknown;
  importKey: string;
  session?: mongoose.ClientSession | null;
}) => {
  const conditions: Record<string, unknown>[] = [
    { "importMetadata.importKey": importKey },
  ];
  if (existingRecordId) conditions.push({ _id: existingRecordId });
  if (normalized.externalId)
    conditions.push({ "importMetadata.externalId": normalized.externalId });
  if (normalized.fingerprint)
    conditions.push({ "importMetadata.fingerprint": normalized.fingerprint });
  if (normalized.name) {
    const versionIds = await MembershipPlanVersionModel.find({
      tenant: tenantId,
      status: "published",
      name: exactInsensitive(normalized.name),
    })
      .distinct("_id")
      .session(session);
    if (versionIds.length)
      conditions.push({ currentPublishedVersion: { $in: versionIds } });
  }
  const records = await MembershipPlanModel.find({
    tenant: tenantId,
    $or: conditions,
  })
    .select("+importMetadata")
    .session(session)
    .lean();
  const unique = new Map(
    records.map((record: any) => [String(record._id), record]),
  );
  if (unique.size > 1)
    throw new Error("Membership plan identity is ambiguous.");
  return [...unique.values()][0] || null;
};

const versionPayload = ({
  tenantId,
  planId,
  version,
  actorId,
  normalized,
}: {
  tenantId: string;
  planId: unknown;
  version: number;
  actorId: string;
  normalized: NormalizedMembershipPlanImportRow;
}) => ({
  tenant: importObjectId(tenantId),
  plan: planId,
  version,
  status: "published",
  name: normalized.name,
  description: normalized.description,
  terms: normalized.terms,
  prices: [
    {
      currency: normalized.currency,
      amountMinor: toCurrencyMinorUnits(
        Number(normalized.price),
        normalized.currency as StudioCommerceCurrency,
      ),
    },
  ],
  billing:
    normalized.billingType === "fixed"
      ? { type: "fixed", durationDays: normalized.durationDays }
      : {
          type: "recurring",
          interval: normalized.billingInterval,
          intervalCount: normalized.intervalCount,
        },
  locationScope: {
    type: normalized.locationScope,
    locationIds: (normalized.locationIds || []).map(importObjectId),
  },
  benefits: normalized.benefits || [],
  createdBy: importObjectId(actorId),
  publishedBy: importObjectId(actorId),
  publishedAt: new Date(),
});

const executeMembershipPlanRow = async ({
  tenantId,
  sessionId,
  actorId,
  session: importSession,
  row,
}: any) => {
  const normalized = row.normalized as NormalizedMembershipPlanImportRow;
  const guard = await loadCommerceImportGuard({
    tenantId,
    actorId,
    permission: WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
    moduleName: "memberships",
  });
  if (normalized.currency !== guard.currency)
    throw new Error("Workspace currency changed after validation.");
  if (
    normalized.locationScope === "all" &&
    guard.access.locationAccess.mode === "selected"
  ) {
    throw new Error("The queued actor cannot import an all-location plan.");
  }
  for (const id of normalized.locationIds || []) {
    if (!canImportLocation(guard.access, id))
      throw new Error(
        "The queued actor no longer has access to a plan location.",
      );
  }
  const importKey = `${sessionId}:${row.rowNumber}`;
  let record = await findPlan({
    tenantId,
    normalized,
    existingRecordId: row.duplicate?.existingRecordId,
    importKey,
  });
  if (record?.importMetadata?.lastMutationKey === importKey)
    return {
      action: "skipped" as const,
      recordId: record._id,
      message: "Membership plan row was already applied.",
    };
  if (
    record?.importMetadata?.externalId &&
    normalized.externalId &&
    record.importMetadata.externalId !== normalized.externalId
  )
    throw new Error(
      "Membership plan external identity changed after validation.",
    );
  if (
    record &&
    importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
  )
    return {
      action: "skipped" as const,
      recordId: record._id,
      message: "Existing membership plan skipped.",
    };
  if (record && (!record.importMetadata || record.status === "archived"))
    throw new Error(
      "Only an active import-owned membership plan can be updated.",
    );

  const transaction = await mongoose.startSession();
  try {
    let result: any;
    await transaction.withTransaction(async () => {
      const currentGuard = await loadCommerceImportGuard({
        tenantId,
        actorId,
        permission: WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
        moduleName: "memberships",
        session: transaction,
      });
      if (normalized.currency !== currentGuard.currency)
        throw new Error("Workspace currency changed after validation.");
      if (
        normalized.locationScope === "all" &&
        currentGuard.access.locationAccess.mode === "selected"
      )
        throw new Error("The queued actor cannot import an all-location plan.");
      for (const id of normalized.locationIds || [])
        if (!canImportLocation(currentGuard.access, id))
          throw new Error(
            "The queued actor no longer has access to a plan location.",
          );
      if ((normalized.locationIds || []).length) {
        const db = mongoose.connection.db;
        if (!db) throw new Error("Database connection is unavailable.");
        const count = await db.collection("locations").countDocuments(
          {
            tenant: importObjectId(tenantId),
            _id: { $in: normalized.locationIds!.map(importObjectId) },
          },
          { session: transaction },
        );
        if (count !== normalized.locationIds!.length)
          throw new Error(
            "A tenant-scoped plan location is no longer available.",
          );
      }
      const resolved = await findPlan({
        tenantId,
        normalized,
        existingRecordId: record?._id || row.duplicate?.existingRecordId,
        importKey,
        session: transaction,
      });
      if (resolved?.importMetadata?.lastMutationKey === importKey) {
        result = {
          action: "skipped" as const,
          recordId: resolved._id,
          message: "Membership plan row was already applied.",
        };
        return;
      }
      if (record && resolved && String(record._id) !== String(resolved._id))
        throw new Error("Membership plan identity changed after validation.");
      if (!record && resolved)
        throw new Error(
          "A matching membership plan was created after validation. Validate again.",
        );
      const current = record
        ? await MembershipPlanModel.findOne({
            _id: record._id,
            tenant: tenantId,
          })
            .select("+importMetadata")
            .session(transaction)
        : null;
      assertImportRecordNotRolledBack(current);
      if (
        record &&
        (!current || !current.importMetadata || current.status === "archived")
      )
        throw new Error(
          "Membership plan update protection changed after validation.",
        );
      if (
        current?.importMetadata?.externalId &&
        normalized.externalId &&
        current.importMetadata.externalId !== normalized.externalId
      )
        throw new Error(
          "Membership plan external identity changed after validation.",
        );
      if (
        current &&
        (Number(current.versionCounter) !== normalized.expectedVersionCounter ||
          String(current.currentPublishedVersion || "") !==
            String(normalized.expectedPublishedVersionId || "") ||
          (normalized.expectedUpdatedAt &&
            new Date(current.updatedAt).toISOString() !==
              normalized.expectedUpdatedAt))
      )
        throw new Error(
          "Membership plan changed after validation. Validate again.",
        );
      const now = new Date();
      if (!current) {
        const planId = new mongoose.Types.ObjectId();
        const version = await MembershipPlanVersionModel.create(
          [
            versionPayload({
              tenantId,
              planId,
              version: 1,
              actorId,
              normalized,
            }) as any,
          ],
          { session: transaction },
        );
        const created = await MembershipPlanModel.create(
          [
            {
              _id: planId,
              tenant: importObjectId(tenantId),
              status: normalized.status,
              currentPublishedVersion: version[0]._id,
              currentDraftVersion: null,
              versionCounter: 1,
              sortOrder: normalized.sortOrder ?? 0,
              createdBy: importObjectId(actorId),
              updatedBy: importObjectId(actorId),
              publishedAt: now,
              archivedAt: normalized.status === "archived" ? now : null,
              importMetadata: importMetadata({
                sessionId,
                rowNumber: row.rowNumber,
                actorId,
                fileType: importSession.fileType,
                externalId: normalized.externalId,
                fingerprint: String(normalized.fingerprint),
              }),
            },
          ] as any,
          { session: transaction },
        );
        await recordDataImportMutation({
          tenantId,
          sessionId,
          rowId: row._id,
          rowNumber: row.rowNumber,
          entityType: DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
          mutationKey: `${importKey}:plan`,
          operation: importMutationOperation.CREATE,
          importOutcome: "created",
          importMessage: "Membership plan imported.",
          targetId: created[0]._id,
          affectedFields: PLAN_FIELDS,
          beforeRecord: null,
          afterRecord: created[0],
          delta: {
            kind: "membership_plan",
            createdVersionId: version[0]._id,
          },
          actorId,
          transaction,
        });
        await recordDataImportMutation({
          tenantId,
          sessionId,
          rowId: row._id,
          rowNumber: row.rowNumber,
          entityType: DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
          mutationKey: `${importKey}:version`,
          operation: importMutationOperation.CREATE,
          importOutcome: "created",
          importMessage: "Membership plan imported.",
          isCanonicalResult: false,
          targetId: version[0]._id,
          affectedFields: PLAN_VERSION_FIELDS,
          beforeRecord: null,
          afterRecord: version[0],
          delta: { kind: "membership_plan_version", planId },
          actorId,
          transaction,
        });
        result = {
          action: "created" as const,
          recordId: created[0]._id,
          message: "Membership plan imported.",
        };
        return;
      }
      const nextVersion = Number(current.versionCounter || 0) + 1;
      const beforePlan = current.toObject({ depopulate: true });
      const version = await MembershipPlanVersionModel.create(
        [
          versionPayload({
            tenantId,
            planId: current._id,
            version: nextVersion,
            actorId,
            normalized,
          }) as any,
        ],
        { session: transaction },
      );
      current.currentPublishedVersion = version[0]._id as any;
      current.currentDraftVersion = null;
      current.versionCounter = nextVersion;
      current.status = normalized.status as any;
      current.sortOrder = normalized.sortOrder ?? current.sortOrder;
      current.updatedBy = importObjectId(actorId) as any;
      current.publishedAt = now;
      current.archivedAt = normalized.status === "archived" ? now : null;
      current.importMetadata = {
        ...((current.importMetadata as any)?.toObject?.() ||
          current.importMetadata ||
          {}),
        source: importSession.fileType,
        importId: sessionId,
        importKey: current.importMetadata?.importKey || importKey,
        ...(normalized.externalId ? { externalId: normalized.externalId } : {}),
        fingerprint: String(normalized.fingerprint),
        lastMutationKey: importKey,
        importedAt: now,
        importedBy: importObjectId(actorId),
      } as any;
      await current.save({ session: transaction });
      await recordDataImportMutation({
        tenantId,
        sessionId,
        rowId: row._id,
        rowNumber: row.rowNumber,
        entityType: DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
        mutationKey: `${importKey}:plan`,
        operation: importMutationOperation.UPDATE,
        importOutcome: "updated",
        importMessage: "Membership plan updated with a new published version.",
        targetId: current._id,
        affectedFields: PLAN_FIELDS,
        beforeRecord: beforePlan,
        afterRecord: current,
        delta: {
          kind: "membership_plan",
          priorVersionId: beforePlan.currentPublishedVersion || null,
          createdVersionId: version[0]._id,
        },
        actorId,
        transaction,
      });
      await recordDataImportMutation({
        tenantId,
        sessionId,
        rowId: row._id,
        rowNumber: row.rowNumber,
        entityType: DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
        mutationKey: `${importKey}:version`,
        operation: importMutationOperation.CREATE,
        importOutcome: "updated",
        importMessage: "Membership plan updated with a new published version.",
        isCanonicalResult: false,
        targetId: version[0]._id,
        affectedFields: PLAN_VERSION_FIELDS,
        beforeRecord: null,
        afterRecord: version[0],
        delta: { kind: "membership_plan_version", planId: current._id },
        actorId,
        transaction,
      });
      result = {
        action: "updated" as const,
        recordId: current._id,
        message: "Membership plan updated with a new published version.",
      };
    });
    return result;
  } catch (error) {
    if (isImportDuplicateKey(error)) {
      record = await findPlan({ tenantId, normalized, importKey });
      if (
        record?.importMetadata?.lastMutationKey === importKey &&
        record.importMetadata?.fingerprint === normalized.fingerprint &&
        (!normalized.externalId ||
          record.importMetadata?.externalId === normalized.externalId)
      )
        return {
          action: "skipped" as const,
          recordId: record._id,
          message: "Membership plan was already imported.",
        };
    }
    throw error;
  } finally {
    await transaction.endSession();
  }
};

export const processMembershipPlanImportSession = ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) =>
  processStagedImportSession({
    tenantId,
    sessionId,
    entityType: DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
    executeRow: executeMembershipPlanRow,
  });
