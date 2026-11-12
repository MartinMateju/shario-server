import { renderTenantEmailFrame } from "@/infrastructure/email/tenant-email-layout.service.js";
import { Types } from "mongoose";

import { EmailTemplate } from "@/modules/email-template/email-template.model.js";
import {
  EMAIL_TEMPLATE_CATEGORY,
  HEX_COLOR_REGEX,
} from "@/modules/email-template/email-template.constants.js";
import {
  emailHtmlToPlainText,
  escapeEmailHtml,
  renderEmailContent,
} from "@/modules/email-template/email-template.rendering.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import { REGISTERED_SENDER_PROVIDER } from "@/modules/registered-sender-email/registered-sender-email.constants.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import {
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
} from "@/modules/tenant-access/tenant-access.constants.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { resolveTenantCommerceOrigin } from "@/modules/checkout/checkout.urls.js";
import {
  getCommunicationIntlLocale,
  resolveCommunicationContentLocale,
  type CommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

export type CouponEmailOrder = {
  _id: unknown;
  tenant?: unknown;
  email: string;
  firstname?: string;
  lastname?: string;
  street?: string;
  city?: string;
  postalCode?: string;
  note?: string;
  quantity?: number;
  sendPost?: boolean;
  productNameSnapshot?: string;
  localeSnapshot?: string;
  validityTimezoneSnapshot?: string;
  expiresAtSnapshot?: Date | string | null;
  voucherSettingsSnapshot?: { validity?: { mode?: string } } | null;
};

type CouponEmailLayout = {
  tenant: unknown;
  isActive?: boolean;
  category?: string;
  isDefault?: boolean;
  headerHtml?: string;
  footerHtml?: string;
  logoUrl?: string;
  primaryColor?: string;
};

type CouponEmailMembership = {
  tenant: unknown;
  status?: string;
  role?: string;
  preferences?: {
    language?: unknown;
    notifications?: { email?: boolean };
  };
  user?: {
    email?: string;
    isEmailVerified?: boolean;
    isAccessGranted?: boolean;
  } | null;
};

export type CouponEmailContext = {
  tenantId: string;
  brandName: string;
  locale: CommunicationContentLocale;
  adminLocale: CommunicationContentLocale;
  timezone: string;
  adminEmail?: string;
  replyTo?: string;
  logoUrl: string;
  primaryColor: string;
  textColor: string;
  backgroundColor: string;
  studioAddress: string;
  studioPhone: string;
  layout: CouponEmailLayout | null;
  commerceOrigin?: string;
};

const mailbox = (value: unknown): string | undefined => {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)
    ? email
    : undefined;
};

const color = (value: unknown, fallback: string): string =>
  typeof value === "string" && HEX_COLOR_REGEX.test(value) ? value : fallback;

const safeLogoUrl = (value: unknown): string => {
  try {
    const url = new URL(String(value || ""));
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};

const safeTimezone = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.trim() }).format();
      return value.trim();
    } catch {
      // Invalid historical preferences must not block paid voucher delivery.
    }
  }
  return "UTC";
};

/** The order's persisted tenant is the only source of email identity. */
export const resolveCouponEmailContext = async (
  order: CouponEmailOrder,
): Promise<CouponEmailContext> => {
  const tenantId = String(order.tenant || "");
  if (!/^[a-f0-9]{24}$/i.test(tenantId) || !Types.ObjectId.isValid(tenantId)) {
    throw new Error("Voucher email requires the order's tenant.");
  }

  const [tenant, savedLayout, memberships, sender] = await Promise.all([
    TenantModel.findOne({ _id: tenantId })
      .select("name slug settings publicSite publicSiteEditor.published")
      .lean()
      .exec(),
    EmailTemplate.findOne({
      tenant: tenantId,
      category: EMAIL_TEMPLATE_CATEGORY.LAYOUT,
      isDefault: true,
      isActive: true,
    })
      .sort({ updatedAt: -1, _id: 1 })
      .lean<CouponEmailLayout | null>()
      .exec(),
    TenantMembershipModel.find({
      tenant: tenantId,
      status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
      role: { $in: [WORKSPACE_ROLE.OWNER, WORKSPACE_ROLE.ADMIN] },
      "preferences.notifications.email": { $ne: false },
    })
      .sort({ createdAt: 1, _id: 1 })
      .populate({
        path: "user",
        select: "email isEmailVerified isAccessGranted",
        match: { isEmailVerified: true, isAccessGranted: { $ne: false } },
      })
      .lean<CouponEmailMembership[]>()
      .exec(),
    // Only read an already verified reply address for template variables.
    // The managed transport resolves authenticated From and Reply-To itself.
    RegisteredSenderEmailModel.findOne({
      tenant: tenantId,
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
      isActive: true,
      replyToVerifiedAt: { $ne: null },
    })
      .select("tenant provider isActive replyToEmail replyToVerifiedAt")
      .sort({ isDefault: -1, createdAt: -1 })
      .lean()
      .exec(),
  ]);

  if (!tenant || String(tenant._id) !== tenantId) {
    throw new Error("Voucher email tenant was not found.");
  }

  // Never use unpublished editor drafts in customer emails.
  const publicSite = tenant.publicSiteEditor?.published || tenant.publicSite;
  const branding = publicSite?.branding;
  const footer = publicSite?.footer;
  const layout = savedLayout &&
      String(savedLayout.tenant) === tenantId &&
      savedLayout.isActive === true && savedLayout.isDefault === true &&
      savedLayout.category === EMAIL_TEMPLATE_CATEGORY.LAYOUT
    ? savedLayout
    : null;

  const eligibleMemberships = memberships.filter((membership) =>
    String(membership.tenant) === tenantId &&
    membership.status === TENANT_MEMBERSHIP_STATUS.ACTIVE &&
    [WORKSPACE_ROLE.OWNER, WORKSPACE_ROLE.ADMIN].some((role) => role === membership.role) &&
    membership.preferences?.notifications?.email !== false &&
    membership.user?.isEmailVerified === true &&
    membership.user?.isAccessGranted !== false &&
    mailbox(membership.user?.email),
  );
  const adminMembership =
    eligibleMemberships.find((membership) => membership.role === WORKSPACE_ROLE.OWNER) ||
    eligibleMemberships[0];
  const adminEmail = mailbox(adminMembership?.user?.email);
  const verifiedReplyTo = sender &&
      String(sender.tenant) === tenantId &&
      sender.provider === REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED &&
      sender.isActive === true && sender.replyToVerifiedAt
    ? mailbox(sender.replyToEmail)
    : undefined;

  return {
    tenantId,
    // Long-lived purchase links use today's canonical tenant subdomain, never
    // a saved custom domain that may since have been removed or reassigned.
    commerceOrigin: typeof tenant.slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenant.slug)
      ? resolveTenantCommerceOrigin({ tenant: { slug: tenant.slug } }) : undefined,
    brandName: String(branding?.displayName || tenant.name || "shario.io")
      .replace(/[\r\n]+/g, " ").trim() || "shario.io",
    locale: resolveCommunicationContentLocale(
      order.localeSnapshot,
      resolveCommunicationContentLocale(
        tenant.settings?.publicDefaultLanguage || tenant.settings?.defaultLanguage,
      ),
    ),
    adminLocale: resolveCommunicationContentLocale(
      adminMembership?.preferences?.language || tenant.settings?.adminLanguage ||
        tenant.settings?.defaultLanguage,
    ),
    timezone: safeTimezone(order.validityTimezoneSnapshot, tenant.settings?.timezone),
    adminEmail,
    replyTo: verifiedReplyTo || adminEmail,
    logoUrl: safeLogoUrl(layout?.logoUrl) || safeLogoUrl(branding?.logoUrl),
    primaryColor: color(layout?.primaryColor || branding?.accentColor, "#1f1a17"),
    textColor: color(branding?.textColor, "#1f1a17"),
    backgroundColor: color(branding?.backgroundColor, "#ffffff"),
    studioAddress: String(footer?.address || ""),
    studioPhone: String(footer?.phone || ""),
    layout,
  };
};

/** State the issued code's actual validity even when a legacy PDF is static. */
export const buildCouponExpiryHtml = (
  order: CouponEmailOrder,
  context: CouponEmailContext,
  locale: CommunicationContentLocale = context.locale,
): string => {
  const cs = locale === "cs";
  if (order.expiresAtSnapshot) {
    const expiresAt = new Date(order.expiresAtSnapshot);
    if (Number.isFinite(expiresAt.getTime())) {
      const date = new Intl.DateTimeFormat(getCommunicationIntlLocale(locale), {
        timeZone: context.timezone,
        dateStyle: "long",
      }).format(expiresAt);
      return `<p><strong>${cs ? "Platnost poukazu do" : "Voucher valid until"}: ${escapeEmailHtml(date)}</strong> (${escapeEmailHtml(context.timezone)})</p>`;
    }
  }
  if (order.voucherSettingsSnapshot?.validity?.mode === "none") {
    return `<p><strong>${cs ? "Poukaz nemá datum expirace." : "This voucher has no expiration date."}</strong></p>`;
  }
  // Old orders do not always snapshot code expiry. Avoid inventing an expiry
  // or claiming perpetual validity for a code whose actual expiry is unknown.
  return "";
};

/** Tenant layout fragments share the existing sanitizer/variable renderer. */
export const wrapCouponEmail = ({
  context,
  order,
  body,
}: {
  context: CouponEmailContext;
  order: CouponEmailOrder;
  body: string;
}): { html: string; text: string } => {
  const variables = {
    firstName: order.firstname || "",
    lastName: order.lastname || "",
    fullName: [order.firstname, order.lastname].filter(Boolean).join(" "),
    email: order.email,
    studioName: context.brandName,
    studio: context.brandName,
    studioEmail: context.replyTo || "",
    studioAddress: context.studioAddress,
    studioPhone: context.studioPhone,
    logo: context.logoUrl,
    orderNumber: String(order._id),
    productName: order.productNameSnapshot || "",
    itemCount: String(order.quantity || 1),
  };
  const defaultHeader = context.logoUrl
    ? `<img src="${escapeEmailHtml(context.logoUrl)}" alt="${escapeEmailHtml(context.brandName)}" width="160" style="max-width:160px;height:auto;">`
    : `<p style="color:${context.primaryColor};font-weight:700;">${escapeEmailHtml(context.brandName)}</p>`;
  const defaultFooter = `<p>${escapeEmailHtml(context.brandName)}</p>`;
  const fragment = (source: string | undefined, fallback: string): string => {
    if (!source?.trim()) return fallback;
    try {
      return renderEmailContent({
        source: { subject: "Voucher", htmlContent: source, format: "html" },
        locale: context.locale,
        variables,
      }).html;
    } catch {
      // A malformed historical layout must not block a paid customer's voucher.
      return fallback;
    }
  };
  const html = renderTenantEmailFrame({
    header: fragment(context.layout?.headerHtml, defaultHeader),
    body,
    footer: fragment(context.layout?.footerHtml, defaultFooter),
    backgroundColor: context.backgroundColor,
    textColor: context.textColor,
  });
  return { html, text: emailHtmlToPlainText(html) };
};
