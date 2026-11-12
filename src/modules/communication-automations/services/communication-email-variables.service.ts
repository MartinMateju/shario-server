export type CommunicationEmailLocale = "cs" | "en";

const localizedValue = (
  value: unknown,
  locale: CommunicationEmailLocale,
): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = locale === "cs"
      ? ["cs", "CZ", "cz", "en", "EN"]
      : ["en", "EN", "cs", "CZ"];
    for (const key of keys) {
      if (typeof record[key] === "string" && String(record[key]).trim()) {
        return String(record[key]).trim();
      }
    }
  }
  return "";
};

const formatDate = (
  value: unknown,
  locale: CommunicationEmailLocale,
  timezone: string,
): string => {
  const date = new Date(value as never);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "cs" ? "cs-CZ" : "en-GB", {
    dateStyle: "medium",
    timeZone: timezone,
  }).format(date);
};

const formatTime = (
  value: unknown,
  locale: CommunicationEmailLocale,
  timezone: string,
): string => {
  const date = new Date(value as never);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "cs" ? "cs-CZ" : "en-GB", {
    timeStyle: "short",
    timeZone: timezone,
  }).format(date);
};

export const formatMinorCurrency = (
  minor: unknown,
  currency: unknown,
  locale: CommunicationEmailLocale,
): string => {
  const amount = Number(minor);
  const currencyCode = String(currency || "").trim().toUpperCase();
  if (!Number.isFinite(amount)) return "";
  if (!/^[A-Z]{3}$/.test(currencyCode)) return String(amount / 100);
  try {
    return new Intl.NumberFormat(locale === "cs" ? "cs-CZ" : "en-GB", {
      style: "currency",
      currency: currencyCode,
    }).format(amount / 100);
  } catch {
    return `${amount / 100} ${currencyCode}`;
  }
};

export const formatCommunicationAddress = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const address = value as Record<string, unknown>;
  return [
    address.line1,
    address.line2,
    [address.postalCode, address.city].filter(Boolean).join(" "),
    address.country,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
};

export const buildCommunicationEmailVariables = ({
  tenant,
  user,
  entity,
  recipient,
  locale,
  timezone,
  sourceOrderId,
}: {
  tenant: Record<string, any>;
  user?: Record<string, any> | null;
  entity?: Record<string, any> | null;
  recipient: { email: string; name: string };
  locale: CommunicationEmailLocale;
  timezone: string;
  sourceOrderId?: unknown;
}): Record<string, string> => {
  const firstName = String(
    user?.firstname || user?.firstName || recipient.name.split(" ")[0] || "",
  );
  const lastName = String(user?.lastname || user?.lastName || "");
  const bookingDate = entity?.start || entity?.end || entity?.createdAt || null;
  const location = entity?.location && typeof entity.location === "object"
    ? entity.location
    : null;
  const product = entity?.bookingProduct &&
    typeof entity.bookingProduct === "object"
    ? entity.bookingProduct
    : null;
  const matchingOrders = (Array.isArray(entity?.orders) ? entity.orders : [])
    .filter(
      (order: any) =>
        order &&
        typeof order === "object" &&
        order.isPaid === true &&
        (!sourceOrderId || String(order._id) === String(sourceOrderId)) &&
        user?._id &&
        String(order.createdBy || "") === String(user._id),
    );
  const studioName = String(location?.name || tenant.name || "");
  const studioAddress = formatCommunicationAddress(
    location?.address || tenant.publicSite?.footer?.address,
  );
  const studioEmail = String(
    location?.contact?.email || tenant.publicSite?.footer?.email || "",
  );
  const studioPhone = String(
    location?.contact?.phone || tenant.publicSite?.footer?.phone || "",
  );
  const logo = String(
    tenant.publicSite?.branding?.logoUrl ||
      tenant.publicSite?.logo?.url ||
      tenant.logo?.url ||
      "",
  );

  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" ").trim(),
    email: recipient.email,
    // Keep the existing template variable name for backwards compatibility,
    // but expose the short member identity when available.
    customId: String(user?.memberNumber ?? user?.customId ?? ""),
    date: formatDate(bookingDate, locale, timezone),
    time: formatTime(bookingDate, locale, timezone),
    studio: studioName,
    studioName,
    studioAddress,
    studioEmail,
    studioPhone,
    logo,
    bookingDate: formatDate(entity?.start, locale, timezone),
    bookingTime: formatTime(entity?.start, locale, timezone),
    productName: localizedValue(product?.name, locale),
    orderNumber: matchingOrders
      .map((order: any) => String(order._id))
      .join(", "),
    totalPrice: matchingOrders
      .map((order: any) =>
        formatMinorCurrency(order.grossAmountMinor, order.currency, locale),
      )
      .filter(Boolean)
      .join(" + "),
  };
};

