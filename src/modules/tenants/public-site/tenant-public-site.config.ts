import { derivePublicTenantCapabilities } from "./tenant-public-site.capabilities.js";
import {
  serializeTenantPublicSite,
  type TenantPublicSiteSnapshot,
} from "./tenant-public-site.serializers.js";

import type { TenantDocument } from "../tenant.types.js";
import { resolveTenantLocaleSettings } from "../tenant-locale.js";
import { getTenantCustomerCapabilities } from "../customer-piece-access.service.js";
import { resolveTenantPublicOrigin } from "@/modules/checkout/checkout.urls.js";

/**
 * One serializer is shared by the anonymous live endpoint and the
 * authenticated draft preview. Keeping the shape identical prevents preview
 * from becoming a second, less-tested rendering contract.
 */
export const buildPublicTenantConfig = async (
  tenant: TenantDocument,
  options: { snapshot?: TenantPublicSiteSnapshot } = {},
) => {
  const localeSettings = resolveTenantLocaleSettings(tenant.settings);

  const config = {
    id: String(tenant._id),
    name: tenant.name,
    slug: tenant.slug,
    publicOrigin: resolveTenantPublicOrigin(tenant),
    settings: {
      defaultLanguage: localeSettings.defaultLanguage,
      publicDefaultLanguage: localeSettings.publicDefaultLanguage,
      supportedPublicLanguages: localeSettings.supportedPublicLanguages,
      currency: tenant.settings.currency,
      timezone: tenant.settings.timezone,
    },
    publicSite: serializeTenantPublicSite(tenant, options),
  };

  // These independent reads both use the current tenant. Do not make the
  // customer-location lookup wait for the public catalogue capability queries.
  const [publicCapabilities, customerCapabilities] = await Promise.all([
    derivePublicTenantCapabilities(tenant, undefined, options),
    getTenantCustomerCapabilities(tenant),
  ]);

  return { ...config, publicCapabilities, customerCapabilities };
};
