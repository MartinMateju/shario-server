/**
 * Notification actions are trusted application links. Only relative portal
 * destinations are accepted so neither a producer nor stored data can turn an
 * inbox item into an external or protocol-relative redirect.
 */
export const isSafeCustomerNotificationActionUrl = (
  value: unknown,
): value is string => {
  if (typeof value !== "string") return false;

  const normalized = value.trim();
  if (!normalized) return true;
  if (normalized.includes("\\") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return false;
  }

  if (!(
    normalized === "/portal" ||
    normalized.startsWith("/portal/") ||
    normalized.startsWith("/portal?") ||
    normalized.startsWith("/portal#")
  )) {
    return false;
  }

  try {
    const origin = "https://customer.shario.io";
    const parsed = new URL(normalized, origin);
    return (
      parsed.origin === origin &&
      !parsed.username &&
      !parsed.password &&
      (parsed.pathname === "/portal" || parsed.pathname.startsWith("/portal/"))
    );
  } catch {
    return false;
  }
};

export const toCustomerNotificationDailyGroupKey = (
  groupKey: string | undefined,
  occurredAt: Date,
): string => {
  const normalized = groupKey?.trim() ?? "";
  if (!normalized) return "";
  if (/:\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  return `${normalized}:${occurredAt.toISOString().slice(0, 10)}`;
};
