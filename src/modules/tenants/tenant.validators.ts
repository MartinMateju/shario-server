export const TENANT_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isValidTenantSlug = (slug: string): boolean => {
  return TENANT_SLUG_REGEX.test(slug);
};

export const isValidHostname = (hostname: string): boolean => {
  if (!hostname || hostname.length > 253) {
    return false;
  }

  return /^[a-z0-9.-]+$/i.test(hostname);
};
