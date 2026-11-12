import { createHash } from "node:crypto";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";
import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ROW_STATUS,
  DATA_IMPORT_STATUS,
  type DataImportDuplicateStrategy,
  type DataImportEntity,
} from "../data-import.constants.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import type { ImportIssue } from "../data-import.types.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import {
  getTenantImportSession,
  serializeImportSession,
} from "./data-import.service.js";

const bestEffortAudit = async (
  input: Parameters<typeof recordDataImportAudit>[0],
) => {
  try {
    await recordDataImportAudit(input);
  } catch {
    /* durable import state is authoritative */
  }
};
const emptySummary = (total: number) => ({
  total,
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
});

export const validateStagedImportSession = async <
  Mapping extends Record<string, string | undefined>,
>(args: {
  tenantId: string;
  sessionId: string;
  entityType: DataImportEntity;
  mappingInput: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  validationContext?: unknown;
  assertMapping: (headers: string[], value: unknown) => Mapping;
  prepare: (input: {
    rows: any[];
    mapping: Mapping;
  }) => Promise<
    Array<{ normalized: any; issues: ImportIssue[]; duplicate: any }>
  >;
}) => {
  if (
    !Object.values(DATA_IMPORT_DUPLICATE_STRATEGY).includes(
      args.duplicateStrategy,
    )
  )
    badRequest({
      message: "Duplicate strategy must be skip or update.",
      code: "IMPORT_DUPLICATE_STRATEGY_INVALID",
    });
  const current = await getTenantImportSession({
    tenantId: args.tenantId,
    sessionId: args.sessionId,
  });
  if (
    current.entityType !== args.entityType ||
    ![
      DATA_IMPORT_STATUS.UPLOADED,
      DATA_IMPORT_STATUS.VALIDATED,
      DATA_IMPORT_STATUS.FAILED,
    ].includes(current.status as never)
  )
    conflict({
      message: "This import can no longer be validated.",
      code: "IMPORT_STATE_INVALID",
    });
  const mapping = args.assertMapping(current.headers || [], args.mappingInput);
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: current._id,
      tenant: args.tenantId,
      entityType: args.entityType,
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
  if (!session)
    conflict({
      message: "This import can no longer be validated.",
      code: "IMPORT_STATE_INVALID",
    });
  try {
    const rows = await DataImportRowModel.find({
      tenant: args.tenantId,
      session: current._id,
    })
      .sort({ rowNumber: 1 })
      .lean();
    const prepared = await args.prepare({ rows, mapping });
    if (prepared.length !== rows.length)
      throw new Error("Import validator returned an invalid row count.");
    const summary = emptySummary(rows.length),
      operations: any[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const item = prepared[index],
        invalid = item.issues.some((issue) => issue.severity === "error");
      summary[invalid ? "invalid" : "valid"] += 1;
      if (item.issues.some((issue) => issue.severity === "warning"))
        summary.warnings += 1;
      if (item.duplicate) {
        summary.duplicates += 1;
        if (!invalid)
          summary[
            item.duplicate.kind === "file" || args.duplicateStrategy === "skip"
              ? "toSkip"
              : "toUpdate"
          ] += 1;
      } else if (!invalid) summary.toCreate += 1;
      operations.push({
        updateOne: {
          filter: {
            _id: rows[index]._id,
            tenant: args.tenantId,
            session: current._id,
          },
          update: {
            $set: {
              normalized: item.normalized,
              issues: item.issues,
              duplicate: item.duplicate
                ? {
                    kind: item.duplicate.kind,
                    existingRecordId: item.duplicate.existingRecordId || null,
                    rowNumber: item.duplicate.rowNumber || null,
                  }
                : null,
              status: invalid
                ? DATA_IMPORT_ROW_STATUS.INVALID
                : DATA_IMPORT_ROW_STATUS.VALID,
              resultRecord: null,
              resultMessage: null,
            },
          },
        },
      });
    }
    if (operations.length)
      await DataImportRowModel.bulkWrite(operations, { ordered: true });
    const validationRevision = createHash("sha256")
      .update(
        JSON.stringify({
          mapping,
          duplicateStrategy: args.duplicateStrategy,
          context: args.validationContext,
          at: Date.now(),
        }),
      )
      .digest("hex");
    const updated = await DataImportSessionModel.findOneAndUpdate(
      {
        _id: current._id,
        tenant: args.tenantId,
        entityType: args.entityType,
        status: DATA_IMPORT_STATUS.VALIDATING,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.VALIDATED,
          mapping,
          duplicateStrategy: args.duplicateStrategy,
          validationRevision,
          summary,
          lastError: null,
        },
      },
      { returnDocument: "after" },
    ).lean();
    if (!updated) throw new Error("Import validation claim was lost.");
    await bestEffortAudit({
      tenantId: args.tenantId,
      sessionId: args.sessionId,
      actorId: args.actorId,
      action: "validated",
      metadata: { entityType: args.entityType, summary },
    });
    return {
      ...serializeImportSession(updated),
      validationRevision,
      preview: prepared.slice(0, 50).map((item, index) => ({
        rowNumber: rows[index].rowNumber,
        normalized: item.normalized,
        issues: item.issues,
        duplicate: item.duplicate,
      })),
    };
  } catch (error) {
    await DataImportSessionModel.updateOne(
      {
        _id: current._id,
        tenant: args.tenantId,
        status: DATA_IMPORT_STATUS.VALIDATING,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.FAILED,
          lastError: {
            code: "IMPORT_VALIDATION_FAILED",
            message: (error instanceof Error
              ? error.message
              : "Import validation failed."
            ).slice(0, 1_000),
          },
        },
      },
    );
    await bestEffortAudit({
      tenantId: args.tenantId,
      sessionId: args.sessionId,
      actorId: args.actorId,
      action: "failed",
      metadata: {
        entityType: args.entityType,
        code: "IMPORT_VALIDATION_FAILED",
      },
    });
    throw error;
  }
};
