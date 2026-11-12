import mongoose, { type ClientSession } from "mongoose";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";
import { VOUCHER_OFFERING_ALLOWANCES } from "@/modules/tenants/tenant.plan.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import { Product } from "./product.model.js";
import { resolveProductKindV2 } from "./product.utils.js";

export const VOUCHER_DELETE_CONFIRMATION = "I agree and I confirm that it can be deleted";

export type VoucherAllowanceTenant = {
  plan?: TenantPlan;
  planVersion?: number;
  voucherQuotaVersion?: number;
  settings?: { timezone?: string };
};

/**
 * One tenant document is the serialization point for publication, order creation,
 * issuance and offering deletion. Call BEFORE reading products/codes in the same
 * transaction. Concurrent operations cause MongoDB to retry their full transaction.
 * Raw collection access keeps this internal revision outside tenant-facing DTOs.
 */
export const acquireVoucherTenantMutationLock = async (
  tenantId: string,
  session: ClientSession,
): Promise<VoucherAllowanceTenant> => {
  if (!session?.inTransaction()) throw new Error("Voucher mutation requires a transaction.");
  const { TenantModel } = await import("@/modules/tenants/tenant.model.js");
  const tenant = await TenantModel.collection.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(tenantId) },
    { $inc: { voucherMutationVersion: 1 } },
    { session, returnDocument: "after" },
  );
  if (!tenant) notFound("Workspace not found.");
  return tenant as VoucherAllowanceTenant;
};

export const resolveVoucherOfferingLimit = (tenant: VoucherAllowanceTenant): number | null => {
  if (tenant.voucherQuotaVersion === undefined) return null;
  if (tenant.voucherQuotaVersion !== 1 || !tenant.plan || !(tenant.plan in VOUCHER_OFFERING_ALLOWANCES)) {
    throw new Error("Invalid voucher offering allowance version or plan.");
  }
  return VOUCHER_OFFERING_ALLOWANCES[tenant.plan];
};

export const isPublishedVoucherOffering = (product: any): boolean =>
  Boolean(product && product.isActive !== false && resolveProductKindV2(product) === "voucher");

export const countActiveVoucherOfferings = async (tenantId: string, session?: ClientSession): Promise<number> => {
  const query = Product.countDocuments({
    tenant: new mongoose.Types.ObjectId(tenantId),
    isActive: { $ne: false },
    $or: [
      { kind: "voucher" },
      { kind: { $in: [null, ""] }, type: { $in: ["coupon", "gift-card", "voucher"] } },
    ],
  } as never);
  if (session) query.session(session);
  return query.exec();
};

/** Tenant lock must already be acquired by the caller in this session. */
export const assertVoucherOfferingPublicationAllowed = async ({
  tenantId, session, tenant, current, desired,
}: {
  tenantId: string;
  session: ClientSession;
  tenant: VoucherAllowanceTenant;
  current?: any;
  desired: any;
}): Promise<void> => {
  if (!session?.inTransaction()) throw new Error("Voucher publication requires a transaction.");
  // Existing over-limit offerings stay usable after a downgrade; no new slots can
  // be published until the tenant archives enough offerings to get below the cap.
  if (!isPublishedVoucherOffering(desired) || isPublishedVoucherOffering(current)) return;
  const maximum = resolveVoucherOfferingLimit(tenant);
  if (maximum === null) return;
  const activeCount = await countActiveVoucherOfferings(tenantId, session);
  if (activeCount >= maximum) {
    conflict({
      message: "Your plan's published voucher limit has been reached. Archive an offering or upgrade your plan.",
      code: "VOUCHER_OFFERING_LIMIT_REACHED",
      details: { activeCount, maxActiveVoucherOfferings: maximum },
    });
  }
};

export type VoucherDeletionPolicy = {
  canDelete: boolean;
  reason: null | "unexpired_codes" | "pending_orders" | "confirmation_required";
  unexpiredCodeCount: number;
  perpetualCodeCount: number;
  pendingOrderCount: number;
  requiresConfirmation: boolean;
  confirmationText: string;
};

export const decideVoucherOfferingDeletion = ({ unexpiredCodeCount, perpetualCodeCount, pendingOrderCount }: {
  unexpiredCodeCount: number;
  perpetualCodeCount: number;
  pendingOrderCount: number;
}): VoucherDeletionPolicy => {
  const reason = pendingOrderCount > 0 ? "pending_orders"
    : unexpiredCodeCount > 0 ? "unexpired_codes"
    : perpetualCodeCount > 0 ? "confirmation_required" : null;
  return {
    canDelete: reason === null,
    reason, unexpiredCodeCount, perpetualCodeCount, pendingOrderCount,
    requiresConfirmation: reason === "confirmation_required",
    confirmationText: VOUCHER_DELETE_CONFIRMATION,
  };
};

export const getVoucherOfferingDeletionPolicy = async ({ tenantId, productId, session, now = new Date() }: {
  tenantId: string;
  productId: string;
  session?: ClientSession;
  now?: Date;
}): Promise<VoucherDeletionPolicy> => {
  const { Coupon, CouponOrder } = await import("@/modules/coupon/coupon.model.js");
  const filter = { tenant: new mongoose.Types.ObjectId(tenantId), product: new mongoose.Types.ObjectId(productId) };
  // Keep operations sequential: MongoDB does not support parallel operations in
  // one transaction. All counts include used codes, following the expiry rule.
  const run = async (query: any): Promise<number> => {
    if (session) query.session(session);
    return query.exec();
  };
  const unexpiredCodeCount = await run(Coupon.countDocuments({ ...filter, expiresAt: { $gt: now } }));
  const perpetualCodeCount = await run(Coupon.countDocuments({ ...filter, expiresAt: null }));
  const pendingOrderCount = await run(CouponOrder.countDocuments({
    ...filter,
    $or: [
      // A completed full refund can retain its original payment status and
      // intent reference. It no longer needs issuance/delivery protection.
      { refundState: { $ne: "revoked" }, status: "pending_coupon_payment" },
      { isProcessing: true },
      { refundState: { $ne: "revoked" }, stripePaymentIntentId: { $nin: ["", null] }, processedAt: null, status: { $ne: "expired_coupon_payment" } },
    ],
  }));
  return decideVoucherOfferingDeletion({ unexpiredCodeCount, perpetualCodeCount, pendingOrderCount });
};

export const assertVoucherOfferingDeletable = (policy: VoucherDeletionPolicy, confirmation?: string): void => {
  if (policy.reason === "pending_orders") conflict({ message: "This voucher has pending purchases or delivery. Archive it instead.", code: "VOUCHER_OFFERING_PENDING_ORDERS", details: policy });
  if (policy.reason === "unexpired_codes") conflict({ message: "This voucher has unexpired codes. Archive it instead.", code: "VOUCHER_OFFERING_UNEXPIRED_CODES", details: policy });
  if (policy.requiresConfirmation && confirmation !== VOUCHER_DELETE_CONFIRMATION) {
    badRequest({ message: "Type the confirmation exactly to delete an offering with codes that have no expiry.", code: "VOUCHER_OFFERING_DELETE_CONFIRMATION_REQUIRED", details: policy });
  }
};

/** Preserve the legacy value fallback before removing its offering. Never alters issued terms. */
export const preserveLegacyVoucherValuesBeforeDeletion = async ({ tenantId, product, session }: {
  tenantId: string;
  product: any;
  session: ClientSession;
}): Promise<void> => {
  const { Coupon, CouponOrder } = await import("@/modules/coupon/coupon.model.js");
  const { resolveCouponRedemptionValue } = await import("@/modules/coupon/coupon.utils.js");
  const tenant = new mongoose.Types.ObjectId(tenantId);
  const coupons = await Coupon.find({ tenant, product: product._id })
    .session(session).lean().exec();
  for (const coupon of coupons) {
    const needsValue = coupon.valueMinorSnapshot == null || coupon.currencySnapshot == null;
    const needsName = !String(coupon.productNameSnapshot ?? "").trim();
    if (!needsValue && !needsName) continue;
    const order = coupon.order ? await CouponOrder.findOne({ _id: coupon.order, tenant })
      .select("unitPriceSnapshot currencySnapshot productNameSnapshot").session(session).lean().exec() : null;
    if (needsName) {
      await Coupon.collection.updateOne({ _id: coupon._id, tenant }, { $set: {
        productNameSnapshot: String(order?.productNameSnapshot || product.name || "Voucher"),
      } }, { session });
    }
    if (!needsValue) continue;
    let snapshot;
    try {
      snapshot = resolveCouponRedemptionValue({ coupon, orderSnapshot: order, product });
    } catch {
      conflict({ message: "An issued voucher needs its original value repaired before this offering can be deleted. Archive it instead.", code: "VOUCHER_VALUE_SNAPSHOT_REQUIRED" });
    }
    // This one-time backfill intentionally bypasses immutable-path stripping;
    // the filter prevents overwriting any existing issuance authority.
    const updated = await Coupon.collection.updateOne({
      _id: coupon._id, tenant, valueMinorSnapshot: null, currencySnapshot: null,
    }, { $set: { valueMinorSnapshot: snapshot.valueMinorSnapshot, currencySnapshot: snapshot.currencySnapshot } }, { session });
    if (updated.modifiedCount !== 1) conflict({ message: "Voucher value snapshot changed; retry deletion.", code: "VOUCHER_VALUE_SNAPSHOT_REQUIRED" });
  }
};
