import { TENANT_DOMAIN_STATUS, TENANT_STATUS } from "./tenant.constants.js";

export const activeTenantByHostnameQuery = (hostname: string) => ({
  domains: {
    $elemMatch: {
      hostname: hostname.toLowerCase().trim(),
      status: TENANT_DOMAIN_STATUS.ACTIVE,
    },
  },
  status: {
    $nin: [TENANT_STATUS.SUSPENDED, TENANT_STATUS.CANCELED],
  },
});
