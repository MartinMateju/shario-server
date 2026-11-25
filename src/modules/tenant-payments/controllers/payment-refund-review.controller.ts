import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { forbidden } from "@/shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import { getAllowedWorkspaceLocationIds } from "@/modules/tenant-access/services/authorization.service.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";
import { listPaymentRefundReviews, resolvePaymentRefundReview } from "../services/payment-refund-review.service.js";
const authorize = (req: WorkspaceAccessRequest) => {
  if (getAllowedWorkspaceLocationIds(getResolvedWorkspaceAccess(req)) !== null)
    forbidden({ code: "REFUND_REVIEW_ALL_LOCATIONS_REQUIRED", message: "Refund review requires access to all studio locations." });
};
export const listRefundReviews = asyncHandler(async (req: WorkspaceAccessRequest, res) => {
  authorize(req);
  res.setHeader("Cache-Control", "no-store");
  res.json(await listPaymentRefundReviews(requireTenantId(req), typeof req.query.cursor === "string" ? req.query.cursor : undefined));
});
export const resolveRefundReview = asyncHandler(async (req: WorkspaceAccessRequest, res) => {
  authorize(req);
  res.setHeader("Cache-Control", "no-store");
  res.json(await resolvePaymentRefundReview({ tenantId: requireTenantId(req), id: String(req.params.id), actorId: String(req.userInfo!.id), body: req.body }));
});
