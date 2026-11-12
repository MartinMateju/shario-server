import type { TenantDocument } from "../tenant.types.js";
import {
  serializeTenantPublicSite,
  type TenantPublicSiteSnapshot,
} from "./tenant-public-site.serializers.js";

type CourseVisibilityTenant = Partial<
  Pick<TenantDocument, "name" | "publicSite" | "publicSiteEditor">
>;

/** Both Courses surfaces share one anonymous catalog; either page can hide it. */
export const isCourseBrowsingVisible = (
  tenant: CourseVisibilityTenant,
  options: { snapshot?: TenantPublicSiteSnapshot } = {},
): boolean => {
  const site = serializeTenantPublicSite(
    {
      name: tenant.name || "Studio",
      publicSite: tenant.publicSite,
      publicSiteEditor: tenant.publicSiteEditor,
    },
    options,
  );
  return (
    site.pages.courses.visible && site.customerPortal.pages.courses.enabled
  );
};

/** Only an explicit opt-in on the selected snapshot permits guest checkout. */
export const isGuestCourseCheckoutEnabled = (
  tenant: CourseVisibilityTenant,
  options: { snapshot?: TenantPublicSiteSnapshot } = {},
): boolean => {
  const site = serializeTenantPublicSite(
    {
      name: tenant.name || "Studio",
      publicSite: tenant.publicSite,
      publicSiteEditor: tenant.publicSiteEditor,
    },
    options,
  );
  return (
    site.pages.courses.visible &&
    site.customerPortal.pages.courses.enabled &&
    site.customerPortal.courses.guestCheckoutEnabled === true
  );
};
