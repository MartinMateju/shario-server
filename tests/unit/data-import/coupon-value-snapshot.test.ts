import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";

// The migration is tested through its injected store. Keep unrelated hydrated
// tenant/product schemas out of this focused unit test.
vi.mock("@/modules/product/product.model.js", () => ({ default: {} }));
vi.mock("@/modules/tenants/tenant.model.js", () => ({ default: {} }));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: {},
  CouponOrder: {},
}));

import {
  migrateCouponValueSnapshots,
  type CouponSnapshotMigrationCoupon,
  type CouponSnapshotMigrationOrder,
  type CouponSnapshotMigrationProduct,
  type CouponSnapshotMigrationTenant,
  type CouponValueSnapshotMigrationStore,
} from "@/modules/coupon/coupon-value-snapshot.migration.js";
import {
  CouponValueSnapshotError,
  createCouponValueSnapshot,
  createCouponValueSnapshotFromOrder,
  createCouponValueSnapshotFromProduct,
  resolveCouponRedemptionValue,
} from "@/modules/coupon/coupon.utils.js";

describe("coupon immutable value snapshots", () => {
  it("creates exact minor-unit snapshots", () => {
    expect(
      createCouponValueSnapshot({ amount: 123.45, currency: "eur" }),
    ).toEqual({
      valueMinorSnapshot: 12_345,
      currencySnapshot: "EUR",
    });
    expect(createCouponValueSnapshot({ amount: 500, currency: "JPY" })).toEqual(
      {
        valueMinorSnapshot: 500,
        currencySnapshot: "JPY",
      },
    );
    expect(() =>
      createCouponValueSnapshot({ amount: 1.001, currency: "EUR" }),
    ).toThrow(CouponValueSnapshotError);
  });

  it("snapshots both native paid-order and manual-product issuance values", () => {
    expect(
      createCouponValueSnapshotFromOrder({
        unitPriceSnapshot: 1_250.5,
        currencySnapshot: "CZK",
      }),
    ).toEqual({ valueMinorSnapshot: 125_050, currencySnapshot: "CZK" });
    expect(
      createCouponValueSnapshotFromProduct({ price: 75.25, currency: "EUR" }),
    ).toEqual({ valueMinorSnapshot: 7_525, currencySnapshot: "EUR" });
  });

  it("prefers Coupon, then CouponOrder, then the legacy Product", () => {
    expect(
      resolveCouponRedemptionValue({
        coupon: {
          valueMinorSnapshot: 12_345,
          currencySnapshot: "EUR",
          order: new mongoose.Types.ObjectId(),
        },
        orderSnapshot: { unitPriceSnapshot: 999, currencySnapshot: "USD" },
        product: { price: 1, currency: "CZK" },
      }),
    ).toMatchObject({
      amount: 123.45,
      currencySnapshot: "EUR",
      source: "coupon",
    });

    expect(
      resolveCouponRedemptionValue({
        coupon: { order: new mongoose.Types.ObjectId() },
        orderSnapshot: { unitPriceSnapshot: 99.5, currencySnapshot: "USD" },
        product: { price: 1, currency: "CZK" },
      }),
    ).toMatchObject({ amount: 99.5, currencySnapshot: "USD", source: "order" });

    expect(
      resolveCouponRedemptionValue({
        coupon: {},
        product: { price: 250 },
        tenantCurrency: "CZK",
      }),
    ).toMatchObject({
      amount: 250,
      currencySnapshot: "CZK",
      source: "product",
    });
  });

  it("fails closed for partial, corrupt, or missing authoritative snapshots", () => {
    expect(() =>
      resolveCouponRedemptionValue({
        coupon: { valueMinorSnapshot: 10_000 },
        product: { price: 100, currency: "CZK" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "COUPON_VALUE_SNAPSHOT_INCOMPLETE" }),
    );
    expect(() =>
      resolveCouponRedemptionValue({
        coupon: { valueMinorSnapshot: -1, currencySnapshot: "CZK" },
        product: { price: 100, currency: "CZK" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "COUPON_VALUE_SNAPSHOT_INVALID" }),
    );
    expect(() =>
      resolveCouponRedemptionValue({
        coupon: { order: new mongoose.Types.ObjectId() },
        orderSnapshot: null,
        product: { price: 100, currency: "CZK" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "COUPON_ORDER_VALUE_SNAPSHOT_MISSING" }),
    );
  });
});

const migrationStore = (input: {
  coupons: CouponSnapshotMigrationCoupon[];
  products: CouponSnapshotMigrationProduct[];
  orders: CouponSnapshotMigrationOrder[];
  tenants: CouponSnapshotMigrationTenant[];
}) => {
  const setSnapshot = vi.fn(
    async ({
      coupon,
      snapshot,
    }: Parameters<CouponValueSnapshotMigrationStore["setSnapshot"]>[0]) => {
      const target = input.coupons.find(
        (candidate) => String(candidate._id) === String(coupon._id),
      );
      if (
        !target ||
        target.valueMinorSnapshot != null ||
        target.currencySnapshot
      ) {
        return false;
      }
      target.valueMinorSnapshot = snapshot.valueMinorSnapshot;
      target.currencySnapshot = snapshot.currencySnapshot;
      return true;
    },
  );
  const store: CouponValueSnapshotMigrationStore = {
    async loadCouponBatch({ afterId, batchSize }) {
      const start = afterId
        ? input.coupons.findIndex(
            (coupon) => String(coupon._id) === String(afterId),
          ) + 1
        : 0;
      return input.coupons.slice(start, start + batchSize);
    },
    async loadProducts(ids) {
      const wanted = new Set(ids.map(String));
      return input.products.filter((product) =>
        wanted.has(String(product._id)),
      );
    },
    async loadOrders(ids) {
      const wanted = new Set(ids.map(String));
      return input.orders.filter((order) => wanted.has(String(order._id)));
    },
    async loadTenants(ids) {
      const wanted = new Set(ids.map(String));
      return input.tenants.filter((tenant) => wanted.has(String(tenant._id)));
    },
    setSnapshot,
  };
  return { store, setSnapshot };
};

describe("coupon value snapshot backfill", () => {
  const setup = () => {
    const tenant = new mongoose.Types.ObjectId();
    const product = new mongoose.Types.ObjectId();
    const order = new mongoose.Types.ObjectId();
    const coupons: CouponSnapshotMigrationCoupon[] = [
      {
        _id: new mongoose.Types.ObjectId(),
        tenant,
        product,
        valueMinorSnapshot: 1_000,
        currencySnapshot: "CZK",
      },
      {
        _id: new mongoose.Types.ObjectId(),
        tenant,
        product,
        order,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        tenant,
        product,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        tenant,
        product,
        valueMinorSnapshot: 500,
      },
    ];
    const harness = migrationStore({
      coupons,
      products: [{ _id: product, tenant, type: "coupon", price: 250 }],
      orders: [
        {
          _id: order,
          tenant,
          unitPriceSnapshot: 99.5,
          currencySnapshot: "EUR",
        },
      ],
      tenants: [{ _id: tenant, settings: { currency: "CZK" } }],
    });
    return { coupons, ...harness };
  };

  it("is dry-run by default and reports invalid rows without writes", async () => {
    const { store, setSnapshot } = setup();
    const summary = await migrateCouponValueSnapshots({ store, batchSize: 2 });
    expect(summary).toMatchObject({
      mode: "dry-run",
      scanned: 4,
      alreadySnapshotted: 1,
      eligible: 2,
      wouldUpdate: 2,
      updated: 0,
      invalid: 1,
      errors: [
        expect.objectContaining({ code: "COUPON_VALUE_SNAPSHOT_INCOMPLETE" }),
      ],
    });
    expect(summary.errors[0]).not.toHaveProperty("promoCode");
    expect(setSnapshot).not.toHaveBeenCalled();
  });

  it("applies once without overwriting snapshots and is idempotent", async () => {
    const { coupons, store, setSnapshot } = setup();
    await expect(
      migrateCouponValueSnapshots({ apply: true, store, batchSize: 2 }),
    ).resolves.toMatchObject({ updated: 2, invalid: 1 });
    expect(setSnapshot).toHaveBeenCalledTimes(2);
    expect(coupons[1]).toMatchObject({
      valueMinorSnapshot: 9_950,
      currencySnapshot: "EUR",
    });
    expect(coupons[2]).toMatchObject({
      valueMinorSnapshot: 25_000,
      currencySnapshot: "CZK",
    });

    setSnapshot.mockClear();
    await expect(
      migrateCouponValueSnapshots({ apply: true, store, batchSize: 2 }),
    ).resolves.toMatchObject({
      updated: 0,
      alreadySnapshotted: 3,
      invalid: 1,
    });
    expect(setSnapshot).not.toHaveBeenCalled();
  });

  it("backfills an ordered voucher from the order without a mutable Product", async () => {
    const tenant = new mongoose.Types.ObjectId();
    const missingProduct = new mongoose.Types.ObjectId();
    const order = new mongoose.Types.ObjectId();
    const coupon: CouponSnapshotMigrationCoupon = {
      _id: new mongoose.Types.ObjectId(),
      tenant,
      product: missingProduct,
      order,
    };
    const { store } = migrationStore({
      coupons: [coupon],
      products: [],
      orders: [
        {
          _id: order,
          tenant,
          unitPriceSnapshot: 149.5,
          currencySnapshot: "EUR",
        },
      ],
      tenants: [],
    });

    await expect(
      migrateCouponValueSnapshots({ apply: true, store }),
    ).resolves.toMatchObject({ updated: 1, invalid: 0 });
    expect(coupon).toMatchObject({
      valueMinorSnapshot: 14_950,
      currencySnapshot: "EUR",
    });
  });
});
