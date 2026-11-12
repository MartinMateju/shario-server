import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TenantModel } from "@/modules/tenants/tenant.model.js";
import { Product } from "@/modules/product/product.model.js";
import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import {
  acquireVoucherTenantMutationLock,
  assertVoucherOfferingPublicationAllowed,
  assertVoucherOfferingDeletable,
  countActiveVoucherOfferings,
  getVoucherOfferingDeletionPolicy,
  preserveLegacyVoucherValuesBeforeDeletion,
  VOUCHER_DELETE_CONFIRMATION,
} from "@/modules/product/voucher-offering.policy.js";

let replicaSet: MongoMemoryReplSet | undefined;
let tenantId: string;
const actorId = new mongoose.Types.ObjectId();
const offer = (name: string, isActive = true) => ({
  tenant: new mongoose.Types.ObjectId(tenantId), createdBy: actorId, name,
  kind: "voucher" as const, type: "coupon" as const, label: name, price: 500, extraCharge: 0,
  currency: "CZK" as const, isActive,
});

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replicaSet.getUri());
  await Promise.all([TenantModel.init(), Product.init(), Coupon.init(), CouponOrder.init()]);
}, 120_000);

beforeEach(async () => {
  await Promise.all([TenantModel.deleteMany({}), Product.deleteMany({}), Coupon.deleteMany({}), CouponOrder.deleteMany({})]);
  const tenant = await TenantModel.create({ name: "Voucher test", slug: "voucher-test", plan: "starter", voucherQuotaVersion: 1 });
  tenantId = String(tenant._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
});

describe("voucher offering transaction guarantees", () => {
  it("allows exactly three simultaneous publications on Starter", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      mongoose.connection.transaction(async (session) => {
        const tenant = await acquireVoucherTenantMutationLock(tenantId, session);
        const desired = offer(`Gift ${i}`);
        await assertVoucherOfferingPublicationAllowed({ tenantId, session, tenant, desired });
        await Product.create([desired], { session });
      }),
    ));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(await countActiveVoucherOfferings(tenantId)).toBe(3);
    for (const failure of outcomes.filter((result) => result.status === "rejected")) {
      expect((failure as PromiseRejectedResult).reason.code).toBe("VOUCHER_OFFERING_LIMIT_REACHED");
    }
  });

  it("blocks duplicate activation when the only remaining slot is raced", async () => {
    await Product.create([offer("A"), offer("B")]);
    const drafts = await Product.create([offer("C", false), offer("D", false)]);
    const outcomes = await Promise.allSettled(drafts.map((draft) =>
      mongoose.connection.transaction(async (session) => {
        const tenant = await acquireVoucherTenantMutationLock(tenantId, session);
        const current = await Product.findOne({ _id: draft._id, tenant: tenantId }).session(session).lean();
        await assertVoucherOfferingPublicationAllowed({ tenantId, session, tenant, current, desired: { ...current, isActive: true } });
        await Product.updateOne({ _id: draft._id, tenant: tenantId }, { $set: { isActive: true } }, { session });
      }),
    ));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await countActiveVoucherOfferings(tenantId)).toBe(3);
  });

  it("serializes issuance against deletion so both cannot succeed", async () => {
    const product = await Product.create(offer("Race"));
    const outcomes = await Promise.allSettled([
      mongoose.connection.transaction(async (session) => {
        await acquireVoucherTenantMutationLock(tenantId, session);
        const current = await Product.findOne({ _id: product._id, tenant: tenantId }).session(session);
        if (!current) throw new Error("Offering was deleted before issuance");
        await Coupon.create([{
          tenant: tenantId, product: product._id, promoCode: "RACE-TEST-2222",
          valueMinorSnapshot: 50000, currencySnapshot: "CZK",
          expiresAt: new Date(Date.now() + 86400_000),
        }], { session });
      }),
      mongoose.connection.transaction(async (session) => {
        await acquireVoucherTenantMutationLock(tenantId, session);
        const policy = await getVoucherOfferingDeletionPolicy({ tenantId, productId: String(product._id), session });
        assertVoucherOfferingDeletable(policy);
        await Product.deleteOne({ _id: product._id, tenant: tenantId }, { session });
      }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const issued = await Coupon.countDocuments({ tenant: tenantId, product: product._id });
    const exists = await Product.exists({ _id: product._id, tenant: tenantId });
    expect(issued === 0 || exists !== null).toBe(true);
  });

  it("preserves an unexpiring legacy code's value when deleting its offering", async () => {
    const product = await Product.create(offer("Legacy"));
    const coupon = await Coupon.create({ tenant: tenantId, product: product._id, promoCode: "LEGACY-TEST-2222", expiresAt: null });
    await mongoose.connection.transaction(async (session) => {
      await acquireVoucherTenantMutationLock(tenantId, session);
      const policy = await getVoucherOfferingDeletionPolicy({ tenantId, productId: String(product._id), session });
      assertVoucherOfferingDeletable(policy, VOUCHER_DELETE_CONFIRMATION);
      await preserveLegacyVoucherValuesBeforeDeletion({ tenantId, product, session });
      await Product.deleteOne({ _id: product._id, tenant: tenantId }, { session });
    });
    const preserved = await Coupon.findById(coupon._id).lean();
    expect(preserved).toMatchObject({ valueMinorSnapshot: 50000, currencySnapshot: "CZK", expiresAt: null, isActive: true });
  });
});
