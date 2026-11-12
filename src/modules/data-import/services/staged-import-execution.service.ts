import { randomUUID } from "node:crypto";
import { emitImportTerminalNotification } from "@/modules/workspace-notifications/workspace-notification.business-events.js";
import {
  DATA_IMPORT_ROW_STATUS,
  DATA_IMPORT_STATUS,
  type DataImportEntity,
} from "../data-import.constants.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import { assertCommerceImportReady } from "./commerce-import-readiness.service.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import { completeImportWithRollbackAvailability } from "./data-import-rollback-availability.service.js";

const LEASE_MS = 5 * 60_000,
  HEARTBEAT_MS = 30_000;
const bestEffortAudit = async (
  input: Parameters<typeof recordDataImportAudit>[0],
) => {
  try {
    await recordDataImportAudit(input);
  } catch {
    /* terminal state is durable */
  }
};
export type StagedExecutionResult = {
  action: "created" | "updated" | "skipped";
  recordId?: unknown;
  message: string;
};
export const processStagedImportSession = async (args: {
  tenantId: string;
  sessionId: string;
  entityType: DataImportEntity;
  executeRow: (input: {
    tenantId: string;
    sessionId: string;
    actorId: string;
    session: any;
    row: any;
  }) => Promise<StagedExecutionResult>;
}) => {
  const claimToken = randomUUID(),
    now = new Date();
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: args.sessionId,
      tenant: args.tenantId,
      entityType: args.entityType,
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
  const actorId = String(session.queuedBy || session.createdBy);
  let heartbeatAt = 0;
  const heartbeat = async (force = false) => {
    if (!force && Date.now() - heartbeatAt < HEARTBEAT_MS) return;
    const result = await DataImportSessionModel.updateOne(
      { _id: session._id, tenant: args.tenantId, claimToken },
      { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
    );
    if (result.matchedCount !== 1)
      throw new Error("Import execution lease was lost.");
    heartbeatAt = Date.now();
  };
  try {
    // The readiness check deliberately runs after the durable session claim. If
    // rollout prerequisites disappear, the catch below moves the session out of
    // QUEUED/PROCESSING instead of leaving it stranded after BullMQ retries.
    await assertCommerceImportReady(args.entityType);
    const rows = await DataImportRowModel.find({
      tenant: args.tenantId,
      session: session._id,
      status: {
        $in: [DATA_IMPORT_ROW_STATUS.VALID, DATA_IMPORT_ROW_STATUS.PROCESSING],
      },
    }).sort({ rowNumber: 1 });
    for (const candidate of rows) {
      await heartbeat();
      const row = await DataImportRowModel.findOneAndUpdate(
        {
          _id: candidate._id,
          tenant: args.tenantId,
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
      if (!row) continue;
      try {
        // A target mutation and its immutable journal commit atomically, while
        // the staged row status is repaired afterward. If the worker crashed
        // between those commits, recover the original outcome from the journal
        // instead of incorrectly turning the retry into a skipped import.
        const committed = await DataImportMutationModel.findOne({
          tenant: args.tenantId,
          session: session._id,
          row: row._id,
          isCanonicalResult: true,
        })
          .sort({ createdAt: 1, _id: 1 })
          .lean();
        const result = committed
          ? {
              action: committed.importOutcome,
              recordId: committed.target,
              message: committed.importMessage,
            }
          : row.duplicate?.kind === "file"
            ? {
                action: "skipped" as const,
                message: "Duplicate row in the uploaded file.",
              }
            : await args.executeRow({
                tenantId: args.tenantId,
                sessionId: args.sessionId,
                actorId,
                session,
                row,
              });
        const status =
          result.action === "created"
            ? DATA_IMPORT_ROW_STATUS.CREATED
            : result.action === "updated"
              ? DATA_IMPORT_ROW_STATUS.UPDATED
              : DATA_IMPORT_ROW_STATUS.SKIPPED;
        await DataImportRowModel.updateOne(
          { _id: row._id, tenant: args.tenantId, session: session._id },
          {
            $set: {
              status,
              resultRecord: result.recordId || null,
              resultMessage: result.message,
            },
          },
        );
      } catch (error) {
        await DataImportRowModel.updateOne(
          { _id: row._id, tenant: args.tenantId, session: session._id },
          {
            $set: {
              status: DATA_IMPORT_ROW_STATUS.FAILED,
              resultRecord: null,
              resultMessage: (error instanceof Error
                ? error.message
                : `${args.entityType} import failed.`
              ).slice(0, 1_000),
            },
          },
        );
      }
    }
    await heartbeat(true);
    const [created, updated, skipped, failed] = await Promise.all([
      DataImportRowModel.countDocuments({
        tenant: args.tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.CREATED,
      }),
      DataImportRowModel.countDocuments({
        tenant: args.tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.UPDATED,
      }),
      DataImportRowModel.countDocuments({
        tenant: args.tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.SKIPPED,
      }),
      DataImportRowModel.countDocuments({
        tenant: args.tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.FAILED,
      }),
    ]);
    await completeImportWithRollbackAvailability({
      tenantId: args.tenantId,
      sessionId: args.sessionId,
      claimToken,
      summary: { created, updated, skipped, failed },
    });
    await bestEffortAudit({
      tenantId: args.tenantId,
      sessionId: args.sessionId,
      actorId,
      action: "completed",
      metadata: {
        entityType: args.entityType,
        created,
        updated,
        skipped,
        failed,
      },
    });
    emitImportTerminalNotification({
      tenantId: args.tenantId,
      sessionId: args.sessionId,
      recipientUserId: actorId,
      entityType: args.entityType,
      status: "completed",
      summary: { created, updated, skipped, failed },
    });
    return { created, updated, skipped, failed };
  } catch (error) {
    const errorCode =
      typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "IMPORT_EXECUTION_FAILED";
    await DataImportSessionModel.updateOne(
      { _id: session._id, tenant: args.tenantId, claimToken },
      {
        $set: {
          status: DATA_IMPORT_STATUS.FAILED,
          leaseExpiresAt: null,
          claimToken: null,
          lastError: {
            code: errorCode,
            message: (error instanceof Error
              ? error.message
              : "Import execution failed."
            ).slice(0, 1_000),
          },
        },
      },
    );
    await bestEffortAudit({
      tenantId: args.tenantId,
      sessionId: args.sessionId,
      actorId,
      action: "failed",
      metadata: { entityType: args.entityType, code: errorCode },
    });
    throw error;
  }
};
