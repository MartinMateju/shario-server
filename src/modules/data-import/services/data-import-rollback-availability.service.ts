import {
  DATA_IMPORT_ROLLBACK_REASON,
  DATA_IMPORT_ROLLBACK_STATUS,
  DATA_IMPORT_STATUS,
} from "../data-import.constants.js";
import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportSessionModel from "../data-import-session.model.js";

export const refreshImportRollbackAvailability = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const [session, canonicalMutations] = await Promise.all([
    DataImportSessionModel.findOne({ _id: sessionId, tenant: tenantId })
      .select(
        "status summary rollback.status rollback.requestedAt rollbackAvailableUntil",
      )
      .lean(),
    DataImportMutationModel.countDocuments({
      tenant: tenantId,
      session: sessionId,
      isCanonicalResult: true,
    }),
  ]);
  if (!session) return;
  if (session.status !== DATA_IMPORT_STATUS.COMPLETED) return;
  if (
    ![
      DATA_IMPORT_ROLLBACK_STATUS.UNAVAILABLE,
      DATA_IMPORT_ROLLBACK_STATUS.AVAILABLE,
    ].includes(session.rollback?.status as any) ||
    session.rollback?.requestedAt
  )
    return;
  const expected =
    Number(session.summary?.created || 0) +
    Number(session.summary?.updated || 0);
  const unexpired =
    Boolean(session.rollbackAvailableUntil) &&
    new Date(session.rollbackAvailableUntil as Date).getTime() > Date.now();
  const available =
    expected > 0 && canonicalMutations === expected && unexpired;
  const unavailableReason = available
    ? null
    : !unexpired
      ? DATA_IMPORT_ROLLBACK_REASON.RETENTION_EXPIRED
      : expected <= 0
        ? DATA_IMPORT_ROLLBACK_REASON.NO_IMPORTED_MUTATIONS
        : canonicalMutations === 0
          ? DATA_IMPORT_ROLLBACK_REASON.LEGACY_MANIFEST_MISSING
          : DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH;
  await DataImportSessionModel.updateOne(
    { _id: sessionId, tenant: tenantId },
    {
      $set: {
        "rollback.status": available
          ? DATA_IMPORT_ROLLBACK_STATUS.AVAILABLE
          : DATA_IMPORT_ROLLBACK_STATUS.UNAVAILABLE,
        "rollback.revision": 0,
        "rollback.unavailableReason": unavailableReason,
        "rollback.counters.eligible": available ? expected : 0,
        "rollback.counters.blocked": available ? 0 : expected,
      },
    },
  );
};

export const completeImportWithRollbackAvailability = async ({
  tenantId,
  sessionId,
  claimToken,
  summary,
}: {
  tenantId: string;
  sessionId: string;
  claimToken: string;
  summary: {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
}): Promise<void> => {
  const [session, canonicalMutations] = await Promise.all([
    DataImportSessionModel.findOne({
      _id: sessionId,
      tenant: tenantId,
      status: DATA_IMPORT_STATUS.PROCESSING,
      claimToken,
    })
      .select("rollbackAvailableUntil")
      .lean(),
    DataImportMutationModel.countDocuments({
      tenant: tenantId,
      session: sessionId,
      isCanonicalResult: true,
    }),
  ]);
  if (!session) throw new Error("Import execution lease was lost.");
  const expected = Number(summary.created) + Number(summary.updated);
  const unexpired = Boolean(
    session.rollbackAvailableUntil &&
    new Date(session.rollbackAvailableUntil).getTime() > Date.now(),
  );
  const available =
    expected > 0 && canonicalMutations === expected && unexpired;
  const unavailableReason = available
    ? null
    : expected <= 0
      ? DATA_IMPORT_ROLLBACK_REASON.NO_IMPORTED_MUTATIONS
      : !unexpired
        ? DATA_IMPORT_ROLLBACK_REASON.RETENTION_EXPIRED
        : canonicalMutations === 0
          ? DATA_IMPORT_ROLLBACK_REASON.LEGACY_MANIFEST_MISSING
          : DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH;
  const completed = await DataImportSessionModel.updateOne(
    {
      _id: sessionId,
      tenant: tenantId,
      status: DATA_IMPORT_STATUS.PROCESSING,
      claimToken,
    },
    {
      $set: {
        status: DATA_IMPORT_STATUS.COMPLETED,
        completedAt: new Date(),
        "summary.created": summary.created,
        "summary.updated": summary.updated,
        "summary.skipped": summary.skipped,
        "summary.failed": summary.failed,
        leaseExpiresAt: null,
        claimToken: null,
        "rollback.status": available
          ? DATA_IMPORT_ROLLBACK_STATUS.AVAILABLE
          : DATA_IMPORT_ROLLBACK_STATUS.UNAVAILABLE,
        "rollback.revision": 0,
        "rollback.unavailableReason": unavailableReason,
        "rollback.counters.eligible": available ? expected : 0,
        "rollback.counters.blocked": available ? 0 : expected,
      },
    },
  );
  if (completed.matchedCount !== 1)
    throw new Error("Import execution lease was lost.");
};
