import mongoose from "mongoose";

import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";
import type { WorkspacePermission } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";

export const importObjectId = (value: unknown): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(String(value));

export const isImportDuplicateKey = (error: unknown): boolean =>
  Boolean((error as { code?: number } | null)?.code === 11_000);

export const loadCommerceImportGuard = async ({
  tenantId,
  actorId,
  permission,
  moduleName,
  session = null,
}: {
  tenantId: string;
  actorId: string;
  permission: WorkspacePermission;
  moduleName: string;
  session?: mongoose.ClientSession | null;
}): Promise<{
  access: ResolvedWorkspaceAccess;
  tenant: Record<string, any>;
  currency: string;
}> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database connection is unavailable.");
  // MongoDB sessions do not support concurrent operations, so keep these
  // reads sequential. This also makes the authorization and entitlement
  // snapshot deterministic inside the caller's transaction.
  const access = await resolveWorkspaceAccessForUser({
    tenantId,
    userId: actorId,
    session,
  });
  const tenant = await db.collection("tenants").findOne(
    { _id: importObjectId(tenantId) },
    {
      projection: {
        modules: 1,
        "settings.currency": 1,
        "settings.defaultLanguage": 1,
      },
      ...(session ? { session } : {}),
    },
  );
  if (!access || !hasWorkspacePermission(access, permission)) {
    throw new Error(
      "The queued actor no longer has permission for this import.",
    );
  }
  if (!tenant) throw new Error("The workspace is no longer available.");
  if (
    !Boolean(
      (tenant.modules as Record<string, unknown> | undefined)?.[moduleName],
    )
  ) {
    throw new Error(`The ${moduleName} module is no longer enabled.`);
  }
  return {
    access,
    tenant: tenant as Record<string, any>,
    currency: String((tenant.settings as any)?.currency || "CZK").toUpperCase(),
  };
};

export const canImportLocation = (
  access: ResolvedWorkspaceAccess,
  locationId: unknown,
): boolean =>
  access.locationAccess.mode !== "selected" ||
  access.locationAccess.locationIds.includes(String(locationId));

export const importMetadata = ({
  sessionId,
  rowNumber,
  actorId,
  fileType,
  externalId,
  fingerprint,
  lastMutationKey,
}: {
  sessionId: string;
  rowNumber: number;
  actorId: string;
  fileType: "csv" | "xlsx";
  externalId?: string;
  fingerprint: string;
  lastMutationKey?: string;
}) => ({
  source: fileType,
  importId: sessionId,
  importKey: `${sessionId}:${rowNumber}`,
  ...(externalId ? { externalId } : {}),
  fingerprint,
  lastMutationKey: lastMutationKey ?? `${sessionId}:${rowNumber}`,
  importedAt: new Date(),
  importedBy: importObjectId(actorId),
});
