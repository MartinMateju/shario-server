import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";

/** Match the public client's URL normalization after the published serializer's safety checks. */
const normalizeLegalUrl = (url: string): string =>
  !url || url.startsWith("/") ? url : new URL(url).href;

/** Course descriptions are presentation content, never legal consent evidence. */
export const getPublishedGuestCourseLegalLinks = (
  tenant: Parameters<typeof serializeTenantPublicSite>[0],
) => {
  const legal = serializeTenantPublicSite(tenant, { snapshot: "published" })
    .footer.legal;
  return {
    terms: normalizeLegalUrl(legal.terms),
    cancellation: normalizeLegalUrl(legal.cancellation),
  };
};
