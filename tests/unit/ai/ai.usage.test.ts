import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";

const mocks = vi.hoisted(() => ({
  getTenantSubscriptionAccess: vi.fn(),
  ledgerFindOne: vi.fn(),
  ledgerFindOneAndUpdate: vi.fn(),
  ledgerFindById: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerAggregate: vi.fn(),
  periodFindOneAndUpdate: vi.fn(),
  periodUpdateOne: vi.fn(),
}));

vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);

vi.mock("@/modules/ai/ai.models.js", () => ({
  AiUsageLedgerModel: {
    findOne: mocks.ledgerFindOne,
    findOneAndUpdate: mocks.ledgerFindOneAndUpdate,
    findById: mocks.ledgerFindById,
    create: mocks.ledgerCreate,
    aggregate: mocks.ledgerAggregate,
  },
  AiUsagePeriodModel: {
    findOneAndUpdate: mocks.periodFindOneAndUpdate,
    updateOne: mocks.periodUpdateOne,
  },
}));

import { AI_FEATURE } from "@/modules/ai/ai.constants.js";
import {
  creditsForUsage,
  getAiUsage,
  releaseAiCredits,
  reserveAiCredits,
  resolveAiUsagePeriod,
  settleAiCredits,
} from "@/modules/ai/services/ai-usage.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ACTOR_ID = "507f1f77bcf86cd799439012";
const RESERVATION_ID = "507f1f77bcf86cd799439013";
const RUN_ID = "507f1f77bcf86cd799439014";
const PERIOD_KEY = "2026-07-01T00:00:00.000Z_2026-08-01T00:00:00.000Z";
const session = {
  withTransaction: async (work: () => Promise<unknown>) => work(),
  endSession: vi.fn(),
};

const subscriptionResult = (overrides: Record<string, any> = {}) => ({
  tenant: {
    _id: TENANT_ID,
    limits: { aiCredits: 100 },
    ...(overrides.tenant ?? {}),
  },
  subscription: {
    currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
    ...(overrides.subscription ?? {}),
  },
});

const usagePeriod = (overrides: Record<string, unknown> = {}) => ({
  tenant: TENANT_ID,
  periodKey: PERIOD_KEY,
  limit: 100,
  reserved: 10,
  consumed: 20,
  ...overrides,
});

const reservation = (overrides: Record<string, unknown> = {}) => ({
  _id: RESERVATION_ID,
  tenant: TENANT_ID,
  actor: ACTOR_ID,
  periodKey: PERIOD_KEY,
  feature: AI_FEATURE.STUDIO_ASSISTANT,
  idempotencyKey: "assistant:conversation-1:message-1",
  status: "reserved",
  reservedCredits: 10,
  settledCredits: 0,
  ...overrides,
});

const selectedLeanQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    lean: vi.fn().mockResolvedValue(value),
  })),
});

beforeEach(() => {
  vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AI usage periods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantSubscriptionAccess.mockResolvedValue(subscriptionResult());
    mocks.periodUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.ledgerAggregate.mockResolvedValue([]);
  });

  it("uses the current Stripe/trial period when it contains the clock", async () => {
    await expect(
      resolveAiUsagePeriod(TENANT_ID, new Date("2026-07-23T12:00:00.000Z")),
    ).resolves.toEqual({
      key: PERIOD_KEY,
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-08-01T00:00:00.000Z"),
      limit: 100,
    });
  });

  it("falls back to a UTC calendar month outside the persisted billing period", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({
        tenant: { limits: { aiCredits: -1 } },
        subscription: {
          currentPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
        },
      }),
    );

    await expect(
      resolveAiUsagePeriod(TENANT_ID, new Date("2026-07-23T12:00:00.000Z")),
    ).resolves.toEqual({
      key: PERIOD_KEY,
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-08-01T00:00:00.000Z"),
      limit: 0,
    });
  });

  it("uses a calendar month for yearly subscriptions so the allowance remains monthly", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({
        subscription: {
          billingInterval: "yearly",
          currentPeriodStart: new Date("2026-01-15T00:00:00.000Z"),
          currentPeriodEnd: new Date("2027-01-15T00:00:00.000Z"),
        },
      }),
    );

    await expect(
      resolveAiUsagePeriod(TENANT_ID, new Date("2026-07-23T12:00:00.000Z")),
    ).resolves.toEqual({
      key: PERIOD_KEY,
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-08-01T00:00:00.000Z"),
      limit: 100,
    });
  });

  it("uses a calendar month for an active manual grant with multi-year trial fields", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({
        subscription: {
          status: "active",
          currentPeriodStart: null,
          currentPeriodEnd: null,
          trialStartedAt: new Date("2026-06-13T12:16:48.473Z"),
          trialEndsAt: new Date("2028-06-27T12:16:48.473Z"),
        },
      }),
    );
    expect(await resolveAiUsagePeriod(TENANT_ID)).toMatchObject({
      key: PERIOD_KEY,
      limit: 100,
    });
  });

  it("retains the actual 14-day allowance window during a real trial", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({
        subscription: {
          status: "trialing",
          currentPeriodStart: null,
          currentPeriodEnd: null,
          trialStartedAt: new Date("2026-07-20T10:00:00.000Z"),
          trialEndsAt: new Date("2026-08-03T10:00:00.000Z"),
        },
      }),
    );
    expect(await resolveAiUsagePeriod(TENANT_ID)).toMatchObject({
      start: new Date("2026-07-20T10:00:00.000Z"),
      end: new Date("2026-08-03T10:00:00.000Z"),
    });
  });

  it.each([
    [{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }, 1],
    [{ inputTokens: 400, outputTokens: 600, totalTokens: 1_000 }, 1],
    [{ inputTokens: 1_000, outputTokens: 1, totalTokens: 1_001 }, 2],
    [{ inputTokens: 0, outputTokens: 0, totalTokens: -5 }, 1],
  ])("converts provider usage %j into %d credits", (usage, expected) => {
    expect(creditsForUsage(usage)).toBe(expected);
  });
});

describe("AI credit reservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantSubscriptionAccess.mockResolvedValue(subscriptionResult());
    mocks.ledgerFindOne.mockResolvedValue(null);
    mocks.periodFindOneAndUpdate
      .mockResolvedValueOnce(usagePeriod({ reserved: 0, consumed: 0 }))
      .mockResolvedValueOnce(usagePeriod({ reserved: 10, consumed: 0 }));
    mocks.ledgerCreate.mockResolvedValue([reservation()]);
    mocks.periodUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it("returns an existing tenant-scoped reservation without reserving again", async () => {
    const existing = reservation({ status: "settled", settledCredits: 2 });
    mocks.ledgerFindOne.mockResolvedValueOnce(existing);

    await expect(
      reserveAiCredits({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        feature: AI_FEATURE.STUDIO_ASSISTANT,
        idempotencyKey: existing.idempotencyKey,
      }),
    ).resolves.toBe(existing);

    expect(mocks.ledgerFindOne).toHaveBeenCalledWith(
      {
        tenant: TENANT_ID,
        idempotencyKey: existing.idempotencyKey,
      },
      null,
      { session },
    );
    expect(mocks.periodFindOneAndUpdate).toHaveBeenCalledOnce();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("atomically re-reserves a previously released idempotency key", async () => {
    const released = reservation({
      status: "released",
      releasedAt: new Date("2026-07-23T09:00:00.000Z"),
      reservedCredits: 10,
    });
    const reclaimed = reservation({
      status: "reserved",
      reservedCredits: 7,
      releasedAt: undefined,
    });
    mocks.ledgerFindOne.mockResolvedValueOnce(released);
    mocks.periodFindOneAndUpdate
      .mockReset()
      .mockResolvedValueOnce(usagePeriod({ reserved: 0, consumed: 0 }))
      .mockResolvedValueOnce(usagePeriod({ reserved: 7, consumed: 0 }));
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(reclaimed);

    await expect(
      reserveAiCredits({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        feature: AI_FEATURE.STUDIO_ASSISTANT,
        idempotencyKey: released.idempotencyKey,
        credits: 7,
      }),
    ).resolves.toBe(reclaimed);

    expect(mocks.ledgerFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: RESERVATION_ID, status: "released" },
      {
        $set: {
          tenant: TENANT_ID,
          idempotencyKey: released.idempotencyKey,
          actor: ACTOR_ID,
          feature: AI_FEATURE.STUDIO_ASSISTANT,
          periodKey: PERIOD_KEY,
          status: "reserved",
          reservedCredits: 7,
          settledCredits: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          model: "",
          run: null,
        },
        $unset: { releasedAt: 1, settledAt: 1 },
      },
      { returnDocument: "after", session },
    );
    expect(mocks.periodUpdateOne).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("atomically reserves a bounded amount before creating the ledger", async () => {
    const result = await reserveAiCredits({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      feature: AI_FEATURE.STUDIO_ASSISTANT,
      idempotencyKey: "assistant:conversation-1:message-1",
      credits: 9.1,
    });

    expect(result).toEqual(reservation());
    expect(mocks.periodFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        tenant: TENANT_ID,
        periodKey: PERIOD_KEY,
        $expr: {
          $lte: [{ $add: ["$reserved", "$consumed", 10] }, "$limit"],
        },
      },
      { $inc: { reserved: 10 } },
      { returnDocument: "after", session },
    );
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(
      [
        {
          tenant: TENANT_ID,
          actor: ACTOR_ID,
          periodKey: PERIOD_KEY,
          feature: AI_FEATURE.STUDIO_ASSISTANT,
          idempotencyKey: "assistant:conversation-1:message-1",
          status: "reserved",
          reservedCredits: 10,
        },
      ],
      { session },
    );
  });

  it("rejects exhaustion without creating a ledger", async () => {
    mocks.periodFindOneAndUpdate
      .mockReset()
      .mockResolvedValueOnce(usagePeriod({ reserved: 90, consumed: 10 }))
      .mockResolvedValueOnce(null);

    await expect(
      reserveAiCredits({
        tenantId: TENANT_ID,
        feature: AI_FEATURE.PUBLIC_CONCIERGE,
        idempotencyKey: "public:request-1",
      }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: "AI_CREDITS_EXHAUSTED",
      details: {
        periodEnd: new Date("2026-08-01T00:00:00.000Z"),
        limit: 100,
      },
    });
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("undoes a losing concurrent reservation and returns the canonical ledger", async () => {
    const canonical = reservation({ _id: "canonical-reservation" });
    mocks.ledgerFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(canonical);
    mocks.ledgerCreate.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), { code: 11000 }),
    );

    await expect(
      reserveAiCredits({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        feature: AI_FEATURE.STUDIO_ASSISTANT,
        idempotencyKey: canonical.idempotencyKey,
      }),
    ).resolves.toBe(canonical);

    expect(mocks.periodUpdateOne).not.toHaveBeenCalled();
  });

  it("undoes the period reservation when ledger creation fails permanently", async () => {
    const failure = new Error("database unavailable");
    mocks.ledgerCreate.mockRejectedValueOnce(failure);

    await expect(
      reserveAiCredits({
        tenantId: TENANT_ID,
        feature: AI_FEATURE.STUDIO_ASSISTANT,
        idempotencyKey: "assistant:request-failure",
      }),
    ).rejects.toBe(failure);

    expect(mocks.periodUpdateOne).not.toHaveBeenCalled();
  });
});

describe("AI credit settlement and release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.periodUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it("settles at actual usage, capped by the reserved amount", async () => {
    const settled = reservation({
      status: "settled",
      settledCredits: 3,
      inputTokens: 2_500,
      outputTokens: 300,
      totalTokens: 2_800,
      model: "test-model",
      run: RUN_ID,
    });
    mocks.ledgerFindById.mockReturnValueOnce(
      selectedLeanQuery({ reservedCredits: 10 }),
    );
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(settled);

    await expect(
      settleAiCredits({
        reservationId: RESERVATION_ID,
        usage: { inputTokens: 2_500, outputTokens: 300, totalTokens: 2_800 },
        model: "test-model",
        runId: RUN_ID,
      }),
    ).resolves.toBe(settled);

    expect(mocks.ledgerFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: RESERVATION_ID, status: "reserved" },
      {
        $set: expect.objectContaining({
          status: "settled",
          settledCredits: 3,
          inputTokens: 2_500,
          outputTokens: 300,
          totalTokens: 2_800,
          model: "test-model",
          run: RUN_ID,
          settledAt: expect.any(Date),
        }),
      },
      { returnDocument: "after", session },
    );
    expect(mocks.periodUpdateOne).toHaveBeenCalledWith(
      { tenant: TENANT_ID, periodKey: PERIOD_KEY },
      { $inc: { reserved: -10, consumed: 3 } },
      { session },
    );
  });

  it("caps unexpectedly large provider usage at the reservation", async () => {
    const settled = reservation({ status: "settled", settledCredits: 10 });
    mocks.ledgerFindById.mockReturnValueOnce(
      selectedLeanQuery({ reservedCredits: 10 }),
    );
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(settled);

    await settleAiCredits({
      reservationId: RESERVATION_ID,
      usage: { inputTokens: 20_000, outputTokens: 1_000, totalTokens: 21_000 },
      model: "test-model",
    });

    expect(
      mocks.ledgerFindOneAndUpdate.mock.calls[0][1].$set.settledCredits,
    ).toBe(10);
    expect(mocks.periodUpdateOne).toHaveBeenCalledWith(
      { tenant: TENANT_ID, periodKey: PERIOD_KEY },
      { $inc: { reserved: -10, consumed: 10 } },
      { session },
    );
  });

  it("makes settlement idempotent when another worker already settled", async () => {
    const existing = reservation({ status: "settled", settledCredits: 2 });
    mocks.ledgerFindById
      .mockReturnValueOnce(selectedLeanQuery({ reservedCredits: 10 }))
      .mockResolvedValueOnce(existing);
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(null);

    await expect(
      settleAiCredits({
        reservationId: RESERVATION_ID,
        usage: { inputTokens: 1_500, outputTokens: 0, totalTokens: 1_500 },
        model: "test-model",
      }),
    ).resolves.toBe(existing);
    expect(mocks.periodUpdateOne).not.toHaveBeenCalled();
  });

  it("releases a reservation once and restores the available counter", async () => {
    const released = reservation({ status: "released" });
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(released);

    await expect(releaseAiCredits(RESERVATION_ID)).resolves.toBe(released);
    expect(mocks.ledgerFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: RESERVATION_ID, status: "reserved" },
      { $set: { status: "released", releasedAt: expect.any(Date) } },
      { returnDocument: "after", session },
    );
    expect(mocks.periodUpdateOne).toHaveBeenCalledWith(
      { tenant: TENANT_ID, periodKey: PERIOD_KEY },
      { $inc: { reserved: -10 } },
      { session },
    );
  });

  it("makes release idempotent after another worker changed the status", async () => {
    const existing = reservation({ status: "settled", settledCredits: 2 });
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(null);
    mocks.ledgerFindById.mockResolvedValueOnce(existing);

    await expect(releaseAiCredits(RESERVATION_ID)).resolves.toBe(existing);
    expect(mocks.periodUpdateOne).not.toHaveBeenCalled();
  });
});

describe("AI usage reporting", () => {
  it("reports remaining credits and settled feature totals without negatives", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValue(subscriptionResult());
    mocks.periodFindOneAndUpdate.mockResolvedValueOnce(
      usagePeriod({ limit: 100, reserved: 8, consumed: 30 }),
    );
    mocks.ledgerAggregate.mockResolvedValueOnce([
      { _id: AI_FEATURE.STUDIO_ASSISTANT, credits: 20, runs: 4 },
      { _id: AI_FEATURE.PUBLIC_CONCIERGE, credits: 10, runs: 10 },
    ]);

    await expect(getAiUsage(TENANT_ID)).resolves.toMatchObject({
      periodKey: PERIOD_KEY,
      limit: 100,
      reserved: 8,
      consumed: 30,
      remaining: 62,
      byFeature: [
        { feature: AI_FEATURE.STUDIO_ASSISTANT, credits: 20, runs: 4 },
        { feature: AI_FEATURE.PUBLIC_CONCIERGE, credits: 10, runs: 10 },
      ],
    });

    expect(mocks.ledgerAggregate.mock.calls[0][0][0]).toMatchObject({
      $match: {
        periodKey: PERIOD_KEY,
        status: "settled",
      },
    });
    expect(
      String(mocks.ledgerAggregate.mock.calls[0][0][0].$match.tenant),
    ).toBe(TENANT_ID);
  });
});
