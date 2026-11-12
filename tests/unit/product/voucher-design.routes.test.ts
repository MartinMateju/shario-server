import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const tenantId = "507f1f77bcf86cd799439011";
const mocks = vi.hoisted(() => ({
  getVoucherDesignDefaults: vi.fn(),
  renderVoucherDesignPreview: vi.fn(),
  uploadVoucherDesignAsset: vi.fn(),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (req, res, next) => {
    if (req.get("x-auth-context") === "anonymous") return res.sendStatus(401);
    req.userInfo = {
      tenant: "507f1f77bcf86cd799439011",
      authContext: req.get("x-auth-context") || "workspace",
    };
    next();
  },
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requirePermission: (permission: string) => (req, res, next) => {
    if (permission === "products.manage" && req.get("x-can-manage") !== "true")
      return res.sendStatus(403);
    next();
  },
}));
vi.mock("@/modules/product/controllers/product.controller.js", () => ({
  createProduct: vi.fn(),
  deleteProduct: vi.fn(),
  getCustomerCourseCatalog: vi.fn((_req, res) => res.status(200).json({products: []})),
  getPublicCourseSessions: vi.fn((_req, res) => res.status(200).json({sessions: []})),
  getCustomerCatalog: vi.fn(),
  getCourseProducts: vi.fn(),
  getProducts: vi.fn(),
  getVoucherAllowance: vi.fn(),
  getProductDeletionPolicy: vi.fn(),
  updateProduct: vi.fn(),
  uploadCouponTemplate: vi.fn(),
}));
vi.mock(
  "@/modules/product/controllers/product-class-category.controller.js",
  () => ({
    createProductClassCategory: vi.fn(),
    deleteProductClassCategory: vi.fn(),
    listProductClassCategories: vi.fn(),
  }),
);
vi.mock("@/modules/product/services/voucher-design.service.js", () => ({
  getVoucherDesignDefaults: mocks.getVoucherDesignDefaults,
  renderVoucherDesignPreview: mocks.renderVoucherDesignPreview,
  uploadVoucherDesignAsset: mocks.uploadVoucherDesignAsset,
  voucherAssetUploadBodySchema: z
    .object({ purpose: z.enum(["logo", "image"]) })
    .strict(),
}));

import router from "@/modules/product/routes/product.routes.js";

const app = express();
app.use(express.json());
app.use(router);
app.use(((error, _req, res, _next) => {
  res
    .status(error instanceof z.ZodError ? 400 : error.statusCode || 500)
    .json({ code: error.code, message: error.message });
}) satisfies ErrorRequestHandler);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getVoucherDesignDefaults.mockResolvedValue({ version: 1 });
  mocks.renderVoucherDesignPreview.mockImplementation(({ format }) =>
    format === "pdf" ? Buffer.from("%PDF SAMPLE") : "<svg>SAMPLE</svg>",
  );
  mocks.uploadVoucherDesignAsset.mockResolvedValue({
    key: "owned-key",
    url: "https://media.shario.test/owned-key",
    width: 10,
    height: 10,
    contentType: "image/png",
  });
});

describe("voucher editor API authorization and multipart limits", () => {
  it.each([
    ["get", "/voucher-design/defaults"],
    ["post", "/voucher-design/assets"],
    ["post", "/voucher-design/preview"],
    ["post", "/voucher-design/pdf"],
  ] as const)(
    "requires workspace product management for %s %s",
    async (method, path) => {
      await request(app)
        [method](path)
        .set("x-auth-context", "anonymous")
        .expect(401);
      await request(app)
        [method](path)
        .set("x-auth-context", "customer")
        .set("x-can-manage", "true")
        .expect(403);
      await request(app)[method](path).expect(403);
      expect(mocks.getVoucherDesignDefaults).not.toHaveBeenCalled();
      expect(mocks.renderVoucherDesignPreview).not.toHaveBeenCalled();
      expect(mocks.uploadVoucherDesignAsset).not.toHaveBeenCalled();
    },
  );

  it("uses the authenticated tenant for defaults and preview", async () => {
    await request(app)
      .get("/voucher-design/defaults")
      .set("x-can-manage", "true")
      .expect(200, { design: { version: 1 } });
    expect(mocks.getVoucherDesignDefaults).toHaveBeenCalledExactlyOnceWith(
      tenantId,
    );
    await request(app)
      .post("/voucher-design/preview")
      .set("x-can-manage", "true")
      .send({ design: {} })
      .expect(200, { svg: "<svg>SAMPLE</svg>" });
    expect(mocks.renderVoucherDesignPreview).toHaveBeenCalledWith({
      tenantId,
      input: { design: {} },
      format: "svg",
    });
  });

  it("downloads a noncached PDF attachment with a fixed safe filename", async () => {
    const response = await request(app)
      .post("/voucher-design/pdf")
      .set("x-can-manage", "true")
      .send({ design: {} })
      .expect(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="voucher-sample.pdf"',
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("accepts one file and its purpose, passing only the authenticated tenant", async () => {
    const response = await request(app)
      .post("/voucher-design/assets")
      .set("x-can-manage", "true")
      .field("purpose", "logo")
      .attach("file", Buffer.from("image bytes"), {
        filename: "logo.png",
        contentType: "image/png",
      });
    expect(response.body).not.toHaveProperty("code");
    expect(response.status).toBe(201);
    expect(mocks.uploadVoucherDesignAsset).toHaveBeenCalledWith({
      tenantId,
      purpose: "logo",
      file: expect.objectContaining({ mimetype: "image/png" }),
    });
  });

  it("rejects SVG before invoking the asset decoder", async () => {
    const response = await request(app)
      .post("/voucher-design/assets")
      .set("x-can-manage", "true")
      .field("purpose", "logo")
      .attach("file", Buffer.from("<svg/>"), {
        filename: "logo.svg",
        contentType: "image/svg+xml",
      })
      .expect(400);
    expect(response.body.code).toBe("VOUCHER_ASSET_TYPE_INVALID");
    expect(mocks.uploadVoucherDesignAsset).not.toHaveBeenCalled();
  });

  it("rejects images over 8MB before service work", async () => {
    const response = await request(app)
      .post("/voucher-design/assets")
      .set("x-can-manage", "true")
      .field("purpose", "image")
      .attach("file", Buffer.alloc(8 * 1024 * 1024 + 1), {
        filename: "image.png",
        contentType: "image/png",
      })
      .expect(413);
    expect(response.body.code).toBe("VOUCHER_ASSET_TOO_LARGE");
    expect(mocks.uploadVoucherDesignAsset).not.toHaveBeenCalled();
  });

  it("rejects an extra tenant field in an upload", async () => {
    await request(app)
      .post("/voucher-design/assets")
      .set("x-can-manage", "true")
      .field("purpose", "logo")
      .field("tenantId", "another-tenant")
      .attach("file", Buffer.from("image"), {
        filename: "logo.png",
        contentType: "image/png",
      })
      .expect(400);
    expect(mocks.uploadVoucherDesignAsset).not.toHaveBeenCalled();
  });
});
