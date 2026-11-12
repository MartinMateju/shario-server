/**
 * Resolves only storage objects owned by the current communications tenant.
 * Invalid/cross-tenant references are treated as unavailable and must never be
 * signed, downloaded or deleted.
 */
export const getOwnedCommunicationR2Key = (
  tenantId: string,
  value: unknown,
): string | null => {
  const uri = String(value || "");
  if (!uri.startsWith("r2://")) return null;
  const key = uri.slice("r2://".length);
  const prefix = `tenants/${tenantId}/communications/`;
  if (
    !key.startsWith(prefix) ||
    key.includes("..") ||
    key.includes("\\") ||
    /[\r\n\0]/.test(key)
  ) {
    return null;
  }
  return key;
};

export const toPrivateCommunicationR2Uri = (key: string) => `r2://${key}`;
