import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  downloadImportReport,
  downloadImportRollbackReport,
  downloadBookingImportTemplate,
  downloadCreditImportTemplate,
  downloadCustomerImportTemplate,
  downloadMembershipImportTemplate,
  downloadMembershipPlanImportTemplate,
  downloadProductImportTemplate,
  downloadVoucherImportTemplate,
  downloadVoucherProductImportTemplate,
  executeImport,
  getImport,
  getImportRows,
  getImportRollbackPreview,
  listImports,
  rollbackImport,
  uploadBookingImport,
  uploadCreditImport,
  uploadCustomerImport,
  uploadMembershipImport,
  uploadMembershipPlanImport,
  uploadProductImport,
  uploadVoucherImport,
  uploadVoucherProductImport,
  validateImport,
} from "./data-import.controller.js";
import {
  requireImportListAccess,
  requireImportRollbackAccess,
  requireImportSessionAccess,
  requireStaticImportAccess,
} from "./data-import-access.middleware.js";
import { dataImportUpload } from "./data-import-upload.middleware.js";
import { DATA_IMPORT_ENTITY } from "./data-import.constants.js";

const router = Router();

const importMutationLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "IMPORT_RATE_LIMITED",
    message: "Too many import requests. Please wait and try again.",
  },
});

const importDownloadLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "IMPORT_DOWNLOAD_RATE_LIMITED",
    message: "Too many report downloads. Please wait and try again.",
  },
});

router.get("/", requireImportListAccess, listImports);
router.get(
  "/templates/customers.csv",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.CUSTOMERS),
  downloadCustomerImportTemplate,
);
router.get(
  "/templates/products.csv",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.PRODUCTS),
  downloadProductImportTemplate,
);
router.get(
  "/templates/bookings.csv",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.BOOKINGS),
  downloadBookingImportTemplate,
);
router.get(
  "/templates/membership-plans.csv",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS),
  downloadMembershipPlanImportTemplate,
);
router.get(
  "/templates/memberships.csv",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.MEMBERSHIPS),
  downloadMembershipImportTemplate,
);
router.get(
  "/templates/credits.csv",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.CREDITS),
  downloadCreditImportTemplate,
);
router.get(
  "/templates/voucher-products.csv",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS),
  downloadVoucherProductImportTemplate,
);
router.get(
  "/templates/vouchers.csv",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.VOUCHERS),
  downloadVoucherImportTemplate,
);
router.post(
  "/customers/uploads",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.CUSTOMERS),
  importMutationLimiter,
  dataImportUpload,
  uploadCustomerImport,
);
router.post(
  "/products/uploads",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.PRODUCTS),
  importMutationLimiter,
  dataImportUpload,
  uploadProductImport,
);
router.post(
  "/bookings/uploads",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.BOOKINGS),
  importMutationLimiter,
  dataImportUpload,
  uploadBookingImport,
);
router.post(
  "/membership-plans/uploads",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS),
  importMutationLimiter,
  dataImportUpload,
  uploadMembershipPlanImport,
);
router.post(
  "/memberships/uploads",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.MEMBERSHIPS),
  importMutationLimiter,
  dataImportUpload,
  uploadMembershipImport,
);
router.post(
  "/credits/uploads",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.CREDITS),
  importMutationLimiter,
  dataImportUpload,
  uploadCreditImport,
);
router.post(
  "/voucher-products/uploads",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS),
  importMutationLimiter,
  dataImportUpload,
  uploadVoucherProductImport,
);
router.post(
  "/vouchers/uploads",
  requireStaticImportAccess(DATA_IMPORT_ENTITY.VOUCHERS),
  importMutationLimiter,
  dataImportUpload,
  uploadVoucherImport,
);
router.post(
  "/:id/validate",
  requireImportSessionAccess,
  importMutationLimiter,
  validateImport,
);
router.post(
  "/:id/execute",
  requireImportSessionAccess,
  importMutationLimiter,
  executeImport,
);
router.get("/:id/rows", requireImportSessionAccess, getImportRows);
router.get(
  "/:id/report.csv",
  requireImportSessionAccess,
  importDownloadLimiter,
  downloadImportReport,
);
router.get(
  "/:id/rollback-preview",
  requireImportRollbackAccess,
  importMutationLimiter,
  getImportRollbackPreview,
);
router.post(
  "/:id/rollback",
  requireImportRollbackAccess,
  importMutationLimiter,
  rollbackImport,
);
router.get(
  "/:id/rollback-report.csv",
  requireImportRollbackAccess,
  importDownloadLimiter,
  downloadImportRollbackReport,
);
router.get("/:id", requireImportSessionAccess, getImport);

export default router;
