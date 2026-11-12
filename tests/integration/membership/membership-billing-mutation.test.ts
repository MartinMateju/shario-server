import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Membership from "@/modules/membership/user-membership.model.js";
import { claimMembershipBillingMutation, recoverMembershipBillingMutation } from "@/modules/membership/membership-billing-mutation.js";

const ids = { membership: new mongoose.Types.ObjectId(), tenant: new mongoose.Types.ObjectId(), user: new mongoose.Types.ObjectId() };
const cancellation = { effective: "period_end", reason: "not_using", comment: "" };
let db: MongoMemoryReplSet;
const read = async () => Membership.findById(ids.membership).select("+stripe.subscriptionId +stripe.customerId").exec();
const provider = (overrides: Record<string, unknown> = {}): any => ({
  id: "sub_billing_mutation", customer: "cus_billing_mutation", status: "active",
  cancel_at_period_end: false, cancel_at: null,
  metadata: { sharioMembershipId: String(ids.membership), sharioTenantId: String(ids.tenant), sharioUserId: String(ids.user) },
  ...overrides,
});
const claim = async (operation: "cancel" | "resume" = "cancel", input = cancellation as object) => {
  const key = await claimMembershipBillingMutation(await read(), operation, input);
  return { key, membership: await read() };
};

describe("membership billing mutation ownership and recovery", () => {
  beforeAll(async () => {
    db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(db.getUri());
    await Membership.init();
  }, 60000);
  afterAll(async () => { await mongoose.disconnect(); await db?.stop(); });
  beforeEach(async () => {
    await Membership.deleteMany({});
    await Membership.collection.insertOne({
      _id: ids.membership, tenant: ids.tenant, user: ids.user, __v: 0,
      status: "active", isOpen: true, billingMutation: null, scheduledPlanChange: null,
      stripe: { subscriptionId: "sub_billing_mutation", customerId: "cus_billing_mutation" },
    } as any);
  });

  it("rejects an old cancellation retry after the original cancellation and a later resume completed", async () => {
    const first = await claim();
    const stalledRetry = first.membership;
    await Membership.collection.updateOne({ _id: ids.membership }, {
      $set: { status: "cancel_scheduled", billingMutation: null }, $inc: { __v: 1 },
    });
    await claim("resume", {});
    await Membership.collection.updateOne({ _id: ids.membership }, {
      $set: { status: "active", billingMutation: null }, $inc: { __v: 1 },
    });
    await expect(claimMembershipBillingMutation(stalledRetry, "cancel", cancellation))
      .rejects.toMatchObject({ code: "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS" });
    expect(await read()).toMatchObject({ status: "active", billingMutation: null });
  });

  it("permits a fresh identical retry to reuse its durable key but rejects a competing stale snapshot", async () => {
    const stale = await read();
    const first = await claim();
    await expect(claimMembershipBillingMutation(stale, "cancel", cancellation))
      .rejects.toMatchObject({ code: "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS" });
    await expect(claimMembershipBillingMutation(await read(), "cancel", cancellation)).resolves.toBe(first.key);
  });

  it("requires the exact observed token even if an external writer did not increment the version", async () => {
    const first = await claim();
    await Membership.collection.updateOne({ _id: ids.membership }, { $set: { billingMutation: "another-operation" } });
    await expect(claimMembershipBillingMutation(first.membership, "cancel", cancellation))
      .rejects.toMatchObject({ code: "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS" });
    expect((await read())?.billingMutation).toBe("another-operation");
  });

  it("fences legacy records that do not yet have a version", async () => {
    await Membership.collection.updateOne({ _id: ids.membership }, { $unset: { __v: "" } });
    const stale = await read();
    await claim();
    await expect(claimMembershipBillingMutation(stale, "cancel", cancellation))
      .rejects.toMatchObject({ code: "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS" });
  });

  it("recovers a succeeded period-end cancellation after local completion was interrupted", async () => {
    const { membership } = await claim();
    await expect(recoverMembershipBillingMutation(membership, provider({ cancel_at_period_end: true }))).resolves.toBe(true);
    expect(await read()).toMatchObject({ billingMutation: null, __v: 2 });
  });

  it("does not confuse a scheduled cancellation with completion of an immediate cancellation", async () => {
    const { key, membership } = await claim("cancel", { ...cancellation, effective: "immediate" });
    await expect(recoverMembershipBillingMutation(membership, provider({ cancel_at_period_end: true }))).resolves.toBe(false);
    expect((await read())?.billingMutation).toBe(key);
    await expect(recoverMembershipBillingMutation(membership, provider({ status: "canceled" }))).resolves.toBe(true);
  });

  it("recovers a succeeded resume but retains a resume whose subscription is still cancelling", async () => {
    const { key, membership } = await claim("resume", {});
    await expect(recoverMembershipBillingMutation(membership, provider({ cancel_at_period_end: true }))).resolves.toBe(false);
    await expect(recoverMembershipBillingMutation(membership, provider({ status: "past_due" }))).resolves.toBe(false);
    await expect(recoverMembershipBillingMutation(membership, provider({ cancel_at: 2_000_000_000 }))).resolves.toBe(false);
    expect((await read())?.billingMutation).toBe(key);
    await expect(recoverMembershipBillingMutation(membership, provider())).resolves.toBe(true);
  });

  it.each([
    { id: "sub_foreign" }, { customer: "cus_foreign" }, { metadata: { sharioMembershipId: "foreign" } },
  ])("never recovers using an unrelated provider object %j", async (overrides) => {
    const { key, membership } = await claim();
    await expect(recoverMembershipBillingMutation(membership, provider({ cancel_at_period_end: true, ...overrides }))).resolves.toBe(false);
    expect((await read())?.billingMutation).toBe(key);
  });

  it("cannot clear a newer mutation using stale provider recovery work", async () => {
    const first = await claim();
    await Membership.collection.updateOne({ _id: ids.membership }, {
      $set: { billingMutation: "a-newer-operation" }, $inc: { __v: 1 },
    });
    await expect(recoverMembershipBillingMutation(first.membership, provider({ cancel_at_period_end: true }))).resolves.toBe(false);
    expect((await read())?.billingMutation).toBe("a-newer-operation");
  });

  it("participates in the caller's transaction and restores the lock on rollback", async () => {
    const { key, membership } = await claim();
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await expect(recoverMembershipBillingMutation(membership, provider({ cancel_at_period_end: true }), session)).resolves.toBe(true);
      await session.abortTransaction();
      expect((await read())?.billingMutation).toBe(key);
    } finally { await session.endSession(); }
  });

  it("keeps unrecognized legacy tokens instead of guessing their cancellation timing", async () => {
    await Membership.collection.updateOne({ _id: ids.membership }, { $set: { billingMutation: "cancel:legacy-hash:legacy-id" } });
    await expect(recoverMembershipBillingMutation(await read(), provider({ cancel_at_period_end: true }))).resolves.toBe(false);
    expect((await read())?.billingMutation).toBe("cancel:legacy-hash:legacy-id");
  });
});
