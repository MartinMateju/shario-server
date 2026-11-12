import type { Types } from "mongoose";

import UserModel from "./user.model.js";
import UserMemberNumberCounterModel from "./user-member-number-counter.model.js";
import {
  allocateUserMemberNumber,
  assertUserMemberNumberAllocationEpoch,
  ensureUserMemberNumberCounterAtLeast,
  isInactiveGeneratedGuest,
  USER_MEMBER_NUMBER_COUNTER_KEY,
} from "./user-member-number.service.js";
import { activeNumericLegacyMemberNumber } from "./user-member-number-high-water.js";

type MemberNumberIdentitySource =
  "memberNumber" | "customId" | "memberNumberHistory";

type MemberNumberConflictOwner = {
  userId: string;
  customId: string;
  memberNumber: number | null;
  sources: MemberNumberIdentitySource[];
};

type MemberNumberConflict = {
  memberNumber: number;
  owners: MemberNumberConflictOwner[];
};

type TenantMigrationSummary = {
  tenantId: string;
  eligible: number;
  assigned: number;
  adoptedLegacyCustomIds: number;
  allocated: number;
  skippedGeneratedGuests: number;
  existingMemberNumberHighWaterMark: number;
  legacyCustomIdHighWaterMark: number;
  existingHighWaterMark: number;
  counterBefore: number;
  counterAfter: number;
  conflicts: MemberNumberConflict[];
};

export type UserMemberNumberMigrationSummary = {
  apply: boolean;
  refused: boolean;
  tenants: TenantMigrationSummary[];
  totals: {
    eligible: number;
    assigned: number;
    adoptedLegacyCustomIds: number;
    allocated: number;
    skippedGeneratedGuests: number;
    conflicts: number;
  };
};

type MigrationUser = {
  _id: Types.ObjectId;
  customId?: unknown;
  memberNumber?: unknown;
  memberNumberHistory?: { number?: unknown }[];
  isAccessGranted?: unknown;
};

type TenantMigrationPlan = {
  tenantId: Types.ObjectId;
  allocationEpoch: number;
  summary: TenantMigrationSummary;
  legacyCustomIdAdoptions: Array<{
    user: MigrationUser;
    memberNumber: number;
  }>;
  allocationCandidates: MigrationUser[];
};

type InternalConflictOwner = Omit<MemberNumberConflictOwner, "sources"> & {
  sources: Set<MemberNumberIdentitySource>;
};

const validCounterValue = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};

const validMemberNumber = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;

/**
 * Legacy IDs are identities only when the complete stored value is decimal
 * digits and normalizes to a positive safe integer. Leading zeros intentionally
 * normalize to the same identity (for example, `0952` and `952`).
 */
const numericLegacyCustomId = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;

  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const isMissingMemberNumber = (value: unknown): boolean =>
  value === undefined || value === null;

const maxOrZero = (values: Array<number | null>): number =>
  values.reduce(
    (highest, value) => (value !== null && value > highest ? value : highest),
    0,
  );

const buildIdentityConflicts = (
  users: MigrationUser[],
): MemberNumberConflict[] => {
  const ownersByNumber = new Map<number, Map<string, InternalConflictOwner>>();

  const addOwner = (
    user: MigrationUser,
    memberNumber: number,
    source: MemberNumberIdentitySource,
  ) => {
    const userId = String(user._id);
    let owners = ownersByNumber.get(memberNumber);
    if (!owners) {
      owners = new Map();
      ownersByNumber.set(memberNumber, owners);
    }

    const existingOwner = owners.get(userId);
    if (existingOwner) {
      existingOwner.sources.add(source);
      return;
    }

    owners.set(userId, {
      userId,
      customId: String(user.customId ?? ""),
      memberNumber: validMemberNumber(user.memberNumber),
      sources: new Set([source]),
    });
  };

  for (const user of users) {
    const persistedMemberNumber = validMemberNumber(user.memberNumber);
    const legacyMemberNumber = numericLegacyCustomId(user.customId);

    if (persistedMemberNumber !== null) {
      addOwner(user, persistedMemberNumber, "memberNumber");
    }
    if (legacyMemberNumber !== null) {
      addOwner(user, legacyMemberNumber, "customId");
    }
  }

  // A legacy adoption must not give a retired physical mark to another user.
  // Existing historical overlaps are outside this initialization migration.
  const adoptionNumbers = new Set(
    users
      .filter((user) => isMissingMemberNumber(user.memberNumber))
      .map((user) => numericLegacyCustomId(user.customId))
      .filter((number): number is number => number !== null),
  );
  for (const user of users) {
    for (const entry of user.memberNumberHistory ?? []) {
      const number = validMemberNumber(entry.number);
      if (number !== null && adoptionNumbers.has(number)) {
        addOwner(user, number, "memberNumberHistory");
      }
    }
  }

  return [...ownersByNumber.entries()]
    .filter(([, owners]) => owners.size > 1)
    .sort(([left], [right]) => left - right)
    .map(([memberNumber, owners]) => ({
      memberNumber,
      owners: [...owners.values()]
        .sort((left, right) => left.userId.localeCompare(right.userId))
        .map((owner) => ({
          ...owner,
          sources: [...owner.sources],
        })),
    }));
};

const summarizePlans = ({
  apply,
  refused,
  plans,
}: {
  apply: boolean;
  refused: boolean;
  plans: TenantMigrationPlan[];
}): UserMemberNumberMigrationSummary => {
  const tenants = plans.map((plan) => plan.summary);

  return {
    apply,
    refused,
    tenants,
    totals: tenants.reduce(
      (total, tenant) => ({
        eligible: total.eligible + tenant.eligible,
        assigned: total.assigned + tenant.assigned,
        adoptedLegacyCustomIds:
          total.adoptedLegacyCustomIds + tenant.adoptedLegacyCustomIds,
        allocated: total.allocated + tenant.allocated,
        skippedGeneratedGuests:
          total.skippedGeneratedGuests + tenant.skippedGeneratedGuests,
        conflicts: total.conflicts + tenant.conflicts.length,
      }),
      {
        eligible: 0,
        assigned: 0,
        adoptedLegacyCustomIds: 0,
        allocated: 0,
        skippedGeneratedGuests: 0,
        conflicts: 0,
      },
    ),
  };
};

export class UserMemberNumberMigrationConflictError extends Error {
  readonly summary: UserMemberNumberMigrationSummary;

  constructor(summary: UserMemberNumberMigrationSummary) {
    super(
      `Refusing to apply user member-number migration: ${summary.totals.conflicts} conflicting numeric identity number(s). Run the dry-run and resolve every conflict first.`,
    );
    this.name = "UserMemberNumberMigrationConflictError";
    this.summary = summary;
  }
}

export const migrateUserMemberNumbers = async ({
  apply = false,
}: {
  apply?: boolean;
} = {}): Promise<UserMemberNumberMigrationSummary> => {
  const tenantIds = (await UserModel.distinct("tenant").exec())
    .filter(Boolean)
    .sort((left, right) => String(left).localeCompare(String(right)));

  const plans: TenantMigrationPlan[] = [];

  // Build and validate every tenant plan before performing any migration
  // writes. This prevents a later tenant conflict from leaving earlier tenants
  // partially backfilled.
  for (const tenantId of tenantIds) {
    // Capture the epoch before reading any source data for the plan. An apply
    // after a repair must abort this plan instead of restoring its stale floor.
    const counter = await UserMemberNumberCounterModel.findOne({
      tenant: tenantId,
      key: USER_MEMBER_NUMBER_COUNTER_KEY,
    })
      .select("value allocationEpoch")
      .lean()
      .exec();
    const users = await UserModel.find({ tenant: tenantId })
      .sort({ createdAt: 1, _id: 1 })
      .select(
        "_id tenant customId memberNumber isAccessGranted +memberNumberHistory",
      )
      .lean()
      .exec();
    const migrationUsers = users as MigrationUser[];
    const missingNumberUsers = migrationUsers.filter((user) =>
      isMissingMemberNumber(user.memberNumber),
    );
    const eligibleUsers = missingNumberUsers.filter(
      (candidate) => !isInactiveGeneratedGuest(candidate),
    );
    const legacyCustomIdAdoptions = eligibleUsers.flatMap((user) => {
      const memberNumber = numericLegacyCustomId(user.customId);
      return memberNumber === null ? [] : [{ user, memberNumber }];
    });
    const allocationCandidates = eligibleUsers.filter(
      (user) => numericLegacyCustomId(user.customId) === null,
    );
    const existingMemberNumberHighWaterMark = maxOrZero(
      migrationUsers.map((user) => validMemberNumber(user.memberNumber)),
    );
    const legacyCustomIdHighWaterMark = maxOrZero(
      migrationUsers.map(activeNumericLegacyMemberNumber),
    );
    const existingHighWaterMark = Math.max(
      existingMemberNumberHighWaterMark,
      legacyCustomIdHighWaterMark,
    );
    const counterBefore = validCounterValue(counter?.value);

    plans.push({
      tenantId: tenantId as Types.ObjectId,
      allocationEpoch: validCounterValue(counter?.allocationEpoch),
      legacyCustomIdAdoptions,
      allocationCandidates,
      summary: {
        tenantId: String(tenantId),
        eligible: eligibleUsers.length,
        assigned: 0,
        adoptedLegacyCustomIds: 0,
        allocated: 0,
        skippedGeneratedGuests:
          missingNumberUsers.length - eligibleUsers.length,
        existingMemberNumberHighWaterMark,
        legacyCustomIdHighWaterMark,
        existingHighWaterMark,
        counterBefore,
        counterAfter: counterBefore,
        conflicts: buildIdentityConflicts(migrationUsers),
      },
    });
  }

  const preflightSummary = summarizePlans({ apply, refused: false, plans });
  if (!apply) return preflightSummary;

  if (preflightSummary.totals.conflicts > 0) {
    throw new UserMemberNumberMigrationConflictError(
      summarizePlans({ apply, refused: true, plans }),
    );
  }

  await Promise.all([
    UserModel.createIndexes(),
    UserMemberNumberCounterModel.createIndexes(),
  ]);

  for (const plan of plans) {
    await ensureUserMemberNumberCounterAtLeast({
      tenantId: plan.tenantId,
      minimum: plan.summary.existingHighWaterMark,
      expectedEpoch: plan.allocationEpoch,
    });

    // Preserve a unique decimal legacy identity exactly: customId "0017"
    // becomes memberNumber 17. The counter is already above every such value,
    // so subsequently allocated users cannot take a legacy identity.
    for (const adoption of plan.legacyCustomIdAdoptions) {
      await assertUserMemberNumberAllocationEpoch({
        tenantId: plan.tenantId,
        expectedEpoch: plan.allocationEpoch,
      });
      const result = await UserModel.collection.updateOne(
        {
          _id: adoption.user._id,
          tenant: plan.tenantId,
          memberNumber: null,
        },
        { $set: { memberNumber: adoption.memberNumber } },
      );

      if (result.modifiedCount === 1) {
        plan.summary.assigned += 1;
        plan.summary.adoptedLegacyCustomIds += 1;
      }
    }

    for (const user of plan.allocationCandidates) {
      const memberNumber = await allocateUserMemberNumber({
        tenantId: plan.tenantId,
        expectedEpoch: plan.allocationEpoch,
      });
      await assertUserMemberNumberAllocationEpoch({
        tenantId: plan.tenantId,
        expectedEpoch: plan.allocationEpoch,
      });

      // Raw collection write intentionally bypasses schema immutability so
      // the rollout can initialize this once on legacy records.
      const result = await UserModel.collection.updateOne(
        {
          _id: user._id,
          tenant: plan.tenantId,
          memberNumber: null,
        },
        { $set: { memberNumber } },
      );

      if (result.modifiedCount === 1) {
        plan.summary.assigned += 1;
        plan.summary.allocated += 1;
      }
    }

    const counterAfterDocument = await UserMemberNumberCounterModel.findOne({
      tenant: plan.tenantId,
      key: USER_MEMBER_NUMBER_COUNTER_KEY,
    })
      .select("value")
      .lean()
      .exec();
    plan.summary.counterAfter = validCounterValue(counterAfterDocument?.value);
  }

  return summarizePlans({ apply, refused: false, plans });
};
