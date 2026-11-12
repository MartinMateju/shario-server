import { Router, type NextFunction, type Request, type Response } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import {
  requireAnyPermission,
  requirePermission,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireNativeInvoicing } from "./invoice.feature.js";

import {
  createAdminInvoice,
  createAdminInvoiceFromOrder,
  creditAdminInvoice,
  downloadAdminInvoicePdf,
  downloadMyInvoicePdf,
  finalizeAdminInvoice,
  getAdminInvoice,
  getAdminInvoiceSettings,
  getMyInvoice,
  listAdminInvoices,
  listMyInvoices,
  recordAdminInvoicePayment,
  reverseAdminInvoicePayment,
  sendAdminInvoice,
  updateAdminInvoice,
  updateAdminInvoiceSettings,
} from "./invoice.controller.js";

export const invoiceRouter = Router();
export const customerInvoiceRouter = Router();

const privateNoStore = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  next();
};

invoiceRouter.use(privateNoStore, requireNativeInvoicing);
customerInvoiceRouter.use(
  privateNoStore,
  requireNativeInvoicing,
  requireCustomerSession,
);

customerInvoiceRouter.get("/", listMyInvoices);
customerInvoiceRouter.get("/:id/pdf", downloadMyInvoicePdf);
customerInvoiceRouter.get("/:id", getMyInvoice);

invoiceRouter.get(
  "/settings",
  requireAnyPermission(
    WORKSPACE_PERMISSION.INVOICES_VIEW,
    WORKSPACE_PERMISSION.WORKSPACE_UPDATE,
  ),
  getAdminInvoiceSettings,
);
invoiceRouter.patch(
  "/settings",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  updateAdminInvoiceSettings,
);
invoiceRouter.post(
  "/from-order/:orderId",
  requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
  requirePermission(WORKSPACE_PERMISSION.INVOICES_CREATE),
  createAdminInvoiceFromOrder,
);

invoiceRouter
  .route("/")
  .get(
    requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
    listAdminInvoices,
  )
  .post(
    requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
    requirePermission(WORKSPACE_PERMISSION.INVOICES_CREATE),
    createAdminInvoice,
  );

invoiceRouter.get(
  "/:id/pdf",
  requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
  requirePermission(WORKSPACE_PERMISSION.INVOICES_EXPORT),
  downloadAdminInvoicePdf,
);
invoiceRouter.post(
  "/:id/finalize",
  requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
  requirePermission(WORKSPACE_PERMISSION.INVOICES_FINALIZE),
  finalizeAdminInvoice,
);
invoiceRouter.post(
  "/:id/send",
  requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
  requirePermission(WORKSPACE_PERMISSION.INVOICES_SEND),
  sendAdminInvoice,
);
invoiceRouter.post(
  "/:id/credit-notes",
  requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
  requirePermission(WORKSPACE_PERMISSION.INVOICES_CREDIT),
  creditAdminInvoice,
);
invoiceRouter.post(
  "/:id/payments",
  requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
  requirePermission(WORKSPACE_PERMISSION.INVOICES_PAYMENTS_MANAGE),
  recordAdminInvoicePayment,
);
invoiceRouter.post(
  "/:id/payments/:paymentId/reverse",
  requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
  requirePermission(WORKSPACE_PERMISSION.INVOICES_PAYMENTS_MANAGE),
  reverseAdminInvoicePayment,
);
invoiceRouter
  .route("/:id")
  .get(
    requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
    getAdminInvoice,
  )
  .patch(
    requirePermission(WORKSPACE_PERMISSION.INVOICES_VIEW),
    requirePermission(WORKSPACE_PERMISSION.INVOICES_CREATE),
    updateAdminInvoice,
  );

export default invoiceRouter;
