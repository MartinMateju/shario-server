import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listLocations: vi.fn(),
  listCourseLocations: vi.fn(),
  listProducts: vi.fn(),
  listVouchers: vi.fn(),
  listMemberships: vi.fn(),
  listKnowledge: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { warn: mocks.warn },
}));

vi.mock("@/modules/booking/booking.public.service.js", () => ({
  listPublicBookingLocations: mocks.listLocations,
  listCustomerBookingLocations: mocks.listCourseLocations,
}));

vi.mock("@/modules/product/services/product.service.js", () => ({
  productService: {
    listPublicProducts: mocks.listProducts,
    listPublicVoucherProducts: mocks.listVouchers,
  },
}));

vi.mock("@/modules/membership/services/membership-plan.service.js", () => ({
  membershipPlanService: { publicCatalog: mocks.listMemberships },
}));

vi.mock("@/modules/communications/services/knowledge.service.js", () => ({
  knowledgePortalService: { list: mocks.listKnowledge },
}));

import { getTenantPublicSitePreviewData } from "@/modules/tenants/public-site/tenant-public-site-preview-data.service.js";

const tenant = {
  _id: "507f1f77bcf86cd799439011",
  slug: "studio-olivka",
  modules: { courses: true },
};

describe("tenant public-site preview data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCourseLocations.mockResolvedValue({ locations: [{ id: "course-location", name: "Course-only studio", booking: { enabled: false } }] });
    mocks.listLocations.mockResolvedValue({
      locations: [{ id: "location-1", name: "Old Town" }],
    });
    mocks.listProducts
      .mockResolvedValueOnce({
        products: [{ id: "product-1" }],
        totalCount: 1,
        currentPage: 1,
        pageSize: 100,
        totalPages: 1,
      })
      .mockResolvedValueOnce({
        products: [{ id: "course-1" }],
        totalCount: 1,
        currentPage: 1,
        pageSize: 50,
        totalPages: 1,
      });
    mocks.listVouchers.mockResolvedValue([{ id: "voucher-1" }]);
    mocks.listMemberships.mockResolvedValue({
      locations: [{ id: "location-1" }],
      plans: [{ id: "membership-1" }],
    });
    mocks.listKnowledge.mockResolvedValue({
      items: [{ id: "guide-1" }],
    });
  });

  it("uses production catalog limits and returns only customer-safe feeds", async () => {
    const data = await getTenantPublicSitePreviewData(tenant as never);

    expect(mocks.listLocations).toHaveBeenCalledWith(tenant);
    expect(mocks.listProducts).toHaveBeenNthCalledWith(1, {
      tenantId: tenant._id,
      limit: 100,
    });
    expect(mocks.listProducts).toHaveBeenNthCalledWith(2, {
      tenantId: tenant._id,
      limit: 50,
      coursesOnly: true,
    });
    expect(mocks.listVouchers).toHaveBeenCalledWith({
      tenantId: tenant._id,
      limit: 100,
    });
    expect(mocks.listKnowledge).toHaveBeenCalledWith(
      { kind: "public", tenantId: tenant._id },
      { page: 1, limit: 100 },
    );
    expect(data).toEqual({
      locations: [{ id: "location-1", name: "Old Town" }],
      courseLocations: [{ id: "course-location", name: "Course-only studio", booking: { enabled: false } }],
      products: [{ id: "product-1" }],
      courses: [{ id: "course-1" }],
      vouchers: [{ id: "voucher-1" }],
      memberships: [{ id: "membership-1" }],
      membershipLocations: [{ id: "location-1" }],
      help: [{ id: "guide-1" }],
    });
  });

  it("keeps course-only locations separate from the time-booking calendar and honors the course module", async () => {
    const data = await getTenantPublicSitePreviewData({ ...tenant, modules: { courses: false } } as never);
    expect(data.courseLocations).toEqual([]);
    expect(data.locations).toEqual([{ id: "location-1", name: "Old Town" }]);
    expect(mocks.listCourseLocations).not.toHaveBeenCalled();
  });

  it("keeps successful feeds when one public dependency fails", async () => {
    mocks.listVouchers.mockRejectedValueOnce(new Error("voucher outage"));

    const data = await getTenantPublicSitePreviewData(tenant as never);

    expect(data.vouchers).toEqual([]);
    expect(data.products).toEqual([{ id: "product-1" }]);
    expect(data.memberships).toEqual([{ id: "membership-1" }]);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: tenant._id, source: "vouchers" }),
      expect.any(String),
    );
  });
});
