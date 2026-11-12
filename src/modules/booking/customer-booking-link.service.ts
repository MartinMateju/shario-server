import { TenantModel } from "@/modules/tenants/tenant.model.js";
import type { ClientSession } from "mongoose";
import {
  buildTenantCommerceUrl,
  normalizeCommerceLocale,
  resolveTenantCommerceOrigin,
  type CommerceLocale,
} from "@/modules/checkout/checkout.urls.js";

type CustomerBookingLinkTenant = {
  slug: string;
  plan?: unknown;
  planVersion?: unknown;
  domains?: Array<{
    hostname?: string;
    status?: string;
    type?: string;
  }>;
  settings?: {
    defaultLanguage?: string;
    publicDefaultLanguage?: string;
  };
};

export type CustomerBookingLink = {
  locale: CommerceLocale;
  url: string;
};

export const buildCustomerBookingLink = (
  tenant: CustomerBookingLinkTenant,
): CustomerBookingLink => {
  const publicDefaultLanguage = String(
    tenant.settings?.publicDefaultLanguage ||
      tenant.settings?.defaultLanguage ||
      "",
  ).toLowerCase();
  const locale = normalizeCommerceLocale(
    publicDefaultLanguage === "cz" ? "cs" : publicDefaultLanguage,
  );
  const origin = resolveTenantCommerceOrigin({ tenant });

  return {
    locale,
    url: buildTenantCommerceUrl({
      origin,
      locale,
      path: "portal",
      query: { tab: "my-bookings" },
    }),
  };
};

export const resolveCustomerBookingLink = async (
  tenantId: unknown,
  session?: ClientSession,
): Promise<CustomerBookingLink | null> => {
  if (!tenantId) return null;

  const tenant = await TenantModel.findById(tenantId)
    .select(
      "slug plan planVersion domains settings.defaultLanguage settings.publicDefaultLanguage",
    )
    .session(session ?? null)
    .lean<CustomerBookingLinkTenant>()
    .exec();

  if (!tenant?.slug) return null;

  return buildCustomerBookingLink(tenant);
};
