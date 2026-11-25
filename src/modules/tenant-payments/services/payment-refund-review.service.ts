import mongoose from "mongoose";
import { z } from "zod";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";
import { Order } from "@/modules/order/order.model.js";
import User from "@/modules/user/user.model.js";
import Membership from "@/modules/membership/user-membership.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import { PaymentRefundReconciliation, PaymentRefundReviewResolution, preparePaymentRefundCollections } from "../payment-refund-reconciliation.model.js";
import { serializeRefundSummary } from "../payment-refund-summary.js";

export const refundReviewResolutionSchema = z.object({
  snapshotVersion: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().min(10).max(2000),
}).strict();
export const serializeRefundReview = (row: any) => ({
  id: row._id, orderId: row.order ? String(row.order) : null,
  membershipId: row.membership ? String(row.membership) : null,
  currency: row.currency || null, paidAmountMinor: row.paidAmountMinor,
  refund: serializeRefundSummary(row.summary), reviewRequired: row.reviewRequired,
  reviewReason: row.reviewReason, snapshotVersion: row.snapshotVersion,
  observedAt: row.lastObservedAt ?? null, updatedAt: row.updatedAt,
});
async function withReviewContext(tenantId: string, reviews: ReturnType<typeof serializeRefundReview>[]) {
  const [orders, memberships] = await Promise.all([
    Order.find({ tenant: tenantId, _id: { $in: reviews.map((row) => row.orderId).filter(Boolean) } }).select("customer").lean().exec(),
    Membership.find({ tenant: tenantId, _id: { $in: reviews.map((row) => row.membershipId).filter(Boolean) } }).select("user planSnapshot.name").lean().exec(),
  ]);
  const users = await User.find({ tenant: tenantId, _id: { $in: memberships.map((row) => row.user) } }).select("firstname lastname").lean().exec();
  return reviews.map((review) => {
    const order = orders.find((row) => String(row._id) === review.orderId);
    const membership = memberships.find((row) => String(row._id) === review.membershipId);
    const customer = order?.customer ?? users.find((row) => String(row._id) === String(membership?.user));
    const customerName = customer ? [customer.firstname, customer.lastname].filter(Boolean).join(" ").trim() : "";
    return { ...review, customerName: customerName || null, membershipName: membership?.planSnapshot?.name || null };
  });
}
export async function listPaymentRefundReviews(tenantId: string, cursor?: string) {
  if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) badRequest("Invalid refund review cursor.");
  const rows = await PaymentRefundReconciliation.find({ tenant: tenantId, reviewRequired: true,
    ...(cursor ? { _id: { $gt: cursor } } : {}) }).sort({ _id: 1 }).limit(51).lean().exec();
  return { reviews: await withReviewContext(tenantId, rows.slice(0, 50).map(serializeRefundReview)), nextCursor: rows.length > 50 ? String(rows[49]._id) : null };
}
export async function resolvePaymentRefundReview(input: { tenantId: string; id: string; actorId: string; body: unknown }) {
  if (!/^[a-f0-9]{64}$/.test(input.id)) notFound("Refund review not found.");
  const parsed = refundReviewResolutionSchema.safeParse(input.body);
  if (!parsed.success) badRequest({ code: "REFUND_REVIEW_INVALID", message: "Provide the current snapshot version, an action note, and evidence (10–2000 characters each)." });
  const body = parsed.data!;
  await preparePaymentRefundCollections();
  let result: any;
  await mongoose.connection.transaction(async (session) => {
    const row = await PaymentRefundReconciliation.findOne({ _id: input.id, tenant: input.tenantId }).session(session).exec();
    if (!row) notFound("Refund review not found.");
    if (row!.snapshotVersion !== body.snapshotVersion || row!.claimToken || !row!.summary ||
        ["payment_binding_missing", "payment_snapshot_mismatch", "provider_snapshot_incomplete", "reconciliation_incomplete"].includes(row!.reviewReason))
      conflict({ code: "REFUND_REVIEW_CHANGED", message: "Refresh this review. Incomplete payment associations must be repaired and reconciled before acknowledgment." });
    if (!row!.reviewRequired) { result = serializeRefundReview(row); return; }
    row!.reviewRequired = false;
    row!.reviewReason = "";
    row!.summary = { ...row!.summary.toObject(), reviewRequired: false, reviewReason: "", updatedAt: new Date() };
    row!.resolution = { actor: new mongoose.Types.ObjectId(input.actorId), note: body.note, evidence: body.evidence, snapshotVersion: body.snapshotVersion, resolvedAt: new Date() };
    await row!.save({ session });
    await PaymentRefundReviewResolution.updateOne({ _id: `${row!._id}:${body.snapshotVersion}` }, { $setOnInsert: {
      reconciliation: row!._id, tenant: input.tenantId, ...row!.resolution.toObject(),
    } }, { upsert: true, session });
    if (row!.order) await Order.updateOne({ _id: row!.order, tenant: input.tenantId, "refund.snapshotVersion": body.snapshotVersion }, { $set: { refund: row!.summary } }, { session });
    if (row!.membership) await Membership.updateOne({ _id: row!.membership, tenant: input.tenantId }, { $inc: { refundReconciliationRevision: 1 } }, { session });
    if (row!.stripeInvoiceId) await MembershipInvoice.updateOne({ tenant: input.tenantId, connectedAccountId: row!.connectedAccountId, stripeInvoiceId: row!.stripeInvoiceId }, { $set: { refund: row!.summary } }, { session });
    result = serializeRefundReview(row);
  });
  return { review: (await withReviewContext(input.tenantId, [result]))[0] };
}
