import { derivePublicTenantCapabilities } from "./tenant-public-site.capabilities.js";
import {
  serializeTenantPublicSite,
  type TenantPublicSiteSnapshot,
} from "./tenant-public-site.serializers.js";

import type { TenantDocument } from "../tenant.types.js";
import { resolveTenantLocaleSettings } from "../tenant-locale.js";
import { getTenantCustomerCapabilities } from "../customer-piece-access.service.js";

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

  return {
    id: String(tenant._id),
    name: tenant.name,
    slug: tenant.slug,
    settings: {
      defaultLanguage: localeSettings.defaultLanguage,
      publicDefaultLanguage: localeSettings.publicDefaultLanguage,
      supportedPublicLanguages: localeSettings.supportedPublicLanguages,
      currency: tenant.settings.currency,
      timezone: tenant.settings.timezone,
    },
    publicSite: serializeTenantPublicSite(tenant, options),
    publicCapabilities: await derivePublicTenantCapabilities(
      tenant,
      undefined,
      options,
    ),
    customerCapabilities: await getTenantCustomerCapabilities(tenant),
  };
};
