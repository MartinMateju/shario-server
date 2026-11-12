export const PUBLIC_SITE_NAV_ITEM = {
  BOOK: "book",
  COURSES: "courses",
  MEMBERSHIPS: "memberships",
  VOUCHERS: "vouchers",
  HELP: "help",
} as const;

export const PUBLIC_SITE_NAV_ITEMS = Object.freeze(
  Object.values(PUBLIC_SITE_NAV_ITEM),
);

export type PublicSiteNavItem = (typeof PUBLIC_SITE_NAV_ITEMS)[number];

// Portal controls are independent of the anonymous website's navigation.
export const CUSTOMER_PORTAL_PAGE_IDS = Object.freeze([
  "calendar",
  "courses",
  "memberships",
  "vouchers",
  "studioGuide",
  "bookings",
  "work",
  "credits",
  "invoices",
  "account",
  "notifications",
  "waitlists",
] as const);

export type CustomerPortalPageId = (typeof CUSTOMER_PORTAL_PAGE_IDS)[number];

export const CUSTOMER_PORTAL_NAVIGATION_KEYS = Object.freeze([
  "bookSession",
  "courses",
  "memberships",
  "giftVouchers",
  "studioGuide",
] as const);

export type CustomerPortalNavigationKey =
  (typeof CUSTOMER_PORTAL_NAVIGATION_KEYS)[number];

export const PUBLIC_SITE_PRIMARY_CTA = {
  AUTO: "auto",
  BOOK: PUBLIC_SITE_NAV_ITEM.BOOK,
  COURSES: PUBLIC_SITE_NAV_ITEM.COURSES,
  MEMBERSHIPS: PUBLIC_SITE_NAV_ITEM.MEMBERSHIPS,
  VOUCHERS: PUBLIC_SITE_NAV_ITEM.VOUCHERS,
} as const;

export const PUBLIC_SITE_PRIMARY_CTAS = Object.freeze(
  Object.values(PUBLIC_SITE_PRIMARY_CTA),
);

export type PublicSitePrimaryCta = (typeof PUBLIC_SITE_PRIMARY_CTAS)[number];

export const PUBLIC_SITE_STYLE_PRESET = Object.freeze({
  CLASSIC_EDITORIAL: "classic-editorial-v1",
  MODERN_MINIMAL: "modern-minimal-v1",
  WARM_ORGANIC: "warm-organic-v1",
} as const);

export const PUBLIC_SITE_STYLE_PRESETS = Object.freeze(
  Object.values(PUBLIC_SITE_STYLE_PRESET),
);

export type PublicSiteStylePreset = (typeof PUBLIC_SITE_STYLE_PRESETS)[number];

export const DEFAULT_PUBLIC_SITE_STYLE_PRESET =
  PUBLIC_SITE_STYLE_PRESET.CLASSIC_EDITORIAL;

/**
 * Curated font pairings are persisted as stable identifiers. Public-site
 * clients map these identifiers to bundled font assets; raw CSS font-family
 * values and remote font URLs never cross the settings boundary.
 */
export const PUBLIC_SITE_FONT_PRESET = Object.freeze({
  SHARIO_SANS: "shario-sans-v1",
  EDITORIAL_SERIF: "editorial-serif-v1",
  MODERN_CONDENSED: "modern-condensed-v1",
  WARM_SERIF: "warm-serif-v1",
} as const);

export const PUBLIC_SITE_FONT_PRESETS = Object.freeze(
  Object.values(PUBLIC_SITE_FONT_PRESET),
);

export type PublicSiteFontPreset = (typeof PUBLIC_SITE_FONT_PRESETS)[number];

export const DEFAULT_PUBLIC_SITE_FONT_PRESET =
  PUBLIC_SITE_FONT_PRESET.SHARIO_SANS;

export const SHARIO_BRAND_COLORS = Object.freeze({
  PRIMARY: "#1F36D4",
  OFFSET: "#FCFBF8",
  ACCENT: "#D27357",
} as const);

export const DEFAULT_PUBLIC_SITE_ACCENT_COLOR = SHARIO_BRAND_COLORS.PRIMARY;
export const DEFAULT_PUBLIC_SITE_SECONDARY_COLOR = SHARIO_BRAND_COLORS.ACCENT;
export const DEFAULT_PUBLIC_SITE_BACKGROUND_COLOR = SHARIO_BRAND_COLORS.OFFSET;
export const DEFAULT_PUBLIC_SITE_TEXT_COLOR = "#1F1F1F";
export const DEFAULT_PUBLIC_SITE_LABEL_COLOR = SHARIO_BRAND_COLORS.PRIMARY;

export const PUBLIC_SITE_LOGO_SIZE = Object.freeze({
  MIN: 24,
  DEFAULT: 48,
  MAX: 72,
} as const);

export const DEFAULT_PUBLIC_SITE_NAV_ORDER: readonly PublicSiteNavItem[] =
  Object.freeze([
    PUBLIC_SITE_NAV_ITEM.BOOK,
    PUBLIC_SITE_NAV_ITEM.COURSES,
    PUBLIC_SITE_NAV_ITEM.MEMBERSHIPS,
    PUBLIC_SITE_NAV_ITEM.VOUCHERS,
    PUBLIC_SITE_NAV_ITEM.HELP,
  ]);

/**
 * Homepage composition intentionally stays bounded to studio-specific,
 * production-owned sections. Tenants can order and hide these sections, but
 * cannot persist arbitrary component names, markup, scripts, or CSS.
 */
export const PUBLIC_SITE_HOME_SECTION = Object.freeze({
  WAYS_TO_VISIT: "waysToVisit",
  FEATURED: "featured",
  ABOUT: "about",
  GALLERY: "gallery",
  TESTIMONIALS: "testimonials",
  LOCATIONS: "locations",
  TEAM: "team",
  FAQ: "faq",
} as const);

export const PUBLIC_SITE_HOME_SECTIONS = Object.freeze(
  Object.values(PUBLIC_SITE_HOME_SECTION),
);

export type PublicSiteHomeSection = (typeof PUBLIC_SITE_HOME_SECTIONS)[number];

export const DEFAULT_PUBLIC_SITE_HOME_SECTION_ORDER: readonly PublicSiteHomeSection[] =
  Object.freeze([
    PUBLIC_SITE_HOME_SECTION.WAYS_TO_VISIT,
    PUBLIC_SITE_HOME_SECTION.FEATURED,
    PUBLIC_SITE_HOME_SECTION.ABOUT,
    PUBLIC_SITE_HOME_SECTION.GALLERY,
    PUBLIC_SITE_HOME_SECTION.TESTIMONIALS,
    PUBLIC_SITE_HOME_SECTION.LOCATIONS,
    PUBLIC_SITE_HOME_SECTION.TEAM,
    PUBLIC_SITE_HOME_SECTION.FAQ,
  ]);

// Preserve the exact legacy homepage on existing tenants. New sections become
// visible only after the tenant explicitly adds them in the builder.
export const DEFAULT_PUBLIC_SITE_HIDDEN_HOME_SECTIONS: readonly PublicSiteHomeSection[] =
  Object.freeze(
    DEFAULT_PUBLIC_SITE_HOME_SECTION_ORDER.filter(
      (section) => section !== PUBLIC_SITE_HOME_SECTION.WAYS_TO_VISIT,
    ),
  );

export const PUBLIC_SITE_LIMITS = Object.freeze({
  DISPLAY_NAME: 120,
  SHORT_TEXT: 240,
  DESCRIPTION: 2_000,
  OPENING_HOURS: 2_000,
  COPYRIGHT: 240,
  URL: 2_048,
  EMAIL: 254,
  PHONE: 80,
  ADDRESS: 500,
});

export const PUBLIC_SITE_MEDIA_SLOT = {
  LOGO: "logo",
  FAVICON: "favicon",
  COVER: "cover",
  HOME_HERO: "homeHero",
  LOGIN_BACKGROUND: "loginBackground",
  REGISTER_BACKGROUND: "registerBackground",
  COURSE_HERO: "courseHero",
} as const;

export const PUBLIC_SITE_MEDIA_SLOTS = Object.freeze(
  Object.values(PUBLIC_SITE_MEDIA_SLOT),
);

export type PublicSiteMediaSlot = (typeof PUBLIC_SITE_MEDIA_SLOTS)[number];

export const PUBLIC_SITE_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
