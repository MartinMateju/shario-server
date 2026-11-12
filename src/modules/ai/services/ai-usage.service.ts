import mongoose, { type ClientSession } from "mongoose";

import { getTenantSubscriptionAccess } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import { resolveMonthlyUsageWindow } from "@/modules/tenants/tenant-usage-period.js";
import { tooManyRequests } from "@/shared/http/httpErrors.js";

import {
  AI_CREDITS_PER_TOKEN_BLOCK,
  AI_FEATURE_CREDIT_RESERVATION,
  AI_USAGE_STATUS,
  type AiFeature,
} from "@/modules/ai/ai.constants.js";
import {
  AiUsageLedgerModel,
  AiUsagePeriodModel,
} from "@/modules/ai/ai.models.js";
import type { AiProviderUsage } from "@/modules/ai/ai.types.js";

type UsagePeriod = {
  key: string;
  start: Date;
  end: Date;
  limit: number;
};

const runUsageTransaction = async <T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
};

export const resolveAiUsagePeriod = async (
  tenantId: string,
  now = new Date(),
): Promise<UsagePeriod> => {
  const { tenant, subscription } = await getTenantSubscriptionAccess(tenantId);
  const limit = Math.max(Number(tenant.limits?.aiCredits || 0), 0);
  const { start, end } = resolveMonthlyUsageWindow(subscription, now);
  return {
    key: `${start.toISOString()}_${end.toISOString()}`,
    start,
    end,
    limit,
  };
};

const ensurePeriod = async (tenantId: string, period: UsagePeriod) =>
  AiUsagePeriodModel.findOneAndUpdate(
    { tenant: tenantId, periodKey: period.key },
    {
      $setOnInsert: {
        tenant: tenantId,
        periodKey: period.key,
        periodStart: period.start,
        periodEnd: period.end,
        reserved: 0,
        consumed: 0,
      },
      $set: { limit: period.limit },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

export const reserveAiCredits = async ({
  tenantId,
  actorId,
  feature,
  idempotencyKey,
  credits = AI_FEATURE_CREDIT_RESERVATION[feature] || 5,
}: {
  tenantId: string;
  actorId?: string | null;
  feature: AiFeature;
  idempotencyKey: string;
  credits?: number;
}) => {
  const period = await resolveAiUsagePeriod(tenantId);
  await ensurePeriod(tenantId, period);
  const reservedAmount = Math.max(Math.ceil(credits), 1);
  try {
    return await runUsageTransaction(async (session) => {
      const existing = await AiUsageLedgerModel.findOne(
        { tenant: tenantId, idempotencyKey },
        null,
        { session },
      );
      if (existing && existing.status !== AI_USAGE_STATUS.RELEASED)
        return existing;

      const usagePeriod = await AiUsagePeriodModel.findOneAndUpdate(
        {
          tenant: tenantId,
          periodKey: period.key,
          $expr: {
            $lte: [
              { $add: ["$reserved", "$consumed", reservedAmount] },
              "$limit",
            ],
          },
        },
        { $inc: { reserved: reservedAmount } },
        { returnDocument: "after", session },
      );
      if (!usagePeriod) {
        tooManyRequests({
          message:
            "The workspace has used its AI credits for this billing period.",
          code: "AI_CREDITS_EXHAUSTED",
          details: { periodEnd: period.end, limit: period.limit },
        });
      }
      const values = {
        tenant: tenantId,
        actor: actorId || null,
        periodKey: period.key,
        feature,
        idempotencyKey,
        status: AI_USAGE_STATUS.RESERVED,
        reservedCredits: reservedAmount,
      };
      if (existing) {
        const reclaimed = await AiUsageLedgerModel.findOneAndUpdate(
          { _id: existing._id, status: AI_USAGE_STATUS.RELEASED },
          {
            $set: {
              ...values,
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
        if (!reclaimed)
          throw new Error(
            "AI reservation changed before it could be reclaimed.",
          );
        return reclaimed;
      }
      const [created] = await AiUsageLedgerModel.create([values], { session });
      return created;
    });
  } catch (error: any) {
    // Aborting the transaction rolls back the counter as well as the ledger.
    if (error?.code === 11000) {
      const concurrent = await AiUsageLedgerModel.findOne({
        tenant: tenantId,
        idempotencyKey,
      });
      if (concurrent && concurrent.status !== AI_USAGE_STATUS.RELEASED)
        return concurrent;
    }
    throw error;
  }
};

export const creditsForUsage = (usage: AiProviderUsage): number =>
  Math.max(
    1,
    Math.ceil(Math.max(usage.totalTokens, 0) / AI_CREDITS_PER_TOKEN_BLOCK),
  );

export const settleAiCredits = async ({
  reservationId,
  usage,
  model,
  runId,
}: {
  reservationId: string;
  usage: AiProviderUsage;
  model: string;
  runId?: string | null;
}) =>
  runUsageTransaction(async (session) => {
    const reservation = await AiUsageLedgerModel.findOneAndUpdate(
      { _id: reservationId, status: AI_USAGE_STATUS.RESERVED },
      {
        $set: {
          status: AI_USAGE_STATUS.SETTLED,
          settledCredits: Math.min(
            creditsForUsage(usage),
            Number(
              (
                await AiUsageLedgerModel.findById(reservationId, null, {
                  session,
                })
                  .select("reservedCredits")
                  .lean()
              )?.reservedCredits || 1,
            ),
          ),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          model,
          run: runId || null,
          settledAt: new Date(),
        },
      },
      { returnDocument: "after", session },
    );
    if (!reservation)
      return AiUsageLedgerModel.findById(reservationId, null, { session });
    await AiUsagePeriodModel.updateOne(
      { tenant: reservation.tenant, periodKey: reservation.periodKey },
      {
        $inc: {
          reserved: -reservation.reservedCredits,
          consumed: reservation.settledCredits,
        },
      },
      { session },
    );
    return reservation;
  });

export const releaseAiCredits = async (reservationId: string) =>
  runUsageTransaction(async (session) => {
    const reservation = await AiUsageLedgerModel.findOneAndUpdate(
      { _id: reservationId, status: AI_USAGE_STATUS.RESERVED },
      { $set: { status: AI_USAGE_STATUS.RELEASED, releasedAt: new Date() } },
      { returnDocument: "after", session },
    );
    if (!reservation)
      return AiUsageLedgerModel.findById(reservationId, null, { session });
    await AiUsagePeriodModel.updateOne(
      { tenant: reservation.tenant, periodKey: reservation.periodKey },
      { $inc: { reserved: -reservation.reservedCredits } },
      { session },
    );
    return reservation;
  });

export const getAiUsage = async (tenantId: string) => {
  const period = await resolveAiUsagePeriod(tenantId);
  const record = await ensurePeriod(tenantId, period);
  const byFeature = await AiUsageLedgerModel.aggregate([
    {
      $match: {
        tenant: new mongoose.Types.ObjectId(tenantId),
        periodKey: period.key,
        status: AI_USAGE_STATUS.SETTLED,
      },
    },
    {
      $group: {
        _id: "$feature",
        credits: { $sum: "$settledCredits" },
        runs: { $sum: 1 },
      },
    },
    { $sort: { credits: -1 } },
  ]);
  return {
    periodKey: period.key,
    periodStart: period.start,
    periodEnd: period.end,
    limit: record.limit,
    reserved: Math.max(Number(record.reserved || 0), 0),
    consumed: Math.max(Number(record.consumed || 0), 0),
    remaining: Math.max(
      Number(record.limit || 0) -
        Number(record.reserved || 0) -
        Number(record.consumed || 0),
      0,
    ),
    byFeature: byFeature.map((item) => ({
      feature: item._id,
      credits: item.credits,
      runs: item.runs,
    })),
  };
};

const staleReservationCutoff = (now = new Date()): Date => {
  const providerTimeout = Number(process.env.OPENAI_TIMEOUT_MS || 30_000);
  const retries = Number(process.env.OPENAI_MAX_RETRIES || 2);
  const minimum = 5 * 60_000;
  const calculated =
    Math.max(
      Number.isFinite(providerTimeout) ? providerTimeout : 30_000,
      3_000,
    ) *
      (Math.max(Number.isFinite(retries) ? retries : 2, 0) + 1) +
    2 * 60_000;
  return new Date(now.getTime() - Math.max(calculated, minimum));
};

/**
 * Repairs process-crash windows in the denormalized period counters.
 * Ledger rows are the source of truth; stale in-flight reservations are first
 * released with a compare-and-set, then every current/affected period is
 * recomputed from its ledger. Re-running this function is idempotent.
 */
export const reconcileAiUsageReservations = async (
  now = new Date(),
): Promise<{ released: number; periodsReconciled: number }> => {
  const stale = await AiUsageLedgerModel.find({
    status: AI_USAGE_STATUS.RESERVED,
    updatedAt: { $lt: staleReservationCutoff(now) },
  })
    .select("_id tenant periodKey")
    .limit(1_000)
    .lean();
  const affected = new Set(
    stale.map(
      (reservation) => `${reservation.tenant}:${reservation.periodKey}`,
    ),
  );
  let released = 0;

  const affectedClauses = [...affected].map((key) => {
    const separator = key.indexOf(":");
    return {
      tenant: key.slice(0, separator),
      periodKey: key.slice(separator + 1),
    };
  });
  const periods = await AiUsagePeriodModel.find({
    $or: [{ periodEnd: { $gt: now } }, ...affectedClauses],
  })
    .select("tenant periodKey")
    .lean();

  for (const period of periods) {
    released += await runUsageTransaction(async (session) => {
      // Every ledger/counter mutation is transactional. Writing this same period
      // first prevents rebuilding totals over an in-flight reservation or settle.
      await AiUsagePeriodModel.updateOne(
        { _id: period._id },
        { $inc: { reconciliationVersion: 1 } },
        { session },
      );
      const expired = await AiUsageLedgerModel.updateMany(
        {
          _id: { $in: stale.map((reservation) => reservation._id) },
          tenant: period.tenant,
          periodKey: period.periodKey,
          status: AI_USAGE_STATUS.RESERVED,
          updatedAt: { $lt: staleReservationCutoff(now) },
        },
        { $set: { status: AI_USAGE_STATUS.RELEASED, releasedAt: now } },
        { session },
      );
      const rows = await AiUsageLedgerModel.aggregate([
        {
          $match: {
            tenant: period.tenant,
            periodKey: period.periodKey,
            status: {
              $in: [AI_USAGE_STATUS.RESERVED, AI_USAGE_STATUS.SETTLED],
            },
          },
        },
        {
          $group: {
            _id: "$status",
            reserved: { $sum: "$reservedCredits" },
            consumed: { $sum: "$settledCredits" },
          },
        },
      ]).session(session);
      const reservedRow = rows.find(
        (row) => row._id === AI_USAGE_STATUS.RESERVED,
      );
      const settledRow = rows.find(
        (row) => row._id === AI_USAGE_STATUS.SETTLED,
      );
      await AiUsagePeriodModel.updateOne(
        { _id: period._id },
        {
          $set: {
            reserved: Math.max(Number(reservedRow?.reserved || 0), 0),
            consumed: Math.max(Number(settledRow?.consumed || 0), 0),
          },
        },
        { session },
      );
      return expired.modifiedCount;
    });
  }

  return { released, periodsReconciled: periods.length };
};

export const aiUsageService = {
  resolvePeriod: resolveAiUsagePeriod,
  reserve: reserveAiCredits,
  settle: settleAiCredits,
  release: releaseAiCredits,
  get: getAiUsage,
  reconcile: reconcileAiUsageReservations,
};
