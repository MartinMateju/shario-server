import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { membershipCheckoutService } from "../services/membership-checkout.service.js";
import { userMembershipService } from "../services/user-membership.service.js";
import { membershipPlanChangeService } from "../services/membership-plan-change.service.js";
import {
  adjustmentSchema,
  assignMembershipSchema,
  billingPortalSchema,
  cancellationSchema,
  checkoutSchema,
  checkoutStatusParamsSchema,
  customerCancellationSchema,
  listMembershipInvoicesSchema,
  listUserMembershipsSchema,
  membershipIdParamsSchema,
  membershipInvoiceParamsSchema,
  userMembershipParamsSchema,
  membershipPlanChangeSchema,
} from "../membership.validators.js";

const allowedLocations = (req: Request) =>
  getAllowedWorkspaceLocationIds(getResolvedWorkspaceAccess(req as WorkspaceAccessRequest));

export const getUserMemberships = asyncHandler(async (req: Request, res: Response) => {
  res.json(await userMembershipService.list(
    requireTenantId(req),
    listUserMembershipsSchema.parse(req.query),
    allowedLocations(req),
  ));
});

export const getUserMembershipDetail = asyncHandler(async (req: Request, res: Response) => {
  const { id } = membershipIdParamsSchema.parse(req.params);
  const membership = await userMembershipService.detail(requireTenantId(req), id, allowedLocations(req));
  res.json({ membership });
});

export const assignMembershipToUser = asyncHandler(async (req: Request, res: Response) => {
  const membership = await userMembershipService.assign(
    requireTenantId(req),
    assignMembershipSchema.parse(req.body),
    allowedLocations(req),
    getAuthenticatedUserId(req),
  );
  res.status(201).json({ membership });
});

export const adjustUserMembership = asyncHandler(async (req: Request, res: Response) => {
  const { id } = membershipIdParamsSchema.parse(req.params);
  const result = await userMembershipService.adjust(
    requireTenantId(req),
    id,
    adjustmentSchema.parse(req.body),
    getAuthenticatedUserId(req),
    req.get("Idempotency-Key"),
    allowedLocations(req),
  );
  res.json(result);
});

export const cancelUserMembership = asyncHandler(async (req: Request, res: Response) => {
  const { id } = membershipIdParamsSchema.parse(req.params);
  const membership = await userMembershipService.cancel(
    requireTenantId(req),
    id,
    cancellationSchema.parse(req.body),
    getAuthenticatedUserId(req),
    "owner",
    allowedLocations(req),
  );
  res.json({ membership });
});

export const getUserMembership = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = userMembershipParamsSchema.parse(req.params);
  const membership = await userMembershipService.getActiveForUser(
    requireTenantId(req), userId, allowedLocations(req),
  );
  res.json({ membership });
});

export const getMyMembership = asyncHandler(async (req: Request, res: Response) => {
  const membership = await userMembershipService.mine(requireTenantId(req), getAuthenticatedUserId(req));
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.json({ membership });
});

export const getMyMembershipLedger = asyncHandler(async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.json(await userMembershipService.ledger(requireTenantId(req), getAuthenticatedUserId(req)));
});

export const getMyMembershipInvoices = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = listMembershipInvoicesSchema.parse(req.query);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.json(await userMembershipService.invoices(requireTenantId(req), getAuthenticatedUserId(req), page, limit));
});

export const getMyMembershipInvoice = asyncHandler(async (req: Request, res: Response) => {
  const { invoiceId } = membershipInvoiceParamsSchema.parse(req.params);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.json({ invoice: await userMembershipService.invoice(requireTenantId(req), getAuthenticatedUserId(req), invoiceId) });
});

export const downloadMyMembershipInvoice = asyncHandler(async (req: Request, res: Response) => {
  const { invoiceId } = membershipInvoiceParamsSchema.parse(req.params);
  const url = await userMembershipService.invoiceDocumentUrl(
    requireTenantId(req), getAuthenticatedUserId(req), invoiceId,
  );
  let document: Awaited<ReturnType<typeof fetch>>;
  try {
    document = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    res.status(502).json({ message: "Membership invoice document is temporarily unavailable." });
    return;
  }
  if (!document.ok) {
    res.status(502).json({ message: "Membership invoice document is temporarily unavailable." });
    return;
  }
  const body = Buffer.from(await document.arrayBuffer());
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Content-Type", document.headers.get("content-type") || "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="membership-invoice-${invoiceId}.pdf"`);
  res.send(body);
});

export const createMembershipCheckout = asyncHandler(async (req: Request, res: Response) => {
  const result = await membershipCheckoutService.create(
    requireTenantId(req),
    getAuthenticatedUserId(req),
    checkoutSchema.parse(req.body),
    req.get("Idempotency-Key"),
  );
  res.status(201).json(result);
});

export const getMembershipCheckoutStatus = asyncHandler(async (req: Request, res: Response) => {
  const { sessionId } = checkoutStatusParamsSchema.parse(req.params);
  res.json(await membershipCheckoutService.status(
    requireTenantId(req), getAuthenticatedUserId(req), sessionId,
  ));
});

export const cancelMyMembership = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const userId = getAuthenticatedUserId(req);
  const current: any = await userMembershipService.mine(tenantId, userId);
  if (!current) {
    res.status(404).json({ message: "Open membership not found." });
    return;
  }
  const input = customerCancellationSchema.parse(req.body);
  const membership = await userMembershipService.cancel(
    tenantId,
    current.id,
    { ...input, effective: "period_end" },
    userId,
    "customer",
    null,
  );
  res.json({ membership });
});

export const resumeMyMembership = asyncHandler(async (req: Request, res: Response) => {
  const membership = await userMembershipService.resume(requireTenantId(req), getAuthenticatedUserId(req));
  res.json({ membership });
});

export const scheduleMyMembershipPlanChange = asyncHandler(async (req: Request, res: Response) => {
  res.json(await membershipPlanChangeService.schedule(requireTenantId(req), getAuthenticatedUserId(req),
    membershipPlanChangeSchema.parse(req.body), req.get("Idempotency-Key")));
});

export const cancelMyMembershipPlanChange = asyncHandler(async (req: Request, res: Response) => {
  res.json(await membershipPlanChangeService.cancel(requireTenantId(req), getAuthenticatedUserId(req)));
});

export const createMyMembershipBillingPortal = asyncHandler(async (req: Request, res: Response) => {
  res.json(await membershipCheckoutService.billingPortal(
    requireTenantId(req),
    getAuthenticatedUserId(req),
    billingPortalSchema.parse(req.body ?? {}),
  ));
});
