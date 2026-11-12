import { logger } from "@/config/logger.js";

import DataImportAuditEventModel from "../data-import-audit-event.model.js";

export const recordDataImportAudit = async ({
  tenantId,
  sessionId,
  actorId,
  action,
  metadata = {},
}: {
  tenantId: string;
  sessionId: string;
  actorId: string;
  action:
    | "uploaded"
    | "validated"
    | "queued"
    | "completed"
    | "failed"
    | "rollback_requested"
    | "rollback_started"
    | "rollback_completed"
    | "rollback_partial"
    | "rollback_blocked"
    | "rollback_failed";
  metadata?: Record<string, unknown>;
}) => {
  try {
    return await DataImportAuditEventModel.create({
      tenant: tenantId,
      session: sessionId,
      actor: actorId,
      action,
      metadata,
    });
  } catch (error) {
    // The session and staged rows are the authoritative durable record. An
    // auxiliary audit write must not turn a successful upload, enqueue, or
    // completed import into a retryable failure.
    logger.error(
      { err: error, tenantId, sessionId, actorId, action },
      "Data import audit event could not be persisted.",
    );
    return null;
  }
};
