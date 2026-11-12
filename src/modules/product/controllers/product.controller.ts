import { getAllowedWorkspaceLocationIds } from "@/modules/tenant-access/services/authorization.service.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";
import { isStudioProduct } from "../product-location.policy.js";
import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { badRequest } from "../../../shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";

import { COURSE_PRODUCT_TYPES } from "../product.constants.js";
import { productService } from "../services/product.service.js";
import type { UploadedFileLike } from "../product.types.js";
import {
  couponTemplateUploadSchema,
  createProductSchema,
  deleteProductSchema,
  productListQuerySchema,
  publicCourseSessionsQuerySchema,
  publicProductParamsSchema,
  publicProductListQuerySchema,
  updateProductSchema,
} from "../product.validators.js";
import { addNextCourseSessions, listPublicCourseSessions } from "../services/product.public-sessions.service.js";

type RequestWithFile = Request & {
  file?: UploadedFileLike;
};

type RequestWithProductFiles = Request & {
  files?:
    UploadedFileLike[] | Partial<Record<"file" | "image", UploadedFileLike[]>>;
};

const productFile = (
  req: RequestWithProductFiles,
  fieldName: "file" | "image",
): UploadedFileLike | undefined => {
  if (!req.files) return undefined;

  if (Array.isArray(req.files)) {
    return req.files.find((file) => file.fieldname === fieldName);
  }

  return req.files[fieldName]?.[0];
};

const allowedProductLocationIds = (req: Request) =>
  getAllowedWorkspaceLocationIds(getResolvedWorkspaceAccess(req as WorkspaceAccessRequest));

export const getProducts = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const query = productListQuerySchema.parse(req.query);

    const result = await productService.listProducts({
      tenantId,
      ...query,
      allowedLocationIds: allowedProductLocationIds(req),
    });

    res.json(result);
  },
);

export const getCourseProducts = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);

    const result = await productService.listProducts({
      tenantId,
      types: COURSE_PRODUCT_TYPES,
      isActive: true,
      page: 1,
      limit: 100,
    });

    res.json(result.products);
  },
);

export const getPublicProducts = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const query = publicProductListQuerySchema.parse(req.query);
    const result = await productService.listPublicProducts({
      tenantId,
      ...query,
      respectPublicCourseVisibility: true,
    });

    res.set("Cache-Control", "no-store, max-age=0");
    res.json(result);
  },
);

/**
 * Customer-facing catalog for authenticated portal screens.
 *
 * Unlike the anonymous catalog, this endpoint does not depend on the studio's
 * public-site publication state. Tenant identity still comes exclusively from
 * the verified access token through `requireTenantId`.
 */
export const getCustomerCatalog = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const query = publicProductListQuerySchema.parse(req.query);
    const result = await productService.listPublicProducts({
      tenantId,
      ...query,
    });

    res.set("Cache-Control", "no-store, max-age=0");
    res.json(result);
  },
);

export const getPublicCourseProducts = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const query = publicProductListQuerySchema.parse(req.query);
    const limit = req.query.limit === undefined ? 100 : query.limit;
    const result = await productService.listPublicProducts({
      tenantId,
      coursesOnly: true,
      respectPublicCourseVisibility: true,
      locationId: query.locationId,
      search: query.search,
      page: query.page,
      limit,
    });

    res.set("Cache-Control", "no-store, max-age=0");
    res.json(await addNextCourseSessions({ tenantId, locationId: query.locationId, products: result.products }));
  },
);

export const getCustomerCourseCatalog = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const query = publicProductListQuerySchema.parse(req.query);
    const result = await productService.listPublicProducts({
      tenantId,
      coursesOnly: true,
      ...query,
    });
    const products = await addNextCourseSessions({
      tenantId,
      locationId: query.locationId,
      products: result.products,
    });
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Vary", "Authorization");
    res.json({ ...result, products });
  },
);

export const getPublicProduct = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const { productId } = publicProductParamsSchema.parse(req.params);
    const product = await productService.getPublicProduct({
      tenantId,
      productId,
      respectPublicCourseVisibility: true,
      locationId: publicProductListQuerySchema.parse(req.query).locationId,
    });

    res.set("Cache-Control", "no-store, max-age=0");
    res.json({ product });
  },
);

export const getPublicCourseSessions = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const { productId } = publicProductParamsSchema.parse(req.params);
    const query = publicCourseSessionsQuerySchema.parse(req.query);

    res.set("Cache-Control", "no-store, max-age=0");
    res.json(
      await listPublicCourseSessions({
        tenantId,
        productId,
        ...query,
      }),
    );
  },
);

export const uploadCouponTemplate = asyncHandler(
  async (req: RequestWithFile, res: Response): Promise<void> => {
    const body = couponTemplateUploadSchema.parse(req.body);

    if (!req.file) {
      badRequest("Missing PDF file. Use multipart field name: file.");
    }

    const voucherTemplate = await productService.uploadCouponTemplate({
      file: req.file,
      productName: body.productName,
    });

    res.status(201).json({
      message: "Coupon template uploaded.",
      voucherTemplate,
    });
  },
);

export const createProduct = asyncHandler(
  async (req: RequestWithProductFiles, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createProductSchema.parse(req.body);

    const product = await productService.createProduct({
      tenantId,
      allowedLocationIds: allowedProductLocationIds(req),
      createdBy,
      input,
      file: productFile(req, "file"),
      image: productFile(req, "image"),
    });

    res.status(201).json({
      message: `New product ${product.name} created.`,
      product,
    });
  },
);

export const updateProduct = asyncHandler(
  async (req: RequestWithProductFiles, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const input = updateProductSchema.parse(req.body);

    const product = await productService.updateProduct({
      tenantId,
      allowedLocationIds: allowedProductLocationIds(req),
      input,
      file: productFile(req, "file"),
      image: productFile(req, "image"),
    });

    res.json({
      message: `${product.name} updated.`,
      product,
    });
  },
);

export const deleteProduct = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const { id, deleteConfirmation } = deleteProductSchema.parse(req.body);

    const product = await productService.deleteProduct({
      tenantId,
      allowedLocationIds: allowedProductLocationIds(req),
      productId: id,
      deleteConfirmation,
    });

    res.json({
      message: `Product ${product.name} ${isStudioProduct(product) ? "archived" : "deleted"}.`,
      product,
    });
  },
);

export const getVoucherAllowance = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  res.json(await productService.getVoucherAllowance(requireTenantId(req)));
});

export const getProductDeletionPolicy = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { productId } = publicProductParamsSchema.parse(req.params);
  res.json(await productService.getDeletionPolicy({ tenantId: requireTenantId(req), productId, allowedLocationIds: allowedProductLocationIds(req) }));
});
