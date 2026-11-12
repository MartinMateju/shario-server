/**
 * Notification actions are rendered as trusted application links. Keeping
 * them relative and under `/app` prevents protocol-relative, external and
 * control-character redirects from reaching the client.
 */
export const isSafeWorkspaceNotificationActionUrl = (
  value: unknown,
): value is string => {
  if (typeof value !== "string") return false;

  const normalized = value.trim();
  if (!normalized) return true;
  if (normalized.includes("\\") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return false;
  }

  return (
    normalized === "/app" ||
    normalized.startsWith("/app/") ||
    normalized.startsWith("/app?") ||
    normalized.startsWith("/app#")
  );
};
