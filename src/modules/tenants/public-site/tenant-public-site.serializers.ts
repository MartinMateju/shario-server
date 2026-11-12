import { serializePortalAppearance } from "@/shared/appearance/portal-appearance.js";
import type {
  TenantDocument,
  TenantPublicSite,
  TenantPublicSiteLocalizedText,
} from "../tenant.types.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";
import {
  CUSTOMER_PORTAL_NAVIGATION_KEYS,
  CUSTOMER_PORTAL_PAGE_IDS,
  DEFAULT_PUBLIC_SITE_ACCENT_COLOR,
  DEFAULT_PUBLIC_SITE_BACKGROUND_COLOR,
  DEFAULT_PUBLIC_SITE_FONT_PRESET,
  DEFAULT_PUBLIC_SITE_HIDDEN_HOME_SECTIONS,
  DEFAULT_PUBLIC_SITE_HOME_SECTION_ORDER,
  DEFAULT_PUBLIC_SITE_LABEL_COLOR,
  DEFAULT_PUBLIC_SITE_NAV_ORDER,
  DEFAULT_PUBLIC_SITE_SECONDARY_COLOR,
  DEFAULT_PUBLIC_SITE_STYLE_PRESET,
  DEFAULT_PUBLIC_SITE_TEXT_COLOR,
  PUBLIC_SITE_LIMITS,
  PUBLIC_SITE_LOGO_SIZE,
  PUBLIC_SITE_FONT_PRESETS,
  PUBLIC_SITE_HOME_SECTIONS,
  PUBLIC_SITE_NAV_ITEMS,
  PUBLIC_SITE_PRIMARY_CTA,
  PUBLIC_SITE_PRIMARY_CTAS,
  PUBLIC_SITE_STYLE_PRESETS,
  type PublicSiteNavItem,
  type PublicSiteFontPreset,
  type PublicSiteHomeSection,
  type PublicSitePrimaryCta,
  type PublicSiteStylePreset,
} from "./tenant-public-site.constants.js";
import {
  isSafePublicSiteText,
  isSafePublicSiteUrl,
} from "./tenant-public-site.validators.js";

type TenantPublicSiteSource = Pick<TenantDocument, "name"> & {
  publicSite?: unknown;
  publicSiteEditor?: unknown;
};

export type TenantPublicSiteSnapshot = "draft" | "published";

const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" ? (value as Record<string, any>) : {};

const text = (value: unknown, maxLength = Number.MAX_SAFE_INTEGER): string => {
  if (typeof value !== "string" || !isSafePublicSiteText(value)) return "";
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : "";
};

const localizedText = (value = ""): TenantPublicSiteLocalizedText =>
  Object.fromEntries(
    ROLLOUT_ELIGIBLE_APP_LOCALES.map((locale) => [locale, value]),
  ) as TenantPublicSiteLocalizedText;

const localized = (
  value: unknown,
  fallback: TenantPublicSiteLocalizedText = localizedText(),
  maxLength: number = PUBLIC_SITE_LIMITS.DESCRIPTION,
): TenantPublicSiteLocalizedText => {
  const source = record(value);
  return Object.fromEntries(
    ROLLOUT_ELIGIBLE_APP_LOCALES.map((locale) => [
      locale,
      text(source[locale], maxLength) || fallback[locale],
    ]),
  ) as TenantPublicSiteLocalizedText;
};

const publicUrl = (
  value: unknown,
  options: { allowRelative?: boolean } = {},
): string => {
  const candidate = text(value, PUBLIC_SITE_LIMITS.URL);
  return isSafePublicSiteUrl(candidate, options) ? candidate : "";
};

const email = (value: unknown): string => {
  const candidate = text(value, PUBLIC_SITE_LIMITS.EMAIL).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
};

const resolvedNavigation = (value: unknown): PublicSiteNavItem[] => {
  const allowed = new Set<string>(PUBLIC_SITE_NAV_ITEMS);
  const unique: PublicSiteNavItem[] = [];

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (
        typeof item === "string" &&
        allowed.has(item) &&
        !unique.includes(item as PublicSiteNavItem)
      ) {
        unique.push(item as PublicSiteNavItem);
      }
    });
  }

  const legacyItems = ["book", "courses", "memberships", "help"] as const;
  const isCompleteLegacyOrder =
    !unique.includes("vouchers") &&
    unique.length === legacyItems.length &&
    legacyItems.every((item, index) => unique[index] === item);

  if (isCompleteLegacyOrder) {
    unique.splice(unique.indexOf("help"), 0, "vouchers");
  }

  DEFAULT_PUBLIC_SITE_NAV_ORDER.forEach((item) => {
    if (!unique.includes(item)) unique.push(item);
  });

  return unique;
};

const resolvedHiddenItems = (value: unknown): PublicSiteNavItem[] => {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(PUBLIC_SITE_NAV_ITEMS);
  return [
    ...new Set(
      value.filter(
        (item): item is PublicSiteNavItem =>
          typeof item === "string" && allowed.has(item),
      ),
    ),
  ];
};

const resolvedHomeSectionOrder = (value: unknown): PublicSiteHomeSection[] => {
  const allowed = new Set<string>(PUBLIC_SITE_HOME_SECTIONS);
  const unique: PublicSiteHomeSection[] = [];

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (
        typeof item === "string" &&
        allowed.has(item) &&
        !unique.includes(item as PublicSiteHomeSection)
      ) {
        unique.push(item as PublicSiteHomeSection);
      }
    });
  }

  DEFAULT_PUBLIC_SITE_HOME_SECTION_ORDER.forEach((section) => {
    if (!unique.includes(section)) unique.push(section);
  });

  return unique;
};

const resolvedHiddenHomeSections = (
  value: unknown,
  orderValue: unknown,
): PublicSiteHomeSection[] => {
  const allowed = new Set<string>(PUBLIC_SITE_HOME_SECTIONS);
  const configured = Array.isArray(value)
    ? value.filter(
        (item): item is PublicSiteHomeSection =>
          typeof item === "string" && allowed.has(item),
      )
    : [...DEFAULT_PUBLIC_SITE_HIDDEN_HOME_SECTIONS];
  const storedOrder = Array.isArray(orderValue)
    ? new Set(orderValue.filter((item) => typeof item === "string"))
    : null;

  return [
    ...new Set([
      ...configured,
      ...(storedOrder
        ? PUBLIC_SITE_HOME_SECTIONS.filter(
            (section) => !storedOrder.has(section),
          )
        : []),
    ]),
  ];
};

const resolvedPrimaryCta = (value: unknown): PublicSitePrimaryCta =>
  PUBLIC_SITE_PRIMARY_CTAS.includes(value as PublicSitePrimaryCta)
    ? (value as PublicSitePrimaryCta)
    : PUBLIC_SITE_PRIMARY_CTA.AUTO;

const resolvedStylePreset = (value: unknown): PublicSiteStylePreset =>
  PUBLIC_SITE_STYLE_PRESETS.includes(value as PublicSiteStylePreset)
    ? (value as PublicSiteStylePreset)
    : DEFAULT_PUBLIC_SITE_STYLE_PRESET;

const resolvedFontPreset = (value: unknown): PublicSiteFontPreset =>
  PUBLIC_SITE_FONT_PRESETS.includes(value as PublicSiteFontPreset)
    ? (value as PublicSiteFontPreset)
    : DEFAULT_PUBLIC_SITE_FONT_PRESET;

const color = (value: unknown, fallback = ""): string => {
  const candidate = text(value);
  return /^#[0-9A-F]{6}$/i.test(candidate) ? candidate.toUpperCase() : fallback;
};

const logoSize = (value: unknown): number => {
  const candidate = typeof value === "number" ? value : Number.NaN;

  return Number.isInteger(candidate) &&
    candidate >= PUBLIC_SITE_LOGO_SIZE.MIN &&
    candidate <= PUBLIC_SITE_LOGO_SIZE.MAX
    ? candidate
    : PUBLIC_SITE_LOGO_SIZE.DEFAULT;
};

/**
 * Resolves old/missing tenant records into a stable, safe public contract.
 * URL fields are revalidated while serializing so corrupted legacy data fails
 * closed instead of reaching a browser.
 */
export const serializeTenantPublicSite = (
  tenant: TenantPublicSiteSource,
  options: { snapshot?: TenantPublicSiteSnapshot } = {},
): TenantPublicSite => {
  const editor = record(tenant.publicSiteEditor);
  const editorSnapshot =
    options.snapshot === "draft"
      ? (editor.draft ?? editor.published)
      : editor.published;
  const root = record(editorSnapshot ?? tenant.publicSite);
  const branding = record(root.branding);
  const logoRedirectUrl = publicUrl(branding.logoRedirectUrl);
  const login = record(root.login);
  const register = record(root.register);
  const header = record(root.header);
  const announcement = record(header.announcement);
  const footer = record(root.footer);
  const social = record(footer.social);
  const legal = record(footer.legal);
  const pages = record(root.pages);
  const homePage = record(pages.home);
  const bookPage = record(pages.book);
  const coursesPage = record(pages.courses);
  const membershipsPage = record(pages.memberships);
  const vouchersPage = record(pages.vouchers);
  const helpPage = record(pages.help);
  const customerPortal = record(root.customerPortal);
  const customerPortalAppearance = record(customerPortal.appearance);
  const customerPortalDashboard = record(customerPortal.dashboard);
  const displayName =
    text(branding.displayName, PUBLIC_SITE_LIMITS.DISPLAY_NAME) ||
    text(tenant.name, PUBLIC_SITE_LIMITS.DISPLAY_NAME) ||
    "Studio";

  return {
    branding: {
      displayName,
      stylePreset: resolvedStylePreset(branding.stylePreset),
      fontPreset: resolvedFontPreset(branding.fontPreset),
      logoUrl: publicUrl(branding.logoUrl),
      logoSize: logoSize(branding.logoSize),
      logoRedirectEnabled:
        branding.logoRedirectEnabled === true && !!logoRedirectUrl,
      logoRedirectUrl,
      faviconUrl: publicUrl(branding.faviconUrl),
      accentColor: /^#[0-9A-F]{6}$/i.test(text(branding.accentColor))
        ? text(branding.accentColor).toUpperCase()
        : DEFAULT_PUBLIC_SITE_ACCENT_COLOR,
      secondaryColor: /^#[0-9A-F]{6}$/i.test(text(branding.secondaryColor))
        ? text(branding.secondaryColor).toUpperCase()
        : DEFAULT_PUBLIC_SITE_SECONDARY_COLOR,
      backgroundColor: /^#[0-9A-F]{6}$/i.test(text(branding.backgroundColor))
        ? text(branding.backgroundColor).toUpperCase()
        : DEFAULT_PUBLIC_SITE_BACKGROUND_COLOR,
      textColor: /^#[0-9A-F]{6}$/i.test(text(branding.textColor))
        ? text(branding.textColor).toUpperCase()
        : DEFAULT_PUBLIC_SITE_TEXT_COLOR,
      buttonTextColor: color(branding.buttonTextColor),
      labelColor: color(branding.labelColor, DEFAULT_PUBLIC_SITE_LABEL_COLOR),
      coverImageUrl: publicUrl(branding.coverImageUrl),
      description: localized(
        branding.description,
        undefined,
        PUBLIC_SITE_LIMITS.DESCRIPTION,
      ),
    },
    login: {
      eyebrow: localized(
        login.eyebrow,
        undefined,
        PUBLIC_SITE_LIMITS.SHORT_TEXT,
      ),
      headline: localized(
        login.headline,
        undefined,
        PUBLIC_SITE_LIMITS.SHORT_TEXT,
      ),
      supportingText: localized(
        login.supportingText,
        undefined,
        PUBLIC_SITE_LIMITS.DESCRIPTION,
      ),
      helpText: localized(
        login.helpText,
        undefined,
        PUBLIC_SITE_LIMITS.DESCRIPTION,
      ),
      backgroundImageUrl: publicUrl(login.backgroundImageUrl),
      labelColor: color(login.labelColor),
    },
    register: {
      eyebrow: localized(
        register.eyebrow,
        undefined,
        PUBLIC_SITE_LIMITS.SHORT_TEXT,
      ),
      headline: localized(
        register.headline,
        undefined,
        PUBLIC_SITE_LIMITS.SHORT_TEXT,
      ),
      supportingText: localized(
        register.supportingText,
        undefined,
        PUBLIC_SITE_LIMITS.DESCRIPTION,
      ),
      helpText: localized(
        register.helpText,
        undefined,
        PUBLIC_SITE_LIMITS.DESCRIPTION,
      ),
      backgroundImageUrl: publicUrl(register.backgroundImageUrl),
      labelColor: color(register.labelColor),
    },
    header: {
      navOrder: resolvedNavigation(header.navOrder),
      hiddenItems: resolvedHiddenItems(header.hiddenItems),
      primaryCta: resolvedPrimaryCta(header.primaryCta),
      announcement: {
        text: localized(
          announcement.text,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        url: publicUrl(announcement.url),
      },
    },
    footer: {
      description: localized(
        footer.description,
        undefined,
        PUBLIC_SITE_LIMITS.DESCRIPTION,
      ),
      openingHours: localized(
        footer.openingHours,
        undefined,
        PUBLIC_SITE_LIMITS.OPENING_HOURS,
      ),
      copyright: localized(
        footer.copyright,
        undefined,
        PUBLIC_SITE_LIMITS.COPYRIGHT,
      ),
      email: email(footer.email),
      phone: text(footer.phone, PUBLIC_SITE_LIMITS.PHONE),
      address: text(footer.address, PUBLIC_SITE_LIMITS.ADDRESS),
      social: {
        instagram: publicUrl(social.instagram, { allowRelative: false }),
        facebook: publicUrl(social.facebook, { allowRelative: false }),
        youtube: publicUrl(social.youtube, { allowRelative: false }),
        website: publicUrl(social.website, { allowRelative: false }),
      },
      legal: {
        studioRules: publicUrl(legal.studioRules),
        terms: publicUrl(legal.terms),
        privacy: publicUrl(legal.privacy),
        cancellation: publicUrl(legal.cancellation),
      },
    },
    pages: {
      home: {
        eyebrow: localized(
          homePage.eyebrow,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        headline: localized(
          homePage.headline,
          localizedText(displayName),
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        description: localized(
          homePage.description,
          localized(
            branding.description,
            undefined,
            PUBLIC_SITE_LIMITS.DESCRIPTION,
          ),
          PUBLIC_SITE_LIMITS.DESCRIPTION,
        ),
        labelColor: color(homePage.labelColor),
        headlineColor: color(homePage.headlineColor),
        sectionOrder: resolvedHomeSectionOrder(homePage.sectionOrder),
        hiddenSections: resolvedHiddenHomeSections(
          homePage.hiddenSections,
          homePage.sectionOrder,
        ),
        sectionContent: Object.fromEntries(
          PUBLIC_SITE_HOME_SECTIONS.map((section) => {
            const content = record(record(homePage.sectionContent)[section]);
            return [
              section,
              {
                title: localized(
                  content.title,
                  undefined,
                  PUBLIC_SITE_LIMITS.SHORT_TEXT,
                ),
                description: localized(content.description),
              },
            ];
          }),
        ) as TenantPublicSite["pages"]["home"]["sectionContent"],
      },
      book: {
        visible: bookPage.visible !== false,
        title: localized(
          bookPage.title,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        description: localized(bookPage.description),
      },
      courses: {
        visible: coursesPage.visible !== false,
        title: localized(
          coursesPage.title,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        description: localized(coursesPage.description),
      },
      memberships: {
        visible: membershipsPage.visible !== false,
        title: localized(
          membershipsPage.title,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        description: localized(membershipsPage.description),
      },
      vouchers: {
        visible: vouchersPage.visible !== false,
        title: localized(
          vouchersPage.title,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        description: localized(vouchersPage.description),
      },
      help: {
        visible: helpPage.visible !== false,
        title: localized(
          helpPage.title,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        description: localized(helpPage.description),
      },
    },
    customerPortal: {
      courses: {
        guestCheckoutEnabled: record(customerPortal.courses).guestCheckoutEnabled === true,
        locations: Array.isArray(record(customerPortal.courses).locations)
          ? record(customerPortal.courses).locations
              .filter((entry: any, index: number, entries: any[]) =>
                /^[a-f0-9]{24}$/i.test(String(entry?.locationId ?? "")) &&
                entries.findIndex(candidate =>
                  String(candidate?.locationId).toLowerCase() === String(entry.locationId).toLowerCase()) === index)
              .slice(0, 100)
              .map((entry: any) => ({
                locationId: String(entry.locationId).toLowerCase(),
                headline: localized(entry.headline, undefined, PUBLIC_SITE_LIMITS.SHORT_TEXT),
                description: localized(entry.description),
                heroImageUrl: publicUrl(entry.heroImageUrl),
              }))
          : [],
      },
      pages: Object.fromEntries(
        CUSTOMER_PORTAL_PAGE_IDS.map((page) => [
          page,
          {
            enabled:
              record(record(customerPortal.pages)[page]).enabled !== false,
          },
        ]),
      ) as TenantPublicSite["customerPortal"]["pages"],
      navigation: Object.fromEntries(
        CUSTOMER_PORTAL_NAVIGATION_KEYS.map((item) => [
          item,
          {
            visible:
              record(record(customerPortal.navigation)[item]).visible !== false,
          },
        ]),
      ) as TenantPublicSite["customerPortal"]["navigation"],
      appearance: serializePortalAppearance(customerPortalAppearance),
      dashboard: {
        eyebrow: localized(
          customerPortalDashboard.eyebrow,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        headline: localized(
          customerPortalDashboard.headline,
          undefined,
          PUBLIC_SITE_LIMITS.SHORT_TEXT,
        ),
        description: localized(customerPortalDashboard.description),
        labelColor: color(customerPortalDashboard.labelColor),
      },
    },
  };
};
