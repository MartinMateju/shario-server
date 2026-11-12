import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({ subscription: vi.fn() }));
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.subscription,
  }),
);

import {
  AiUsageLedgerModel as Ledger,
  AiUsagePeriodModel as Period,
} from "@/modules/ai/ai.models.js";
import { AI_FEATURE } from "@/modules/ai/ai.constants.js";
import {
  getAiUsage,
  reconcileAiUsageReservations,
  releaseAiCredits,
  reserveAiCredits,
  settleAiCredits,
} from "@/modules/ai/services/ai-usage.service.js";

let replica: MongoMemoryReplSet;
const tenantId = String(new mongoose.Types.ObjectId());
const reserve = (key: string, credits = 10) =>
  reserveAiCredits({
    tenantId,
    feature: AI_FEATURE.STUDIO_ASSISTANT,
    idempotencyKey: key,
    credits,
  });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("AI usage transactions and reconciliation", () => {
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all([Ledger.init(), Period.init()]);
  }, 60_000);
  beforeEach(async () => {
    await Promise.all([Ledger.deleteMany({}), Period.deleteMany({})]);
    mocks.subscription.mockResolvedValue({
      tenant: { limits: { aiCredits: 10 } },
      subscription: { status: "active", billingInterval: "monthly" },
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });

  it("cannot erase a reservation paused between its counter write and ledger insert", async () => {
    await getAiUsage(tenantId);
    const entered = deferred();
    const finish = deferred();
    const original = Ledger.create.bind(Ledger);
    vi.spyOn(Ledger, "create").mockImplementationOnce((async (
      ...args: any[]
    ) => {
      entered.resolve();
      await finish.promise;
      return (original as any)(...args);
    }) as any);
    const reservation = reserve("paused-reservation");
    await entered.promise;
    const repair = reconcileAiUsageReservations();
    // The repair must wait for the transaction holding the period, not publish
    // a zero balance from a snapshot where the ledger insert is still pending.
    await new Promise((resolve) => setTimeout(resolve, 50));
    finish.resolve();
    await Promise.all([reservation, repair]);

    expect(await getAiUsage(tenantId)).toMatchObject({
      reserved: 10,
      remaining: 0,
    });
    await expect(reserve("over-limit", 1)).rejects.toMatchObject({
      code: "AI_CREDITS_EXHAUSTED",
    });
    expect(await Ledger.countDocuments({ tenant: tenantId })).toBe(1);
  });

  it("keeps duplicate concurrent admissions idempotent", async () => {
    await getAiUsage(tenantId);
    const [first, second] = await Promise.all([
      reserve("same"),
      reserve("same"),
    ]);
    expect(String(first._id)).toBe(String(second._id));
    expect(await getAiUsage(tenantId)).toMatchObject({
      reserved: 10,
      remaining: 0,
    });
    expect(await Ledger.countDocuments({ tenant: tenantId })).toBe(1);
  });

  it("enforces the quota during simultaneous first-period creation", async () => {
    const outcomes = await Promise.allSettled([
      reserve("first-a", 6),
      reserve("first-b", 6),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected"),
    ).toMatchObject({
      reason: { code: "AI_CREDITS_EXHAUSTED" },
    });
    expect(await Period.countDocuments({ tenant: tenantId })).toBe(1);
    expect(await getAiUsage(tenantId)).toMatchObject({
      reserved: 6,
      remaining: 4,
    });
  });

  it("cannot admit a request with a zero-credit allowance", async () => {
    mocks.subscription.mockResolvedValue({
      tenant: { limits: { aiCredits: 0 } },
      subscription: { status: "active" },
    });
    await expect(reserve("zero-limit", 1)).rejects.toMatchObject({
      code: "AI_CREDITS_EXHAUSTED",
    });
    expect(await Ledger.countDocuments({ tenant: tenantId })).toBe(0);
    expect(await getAiUsage(tenantId)).toMatchObject({
      reserved: 0,
      consumed: 0,
      remaining: 0,
    });
  });

  it("rolls back the counter when ledger insertion fails", async () => {
    vi.spyOn(Ledger, "create").mockRejectedValueOnce(
      new Error("test insertion failure"),
    );
    await expect(reserve("failed")).rejects.toThrow("test insertion failure");
    expect(await getAiUsage(tenantId)).toMatchObject({
      reserved: 0,
      remaining: 10,
    });
    expect(await Ledger.countDocuments({ tenant: tenantId })).toBe(0);
    await expect(reserve("after-failure")).resolves.toMatchObject({
      status: "reserved",
    });
  });

  it("rolls back settlement if its period update fails, then retries once", async () => {
    const reservation = await reserve("settlement");
    vi.spyOn(Period, "updateOne").mockRejectedValueOnce(
      new Error("test period failure"),
    );
    const input = {
      reservationId: String(reservation._id),
      usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      model: "test",
    };
    await expect(settleAiCredits(input)).rejects.toThrow("test period failure");
    expect((await Ledger.findById(reservation._id))?.status).toBe("reserved");
    await Promise.all([settleAiCredits(input), reconcileAiUsageReservations()]);
    await settleAiCredits(input);
    expect(await getAiUsage(tenantId)).toMatchObject({
      reserved: 0,
      consumed: 2,
      remaining: 8,
    });
  });

  it("does not expire a fresh retry just because the original ledger is old", async () => {
    const reservation = await reserve("retry");
    await releaseAiCredits(String(reservation._id));
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    await Ledger.collection.updateOne(
      { _id: reservation._id },
      { $set: { createdAt: old, updatedAt: old } },
    );
    await reserve("retry");
    expect(await reconcileAiUsageReservations()).toMatchObject({ released: 0 });
    expect(await getAiUsage(tenantId)).toMatchObject({
      reserved: 10,
      remaining: 0,
    });
  });

  it("releases stale reservations and repairs counters atomically and idempotently", async () => {
    const reservation = await reserve("stale");
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    await Ledger.collection.updateOne(
      { _id: reservation._id },
      { $set: { updatedAt: old } },
    );
    await Period.updateOne({ tenant: tenantId }, { $set: { reserved: 100 } });
    expect(await reconcileAiUsageReservations()).toMatchObject({ released: 1 });
    expect(await reconcileAiUsageReservations()).toMatchObject({ released: 0 });
    expect(await getAiUsage(tenantId)).toMatchObject({
      reserved: 0,
      consumed: 0,
      remaining: 10,
    });
  });
});
