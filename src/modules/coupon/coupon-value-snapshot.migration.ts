import mongoose from "mongoose";

import ProductModel from "@/modules/product/product.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import { Coupon, CouponOrder } from "./coupon.model.js";
import {
  CouponValueSnapshotError,
  resolveCouponRedemptionValue,
  type CouponValueSnapshot,
} from "./coupon.utils.js";

type Id = mongoose.Types.ObjectId | string;

export type CouponSnapshotMigrationCoupon = {
  _id: Id;
  tenant: Id;
  product: Id;
  order?: Id | null;
  valueMinorSnapshot?: number | null;
  currencySnapshot?: string | null;
};

export type CouponSnapshotMigrationProduct = {
  _id: Id;
  tenant: Id;
  type?: string;
  price?: number;
  currency?: string;
};

export type CouponSnapshotMigrationOrder = {
  _id: Id;
  tenant: Id;
  unitPriceSnapshot?: number;
  currencySnapshot?: string;
};

export type CouponSnapshotMigrationTenant = {
  _id: Id;
  settings?: { currency?: string };
};

export type CouponValueSnapshotMigrationStore = {
  loadCouponBatch(input: {
    afterId: Id | null;
    batchSize: number;
    tenantId?: string;
  }): Promise<CouponSnapshotMigrationCoupon[]>;
  loadProducts(ids: Id[]): Promise<CouponSnapshotMigrationProduct[]>;
  loadOrders(ids: Id[]): Promise<CouponSnapshotMigrationOrder[]>;
  loadTenants(ids: Id[]): Promise<CouponSnapshotMigrationTenant[]>;
  setSnapshot(input: {
    coupon: CouponSnapshotMigrationCoupon;
    snapshot: CouponValueSnapshot;
  }): Promise<boolean>;
};

export type CouponValueSnapshotMigrationSummary = {
  mode: "dry-run" | "apply";
  tenantId: string | null;
  scanned: number;
  alreadySnapshotted: number;
  eligible: number;
  wouldUpdate: number;
  updated: number;
  raced: number;
  invalid: number;
  errors: Array<{
    couponId: string;
    code: string;
    message: string;
  }>;
};

const key = (tenant: Id, id: Id): string => `${String(tenant)}:${String(id)}`;

const uniqueIds = (values: Array<Id | null | undefined>): Id[] => {
  const byValue = new Map<string, Id>();
  for (const value of values) {
    if (value !== null && value !== undefined)
      byValue.set(String(value), value);
  }
  return [...byValue.values()];
};

const toObjectId = (value: Id): mongoose.Types.ObjectId =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(value);

export const couponValueSnapshotMigrationStore: CouponValueSnapshotMigrationStore =
  {
    async loadCouponBatch({ afterId, batchSize, tenantId }) {
      const filter: Record<string, unknown> = {};
      if (afterId) filter._id = { $gt: toObjectId(afterId) };
      if (tenantId) filter.tenant = toObjectId(tenantId);
      return (await Coupon.find(filter)
        .select("_id tenant product order valueMinorSnapshot currencySnapshot")
        .sort({ _id: 1 })
        .limit(batchSize)
        .lean()
        .exec()) as unknown as CouponSnapshotMigrationCoupon[];
    },

    async loadProducts(ids) {
      if (!ids.length) return [];
      return (await ProductModel.find({ _id: { $in: ids.map(toObjectId) } })
        .select("_id tenant type price currency")
        .lean()
        .exec()) as unknown as CouponSnapshotMigrationProduct[];
    },

    async loadOrders(ids) {
      if (!ids.length) return [];
      return (await CouponOrder.find({ _id: { $in: ids.map(toObjectId) } })
        .select("_id tenant unitPriceSnapshot currencySnapshot")
        .lean()
        .exec()) as unknown as CouponSnapshotMigrationOrder[];
    },

    async loadTenants(ids) {
      if (!ids.length) return [];
      return (await TenantModel.find({ _id: { $in: ids.map(toObjectId) } })
        .select("_id settings.currency")
        .lean()
        .exec()) as unknown as CouponSnapshotMigrationTenant[];
    },

    async setSnapshot({ coupon, snapshot }) {
      // Use the raw collection because these two fields are immutable after the
      // initial one-time backfill. The null predicates make retries/concurrency
      // idempotent and ensure an existing snapshot can never be overwritten.
      const result = await Coupon.collection.updateOne(
        {
          _id: toObjectId(coupon._id),
          tenant: toObjectId(coupon.tenant),
          valueMinorSnapshot: null,
          currencySnapshot: null,
        },
        { $set: snapshot },
      );
      return result.modifiedCount === 1;
    },
  };

const normalizeMigrationError = (error: unknown) => {
  if (error instanceof CouponValueSnapshotError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "COUPON_VALUE_SNAPSHOT_BACKFILL_INVALID",
    message: error instanceof Error ? error.message : String(error),
  };
};

export const migrateCouponValueSnapshots = async (
  options: {
    apply?: boolean;
    tenantId?: string;
    batchSize?: number;
    store?: CouponValueSnapshotMigrationStore;
  } = {},
): Promise<CouponValueSnapshotMigrationSummary> => {
  const apply = options.apply === true;
  const tenantId = options.tenantId?.trim() || undefined;
  if (tenantId && !mongoose.Types.ObjectId.isValid(tenantId)) {
    throw new Error("tenantId must be a valid object id.");
  }
  const requestedBatchSize = options.batchSize ?? 250;
  if (!Number.isSafeInteger(requestedBatchSize) || requestedBatchSize < 1) {
    throw new Error("batchSize must be a positive whole number.");
  }
  const batchSize = Math.min(requestedBatchSize, 1_000);
  const store = options.store ?? couponValueSnapshotMigrationStore;
  const summary: CouponValueSnapshotMigrationSummary = {
    mode: apply ? "apply" : "dry-run",
    tenantId: tenantId ?? null,
    scanned: 0,
    alreadySnapshotted: 0,
    eligible: 0,
    wouldUpdate: 0,
    updated: 0,
    raced: 0,
    invalid: 0,
    errors: [],
  };
  let afterId: Id | null = null;

  for (;;) {
    const coupons = await store.loadCouponBatch({
      afterId,
      batchSize,
      tenantId,
    });
    if (!coupons.length) break;

    const missing = coupons.filter(
      (coupon) =>
        coupon.valueMinorSnapshot === null ||
        coupon.valueMinorSnapshot === undefined ||
        !String(coupon.currencySnapshot ?? "").trim(),
    );
    const [products, orders, tenants] = await Promise.all([
      store.loadProducts(uniqueIds(missing.map((coupon) => coupon.product))),
      store.loadOrders(uniqueIds(missing.map((coupon) => coupon.order))),
      store.loadTenants(uniqueIds(missing.map((coupon) => coupon.tenant))),
    ]);
    const productsByKey = new Map(
      products.map((product) => [key(product.tenant, product._id), product]),
    );
    const ordersByKey = new Map(
      orders.map((order) => [key(order.tenant, order._id), order]),
    );
    const tenantsById = new Map(
      tenants.map((tenant) => [String(tenant._id), tenant]),
    );

    for (const coupon of coupons) {
      summary.scanned += 1;
      try {
        const hasValue =
          coupon.valueMinorSnapshot !== null &&
          coupon.valueMinorSnapshot !== undefined;
        const hasCurrency = Boolean(
          String(coupon.currencySnapshot ?? "").trim(),
        );
        if (hasValue || hasCurrency) {
          resolveCouponRedemptionValue({
            coupon,
            product: {},
          });
          summary.alreadySnapshotted += 1;
          continue;
        }

        const order = coupon.order
          ? (ordersByKey.get(key(coupon.tenant, coupon.order)) ?? null)
          : null;
        const product = productsByKey.get(key(coupon.tenant, coupon.product));
        // A CouponOrder is the immutable paid-value authority and must remain
        // backfillable even if the mutable Product was later archived, changed,
        // or removed. Product validity matters only for the legacy fallback.
        if (!coupon.order && (!product || product.type !== "coupon")) {
          throw new CouponValueSnapshotError(
            "COUPON_PRODUCT_VALUE_INVALID",
            "Voucher product is missing or is not a coupon product.",
          );
        }
        const tenant = tenantsById.get(String(coupon.tenant));
        const resolved = resolveCouponRedemptionValue({
          coupon,
          orderSnapshot: order,
          product: product ?? {},
          tenantCurrency: tenant?.settings?.currency,
        });
        const snapshot: CouponValueSnapshot = {
          valueMinorSnapshot: resolved.valueMinorSnapshot,
          currencySnapshot: resolved.currencySnapshot as StudioCommerceCurrency,
        };
        summary.eligible += 1;
        if (!apply) {
          summary.wouldUpdate += 1;
          continue;
        }
        if (await store.setSnapshot({ coupon, snapshot })) {
          summary.updated += 1;
        } else {
          summary.raced += 1;
        }
      } catch (error) {
        summary.invalid += 1;
        if (summary.errors.length < 200) {
          const normalized = normalizeMigrationError(error);
          summary.errors.push({
            couponId: String(coupon._id),
            ...normalized,
          });
        }
      }
    }

    afterId = coupons.at(-1)!._id;
    if (coupons.length < batchSize) break;
  }

  return summary;
};

export default migrateCouponValueSnapshots;
