import {
  DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE,
  LEGACY_LOCATION_ACTIVITY_SELECTION_MODE,
  LOCATION_ACTIVITY_SELECTION_MODES,
  type LocationActivitySelectionMode,
} from "./location.constants.js";

const LOCATION_ACTIVITY_SELECTION_MODE_SET = new Set<string>(
  LOCATION_ACTIVITY_SELECTION_MODES,
);

/**
 * Lean reads do not apply Mongoose defaults. Missing historical values must
 * therefore resolve explicitly to OPTIONAL, which preserves the old booking
 * behavior while newly-created locations persist REQUIRED.
 */
export const resolveLocationActivitySelectionMode = (
  value: unknown,
): LocationActivitySelectionMode => {
  const candidate = String(value ?? "").trim();

  if (!candidate) return LEGACY_LOCATION_ACTIVITY_SELECTION_MODE;

  return LOCATION_ACTIVITY_SELECTION_MODE_SET.has(candidate)
    ? (candidate as LocationActivitySelectionMode)
    : DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE;
};

export const slugifyLocation = (value: string): string => {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
};

export const normalizeLocationCode = (value: string): string => {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "")
    .slice(0, 20);
};

export const buildLocationCode = (slug: string): string => {
  const base = normalizeLocationCode(
    String(slug || "")
      .split("-")
      .map((part) => part[0])
      .join(""),
  );

  return base || "LOC";
};

export const formatLocationAddress = (
  location:
    | {
        address?: {
          line1?: string;
          line2?: string;
          city?: string;
          postalCode?: string;
          country?: string;
        };
      }
    | null
    | undefined,
): string =>
  [
    location?.address?.line1,
    location?.address?.line2,
    [location?.address?.postalCode, location?.address?.city]
      .filter(Boolean)
      .join(" "),
    location?.address?.country,
  ]
    .filter(Boolean)
    .join(", ");
