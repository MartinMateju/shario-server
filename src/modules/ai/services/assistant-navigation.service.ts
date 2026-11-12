const MAX_NAVIGATION_ITEMS = 3;
const BOOKING_PATH = "/app/bookings/new";
const SAFE_RETURN_TO = "/app/ai";
const BOOKING_QUERY_KEYS = new Set([
  "productId",
  "locationId",
  "start",
  "end",
  "returnTo",
]);

export type NormalizedAssistantNavigation =
  | {
      kind: "setup_step";
      stepId: string;
      label: string;
      href: string;
    }
  | {
      kind: "booking_composer";
      label: string;
      href: string;
    };

const recordValue = (value: unknown): Record<string, any> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, any>;
  if (typeof candidate.toObject === "function") {
    const plain = candidate.toObject();
    return plain && typeof plain === "object" && !Array.isArray(plain)
      ? (plain as Record<string, any>)
      : null;
  }
  return candidate;
};

const compactString = (value: unknown, maxLength: number): string =>
  String(value ?? "")
    .trim()
    .slice(0, maxLength);

const relativeWorkspaceUrl = (value: unknown): URL | null => {
  const raw = compactString(value, 300);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const url = new URL(raw, "https://studio.invalid");
    return url.origin === "https://studio.invalid" ? url : null;
  } catch {
    return null;
  }
};

const normalizedSetupNavigation = (
  item: Record<string, any>,
): NormalizedAssistantNavigation | null => {
  const stepId = compactString(item.stepId, 80);
  const label = compactString(item.label, 200);
  const url = relativeWorkspaceUrl(item.href);
  if (
    !stepId ||
    !label ||
    !url ||
    url.hash ||
    !(url.pathname === "/app" || url.pathname.startsWith("/app/"))
  ) {
    return null;
  }
  return {
    kind: "setup_step",
    stepId,
    label,
    href: url.pathname + url.search,
  };
};

const exactObjectId = (value: string): boolean => /^[a-f0-9]{24}$/i.test(value);

const parsedIsoInstant = (value: string): Date | null => {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const normalizedBookingNavigation = (
  item: Record<string, any>,
): NormalizedAssistantNavigation | null => {
  const label = compactString(item.label, 200);
  const url = relativeWorkspaceUrl(item.href);
  if (!label || !url || url.pathname !== BOOKING_PATH || url.hash) return null;

  const keys = Array.from(url.searchParams.keys());
  if (
    keys.some((key) => !BOOKING_QUERY_KEYS.has(key)) ||
    new Set(keys).size !== keys.length
  ) {
    return null;
  }
  if (
    url.searchParams.getAll("returnTo").length !== 1 ||
    url.searchParams.get("returnTo") !== SAFE_RETURN_TO
  ) {
    return null;
  }

  const canonicalKeys = ["productId", "locationId", "start", "end"] as const;
  const values = Object.fromEntries(
    canonicalKeys.map((key) => [key, url.searchParams.getAll(key)]),
  ) as Record<(typeof canonicalKeys)[number], string[]>;
  const suppliedCount = canonicalKeys.filter(
    (key) => values[key].length > 0,
  ).length;
  if (suppliedCount !== 0 && suppliedCount !== canonicalKeys.length) {
    return null;
  }

  const params = new URLSearchParams();
  if (suppliedCount === canonicalKeys.length) {
    if (canonicalKeys.some((key) => values[key].length !== 1)) return null;
    const productId = values.productId[0]!;
    const locationId = values.locationId[0]!;
    const start = parsedIsoInstant(values.start[0]!);
    const end = parsedIsoInstant(values.end[0]!);
    if (
      !exactObjectId(productId) ||
      !exactObjectId(locationId) ||
      !start ||
      !end ||
      end.getTime() <= start.getTime() ||
      end.getTime() - start.getTime() > 24 * 60 * 60_000
    ) {
      return null;
    }
    params.set("productId", productId);
    params.set("locationId", locationId);
    params.set("start", start.toISOString());
    params.set("end", end.toISOString());
  }
  params.set("returnTo", SAFE_RETURN_TO);
  const href = BOOKING_PATH + "?" + params.toString();
  if (href.length > 300) return null;
  return { kind: "booking_composer", label, href };
};

export const normalizeAssistantNavigation = (
  value: unknown,
): NormalizedAssistantNavigation[] => {
  if (!Array.isArray(value)) return [];
  const normalized: NormalizedAssistantNavigation[] = [];
  for (const candidate of value.slice(0, MAX_NAVIGATION_ITEMS)) {
    const item = recordValue(candidate);
    if (!item) continue;
    const kind = compactString(item.kind, 40);
    const navigation =
      kind === "booking_composer"
        ? normalizedBookingNavigation(item)
        : kind === "" || kind === "setup_step"
          ? normalizedSetupNavigation(item)
          : null;
    if (navigation) normalized.push(navigation);
  }
  return normalized;
};
