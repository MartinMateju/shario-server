import {
  enqueueDataImport,
  enqueueDataImportRollback,
} from "@/infrastructure/queues/data-import.queue.js";
import mongoose from "mongoose";
import { conflict } from "@/shared/http/httpErrors.js";

import {
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_LIMITS,
  DATA_IMPORT_MUTATION_ROLLBACK_STATUS,
  DATA_IMPORT_ROLLBACK_STATUS,
  DATA_IMPORT_STATUS,
} from "../data-import.constants.js";
import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import {
  getTenantImportSession,
  serializeImportSession,
} from "./data-import.service.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import { queueImportRollbackState } from "./data-import-rollback.service.js";

export const queueDataImportSession = async ({
  tenantId,
  sessionId,
  validationRevision,
  actorId,
}: {
  tenantId: string;
  sessionId: string;
  validationRevision: string;
  actorId: string;
}) => {
  const current = await getTenantImportSession({ tenantId, sessionId });
  if (
    current.status !== DATA_IMPORT_STATUS.VALIDATED ||
    !validationRevision ||
    current.validationRevision !== validationRevision
  ) {
    conflict({
      message: "Validate the current mapping before starting the import.",
      code: "IMPORT_VALIDATION_STALE",
    });
  }
  const queued = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: current._id,
      tenant: tenantId,
      status: DATA_IMPORT_STATUS.VALIDATED,
      validationRevision,
    },
    {
      $set: {
        status: DATA_IMPORT_STATUS.QUEUED,
        queuedAt: new Date(),
        queuedBy: actorId,
        lastError: null,
      },
    },
    { returnDocument: "after" },
  ).lean();
  if (!queued) {
    conflict({
      message: "The import state changed. Refresh and try again.",
      code: "IMPORT_STATE_CONFLICT",
    });
  }
  try {
    const queueResult = await enqueueDataImport({
      tenantId,
      sessionId,
      entityType:
        current.entityType as (typeof DATA_IMPORT_ENTITY)[keyof typeof DATA_IMPORT_ENTITY],
    });
    if (!queueResult.queueAccepted) {
      throw new Error(
        "The retained data import job is not in a runnable state.",
      );
    }
  } catch (error) {
    await DataImportSessionModel.updateOne(
      {
        _id: queued._id,
        tenant: tenantId,
        status: DATA_IMPORT_STATUS.QUEUED,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.VALIDATED,
          lastError: {
            code: "IMPORT_QUEUE_UNAVAILABLE",
            message: "The import could not be queued. Please try again.",
          },
        },
      },
    );
    throw error;
  }
  await recordDataImportAudit({
    tenantId,
    sessionId,
    actorId,
    action: "queued",
    metadata: {
      validationRevision,
    },
  });
  return serializeImportSession(queued);
};

export const queueCustomerImportSession = queueDataImportSession;

export const queueImportRollbackSession = async ({
  tenantId,
  sessionId,
  revision,
  previewToken,
  idempotencyKey,
  actorId,
}: {
  tenantId: string;
  sessionId: string;
  revision: number;
  previewToken: string;
  idempotencyKey: string;
  actorId: string;
}) => {
  const queued = await queueImportRollbackState({
    tenantId,
    sessionId,
    revision,
    previewToken,
    idempotencyKey,
    actorId,
  });
  const rollbackRevision = Number(queued.rollback?.revision || 0);
  if (
    [
      DATA_IMPORT_ROLLBACK_STATUS.COMPLETED,
      DATA_IMPORT_ROLLBACK_STATUS.PARTIAL,
      DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
    ].includes(queued.rollback?.status as never)
  )
    return queued;
  try {
    const queueResult = await enqueueDataImportRollback({
      tenantId,
      sessionId,
      entityType: queued.entityType,
      rollbackRevision,
    });
    if (!queueResult.queueAccepted)
      throw new Error("The retained rollback job is not in a runnable state.");
  } catch (error) {
    const retentionUntil = new Date(
      Date.now() + DATA_IMPORT_LIMITS.ROW_RETENTION_DAYS * 86_400_000,
    );
    const transaction = await mongoose.startSession();
    let markedFailed = false;
    try {
      await transaction.withTransaction(async () => {
        const failedSession = await DataImportSessionModel.updateOne(
          {
            _id: sessionId,
            tenant: tenantId,
            "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.QUEUED,
            "rollback.revision": rollbackRevision,
          },
          {
            $set: {
              "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.FAILED,
              "rollback.lastError": {
                code: "IMPORT_ROLLBACK_QUEUE_UNAVAILABLE",
                message: "The rollback could not be queued. Please try again.",
              },
              rollbackAvailableUntil: retentionUntil,
              reportAvailableUntil: retentionUntil,
            },
          },
          { session: transaction },
        );
        if (failedSession.matchedCount !== 1) return;
        markedFailed = true;
        await DataImportMutationModel.updateMany(
          {
            tenant: tenantId,
            session: sessionId,
            "rollback.status": {
              $in: [
                DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PENDING,
                DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PROCESSING,
              ],
            },
          },
          {
            $set: {
              "rollback.status": DATA_IMPORT_MUTATION_ROLLBACK_STATUS.FAILED,
              "rollback.reasonCode": "IMPORT_ROLLBACK_QUEUE_UNAVAILABLE",
              "rollback.message":
                "The rollback could not be queued. Please try again.",
              "rollback.completedAt": new Date(),
              "rollback.leaseExpiresAt": null,
              "rollback.claimToken": null,
            },
          },
          { session: transaction },
        );
        await DataImportMutationModel.updateMany(
          { tenant: tenantId, session: sessionId },
          { $set: { expiresAt: retentionUntil } },
          { session: transaction },
        );
        await DataImportRowModel.updateMany(
          { tenant: tenantId, session: sessionId },
          { $set: { expiresAt: retentionUntil } },
          { session: transaction },
        );
      });
    } finally {
      await transaction.endSession();
    }
    if (!markedFailed) {
      const current = await getTenantImportSession({ tenantId, sessionId });
      if (
        current.rollback?.revision === rollbackRevision &&
        current.rollback?.status !== DATA_IMPORT_ROLLBACK_STATUS.FAILED
      )
        return serializeImportSession(current);
    }
    throw error;
  }
  return queued;
};
