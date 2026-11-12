import { Schema } from "mongoose";
import { portalAppearanceSchema } from "@/shared/appearance/portal-appearance.schema.js";

import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";

import type { TenantPublicSite } from "../tenant.types.js";
import { isSafePublicSiteUrl } from "./tenant-public-site.validators.js";
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
} from "./tenant-public-site.constants.js";

const uniqueValues = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

const localizedTextSchema = new Schema(
  Object.fromEntries(
    ROLLOUT_ELIGIBLE_APP_LOCALES.map((locale) => [
      locale,
      {
        type: String,
        trim: true,
        default: "",
        maxlength: PUBLIC_SITE_LIMITS.DESCRIPTION,
      },
    ]),
  ),
  { _id: false },
);

const publicSiteBrandingSchema = new Schema(
  {
    displayName: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.DISPLAY_NAME,
    },
    stylePreset: {
      type: String,
      enum: PUBLIC_SITE_STYLE_PRESETS,
      default: DEFAULT_PUBLIC_SITE_STYLE_PRESET,
    },
    fontPreset: {
      type: String,
      enum: PUBLIC_SITE_FONT_PRESETS,
      default: DEFAULT_PUBLIC_SITE_FONT_PRESET,
    },
    logoUrl: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.URL,
    },
    logoSize: {
      type: Number,
      default: PUBLIC_SITE_LOGO_SIZE.DEFAULT,
      min: PUBLIC_SITE_LOGO_SIZE.MIN,
      max: PUBLIC_SITE_LOGO_SIZE.MAX,
      validate: {
        validator: Number.isInteger,
        message: "Logo size must be a whole number.",
      },
    },
    logoRedirectEnabled: {
      type: Boolean,
      default: false,
    },
    logoRedirectUrl: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.URL,
      required: function (this: { logoRedirectEnabled?: boolean }) {
        return this.logoRedirectEnabled === true;
      },
      validate: {
        validator: (value: string) => isSafePublicSiteUrl(value),
        message: "Enter an HTTPS or root-relative URL.",
      },
    },
    faviconUrl: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.URL,
    },
    accentColor: {
      type: String,
      trim: true,
      uppercase: true,
      default: DEFAULT_PUBLIC_SITE_ACCENT_COLOR,
      match: /^#[0-9A-F]{6}$/,
    },
    secondaryColor: {
      type: String,
      trim: true,
      uppercase: true,
      default: DEFAULT_PUBLIC_SITE_SECONDARY_COLOR,
      match: /^#[0-9A-F]{6}$/,
    },
    backgroundColor: {
      type: String,
      trim: true,
      uppercase: true,
      default: DEFAULT_PUBLIC_SITE_BACKGROUND_COLOR,
      match: /^#[0-9A-F]{6}$/,
    },
    textColor: {
      type: String,
      trim: true,
      uppercase: true,
      default: DEFAULT_PUBLIC_SITE_TEXT_COLOR,
      match: /^#[0-9A-F]{6}$/,
    },
    buttonTextColor: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      match: /^(?:|#[0-9A-F]{6})$/,
    },
    labelColor: {
      type: String,
      trim: true,
      uppercase: true,
      default: DEFAULT_PUBLIC_SITE_LABEL_COLOR,
      match: /^#[0-9A-F]{6}$/,
    },
    coverImageUrl: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.URL,
    },
    description: {
      type: localizedTextSchema,
      default: () => ({}),
    },
  },
  { _id: false },
);

const publicSiteLoginSchema = new Schema(
  {
    eyebrow: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    headline: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    supportingText: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    helpText: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    backgroundImageUrl: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.URL,
    },
    labelColor: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      match: /^(?:|#[0-9A-F]{6})$/,
    },
  },
  { _id: false },
);

const publicSiteRegisterSchema = new Schema(
  {
    eyebrow: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    headline: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    supportingText: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    helpText: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    backgroundImageUrl: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.URL,
    },
    labelColor: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      match: /^(?:|#[0-9A-F]{6})$/,
    },
  },
  { _id: false },
);

const publicSiteHeaderSchema = new Schema(
  {
    navOrder: {
      type: [
        {
          type: String,
          enum: PUBLIC_SITE_NAV_ITEMS,
        },
      ],
      default: () => [...DEFAULT_PUBLIC_SITE_NAV_ORDER],
      validate: {
        validator: uniqueValues,
        message: "Public navigation items must be unique.",
      },
    },
    hiddenItems: {
      type: [
        {
          type: String,
          enum: PUBLIC_SITE_NAV_ITEMS,
        },
      ],
      default: [],
      validate: {
        validator: uniqueValues,
        message: "Hidden public navigation items must be unique.",
      },
    },
    primaryCta: {
      type: String,
      enum: PUBLIC_SITE_PRIMARY_CTAS,
      default: PUBLIC_SITE_PRIMARY_CTA.AUTO,
    },
    announcement: {
      type: new Schema(
        {
          text: {
            type: localizedTextSchema,
            default: () => ({}),
          },
          url: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { _id: false },
);

const publicSiteFooterSchema = new Schema(
  {
    description: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    openingHours: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    copyright: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.EMAIL,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.PHONE,
    },
    address: {
      type: String,
      trim: true,
      default: "",
      maxlength: PUBLIC_SITE_LIMITS.ADDRESS,
    },
    social: {
      type: new Schema(
        {
          instagram: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
          facebook: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
          youtube: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
          website: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    legal: {
      type: new Schema(
        {
          studioRules: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
          terms: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
          privacy: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
          cancellation: {
            type: String,
            trim: true,
            default: "",
            maxlength: PUBLIC_SITE_LIMITS.URL,
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { _id: false },
);

const pageHeadingSchema = new Schema(
  {
    title: {
      type: localizedTextSchema,
      default: () => ({}),
    },
    description: {
      type: localizedTextSchema,
      default: () => ({}),
    },
  },
  { _id: false },
);

const publicSitePageSchema = pageHeadingSchema.clone();
publicSitePageSchema.add({
  // Existing sites keep their pages until an owner explicitly hides them.
  visible: { type: Boolean, default: true },
});

const publicSitePagesSchema = new Schema(
  {
    home: {
      type: new Schema(
        {
          eyebrow: {
            type: localizedTextSchema,
            default: () => ({}),
          },
          headline: {
            type: localizedTextSchema,
            default: () => ({}),
          },
          description: {
            type: localizedTextSchema,
            default: () => ({}),
          },
          labelColor: {
            type: String,
            trim: true,
            uppercase: true,
            default: "",
            match: /^(?:|#[0-9A-F]{6})$/,
          },
          headlineColor: {
            type: String,
            trim: true,
            uppercase: true,
            default: "",
            match: /^(?:|#[0-9A-F]{6})$/,
          },
          sectionOrder: {
            type: [
              {
                type: String,
                enum: PUBLIC_SITE_HOME_SECTIONS,
              },
            ],
            default: () => [...DEFAULT_PUBLIC_SITE_HOME_SECTION_ORDER],
            validate: {
              validator: (values: string[]) => uniqueValues(values),
              message: "Homepage sections must be unique.",
            },
          },
          hiddenSections: {
            type: [
              {
                type: String,
                enum: PUBLIC_SITE_HOME_SECTIONS,
              },
            ],
            default: () => [...DEFAULT_PUBLIC_SITE_HIDDEN_HOME_SECTIONS],
            validate: {
              validator: uniqueValues,
              message: "Hidden homepage sections must be unique.",
            },
          },
          sectionContent: {
            type: new Schema(
              Object.fromEntries(
                PUBLIC_SITE_HOME_SECTIONS.map((section) => [
                  section,
                  {
                    type: pageHeadingSchema,
                    default: () => ({}),
                  },
                ]),
              ),
              { _id: false },
            ),
            default: () => ({}),
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    book: {
      type: publicSitePageSchema,
      default: () => ({}),
    },
    courses: {
      type: publicSitePageSchema,
      default: () => ({}),
    },
    memberships: {
      type: publicSitePageSchema,
      default: () => ({}),
    },
    vouchers: {
      type: publicSitePageSchema,
      default: () => ({}),
    },
    help: {
      type: publicSitePageSchema,
      default: () => ({}),
    },
  },
  { _id: false },
);

const customerPortalPageSchema = new Schema(
  { enabled: { type: Boolean, default: true } },
  { _id: false },
);

const customerPortalNavigationItemSchema = new Schema(
  { visible: { type: Boolean, default: true } },
  { _id: false },
);

const publicSiteCustomerPortalSchema = new Schema(
  {
    courses: {
      type: new Schema(
        {
          guestCheckoutEnabled: { type: Boolean, default: false },
          locations: {
            type: [new Schema({
              locationId: { type: String, required: true, match: /^[a-f0-9]{24}$/i },
              headline: { type: localizedTextSchema, default: () => ({}) },
              description: { type: localizedTextSchema, default: () => ({}) },
              heroImageUrl: { type: String, trim: true, default: "", maxlength: PUBLIC_SITE_LIMITS.URL },
            }, { _id: false })],
            default: () => [],
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    pages: {
      type: new Schema(
        Object.fromEntries(
          CUSTOMER_PORTAL_PAGE_IDS.map((page) => [
            page,
            { type: customerPortalPageSchema, default: () => ({}) },
          ]),
        ),
        { _id: false },
      ),
      default: () => ({}),
    },
    navigation: {
      type: new Schema(
        Object.fromEntries(
          CUSTOMER_PORTAL_NAVIGATION_KEYS.map((item) => [
            item,
            { type: customerPortalNavigationItemSchema, default: () => ({}) },
          ]),
        ),
        { _id: false },
      ),
      default: () => ({}),
    },
    appearance: {
      type: portalAppearanceSchema,
      default: () => ({}),
    },
    dashboard: {
      type: new Schema(
        {
          eyebrow: {
            type: localizedTextSchema,
            default: () => ({}),
          },
          headline: {
            type: localizedTextSchema,
            default: () => ({}),
          },
          description: {
            type: localizedTextSchema,
            default: () => ({}),
          },
          labelColor: {
            type: String,
            trim: true,
            uppercase: true,
            default: "",
            match: /^(?:|#[0-9A-F]{6})$/,
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { _id: false },
);

export const tenantPublicSiteSchema = new Schema<TenantPublicSite>(
  {
    branding: {
      type: publicSiteBrandingSchema,
      default: () => ({}),
    },
    login: {
      type: publicSiteLoginSchema,
      default: () => ({}),
    },
    register: {
      type: publicSiteRegisterSchema,
      default: () => ({}),
    },
    header: {
      type: publicSiteHeaderSchema,
      default: () => ({}),
    },
    footer: {
      type: publicSiteFooterSchema,
      default: () => ({}),
    },
    pages: {
      type: publicSitePagesSchema,
      default: () => ({}),
    },
    customerPortal: {
      type: publicSiteCustomerPortalSchema,
      default: () => ({}),
    },
  },
  { _id: false },
);

export const tenantPublicSiteEditorSchema = new Schema(
  {
    draft: {
      type: tenantPublicSiteSchema,
      default: undefined,
    },
    published: {
      type: tenantPublicSiteSchema,
      default: undefined,
    },
    draftRevision: {
      type: Number,
      min: 0,
      default: 0,
    },
    publishedRevision: {
      type: Number,
      min: 0,
      default: 0,
    },
    draftUpdatedAt: {
      type: Date,
      default: undefined,
    },
    publishedAt: {
      type: Date,
      default: undefined,
    },
    publishedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
    },
    draftRestoredFromVersion: {
      type: Schema.Types.ObjectId,
      ref: "TenantPublicSiteVersion",
      default: undefined,
    },
  },
  { _id: false },
);
