import { logger } from "@/config/logger.js";
import { listPublicBookingLocations, listCustomerBookingLocations } from "@/modules/booking/booking.public.service.js";
import { knowledgePortalService } from "@/modules/communications/services/knowledge.service.js";
import { membershipPlanService } from "@/modules/membership/services/membership-plan.service.js";
import { productService } from "@/modules/product/services/product.service.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";

const emptyProductPage = Object.freeze({
  products: [],
  totalCount: 0,
  currentPage: 1,
  pageSize: 100,
  totalPages: 0,
});

const emptyMembershipCatalog = Object.freeze({
  locations: [],
  plans: [],
});

/**
 * Returns the same customer-safe DTOs used by public and authenticated catalog
 * surfaces, while deliberately excluding bookings, customers, access codes,
 * staff notes, and draft commerce records. A disabled module is represented by
 * an empty collection so the builder can still render the production empty
 * state.
 */
export const getTenantPublicSitePreviewData = async (
  tenant: TenantDocument,
) => {
  const [
    locationsResult,
    courseLocationsResult,
    productsResult,
    coursesResult,
    vouchersResult,
    membershipsResult,
    knowledgeResult,
  ] = await Promise.allSettled([
    listPublicBookingLocations(tenant),
    tenant.modules?.courses === true ? listCustomerBookingLocations(tenant) : Promise.resolve({ locations: [] }),
    productService.listPublicProducts({
      tenantId: String(tenant._id),
      limit: 100,
    }),
    productService.listPublicProducts({
      tenantId: String(tenant._id),
      limit: 50,
      coursesOnly: true,
    }),
    productService.listPublicVoucherProducts({
      tenantId: String(tenant._id),
      limit: 100,
    }),
    membershipPlanService.publicCatalog(tenant.slug),
    knowledgePortalService.list(
      { kind: "public", tenantId: String(tenant._id) },
      { page: 1, limit: 100 },
    ),
  ]);

  [
    ["locations", locationsResult],
    ["courseLocations", courseLocationsResult],
    ["products", productsResult],
    ["courses", coursesResult],
    ["vouchers", vouchersResult],
    ["memberships", membershipsResult],
    ["help", knowledgeResult],
  ].forEach(([source, result]) => {
    if ((result as PromiseSettledResult<unknown>).status !== "rejected") {
      return;
    }
    logger.warn(
      {
        tenantId: String(tenant._id),
        source,
        err: (result as PromiseRejectedResult).reason,
      },
      "Public-site preview data lookup failed; catalog rendered empty.",
    );
  });

  const locations =
    locationsResult.status === "fulfilled"
      ? locationsResult.value.locations
      : [];
  const products =
    productsResult.status === "fulfilled"
      ? productsResult.value
      : emptyProductPage;
  const courses =
    coursesResult.status === "fulfilled"
      ? coursesResult.value
      : emptyProductPage;
  const vouchers =
    vouchersResult.status === "fulfilled" ? vouchersResult.value : [];
  const memberships =
    membershipsResult.status === "fulfilled"
      ? membershipsResult.value
      : emptyMembershipCatalog;
  const knowledge =
    knowledgeResult.status === "fulfilled" ? knowledgeResult.value.items : [];

  return {
    locations,
    courseLocations: courseLocationsResult.status === "fulfilled" ? courseLocationsResult.value.locations : [],
    products: products.products,
    courses: courses.products,
    vouchers,
    memberships: memberships.plans,
    membershipLocations: memberships.locations,
    help: knowledge,
  };
};
