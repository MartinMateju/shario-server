import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPublishedTenantBySlug: vi.fn(),
  getTenantSubscriptionAccess: vi.fn(),
  listPublicProducts: vi.fn(),
  getPublicProduct: vi.fn(),
  listCustomerBookingLocations: vi.fn(),
  listPublicCourseSessions: vi.fn(),
  pass: vi.fn((_req, _res, next) => next()),
}));

vi.mock("@/modules/booking/booking.public.service.js", () => ({
  listCustomerBookingLocations: mocks.listCustomerBookingLocations,
}));

vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicTenantLookupLimiter: mocks.pass,
}));

vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  findPublishedTenantBySlug: mocks.findPublishedTenantBySlug,
}));

vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);

vi.mock("@/modules/product/services/product.service.js", () => ({
  productService: {
    listPublicProducts: mocks.listPublicProducts,
    getPublicProduct: mocks.getPublicProduct,
  },
}));

vi.mock(
  "@/modules/product/services/product.public-sessions.service.js",
  () => ({
    listPublicCourseSessions: mocks.listPublicCourseSessions,
    addNextCourseSessions: async ({ products }: any) => products,
  }),
);

import { publicProductRouter } from "@/modules/product/routes/product.public.routes.js";

const tenant = {
  _id: "507f1f77bcf86cd799439011",
  slug: "studio-grohovka",
  status: "active",
  modules: {
    payments: true,
    courses: true,
  },
};

const app = express();
app.use(publicProductRouter);

describe("public product catalog routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findPublishedTenantBySlug.mockResolvedValue(tenant);
    mocks.getTenantSubscriptionAccess.mockResolvedValue({
      tenant,
      subscription: {},
      access: { canUseFeatures: true },
    });
    mocks.listPublicProducts.mockResolvedValue({
      products: [],
      totalCount: 0,
      currentPage: 1,
      pageSize: 50,
      totalPages: 0,
    });
    mocks.listPublicCourseSessions.mockResolvedValue({
      product: {
        id: "507f1f77bcf86cd799439012",
        name: "Wheel basics",
      },
      sessions: [
        {
          id: "507f1f77bcf86cd799439013",
          start: "2026-08-03T08:00:00.000Z",
          end: "2026-08-03T10:00:00.000Z",
          remainingCapacity: 4,
          available: true,
        },
      ],
    });
  });

  it("lists safe active course locations even when time booking is disabled, using only the published tenant", async () => {
    mocks.listCustomerBookingLocations.mockResolvedValue({
      locations: [
        {
          id: "507f1f77bcf86cd799439013",
          name: "Course studio",
          booking: { enabled: false },
        },
      ],
    });
    const response = await request(app)
      .get(
        "/tenants/studio-grohovka/products/courses/locations?tenantId=507f1f77bcf86cd799439099",
      )
      .expect(200);
    expect(mocks.listCustomerBookingLocations).toHaveBeenCalledWith(tenant);
    expect(response.body.locations[0].name).toBe("Course studio");
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce({
      ...tenant,
      modules: { payments: true, courses: false },
    });
    await request(app)
      .get("/tenants/studio-grohovka/products/courses/locations")
      .expect(403);
  });

  it("uses only the published slug tenant and ignores a supplied tenant id", async () => {
    const response = await request(app)
      .get(
        "/tenants/studio-grohovka/products?tenantId=507f1f77bcf86cd799439099&isActive=false",
      )
      .expect(200);

    expect(mocks.listPublicProducts).toHaveBeenCalledWith({
      tenantId: tenant._id,
      search: "",
      page: 1,
      limit: 50,
      respectPublicCourseVisibility: true,
    });
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
  });

  it("does not expose an unpublished workspace", async () => {
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce(null);

    const response = await request(app)
      .get("/tenants/draft-studio/products")
      .expect(404);

    expect(response.body).toEqual({
      message: "Workspace not found.",
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });
    expect(mocks.listPublicProducts).not.toHaveBeenCalled();
  });

  it("blocks catalogs for restricted subscriptions and disabled modules", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce({
      tenant,
      subscription: {},
      access: { canUseFeatures: false },
    });

    await request(app).get("/tenants/studio-grohovka/products").expect(403);
    expect(mocks.listPublicProducts).not.toHaveBeenCalled();

    mocks.findPublishedTenantBySlug.mockResolvedValueOnce({
      ...tenant,
      modules: {
        ...tenant.modules,
        courses: false,
      },
    });

    await request(app)
      .get("/tenants/studio-grohovka/products/courses")
      .expect(403);
    expect(mocks.listPublicProducts).not.toHaveBeenCalled();
  });

  it("includes canonical and legacy courses through the course contract", async () => {
    await request(app)
      .get("/tenants/studio-grohovka/products/courses")
      .expect(200);

    expect(mocks.listPublicProducts).toHaveBeenCalledWith({
      tenantId: tenant._id,
      coursesOnly: true,
      respectPublicCourseVisibility: true,
      locationId: undefined,
      search: "",
      page: 1,
      limit: 100,
    });
  });

  it("serves bounded public course sessions from the slug-resolved tenant", async () => {
    const response = await request(app)
      .get(
        "/tenants/studio-grohovka/products/507f1f77bcf86cd799439012/sessions",
      )
      .query({
        locationId: "507f1f77bcf86cd799439088",
        from: "2026-08-01",
        to: "2026-08-31",
        limit: 25,
      })
      .expect(200);

    expect(mocks.listPublicCourseSessions).toHaveBeenCalledWith({
      tenantId: tenant._id,
      productId: "507f1f77bcf86cd799439012",
      locationId: "507f1f77bcf86cd799439088",
      from: "2026-08-01",
      to: "2026-08-31",
      limit: 25,
    });
    expect(response.body.sessions).toEqual([
      {
        id: "507f1f77bcf86cd799439013",
        start: "2026-08-03T08:00:00.000Z",
        end: "2026-08-03T10:00:00.000Z",
        remainingCapacity: 4,
        available: true,
      },
    ]);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
  });

  it("forwards the selected location and search to the public course list", async () => {
    await request(app)
      .get("/tenants/studio-grohovka/products/courses")
      .query({ locationId: "507f1f77bcf86cd799439088", search: "wheel" })
      .expect(200);
    expect(mocks.listPublicProducts).toHaveBeenCalledWith({
      tenantId: tenant._id,
      coursesOnly: true,
      page: 1,
      limit: 100,
      respectPublicCourseVisibility: true,
      locationId: "507f1f77bcf86cd799439088",
      search: "wheel",
    });
  });

  it.each([
    "/products/courses",
    "/products/courses/locations",
    "/products/507f1f77bcf86cd799439012/sessions",
  ])(
    "allows anonymous %s when both published course pages are enabled",
    async (path) => {
      mocks.findPublishedTenantBySlug.mockResolvedValueOnce({
        ...tenant,
        publicSiteEditor: {
          published: {
            pages: { courses: { visible: true } },
            customerPortal: { pages: { courses: { enabled: true } } },
          },
          draft: { customerPortal: { pages: { courses: { enabled: false } } } },
        },
      });
      await request(app).get(`/tenants/studio-grohovka${path}`).expect(200);
    },
  );

  it.each([
    { pages: { courses: { visible: false } } },
    { customerPortal: { pages: { courses: { enabled: false } } } },
  ])(
    "does not expose any anonymous course endpoint when a published page is disabled: %o",
    async (published) => {
      mocks.findPublishedTenantBySlug.mockResolvedValue({
        ...tenant,
        publicSite: {},
        publicSiteEditor: { published, draft: {} },
      });
      for (const path of [
        "/products/courses",
        "/products/courses/locations",
        "/products/507f1f77bcf86cd799439012/sessions",
      ]) {
        const response = await request(app)
          .get(`/tenants/studio-grohovka${path}`)
          .expect(404);
        expect(response.body.code).toBe("PUBLIC_COURSES_NOT_AVAILABLE");
        expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
      }
      expect(mocks.listPublicProducts).not.toHaveBeenCalled();
      expect(mocks.listCustomerBookingLocations).not.toHaveBeenCalled();
      expect(mocks.listPublicCourseSessions).not.toHaveBeenCalled();
    },
  );

  it("enforces published visibility on generic anonymous product details too", async () => {
    mocks.getPublicProduct.mockResolvedValueOnce({
      id: "507f1f77bcf86cd799439012",
    });
    await request(app)
      .get("/tenants/studio-grohovka/products/507f1f77bcf86cd799439012")
      .expect(200);
    expect(mocks.getPublicProduct).toHaveBeenCalledWith({
      tenantId: tenant._id,
      productId: "507f1f77bcf86cd799439012",
      locationId: undefined,
      respectPublicCourseVisibility: true,
    });
  });
});
