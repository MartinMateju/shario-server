// The same controlled palette can be stored on a studio or on a customer's
// tenant-scoped account. Blank values inherit the next layer of the palette.
export const PORTAL_APPEARANCE_COLOR_KEYS = Object.freeze([
  "backgroundColor",
  "surfaceColor",
  "textColor",
  "headingColor",
  "headerBackgroundColor",
  "headerTextColor",
  "primaryButtonColor",
  "calendarBackgroundColor",
  "calendarTextColor",
  "profileMenuBackgroundColor",
] as const);

export type PortalAppearanceColorKey =
  (typeof PORTAL_APPEARANCE_COLOR_KEYS)[number];
export type PortalAppearance = Record<PortalAppearanceColorKey, string>;

export const serializePortalAppearance = (value: unknown): PortalAppearance => {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    PORTAL_APPEARANCE_COLOR_KEYS.map((key) => {
      const candidate =
        typeof source[key] === "string" ? source[key].trim().toUpperCase() : "";
      return [key, /^#[0-9A-F]{6}$/.test(candidate) ? candidate : ""];
    }),
  ) as PortalAppearance;
};
