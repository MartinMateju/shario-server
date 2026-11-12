import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPublicProducts: vi.fn(),
  addNextCourseSessions: vi.fn(),
}));

vi.mock("@/modules/product/services/product.service.js", () => ({
  productService: {
    listPublicProducts: mocks.listPublicProducts,
  },
}));

vi.mock("@/modules/product/services/product.public-sessions.service.js", () => ({
  addNextCourseSessions: mocks.addNextCourseSessions,
  listPublicCourseSessions: vi.fn(),
}));

import { getCustomerCatalog, getCustomerCourseCatalog } from "@/modules/product/controllers/product.controller.js";

const TOKEN_TENANT_ID = "507f1f77bcf86cd799439011";
const UNTRUSTED_TENANT_ID = "507f1f77bcf86cd799439099";

const app = express();
app.use(
  (req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, {
      userInfo: {
        id: "507f191e810c19729de860ea",
        email: "customer@example.com",
        tenant: TOKEN_TENANT_ID,
      },
    });
    next();
  },
);
app.get("/products/customer-catalog", getCustomerCatalog);
app.get("/products/customer-catalog/courses", getCustomerCourseCatalog);

describe("authenticated customer product catalog controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addNextCourseSessions.mockImplementation(async ({ products }) => products);
    mocks.listPublicProducts.mockResolvedValue({
      products: [],
      totalCount: 0,
      currentPage: 1,
      pageSize: 50,
      totalPages: 0,
    });
  });

  it("keeps course pagination and location filtering bound to the customer's token tenant", async () => {
    const response = await request(app).get("/products/customer-catalog/courses")
      .query({
        tenantId: UNTRUSTED_TENANT_ID, locationId: "507f1f77bcf86cd799439013",
        page: 2, limit: 10, search: "clay",
      }).expect(200);
    expect(mocks.listPublicProducts).toHaveBeenCalledWith({
      tenantId: TOKEN_TENANT_ID, coursesOnly: true,
      locationId: "507f1f77bcf86cd799439013", page: 2, limit: 10, search: "clay",
    });
    expect(mocks.addNextCourseSessions).toHaveBeenCalledWith({
      tenantId: TOKEN_TENANT_ID, locationId: "507f1f77bcf86cd799439013", products: [],
    });
    expect(response.body).toMatchObject({ products: [], totalCount: 0, currentPage: 1, pageSize: 50, totalPages: 0 });
    expect(response.headers["cache-control"]).toContain("private");
    expect(response.headers.vary).toBe("Authorization");
  });

  it("uses only the tenant from the verified JWT and returns the public-safe catalog DTO", async () => {
    const response = await request(app)
      .get(
        `/products/customer-catalog?tenantId=${UNTRUSTED_TENANT_ID}&isActive=false&search=clay`,
      )
      .expect(200);

    expect(mocks.listPublicProducts).toHaveBeenCalledWith({
      tenantId: TOKEN_TENANT_ID,
      search: "clay",
      page: 1,
      limit: 50,
    });
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
  });
});
