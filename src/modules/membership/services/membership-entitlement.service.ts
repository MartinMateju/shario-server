import mongoose from "mongoose";

import LocationModel from "@/modules/location/location.model.js";
import UserModel from "@/modules/user/user.model.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import MembershipEntitlementBalanceModel from "../membership-entitlement-balance.schema.js";
import MembershipEntitlementLedgerModel from "../membership-entitlement-ledger.schema.js";
import UserMembershipModel from "../user-membership.model.js";
import {
  MEMBERSHIP_BENEFIT_TYPE,
  MEMBERSHIP_ALLOWANCE_UNIT,
  MEMBERSHIP_LEDGER_ENTRY_TYPE,
  MEMBERSHIP_STATUS,
} from "../membership.constants.js";
import {
  assertMembershipIdempotencyIdentity,
  membershipIdentityHash,
} from "../membership.idempotency.js";
import { toObjectId } from "../membership.utils.js";
import { membershipAllowsLocation } from "../membership.location-policy.js";
import {
  availableCurrentPeriod, calculateTimeCarryover, consumeTimeBuckets,
  copyTimeBuckets, isTimeAllowance, restoreTimeBuckets,
  type TimeAllocation, type TimeBucket,
} from "../membership-time-buckets.js";

const isDuplicateKey = (error: any): boolean => error?.code === 11000;

const expirationForBenefit = (
  benefit: any,
  periodStart: Date,
  periodEnd: Date | null,
): Date | null => {
  if (benefit.expiresAfterDays) {
    return new Date(
      periodStart.getTime() + Number(benefit.expiresAfterDays) * 86_400_000,
    );
  }
  return periodEnd;
};

const mutationForEntry = (type: string, amount: number) => {
  switch (type) {
    case MEMBERSHIP_LEDGER_ENTRY_TYPE.GRANT:
      return { granted: amount, available: amount, sequence: 1 };
    case MEMBERSHIP_LEDGER_ENTRY_TYPE.ADJUSTMENT:
      return { adjusted: amount, available: amount, sequence: 1 };
    case MEMBERSHIP_LEDGER_ENTRY_TYPE.REDEMPTION:
      return { redeemed: Math.abs(amount), available: amount, sequence: 1 };
    case MEMBERSHIP_LEDGER_ENTRY_TYPE.REVERSAL:
      return {
        redeemed: -Math.abs(amount),
        available: Math.abs(amount),
        sequence: 1,
      };
    case MEMBERSHIP_LEDGER_ENTRY_TYPE.EXPIRATION:
      return { expired: Math.abs(amount), available: amount, sequence: 1 };
    default:
      throw new Error(`Unsupported entitlement entry type: ${type}`);
  }
};

const appendEntry = async (input: {
  tenantId: string;
  userId: string;
  membershipId: string;
  benefitKey: string;
  type: string;
  amount: number;
  reason: string;
  note?: string;
  actorId?: string | null;
  reference?: { type: string; id: string };
  relatedEntryId?: string | null;
  expiresAt?: Date | null;
  idempotencyKey: string;
  identity: Record<string, unknown>;
  session: mongoose.ClientSession;
  grantBucket?: TimeBucket;
  restoreAllocations?: TimeAllocation[];
  expireAllocations?: TimeAllocation[];
}) => {
  const identityHash = membershipIdentityHash(input.identity);
  const existing = await MembershipEntitlementLedgerModel.findOne({
    membership: toObjectId(input.membershipId),
    idempotencyKey: input.idempotencyKey,
  })
    .session(input.session)
    .exec();
  if (existing) {
    assertMembershipIdempotencyIdentity(existing.identityHash, identityHash);
    return existing;
  }

  const currentBalance = await MembershipEntitlementBalanceModel.findOne({
    membership: toObjectId(input.membershipId), benefitKey: input.benefitKey,
  }).session(input.session).exec();
  let timeBuckets: TimeBucket[] | undefined;
  let timeAllocations: TimeAllocation[] = [];
  if (currentBalance?.timeBucketVersion === 1) {
    timeBuckets = copyTimeBuckets(currentBalance);
    if (input.amount < 0) {
      try {
        if (input.expireAllocations) {
          timeAllocations = input.expireAllocations;
          for (const allocation of timeAllocations) {
            const bucket = timeBuckets.find((candidate) => candidate.key === allocation.key);
            if (!bucket || bucket.available < allocation.amount) throw new Error("Missing refund bucket.");
            bucket.available -= allocation.amount;
          }
        } else {
          const consumed = consumeTimeBuckets(timeBuckets, Math.abs(input.amount), new Date(),
            input.type !== MEMBERSHIP_LEDGER_ENTRY_TYPE.REDEMPTION);
          timeBuckets = consumed.buckets;
          timeAllocations = consumed.allocations;
        }
      } catch {
        conflict({ message: "Membership entitlement has insufficient available balance.",
          code: "MEMBERSHIP_ENTITLEMENT_INSUFFICIENT" });
      }
    } else if (input.restoreAllocations) {
      timeAllocations = input.restoreAllocations;
      timeBuckets = restoreTimeBuckets(timeBuckets, timeAllocations);
    } else if (input.amount > 0) {
      const bucket = input.grantBucket ?? {
        key: `adjustment:${input.idempotencyKey}`, periodKey: currentBalance.timePeriodKey,
        kind: "adjustment" as const, available: input.amount,
        expiresAt: new Date(currentBalance.expiresAt!),
      };
      timeBuckets.push(bucket);
      timeAllocations = [{ key: bucket.key, periodKey: bucket.periodKey, kind: bucket.kind,
        amount: input.amount, expiresAt: bucket.expiresAt }];
    }
  }

  const availabilityFilter =
    input.amount < 0
      ? {
          $and: [
            { available: { $gte: Math.abs(input.amount) } },
            ...(input.type === MEMBERSHIP_LEDGER_ENTRY_TYPE.REDEMPTION
              ? [
                  {
                    $or: [
                      { expiresAt: null },
                      { expiresAt: { $gt: new Date() } },
                    ],
                  },
                ]
              : []),
          ],
        }
      : {};
  const balance = await MembershipEntitlementBalanceModel.findOneAndUpdate(
    {
      membership: toObjectId(input.membershipId),
      benefitKey: input.benefitKey,
      ...(typeof currentBalance?.sequence === "number" ? { sequence: currentBalance.sequence } : {}),
      ...availabilityFilter,
    },
    { $inc: mutationForEntry(input.type, input.amount),
      ...(timeBuckets ? { $set: { timeBuckets } } : {}), },
    { returnDocument: "after", session: input.session, runValidators: true },
  ).exec();
  if (!balance) {
    conflict({
      message: "Membership entitlement has insufficient available balance.",
      code: "MEMBERSHIP_ENTITLEMENT_INSUFFICIENT",
      details: {
        benefitKey: input.benefitKey,
        requested: Math.abs(input.amount),
      },
    });
  }
  if (balance.unit === "credit") {
    await UserModel.updateOne(
      { _id: toObjectId(input.userId), tenant: toObjectId(input.tenantId) },
      [
        {
          $set: {
            membershipCredits: {
              $max: [
                0,
                {
                  $add: [{ $ifNull: ["$membershipCredits", 0] }, input.amount],
                },
              ],
            },
            membershipCreditsExpireAt:
              input.expiresAt ?? balance.expiresAt ?? null,
          },
        },
      ],
      { session: input.session, updatePipeline: true },
    ).exec();
  }
  const createdEntries: any = await MembershipEntitlementLedgerModel.create(
    [
      {
        tenant: toObjectId(input.tenantId),
        user: toObjectId(input.userId),
        membership: toObjectId(input.membershipId),
        benefitKey: input.benefitKey,
        type: input.type,
        amount: input.amount,
        balanceAfter: balance.available,
        sequence: balance.sequence,
        reason: input.reason,
        note: input.note ?? "",
        actor: input.actorId ? toObjectId(input.actorId) : null,
        reference: input.reference ?? {},
        relatedEntry: input.relatedEntryId
          ? toObjectId(input.relatedEntryId)
          : null,
        idempotencyKey: input.idempotencyKey,
        identityHash,
        expiresAt: input.expiresAt ?? null,
        timeAllocations,
      },
    ] as any,
    { session: input.session },
  );
  const entry = createdEntries[0];
  return entry;
};

export const grantMembershipPeriodEntitlements = async (input: {
  membership: any;
  periodStart: Date;
  periodEnd: Date | null;
  periodKey: string;
  session: mongoose.ClientSession;
  planChangeCarryover?: Record<string, number>;
}) => {
  const membershipId = String(input.membership._id);
  const tenantId = String(input.membership.tenant);
  const userId = String(input.membership.user);
  // A delayed invoice must never rewind an already granted time period.
  const newerTimePeriod = await MembershipEntitlementBalanceModel.findOne({
    membership: input.membership._id, timeBucketVersion: 1,
    timePeriodStart: { $gte: input.periodStart },
  }).session(input.session).exec();
  if (newerTimePeriod) return false;
  const claimed = await UserMembershipModel.updateOne(
    {
      _id: input.membership._id,
      grantedPeriodKeys: { $ne: input.periodKey },
    },
    { $addToSet: { grantedPeriodKeys: input.periodKey } },
    { session: input.session },
  ).exec();
  if (claimed.modifiedCount === 0) return false;
  for (const benefit of input.membership.planSnapshot.benefits ?? []) {
    if (benefit.type !== MEMBERSHIP_BENEFIT_TYPE.ALLOWANCE) continue;
    const quantity = Number(benefit.quantity ?? 0);
    const expiresAt = expirationForBenefit(
      benefit,
      input.periodStart,
      input.periodEnd,
    );
    const priorBalance = await MembershipEntitlementBalanceModel.findOne({
      membership: input.membership._id,
      benefitKey: benefit.key,
    })
      .session(input.session)
      .exec();
    const tracksTime = isTimeAllowance(benefit) && Boolean(input.periodEnd);
    const monthly = input.membership.planSnapshot.billing?.type === "recurring" &&
      input.membership.planSnapshot.billing?.interval === "month" &&
      Number(input.membership.planSnapshot.billing?.intervalCount ?? 1) === 1;
    const carryover = tracksTime && monthly
      ? input.planChangeCarryover?.[benefit.key] ?? calculateTimeCarryover(priorBalance, benefit, input.periodStart) : 0;
    if (priorBalance && priorBalance.available > 0) {
      await appendEntry({
        tenantId,
        userId,
        membershipId,
        benefitKey: benefit.key,
        type: MEMBERSHIP_LEDGER_ENTRY_TYPE.EXPIRATION,
        amount: -priorBalance.available,
        reason: "period_ended",
        idempotencyKey: `period:${input.periodKey}:expire-prior:${benefit.key}`,
        identity: {
          membershipId,
          periodKey: input.periodKey,
          benefitKey: benefit.key,
          priorAvailable: priorBalance.available,
        },
        session: input.session,
      });
    }
    await MembershipEntitlementBalanceModel.updateOne(
      { membership: input.membership._id, benefitKey: benefit.key },
      {
        $setOnInsert: {
          tenant: input.membership.tenant,
          user: input.membership.user,
          membership: input.membership._id,
          benefitKey: benefit.key,
          granted: 0,
          redeemed: 0,
          adjusted: 0,
          expired: 0,
          available: 0,
          sequence: 0,
        },
        $set: {
          expiresAt,
          unit: benefit.unit ?? "",
          currency: benefit.currency ?? "",
          ...(tracksTime ? {
            timeBucketVersion: 1, timeBuckets: [],
            timePeriodKey: input.periodKey, timePeriodStart: input.periodStart,
            timePeriodEnd: input.periodEnd, timeGrantQuantity: quantity,
            rolloverCandidateAvailable: null,
          } : {}),
        },
      },
      { upsert: true, session: input.session },
    ).exec();
    if (carryover > 0) {
      await appendEntry({
        tenantId, userId, membershipId, benefitKey: benefit.key,
        type: MEMBERSHIP_LEDGER_ENTRY_TYPE.GRANT, amount: carryover,
        reason: "period_rollover", expiresAt: input.periodEnd,
        idempotencyKey: `period:${input.periodKey}:carryover:${benefit.key}`,
        identity: { membershipId, periodKey: input.periodKey, benefitKey: benefit.key, carryover },
        grantBucket: { key: `${input.periodKey}:carryover`, periodKey: input.periodKey,
          kind: "carryover", available: carryover, expiresAt: input.periodEnd! },
        session: input.session,
      });
    }
    if (quantity === 0) continue;
    await appendEntry({
      tenantId,
      userId,
      membershipId,
      benefitKey: benefit.key,
      type: MEMBERSHIP_LEDGER_ENTRY_TYPE.GRANT,
      amount: quantity,
      reason: "period_grant",
      expiresAt,
      idempotencyKey: `period:${input.periodKey}:grant:${benefit.key}`,
      identity: {
        membershipId,
        periodKey: input.periodKey,
        benefitKey: benefit.key,
        quantity,
      },
      ...(tracksTime ? { grantBucket: {
        key: `${input.periodKey}:period`, periodKey: input.periodKey,
        kind: "period" as const, available: quantity, expiresAt: expiresAt!,
      } } : {}),
      session: input.session,
    });
  }
  return true;
};

/**
 * Migration-only primitive. It records the remaining source allocation at the
 * cutover without granting a full plan period and participates in the caller's
 * transaction. Unlike the staff adjustment API, this intentionally supports
 * non-adjustable allowance benefits because it imports source truth rather
 * than granting a discretionary benefit.
 */
export const appendMembershipImportAdjustment = async (input: {
  tenantId: string;
  userId: string;
  membershipId: string;
  benefit: any;
  delta: number;
  periodStart: Date;
  periodEnd: Date | null;
  actorId: string;
  note?: string;
  idempotencyKey: string;
  session: mongoose.ClientSession;
}) => {
  if (
    input.benefit?.type !== MEMBERSHIP_BENEFIT_TYPE.ALLOWANCE ||
    !Number.isSafeInteger(input.delta)
  ) {
    throw new Error(
      "A migration adjustment requires an integer allowance delta.",
    );
  }
  if (isTimeAllowance(input.benefit)) {
    conflict({ message: "Time allowances require a paid period grant and cannot be imported as an aggregate balance.",
      code: "MEMBERSHIP_TIME_IMPORT_UNSUPPORTED" });
  }
  const expiresAt = expirationForBenefit(
    input.benefit,
    input.periodStart,
    input.periodEnd,
  );
  await MembershipEntitlementBalanceModel.updateOne(
    {
      membership: toObjectId(input.membershipId),
      benefitKey: input.benefit.key,
    },
    {
      $setOnInsert: {
        tenant: toObjectId(input.tenantId),
        user: toObjectId(input.userId),
        membership: toObjectId(input.membershipId),
        benefitKey: input.benefit.key,
        granted: 0,
        redeemed: 0,
        adjusted: 0,
        expired: 0,
        available: 0,
        sequence: 0,
      },
      $set: {
        unit: input.benefit.unit ?? "",
        currency: input.benefit.currency ?? "",
        expiresAt,
      },
    },
    { upsert: true, session: input.session, runValidators: true },
  ).exec();
  if (input.delta === 0) return null;
  return appendEntry({
    tenantId: input.tenantId,
    userId: input.userId,
    membershipId: input.membershipId,
    benefitKey: input.benefit.key,
    type: MEMBERSHIP_LEDGER_ENTRY_TYPE.ADJUSTMENT,
    amount: input.delta,
    reason: "migration",
    note: input.note,
    actorId: input.actorId,
    expiresAt,
    idempotencyKey: input.idempotencyKey,
    identity: {
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      benefitKey: input.benefit.key,
      delta: input.delta,
      periodStart: input.periodStart.toISOString(),
      periodEnd: input.periodEnd?.toISOString() ?? null,
    },
    session: input.session,
  });
};

export const resolveMembershipEntitlement = async (input: {
  tenantId: string;
  userId: string;
  benefitKey: string;
  locationId?: string | null;
  session?: mongoose.ClientSession | null;
}) => {
  const membership = await UserMembershipModel.findOne({
    tenant: toObjectId(input.tenantId),
    user: toObjectId(input.userId),
    status: {
      $in: [MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED],
    },
  })
    .session(input.session ?? null)
    .exec();
  if (
    !membership ||
    ![MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED].includes(
      membership.status as any,
    )
  ) {
    notFound({
      message: "Active membership not found.",
      code: "MEMBERSHIP_NOT_ACTIVE",
    });
  }
  if (
    membership.currentPeriodEnd &&
    membership.currentPeriodEnd <= new Date()
  ) {
    notFound({
      message: "Active membership not found.",
      code: "MEMBERSHIP_PERIOD_ENDED",
    });
  }
  const benefit = (membership.planSnapshot.benefits ?? []).find(
    (item: any) => item.key === input.benefitKey,
  );
  if (!benefit)
    notFound({
      message: "Membership benefit not found.",
      code: "MEMBERSHIP_BENEFIT_NOT_FOUND",
    });

  if (!membershipAllowsLocation(membership, input.locationId)) {
    notFound({
      message: "Membership benefit is not available at this location.",
      code: "MEMBERSHIP_LOCATION_NOT_ALLOWED",
    });
  }
  if (input.locationId) {
    const location = await LocationModel.exists({
      _id: toObjectId(input.locationId),
      tenant: toObjectId(input.tenantId),
    }).session(input.session ?? null);
    if (!location) notFound("Location not found.");
  }
  const balance = await MembershipEntitlementBalanceModel.findOne({
    membership: membership._id,
    benefitKey: input.benefitKey,
  })
    .session(input.session ?? null)
    .exec();
  if (balance?.expiresAt && balance.expiresAt <= new Date()) {
    conflict({
      message: "Membership entitlement has expired.",
      code: "MEMBERSHIP_ENTITLEMENT_EXPIRED",
    });
  }
  return { membership, benefit, balance };
};

export const redeemMembershipEntitlement = async (input: {
  tenantId: string;
  userId: string;
  benefitKey: string;
  quantity: number;
  requiredMoneyAmountMinor?: number;
  requiredMoneyCurrency?: string;
  locationId?: string | null;
  reference: { type: string; id: string };
  idempotencyKey: string;
  session?: mongoose.ClientSession | null;
  bookingContext?: {
    productKind: string;
    bookingMode: string;
    participantCount: number;
    durationMinutes: number;
  };
}) => {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0)
    throw new Error("Redemption quantity must be a positive integer.");
  const { membership, benefit } = await resolveMembershipEntitlement(input);
  if (isTimeAllowance(benefit) && (benefit as any).usageScope === "open_studio") {
    const context = input.bookingContext;
    const required = benefit.unit === "minute"
      ? context?.durationMinutes : Math.ceil(Number(context?.durationMinutes) / 60);
    if (!context || context.productKind !== "open_studio" || context.bookingMode !== "public" ||
        context.participantCount !== 1 || !Number.isSafeInteger(context.durationMinutes) ||
        context.durationMinutes <= 0 || input.quantity !== required) {
      conflict({ message: "Membership hours may only pay for the member's own Open Studio visit.",
        code: "MEMBERSHIP_TIME_PERSONAL_OPEN_STUDIO_REQUIRED" });
    }
  }
  if (
    input.requiredMoneyAmountMinor !== undefined &&
    (benefit.unit !== MEMBERSHIP_ALLOWANCE_UNIT.MONEY_MINOR ||
      String(benefit.currency || "").toUpperCase() !==
        String(input.requiredMoneyCurrency || "").toUpperCase() ||
      input.quantity !== input.requiredMoneyAmountMinor)
  ) {
    conflict({
      message: "Private booking fees require a monetary allowance covering the full booking, a card, or money credits.",
      code: "PRIVATE_BOOKING_SURCHARGE_REQUIRES_MONEY",
    });
  }
  if (benefit.type !== MEMBERSHIP_BENEFIT_TYPE.ALLOWANCE) {
    conflict({
      message: "This membership benefit is not consumable.",
      code: "MEMBERSHIP_BENEFIT_NOT_CONSUMABLE",
    });
  }
  const { session: externalSession = null, ...redemptionIdentity } = input;
  const appendRedemption = (session: mongoose.ClientSession) =>
    appendEntry({
      tenantId: input.tenantId,
      userId: input.userId,
      membershipId: String(membership._id),
      benefitKey: input.benefitKey,
      type: MEMBERSHIP_LEDGER_ENTRY_TYPE.REDEMPTION,
      amount: -input.quantity,
      reason: "benefit_redemption",
      expiresAt: membership.currentPeriodEnd,
      reference: input.reference,
      idempotencyKey: input.idempotencyKey,
      identity: redemptionIdentity,
      session,
    });
  const resolveDuplicate = async (error: unknown) => {
    if (isDuplicateKey(error)) {
      const existing = await MembershipEntitlementLedgerModel.findOne({
        membership: membership._id,
        idempotencyKey: input.idempotencyKey,
      })
        .session(externalSession)
        .exec();
      if (existing) {
        assertMembershipIdempotencyIdentity(
          existing.identityHash,
          membershipIdentityHash(redemptionIdentity),
        );
        return existing;
      }
    }
    throw error;
  };

  if (externalSession) {
    try {
      return await appendRedemption(externalSession);
    } catch (error) {
      return resolveDuplicate(error);
    }
  }

  const session = await mongoose.startSession();
  try {
    let entry: any;
    await session.withTransaction(async () => {
      entry = await appendRedemption(session);
    });
    return entry;
  } catch (error) {
    return resolveDuplicate(error);
  } finally {
    await session.endSession();
  }
};

export const reverseMembershipRedemption = async (input: {
  tenantId: string;
  membershipId: string;
  redemptionEntryId: string;
  reason: string;
  actorId?: string | null;
  idempotencyKey: string;
  session?: mongoose.ClientSession | null;
}) => {
  const { session: _externalSession, ...reversalIdentity } = input;
  const redemption = await MembershipEntitlementLedgerModel.findOne({
    _id: toObjectId(input.redemptionEntryId),
    tenant: toObjectId(input.tenantId),
    membership: toObjectId(input.membershipId),
    type: MEMBERSHIP_LEDGER_ENTRY_TYPE.REDEMPTION,
  })
    .session(input.session ?? null)
    .exec();
  if (!redemption) notFound("Membership redemption not found.");
  const appendReversal = async (session: mongoose.ClientSession) => {
    const existing = await MembershipEntitlementLedgerModel.findOne({
      membership: toObjectId(input.membershipId), idempotencyKey: input.idempotencyKey,
    }).session(session).exec();
    if (existing) {
      assertMembershipIdempotencyIdentity(existing.identityHash, membershipIdentityHash(reversalIdentity));
      return existing;
    }
    const balance = await MembershipEntitlementBalanceModel.findOne({
      membership: toObjectId(input.membershipId), benefitKey: redemption.benefitKey,
    }).session(session).exec();
    let allocations: TimeAllocation[] | undefined;
    let expiredAllocations: TimeAllocation[] = [];
    if (balance?.timeBucketVersion === 1) {
      const now = new Date();
      allocations = (redemption.timeAllocations ?? []).map((allocation: any) => ({
        key: allocation.key, periodKey: allocation.periodKey, kind: allocation.kind,
        amount: allocation.amount, expiresAt: new Date(allocation.expiresAt),
      }));
      if (!allocations.length) {
        // Old time-redemption rows have no buckets. Never credit an old period
        // into a new one simply because cancellation arrived after renewal.
        const samePeriod = balance.timePeriodStart && redemption.createdAt >= balance.timePeriodStart;
        const originalExpiry = redemption.expiresAt ?? (samePeriod ? balance.expiresAt : redemption.createdAt);
        allocations = [{ key: `legacy-refund:${redemption._id}`, periodKey: "legacy-refund",
          kind: "adjustment", amount: Math.abs(redemption.amount), expiresAt: new Date(originalExpiry!) }];
      }
      const membership = await UserMembershipModel.findOne({
        _id: toObjectId(input.membershipId), tenant: toObjectId(input.tenantId),
      }).session(session).exec();
      const active = membership &&
        [MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED].includes(membership.status as any) &&
        (!membership.currentPeriodEnd || membership.currentPeriodEnd > now);
      expiredAllocations = allocations.filter((allocation) => !active || allocation.expiresAt <= now);
    }
    const reversal = await appendEntry({
      tenantId: input.tenantId,
      userId: String(redemption.user),
      membershipId: input.membershipId,
      benefitKey: redemption.benefitKey,
      type: MEMBERSHIP_LEDGER_ENTRY_TYPE.REVERSAL,
      amount: Math.abs(redemption.amount),
      reason: input.reason,
      actorId: input.actorId,
      reference: redemption.reference as any,
      relatedEntryId: String(redemption._id),
      idempotencyKey: input.idempotencyKey,
      identity: reversalIdentity,
      restoreAllocations: allocations,
      session,
    });
    const expiredAmount = expiredAllocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    if (expiredAmount > 0) {
      await appendEntry({
        tenantId: input.tenantId, userId: String(redemption.user), membershipId: input.membershipId,
        benefitKey: redemption.benefitKey, type: MEMBERSHIP_LEDGER_ENTRY_TYPE.EXPIRATION,
        amount: -expiredAmount, reason: "reversal_original_expired",
        relatedEntryId: String(reversal._id), expiresAt: new Date(),
        idempotencyKey: `refund-expiry:${redemption._id}`,
        expireAllocations: expiredAllocations,
        identity: { redemptionEntryId: String(redemption._id), expiredAmount }, session,
      });
    }
    return reversal;
  };

  const resolveDuplicate = async (error: unknown) => {
    if (isDuplicateKey(error)) {
      const existing = await MembershipEntitlementLedgerModel.findOne({
        membership: toObjectId(input.membershipId),
        idempotencyKey: input.idempotencyKey,
      })
        .session(input.session ?? null)
        .exec();
      if (existing) {
        assertMembershipIdempotencyIdentity(
          existing.identityHash,
          membershipIdentityHash(reversalIdentity),
        );
        return existing;
      }
    }
    throw error;
  };

  if (input.session) {
    try {
      return await appendReversal(input.session);
    } catch (error) {
      return resolveDuplicate(error);
    }
  }

  const session = await mongoose.startSession();
  try {
    let entry: any;
    await session.withTransaction(async () => {
      entry = await appendReversal(session);
    });
    return entry;
  } catch (error) {
    return resolveDuplicate(error);
  } finally {
    await session.endSession();
  }
};

export const adjustMembershipEntitlement = async (input: {
  tenantId: string;
  membershipId: string;
  benefitKey: string;
  delta: number;
  reason: string;
  note?: string;
  actorId: string;
  idempotencyKey: string;
}) => {
  const membership = await UserMembershipModel.findOne({
    _id: toObjectId(input.membershipId),
    tenant: toObjectId(input.tenantId),
    status: {
      $in: [MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED],
    },
  }).exec();
  if (!membership) notFound("Membership not found.");
  const benefit = (membership.planSnapshot.benefits ?? []).find(
    (item: any) => item.key === input.benefitKey,
  );
  if (
    !benefit ||
    benefit.type !== MEMBERSHIP_BENEFIT_TYPE.ALLOWANCE ||
    benefit.adjustable === false
  ) {
    conflict({
      message: "Only adjustable allowance benefits may be adjusted.",
      code: "MEMBERSHIP_BENEFIT_NOT_ADJUSTABLE",
    });
  }
  const session = await mongoose.startSession();
  try {
    let entry: any;
    await session.withTransaction(async () => {
      const balance = await MembershipEntitlementBalanceModel.findOne({
        membership: membership._id, benefitKey: input.benefitKey,
      }).session(session).exec();
      if (balance?.timeBucketVersion === 1 && balance.expiresAt && balance.expiresAt <= new Date()) {
        conflict({ message: "Membership entitlement has expired.", code: "MEMBERSHIP_ENTITLEMENT_EXPIRED" });
      }
      entry = await appendEntry({
        tenantId: input.tenantId,
        userId: String(membership.user),
        membershipId: input.membershipId,
        benefitKey: input.benefitKey,
        type: MEMBERSHIP_LEDGER_ENTRY_TYPE.ADJUSTMENT,
        amount: input.delta,
        reason: input.reason,
        note: input.note,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        identity: input,
        session,
      });
    });
    return entry;
  } catch (error) {
    if (isDuplicateKey(error)) {
      const existing = await MembershipEntitlementLedgerModel.findOne({
        membership: membership._id,
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) {
        assertMembershipIdempotencyIdentity(
          existing.identityHash,
          membershipIdentityHash(input),
        );
        return existing;
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const expireMembershipEntitlements = async (input: {
  tenantId: string;
  membership: any;
  reason: string;
  idempotencyPrefix: string;
  session: mongoose.ClientSession;
}) => {
  // Terminal cancellation/expiration forfeits carry eligibility, including a
  // balance already zeroed by the scheduled entitlement expiry worker.
  await MembershipEntitlementBalanceModel.updateMany(
    { membership: input.membership._id, timeBucketVersion: 1 },
    { $set: { rolloverCandidateAvailable: 0 } },
    { session: input.session },
  ).exec();
  const balances = await MembershipEntitlementBalanceModel.find({
    membership: input.membership._id,
    available: { $gt: 0 },
  })
    .session(input.session)
    .exec();
  for (const balance of balances) {
    await appendEntry({
      tenantId: input.tenantId,
      userId: String(input.membership.user),
      membershipId: String(input.membership._id),
      benefitKey: balance.benefitKey,
      type: MEMBERSHIP_LEDGER_ENTRY_TYPE.EXPIRATION,
      amount: -balance.available,
      reason: input.reason,
      expiresAt: new Date(),
      idempotencyKey: `${input.idempotencyPrefix}:${balance.benefitKey}`,
      identity: {
        membershipId: String(input.membership._id),
        reason: input.reason,
        benefitKey: balance.benefitKey,
        available: balance.available,
      },
      session: input.session,
    });
  }
};

export const expireDueMembershipEntitlement = async (input: {
  tenantId: string;
  membership: any;
  benefitKey: string;
  idempotencyKey: string;
  session: mongoose.ClientSession;
}) => {
  const balance = await MembershipEntitlementBalanceModel.findOne({
    membership: input.membership._id,
    benefitKey: input.benefitKey,
    available: { $gt: 0 },
    expiresAt: { $lte: new Date() },
  })
    .session(input.session)
    .exec();
  if (!balance) return false;
  if (balance.timeBucketVersion === 1 && balance.rolloverCandidateAvailable == null) {
    await MembershipEntitlementBalanceModel.updateOne(
      { _id: balance._id },
      { $set: { rolloverCandidateAvailable: availableCurrentPeriod(balance) } },
      { session: input.session },
    ).exec();
  }
  await appendEntry({
    tenantId: input.tenantId,
    userId: String(input.membership.user),
    membershipId: String(input.membership._id),
    benefitKey: balance.benefitKey,
    type: MEMBERSHIP_LEDGER_ENTRY_TYPE.EXPIRATION,
    amount: -balance.available,
    reason: "benefit_expired",
    expiresAt: balance.expiresAt,
    idempotencyKey: input.idempotencyKey,
    identity: {
      membershipId: String(input.membership._id),
      benefitKey: balance.benefitKey,
      expiresAt: balance.expiresAt,
      available: balance.available,
    },
    session: input.session,
  });
  return true;
};

/**
 * Booking and firing domains intentionally call these primitives explicitly.
 * Automatic allocation is not wired here because those domains do not expose
 * one unambiguous resource-to-benefit mapping in V1.
 */
export const membershipEntitlementService = {
  resolve: resolveMembershipEntitlement,
  redeem: redeemMembershipEntitlement,
  reverse: reverseMembershipRedemption,
  adjust: adjustMembershipEntitlement,
  grantPeriod: grantMembershipPeriodEntitlements,
  expire: expireMembershipEntitlements,
  expireDue: expireDueMembershipEntitlement,
  appendImportAdjustment: appendMembershipImportAdjustment,
};

export default membershipEntitlementService;
