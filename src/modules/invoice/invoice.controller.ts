import type { Request, Response } from "express";
import { z } from "zod";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
} from "@/modules/tenant-access/services/authorization.service.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import {
  createCreditNote,
  createInvoiceFromOrder,
  createManualInvoice,
  finalizeInvoice,
  getCustomerInvoiceById,
  getInvoiceById,
  listInvoices,
  recordInvoicePayment,
  reverseInvoicePayment,
  sendInvoice,
  serializeCustomerInvoice,
  serializeInvoice,
  updateDraftInvoice,
} from "./invoice.service.js";
import {
  getInvoiceSettings,
  updateInvoiceSettings,
} from "./invoice-settings.service.js";
import { renderInvoicePdf } from "./invoice.pdf.service.js";
import {
  createManualInvoiceSchema,
  creditNoteSchema,
  invoiceListSchema,
  recordInvoicePaymentSchema,
  reverseInvoicePaymentSchema,
  sendInvoiceSchema,
  updateDraftInvoiceSchema,
  updateInvoiceSettingsSchema,
} from "./invoice.validators.js";

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    badRequest({
      message: "Invalid invoice request.",
      code: "INVALID_INVOICE_REQUEST",
      details: result.error.flatten(),
    });
  }
  return result.data;
};

const allowedLocations = (req: Request) =>
  getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  );

const canViewPaymentAudit = (req: Request): boolean => {
  const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);
  return (
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.PAYMENTS_VIEW) ||
    hasWorkspacePermission(
      access,
      WORKSPACE_PERMISSION.INVOICES_PAYMENTS_MANAGE,
    )
  );
};

const invoiceId = (req: Request): string => String(req.params.id ?? "");
const paymentId = (req: Request): string => String(req.params.paymentId ?? "");

const idempotencyKey = (req: Request): string | undefined => {
  const value = req.get("idempotency-key")?.trim();
  return value || undefined;
};

const sendPdf = async (res: Response, invoice: any): Promise<void> => {
  const buffer = await renderInvoicePdf(invoice);
  const filename = `${String(invoice.number || "invoice").replace(/[^A-Z0-9_-]/gi, "_")}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.status(200).send(buffer);
};

export const listAdminInvoices = asyncHandler(async (req: Request, res: Response) => {
  const result = await listInvoices({
    tenantId: requireTenantId(req),
    input: parse(invoiceListSchema, req.query),
    allowedLocationIds: allowedLocations(req),
  });
  res.status(200).json(result);
});

export const createAdminInvoice = asyncHandler(async (req: Request, res: Response) => {
  const input = parse(createManualInvoiceSchema, {
    ...(req.body ?? {}),
    idempotencyKey: req.body?.idempotencyKey ?? idempotencyKey(req),
  });
  const invoice = await createManualInvoice({
    tenantId: requireTenantId(req),
    userId: getAuthenticatedUserId(req),
    input,
    allowedLocationIds: allowedLocations(req),
  });
  res.status(201).json({ invoice });
});

export const createAdminInvoiceFromOrder = asyncHandler(
  async (req: Request, res: Response) => {
    const invoice = await createInvoiceFromOrder({
      tenantId: requireTenantId(req),
      orderId: String(req.params.orderId ?? ""),
      actorUserId: getAuthenticatedUserId(req),
      automatic: false,
      finalizePaid: false,
      allowedLocationIds: allowedLocations(req),
    });
    res.status(201).json({ invoice });
  },
);

export const getAdminInvoice = asyncHandler(async (req: Request, res: Response) => {
  const invoice = await getInvoiceById({
    tenantId: requireTenantId(req),
    invoiceId: invoiceId(req),
    allowedLocationIds: allowedLocations(req),
  });
  res.status(200).json({
    invoice: serializeInvoice(invoice, {
      includePaymentAudit: canViewPaymentAudit(req),
    }),
  });
});

export const updateAdminInvoice = asyncHandler(async (req: Request, res: Response) => {
  const invoice = await updateDraftInvoice({
    tenantId: requireTenantId(req),
    invoiceId: invoiceId(req),
    userId: getAuthenticatedUserId(req),
    input: parse(updateDraftInvoiceSchema, req.body),
    allowedLocationIds: allowedLocations(req),
  });
  res.status(200).json({ invoice });
});

export const finalizeAdminInvoice = asyncHandler(async (req: Request, res: Response) => {
  const invoice = await finalizeInvoice({
    tenantId: requireTenantId(req),
    invoiceId: invoiceId(req),
    userId: getAuthenticatedUserId(req),
    allowedLocationIds: allowedLocations(req),
  });
  res.status(200).json({ invoice });
});

export const sendAdminInvoice = asyncHandler(async (req: Request, res: Response) => {
  const input = parse(sendInvoiceSchema, req.body);
  const invoice = await sendInvoice({
    tenantId: requireTenantId(req),
    invoiceId: invoiceId(req),
    userId: getAuthenticatedUserId(req),
    recipient: input.recipient,
    allowedLocationIds: allowedLocations(req),
  });
  res.status(200).json({ invoice });
});

export const recordAdminInvoicePayment = asyncHandler(
  async (req: Request, res: Response) => {
    const input = parse(recordInvoicePaymentSchema, {
      ...(req.body ?? {}),
      idempotencyKey: req.body?.idempotencyKey ?? idempotencyKey(req),
    });
    const result = await recordInvoicePayment({
      tenantId: requireTenantId(req),
      invoiceId: invoiceId(req),
      userId: getAuthenticatedUserId(req),
      input,
      allowedLocationIds: allowedLocations(req),
    });
    res.status(201).json(result);
  },
);

export const reverseAdminInvoicePayment = asyncHandler(
  async (req: Request, res: Response) => {
    const input = parse(reverseInvoicePaymentSchema, {
      ...(req.body ?? {}),
      idempotencyKey: req.body?.idempotencyKey ?? idempotencyKey(req),
    });
    const result = await reverseInvoicePayment({
      tenantId: requireTenantId(req),
      invoiceId: invoiceId(req),
      paymentId: paymentId(req),
      userId: getAuthenticatedUserId(req),
      input,
      allowedLocationIds: allowedLocations(req),
    });
    res.status(200).json(result);
  },
);

export const creditAdminInvoice = asyncHandler(async (req: Request, res: Response) => {
  const input = parse(creditNoteSchema, {
    ...(req.body ?? {}),
    idempotencyKey: req.body?.idempotencyKey ?? idempotencyKey(req),
  });
  const result = await createCreditNote({
    tenantId: requireTenantId(req),
    invoiceId: invoiceId(req),
    userId: getAuthenticatedUserId(req),
    input,
    allowedLocationIds: allowedLocations(req),
  });
  res.status(201).json(result);
});

export const downloadAdminInvoicePdf = asyncHandler(
  async (req: Request, res: Response) => {
    const invoice = await getInvoiceById({
      tenantId: requireTenantId(req),
      invoiceId: invoiceId(req),
      allowedLocationIds: allowedLocations(req),
    });
    await sendPdf(res, invoice);
  },
);

export const getAdminInvoiceSettings = asyncHandler(
  async (req: Request, res: Response) => {
    const settings = await getInvoiceSettings(requireTenantId(req));
    res.status(200).json({ settings });
  },
);

export const updateAdminInvoiceSettings = asyncHandler(
  async (req: Request, res: Response) => {
    const settings = await updateInvoiceSettings({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      input: parse(updateInvoiceSettingsSchema, req.body),
    });
    res.status(200).json({ settings });
  },
);

export const listMyInvoices = asyncHandler(async (req: Request, res: Response) => {
  const result = await listInvoices({
    tenantId: requireTenantId(req),
    input: parse(invoiceListSchema, req.query),
    allowedLocationIds: null,
    customerUserId: getAuthenticatedUserId(req),
  });
  res.status(200).json(result);
});

export const getMyInvoice = asyncHandler(async (req: Request, res: Response) => {
  const invoice = await getCustomerInvoiceById({
    tenantId: requireTenantId(req),
    invoiceId: invoiceId(req),
    userId: getAuthenticatedUserId(req),
  });
  res.status(200).json({ invoice: serializeCustomerInvoice(invoice) });
});

export const downloadMyInvoicePdf = asyncHandler(
  async (req: Request, res: Response) => {
    const invoice = await getCustomerInvoiceById({
      tenantId: requireTenantId(req),
      invoiceId: invoiceId(req),
      userId: getAuthenticatedUserId(req),
    });
    await sendPdf(res, invoice);
  },
);
