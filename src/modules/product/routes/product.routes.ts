import {
  createProduct,
  deleteProduct,
  getCustomerCatalog,
  getCustomerCourseCatalog,
  getPublicCourseSessions,
  getCourseProducts,
  getProducts,
  getVoucherAllowance,
  getProductDeletionPolicy,
  updateProduct,
  uploadCouponTemplate,
} from "@/modules/product/controllers/product.controller.js";
import {
  createProductClassCategory,
  deleteProductClassCategory,
  listProductClassCategories,
} from "@/modules/product/controllers/product-class-category.controller.js";
import {
  uploadProductFiles,
  uploadSingleProductFile,
} from "@/modules/product/middleware/productUpload.middleware.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import {
  requireCustomerSession,
  requireWorkspaceSession,
} from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import express from "express";
import {
  downloadVoucherEditorSample,
  getVoucherEditorDefaults,
  previewVoucherEditor,
  uploadVoucherEditorAsset,
} from "../controllers/voucher-design.controller.js";
import {
  uploadVoucherAssetFile,
  voucherAssetUploadLimiter,
  voucherPdfLimiter,
  voucherPreviewLimiter,
} from "../middleware/voucher-design-upload.middleware.js";

const router = express.Router();

const viewProducts = requirePermission(WORKSPACE_PERMISSION.PRODUCTS_VIEW);
const manageProducts = requirePermission(WORKSPACE_PERMISSION.PRODUCTS_MANAGE);
const viewCourses = requirePermission(WORKSPACE_PERMISSION.COURSES_VIEW);
const paymentsModule = requireTenantModule("payments");
const coursesModule = requireTenantModule("courses");

router.use(verifyJWT);

// Authenticated customers need the safe storefront DTO even when the public
// tenant site is still a draft. The surrounding API boundary enforces the
// tenant subscription; this route intentionally needs no workspace permission.
router.get(
  "/customer-catalog",
  requireCustomerSession,
  paymentsModule,
  getCustomerCatalog,
);
router.get(
  "/customer-catalog/courses",
  requireCustomerSession,
  paymentsModule,
  coursesModule,
  getCustomerCourseCatalog,
);
router.get(
  "/customer-catalog/:productId/sessions",
  requireCustomerSession,
  paymentsModule,
  coursesModule,
  getPublicCourseSessions,
);
router.use(requireWorkspaceSession);
router.get(
  "/voucher-design/defaults",
  manageProducts,
  getVoucherEditorDefaults,
);
router.post(
  "/voucher-design/assets",
  manageProducts,
  voucherAssetUploadLimiter,
  uploadVoucherAssetFile,
  uploadVoucherEditorAsset,
);
router.post(
  "/voucher-design/preview",
  manageProducts,
  voucherPreviewLimiter,
  previewVoucherEditor,
);
router.post(
  "/voucher-design/pdf",
  manageProducts,
  voucherPdfLimiter,
  downloadVoucherEditorSample,
);
router.get("/", viewProducts, getProducts);
router.get("/voucher-allowance", viewProducts, getVoucherAllowance);
router.get(
  "/:productId/deletion-policy",
  manageProducts,
  getProductDeletionPolicy,
);
router.get("/courses", viewCourses, coursesModule, getCourseProducts);
router.get(
  "/class-categories",
  viewProducts,
  coursesModule,
  listProductClassCategories,
);

router.post("/", manageProducts, uploadProductFiles, createProduct);
router.post(
  "/class-categories",
  manageProducts,
  coursesModule,
  createProductClassCategory,
);
router.post(
  "/coupon-template",
  manageProducts,
  uploadSingleProductFile,
  uploadCouponTemplate,
);
router.patch("/", manageProducts, uploadProductFiles, updateProduct);
router.delete("/", manageProducts, deleteProduct);
router.delete(
  "/class-categories/:categoryId",
  manageProducts,
  coursesModule,
  deleteProductClassCategory,
);

export default router;
