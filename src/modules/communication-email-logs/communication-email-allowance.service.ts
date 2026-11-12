import { getTenantSubscriptionAccess } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import { resolveMonthlyUsageWindow } from "@/modules/tenants/tenant-usage-period.js";

import {
  COMMUNICATION_EMAIL_ALLOWANCE_CLASS,
  COMMUNICATION_EMAIL_LOG_STATUS,
  type CommunicationEmailAllowanceClass,
} from "./communication-email-log.constants.js";
import CommunicationEmailLogModel from "./communication-email-log.model.js";
import {
  COMMUNICATION_EMAIL_ALLOWANCE_STATUS,
  CommunicationEmailAllowanceLedgerModel,
  CommunicationEmailAllowancePeriodModel,
} from "./communication-email-allowance.model.js";

type EmailAllowancePeriod = {
  key: string;
  start: Date;
  end: Date;
  limit: number;
};

type ExemptReservation = {
  kind: "exempt";
  reason: "essential_system" | "legacy_plan";
};

type ExhaustedReservation = {
  kind: "exhausted";
  periodEnd: Date;
  limit: number;
};

type MeteredReservation = {
  kind: "reserved";
  reservationId: string;
  status: string;
};

export type EmailAllowanceReservation =
  ExemptReservation | ExhaustedReservation | MeteredReservation;

export const resolveCommunicationEmailAllowancePeriod = async (
  tenantId: string,
  now = new Date(),
): Promise<EmailAllowancePeriod & { planVersion: number }> => {
  const { tenant, subscription } = await getTenantSubscriptionAccess(tenantId);
  const planVersion = Math.max(Number(tenant.planVersion ?? 1), 1);
  const limit = Math.max(Number(tenant.limits?.monthlyEmails ?? 0), 0);
  const { start, end } = resolveMonthlyUsageWindow(subscription, now);
  return {
    key: `${start.toISOString()}_${end.toISOString()}`,
    start,
    end,
    limit,
    planVersion,
  };
};

const ensurePeriod = async (tenantId: string, period: EmailAllowancePeriod) =>
  CommunicationEmailAllowancePeriodModel.findOneAndUpdate(
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

const reservePeriodUnit = async (
  tenantId: string,
  period: EmailAllowancePeriod,
) =>
  CommunicationEmailAllowancePeriodModel.findOneAndUpdate(
    {
      tenant: tenantId,
      periodKey: period.key,
      $expr: {
        $lt: [{ $add: ["$reserved", "$consumed"] }, "$limit"],
      },
    },
    { $inc: { reserved: 1 } },
    { returnDocument: "after" },
  );

export const reserveCommunicationEmailAllowance = async ({
  tenantId,
  emailLogId,
  idempotencyKey,
  allowanceClass = COMMUNICATION_EMAIL_ALLOWANCE_CLASS.METERED,
  planVersion,
}: {
  tenantId: string;
  emailLogId?: string | null;
  idempotencyKey: string;
  allowanceClass?: CommunicationEmailAllowanceClass;
  planVersion?: number;
}): Promise<EmailAllowanceReservation> => {
  if (allowanceClass === COMMUNICATION_EMAIL_ALLOWANCE_CLASS.ESSENTIAL_SYSTEM) {
    return { kind: "exempt", reason: "essential_system" };
  }

  if (planVersion !== undefined && Math.max(Number(planVersion), 1) < 3) {
    return { kind: "exempt", reason: "legacy_plan" };
  }

  const period = await resolveCommunicationEmailAllowancePeriod(tenantId);
  if (period.planVersion < 3) {
    return { kind: "exempt", reason: "legacy_plan" };
  }

  const existing = await CommunicationEmailAllowanceLedgerModel.findOne({
    tenant: tenantId,
    idempotencyKey,
  });
  if (
    existing &&
    existing.status !== COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED
  ) {
    return {
      kind: "reserved",
      reservationId: String(existing._id),
      status: String(existing.status),
    };
  }

  await ensurePeriod(tenantId, period);
  const usagePeriod = await reservePeriodUnit(tenantId, period);
  if (!usagePeriod) {
    // A concurrent retry with this idempotency key may have consumed the last
    // unit between our first ledger lookup and the atomic period reservation.
    // Return that canonical reservation rather than misreporting exhaustion.
    const concurrent = await CommunicationEmailAllowanceLedgerModel.findOne({
      tenant: tenantId,
      idempotencyKey,
      status: { $ne: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED },
    });
    if (concurrent) {
      return {
        kind: "reserved",
        reservationId: String(concurrent._id),
        status: String(concurrent.status),
      };
    }
    return {
      kind: "exhausted",
      periodEnd: period.end,
      limit: period.limit,
    };
  }

  if (existing) {
    const reclaimed =
      await CommunicationEmailAllowanceLedgerModel.findOneAndUpdate(
        {
          _id: existing._id,
          status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED,
        },
        {
          $set: {
            periodKey: period.key,
            emailLog: emailLogId || null,
            status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RESERVED,
          },
          $unset: { consumedAt: 1, releasedAt: 1 },
        },
        { returnDocument: "after" },
      );
    if (reclaimed) {
      return {
        kind: "reserved",
        reservationId: String(reclaimed._id),
        status: String(reclaimed.status),
      };
    }

    await CommunicationEmailAllowancePeriodModel.updateOne(
      { tenant: tenantId, periodKey: period.key },
      { $inc: { reserved: -1 } },
    );
    const canonical = await CommunicationEmailAllowanceLedgerModel.findById(
      existing._id,
    );
    return {
      kind: "reserved",
      reservationId: String(canonical?._id ?? existing._id),
      status: String(canonical?.status ?? existing.status),
    };
  }

  try {
    const created = await CommunicationEmailAllowanceLedgerModel.create({
      tenant: tenantId,
      periodKey: period.key,
      idempotencyKey,
      emailLog: emailLogId || null,
      status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RESERVED,
    });
    return {
      kind: "reserved",
      reservationId: String(created._id),
      status: String(created.status),
    };
  } catch (error: any) {
    await CommunicationEmailAllowancePeriodModel.updateOne(
      { tenant: tenantId, periodKey: period.key },
      { $inc: { reserved: -1 } },
    );
    if (error?.code === 11000) {
      const canonical = await CommunicationEmailAllowanceLedgerModel.findOne({
        tenant: tenantId,
        idempotencyKey,
      });
      if (canonical) {
        if (
          canonical.status === COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED
        ) {
          const retryPeriod = await reservePeriodUnit(tenantId, period);
          if (!retryPeriod) {
            const winner = await CommunicationEmailAllowanceLedgerModel.findOne(
              {
                tenant: tenantId,
                idempotencyKey,
                status: {
                  $ne: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED,
                },
              },
            );
            if (winner) {
              return {
                kind: "reserved",
                reservationId: String(winner._id),
                status: String(winner.status),
              };
            }
            return {
              kind: "exhausted",
              periodEnd: period.end,
              limit: period.limit,
            };
          }
          const reclaimed =
            await CommunicationEmailAllowanceLedgerModel.findOneAndUpdate(
              {
                _id: canonical._id,
                status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED,
              },
              {
                $set: {
                  periodKey: period.key,
                  emailLog: emailLogId || null,
                  status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RESERVED,
                },
                $unset: { consumedAt: 1, releasedAt: 1 },
              },
              { returnDocument: "after" },
            );
          if (reclaimed) {
            return {
              kind: "reserved",
              reservationId: String(reclaimed._id),
              status: String(reclaimed.status),
            };
          }
          await CommunicationEmailAllowancePeriodModel.updateOne(
            { tenant: tenantId, periodKey: period.key },
            { $inc: { reserved: -1 } },
          );
          const winner = await CommunicationEmailAllowanceLedgerModel.findById(
            canonical._id,
          );
          if (
            winner &&
            winner.status !== COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED
          ) {
            return {
              kind: "reserved",
              reservationId: String(winner._id),
              status: String(winner.status),
            };
          }
          throw new Error(
            "Email allowance idempotency ledger could not be reclaimed safely.",
          );
        }
        return {
          kind: "reserved",
          reservationId: String(canonical._id),
          status: String(canonical.status),
        };
      }
    }
    throw error;
  }
};

export const consumeCommunicationEmailAllowance = async (
  reservationId: string,
) => {
  const reservation =
    await CommunicationEmailAllowanceLedgerModel.findOneAndUpdate(
      {
        _id: reservationId,
        status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RESERVED,
      },
      {
        $set: {
          status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.CONSUMED,
          consumedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
  if (!reservation) {
    return CommunicationEmailAllowanceLedgerModel.findById(reservationId);
  }
  await CommunicationEmailAllowancePeriodModel.updateOne(
    { tenant: reservation.tenant, periodKey: reservation.periodKey },
    { $inc: { reserved: -1, consumed: 1 } },
  );
  return reservation;
};

export const releaseCommunicationEmailAllowance = async (
  reservationId: string,
) => {
  const reservation =
    await CommunicationEmailAllowanceLedgerModel.findOneAndUpdate(
      {
        _id: reservationId,
        status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RESERVED,
      },
      {
        $set: {
          status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED,
          releasedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
  if (!reservation) {
    return CommunicationEmailAllowanceLedgerModel.findById(reservationId);
  }
  await CommunicationEmailAllowancePeriodModel.updateOne(
    { tenant: reservation.tenant, periodKey: reservation.periodKey },
    { $inc: { reserved: -1 } },
  );
  return reservation;
};

const CONSUMED_EMAIL_LOG_STATUSES = new Set<string>([
  COMMUNICATION_EMAIL_LOG_STATUS.SENT,
  COMMUNICATION_EMAIL_LOG_STATUS.DELIVERED,
  COMMUNICATION_EMAIL_LOG_STATUS.BOUNCED,
  COMMUNICATION_EMAIL_LOG_STATUS.COMPLAINED,
  COMMUNICATION_EMAIL_LOG_STATUS.AMBIGUOUS,
]);

const RELEASED_EMAIL_LOG_STATUSES = new Set<string>([
  COMMUNICATION_EMAIL_LOG_STATUS.FAILED,
  COMMUNICATION_EMAIL_LOG_STATUS.CANCELED,
  COMMUNICATION_EMAIL_LOG_STATUS.SUPPRESSED,
]);

/**
 * Repairs quota reservations after a worker loses its email-log claim. Active,
 * queued, and scheduled deliveries remain reserved; only durable terminal log
 * states can consume or release a unit.
 */
export const reconcileCommunicationEmailAllowanceReservations = async ({
  limit = 500,
  emailLogIds,
}: {
  limit?: number;
  emailLogIds?: string[];
} = {}): Promise<{ consumed: number; released: number }> => {
  const normalizedLogIds = (emailLogIds ?? []).filter(Boolean);
  const reservations = await CommunicationEmailAllowanceLedgerModel.find({
    status: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RESERVED,
    emailLog: normalizedLogIds.length
      ? { $in: normalizedLogIds }
      : { $ne: null },
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(Math.min(Math.max(Number(limit) || 1, 1), 2_000))
    .select("_id emailLog")
    .lean();
  if (!reservations.length) return { consumed: 0, released: 0 };

  const logs = await CommunicationEmailLogModel.find({
    _id: { $in: reservations.map((reservation) => reservation.emailLog) },
  })
    .select("_id status")
    .lean();
  const statusByLogId = new Map(
    logs.map((log) => [String(log._id), String(log.status)]),
  );
  let consumed = 0;
  let released = 0;

  for (const reservation of reservations) {
    const status = statusByLogId.get(String(reservation.emailLog));
    if (status && CONSUMED_EMAIL_LOG_STATUSES.has(status)) {
      const settled = await consumeCommunicationEmailAllowance(
        String(reservation._id),
      );
      consumed += Number(
        settled?.status === COMMUNICATION_EMAIL_ALLOWANCE_STATUS.CONSUMED,
      );
    } else if (status && RELEASED_EMAIL_LOG_STATUSES.has(status)) {
      const settled = await releaseCommunicationEmailAllowance(
        String(reservation._id),
      );
      released += Number(
        settled?.status === COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RELEASED,
      );
    }
  }

  return { consumed, released };
};
