import { z } from "zod";
import { portalAppearancePatchSchema } from "@/shared/appearance/portal-appearance.validators.js";

import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  type RolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

import {
  CUSTOMER_PORTAL_NAVIGATION_KEYS,
  CUSTOMER_PORTAL_PAGE_IDS,
  type CustomerPortalNavigationKey,
  type CustomerPortalPageId,
  PUBLIC_SITE_LIMITS,
  PUBLIC_SITE_LOGO_SIZE,
  PUBLIC_SITE_FONT_PRESETS,
  PUBLIC_SITE_HOME_SECTIONS,
  PUBLIC_SITE_NAV_ITEMS,
  PUBLIC_SITE_PRIMARY_CTAS,
  PUBLIC_SITE_STYLE_PRESETS,
} from "./tenant-public-site.constants.js";

const hasUniqueValues = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

const LEGACY_PUBLIC_SITE_NAV_ORDER = [
  "book",
  "courses",
  "memberships",
  "help",
] as const;

const migrateLegacyNavOrder = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;

  const legacyItems = new Set<string>(LEGACY_PUBLIC_SITE_NAV_ORDER);
  const isCompleteLegacyOrder =
    value.length === LEGACY_PUBLIC_SITE_NAV_ORDER.length &&
    new Set(value).size === value.length &&
    value.every((item) => typeof item === "string" && legacyItems.has(item));

  if (!isCompleteLegacyOrder) return value;

  const migrated = [...value];
  const isDefaultOrder = LEGACY_PUBLIC_SITE_NAV_ORDER.every(
    (item, index) => value[index] === item,
  );

  if (isDefaultOrder) {
    migrated.splice(migrated.indexOf("help"), 0, "vouchers");
  } else {
    migrated.push("vouchers");
  }

  return migrated;
};

export const isSafePublicSiteText = (value: string): boolean =>
  !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) &&
  !/<\/?[a-z][^>]*>/i.test(value);

const isSafeRelativeUrl = (value: string): boolean =>
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !value.includes("\\") &&
  !/[\u0000-\u001F\u007F]/.test(value);

export const isSafePublicSiteUrl = (
  value: string,
  { allowRelative = true }: { allowRelative?: boolean } = {},
): boolean => {
  if (!value) return true;
  if (allowRelative && isSafeRelativeUrl(value)) return true;

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
};

const boundedText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      isSafePublicSiteText,
      "HTML and control characters are not allowed.",
    );
const localizedTextPatchSchema = (
  max: number = PUBLIC_SITE_LIMITS.DESCRIPTION,
) => {
  const shape = Object.fromEntries(
    ROLLOUT_ELIGIBLE_APP_LOCALES.map((locale) => [
      locale,
      boundedText(max).optional(),
    ]),
  ) as Record<
    RolloutEligibleAppLocale,
    z.ZodOptional<ReturnType<typeof boundedText>>
  >;

  return z
    .object(shape)
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: "At least one localized value must be provided.",
    });
};

const safeUrl = ({ allowRelative = true }: { allowRelative?: boolean } = {}) =>
  z
    .string()
    .trim()
    .max(PUBLIC_SITE_LIMITS.URL)
    .refine(
      (value) => isSafePublicSiteUrl(value, { allowRelative }),
      allowRelative
        ? "Enter an HTTPS or root-relative URL."
        : "Enter an HTTPS URL.",
    );

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Enter a six-digit hex colour.")
  .transform((value) => value.toUpperCase());

const inheritableColor = z.union([z.literal(""), hexColor]);

const brandingPatchSchema = z
  .object({
    displayName: boundedText(PUBLIC_SITE_LIMITS.DISPLAY_NAME).optional(),
    stylePreset: z.enum(PUBLIC_SITE_STYLE_PRESETS).optional(),
    fontPreset: z.enum(PUBLIC_SITE_FONT_PRESETS).optional(),
    logoUrl: safeUrl().optional(),
    logoRedirectEnabled: z.boolean().optional(),
    logoRedirectUrl: safeUrl().optional(),
    logoSize: z
      .number()
      .int()
      .min(PUBLIC_SITE_LOGO_SIZE.MIN)
      .max(PUBLIC_SITE_LOGO_SIZE.MAX)
      .optional(),
    faviconUrl: safeUrl().optional(),
    accentColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, "Enter a six-digit hex colour.")
      .transform((value) => value.toUpperCase())
      .optional(),
    secondaryColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, "Enter a six-digit hex colour.")
      .transform((value) => value.toUpperCase())
      .optional(),
    backgroundColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, "Enter a six-digit hex colour.")
      .transform((value) => value.toUpperCase())
      .optional(),
    textColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, "Enter a six-digit hex colour.")
      .transform((value) => value.toUpperCase())
      .optional(),
    labelColor: hexColor.optional(),
    buttonTextColor: inheritableColor.optional(),
    coverImageUrl: safeUrl().optional(),
    description: localizedTextPatchSchema().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one branding setting must be provided.",
  })
  .refine(
    (value) => value.logoRedirectEnabled !== true || value.logoRedirectUrl !== "",
    {
      path: ["logoRedirectUrl"],
      message: "Enter a destination URL to enable the logo link.",
    },
  );

const loginPatchSchema = z
  .object({
    eyebrow: localizedTextPatchSchema(PUBLIC_SITE_LIMITS.SHORT_TEXT).optional(),
    headline: localizedTextPatchSchema(
      PUBLIC_SITE_LIMITS.SHORT_TEXT,
    ).optional(),
    supportingText: localizedTextPatchSchema().optional(),
    helpText: localizedTextPatchSchema().optional(),
    backgroundImageUrl: safeUrl().optional(),
    labelColor: inheritableColor.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one login setting must be provided.",
  });

const registerPatchSchema = z
  .object({
    eyebrow: localizedTextPatchSchema(PUBLIC_SITE_LIMITS.SHORT_TEXT).optional(),
    headline: localizedTextPatchSchema(
      PUBLIC_SITE_LIMITS.SHORT_TEXT,
    ).optional(),
    supportingText: localizedTextPatchSchema().optional(),
    helpText: localizedTextPatchSchema().optional(),
    backgroundImageUrl: safeUrl().optional(),
    labelColor: inheritableColor.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one registration setting must be provided.",
  });

const navOrderSchema = z.preprocess(
  migrateLegacyNavOrder,
  z
    .array(z.enum(PUBLIC_SITE_NAV_ITEMS))
    .length(
      PUBLIC_SITE_NAV_ITEMS.length,
      "Navigation order must contain every supported item.",
    )
    .refine(hasUniqueValues, "Navigation items must be unique."),
);

const hiddenItemsSchema = z
  .array(z.enum(PUBLIC_SITE_NAV_ITEMS))
  .max(PUBLIC_SITE_NAV_ITEMS.length)
  .refine(hasUniqueValues, "Hidden navigation items must be unique.");

const announcementPatchSchema = z
  .object({
    text: localizedTextPatchSchema(PUBLIC_SITE_LIMITS.SHORT_TEXT).optional(),
    url: safeUrl().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one announcement setting must be provided.",
  });

const headerPatchSchema = z
  .object({
    navOrder: navOrderSchema.optional(),
    hiddenItems: hiddenItemsSchema.optional(),
    primaryCta: z.enum(PUBLIC_SITE_PRIMARY_CTAS).optional(),
    announcement: announcementPatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one header setting must be provided.",
  });

const socialPatchSchema = z
  .object({
    instagram: safeUrl({ allowRelative: false }).optional(),
    facebook: safeUrl({ allowRelative: false }).optional(),
    youtube: safeUrl({ allowRelative: false }).optional(),
    website: safeUrl({ allowRelative: false }).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one social link must be provided.",
  });

const legalPatchSchema = z
  .object({
    studioRules: safeUrl().optional(),
    terms: safeUrl().optional(),
    privacy: safeUrl().optional(),
    cancellation: safeUrl().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one legal link must be provided.",
  });

const footerPatchSchema = z
  .object({
    description: localizedTextPatchSchema().optional(),
    openingHours: localizedTextPatchSchema(
      PUBLIC_SITE_LIMITS.OPENING_HOURS,
    ).optional(),
    copyright: localizedTextPatchSchema(
      PUBLIC_SITE_LIMITS.COPYRIGHT,
    ).optional(),
    email: z
      .union([
        z.literal(""),
        z.string().trim().toLowerCase().email().max(PUBLIC_SITE_LIMITS.EMAIL),
      ])
      .optional(),
    phone: boundedText(PUBLIC_SITE_LIMITS.PHONE).optional(),
    address: boundedText(PUBLIC_SITE_LIMITS.ADDRESS).optional(),
    social: socialPatchSchema.optional(),
    legal: legalPatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one footer setting must be provided.",
  });

const pageHeadingPatchSchema = z
  .object({
    title: localizedTextPatchSchema(PUBLIC_SITE_LIMITS.SHORT_TEXT).optional(),
    description: localizedTextPatchSchema().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one page setting must be provided.",
  });

const publicPagePatchSchema = pageHeadingPatchSchema.safeExtend({
  visible: z.boolean().optional(),
});

const homeSectionOrderSchema = z
  .array(z.enum(PUBLIC_SITE_HOME_SECTIONS))
  .max(PUBLIC_SITE_HOME_SECTIONS.length)
  .refine(hasUniqueValues, "Homepage sections must be unique.");

const hiddenHomeSectionsSchema = z
  .array(z.enum(PUBLIC_SITE_HOME_SECTIONS))
  .max(PUBLIC_SITE_HOME_SECTIONS.length)
  .refine(hasUniqueValues, "Hidden homepage sections must be unique.");

const homeSectionContentPatchSchema = z
  .object(
    Object.fromEntries(
      PUBLIC_SITE_HOME_SECTIONS.map((section) => [
        section,
        pageHeadingPatchSchema.optional(),
      ]),
    ),
  )
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one homepage section must be provided.",
  });

const homePagePatchSchema = z
  .object({
    eyebrow: localizedTextPatchSchema(PUBLIC_SITE_LIMITS.SHORT_TEXT).optional(),
    headline: localizedTextPatchSchema(
      PUBLIC_SITE_LIMITS.SHORT_TEXT,
    ).optional(),
    description: localizedTextPatchSchema().optional(),
    labelColor: inheritableColor.optional(),
    headlineColor: inheritableColor.optional(),
    sectionOrder: homeSectionOrderSchema.optional(),
    hiddenSections: hiddenHomeSectionsSchema.optional(),
    sectionContent: homeSectionContentPatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one home-page setting must be provided.",
  });

const pagesPatchSchema = z
  .object({
    home: homePagePatchSchema.optional(),
    book: publicPagePatchSchema.optional(),
    courses: publicPagePatchSchema.optional(),
    memberships: publicPagePatchSchema.optional(),
    vouchers: publicPagePatchSchema.optional(),
    help: publicPagePatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one public page must be provided.",
  });

const customerPortalDashboardPatchSchema = z
  .object({
    eyebrow: localizedTextPatchSchema(PUBLIC_SITE_LIMITS.SHORT_TEXT).optional(),
    headline: localizedTextPatchSchema(
      PUBLIC_SITE_LIMITS.SHORT_TEXT,
    ).optional(),
    description: localizedTextPatchSchema().optional(),
    labelColor: inheritableColor.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one customer-portal dashboard setting must be provided.",
  });

const customerPortalPagePatchSchema = z
  .object({ enabled: z.boolean() })
  .strict();

const customerPortalPagesPatchSchema = z
  .object(
    Object.fromEntries(
      CUSTOMER_PORTAL_PAGE_IDS.map((page) => [
        page,
        customerPortalPagePatchSchema.optional(),
      ]),
    ) as Record<
      CustomerPortalPageId,
      z.ZodOptional<typeof customerPortalPagePatchSchema>
    >,
  )
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one customer-portal page must be provided.",
  });

const customerPortalNavigationItemPatchSchema = z
  .object({ visible: z.boolean() })
  .strict();

const customerPortalNavigationPatchSchema = z
  .object(
    Object.fromEntries(
      CUSTOMER_PORTAL_NAVIGATION_KEYS.map((item) => [
        item,
        customerPortalNavigationItemPatchSchema.optional(),
      ]),
    ) as Record<
      CustomerPortalNavigationKey,
      z.ZodOptional<typeof customerPortalNavigationItemPatchSchema>
    >,
  )
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one customer-portal navigation item must be provided.",
  });

const customerPortalPatchSchema = z
  .object({
    courses: z.object({
      guestCheckoutEnabled: z.boolean().optional(),
      locations: z.array(z.object({
        locationId: z.string().regex(/^[a-f0-9]{24}$/i).transform(value => value.toLowerCase()),
        headline: localizedTextPatchSchema(PUBLIC_SITE_LIMITS.SHORT_TEXT).optional(),
        description: localizedTextPatchSchema().optional(),
        heroImageUrl: safeUrl().optional(),
      }).strict()).max(100).refine(
        entries => hasUniqueValues(entries.map(entry => entry.locationId)),
        "Each studio location can have only one course-page override.",
      ).optional(),
    }).strict().refine(value => Object.keys(value).length > 0, {
      message: "At least one course-page setting must be provided.",
    }).optional(),
    pages: customerPortalPagesPatchSchema.optional(),
    navigation: customerPortalNavigationPatchSchema.optional(),
    appearance: portalAppearancePatchSchema.optional(),
    dashboard: customerPortalDashboardPatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one customer-portal setting must be provided.",
  });

/**
 * Controlled public-site customization only. Unknown fields (including HTML,
 * CSS, scripts and arbitrary component configuration) are rejected.
 */
export const updateTenantPublicSiteSchema = z
  .object({
    branding: brandingPatchSchema.optional(),
    login: loginPatchSchema.optional(),
    register: registerPatchSchema.optional(),
    header: headerPatchSchema.optional(),
    footer: footerPatchSchema.optional(),
    pages: pagesPatchSchema.optional(),
    customerPortal: customerPortalPatchSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one public-site setting must be provided.",
  });

export type UpdateTenantPublicSiteInput = z.infer<
  typeof updateTenantPublicSiteSchema
>;

const revisionSchema = z.number().int().min(0);

export const mutateTenantPublicSiteDraftSchema = z.union([
  z
    .object({
      patch: updateTenantPublicSiteSchema,
      revision: revisionSchema.optional(),
    })
    .strict(),
  updateTenantPublicSiteSchema.transform((patch) => ({ patch })),
]);

export const publicSiteRevisionSchema = z
  .object({
    revision: revisionSchema,
  })
  .strict();

export const publicSiteVersionParamsSchema = z
  .object({
    versionId: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{24}$/, "Invalid public-site version id."),
  })
  .strict();
