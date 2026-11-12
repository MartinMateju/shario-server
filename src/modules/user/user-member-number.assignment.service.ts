import mongoose, { type ClientSession, type Types } from "mongoose";

import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";

import { LEGACY_ROLE, TENANT_ROLE } from "./user.constants.js";
import {
  allocateUserMemberNumber,
  assertUserMemberNumberAllocationEpoch,
  withUserMemberNumberAllocationEpoch,
  readUserMemberNumberAllocationEpoch,
  ensureUserMemberNumberCounterAtLeast,
  isInactiveGeneratedGuest,
  isValidUserMemberNumber,
  USER_MEMBER_NUMBER_HISTORY_REASON,
  type UserMemberNumberHistoryReason,
} from "./user-member-number.service.js";
import UserModel from "./user.model.js";
import { tenantMemberNumberHighWaterMark } from "./user-member-number-high-water.js";

type IdLike = string | Types.ObjectId;

type MemberNumberHistoryRecord = {
  number: number;
  replacedAt: Date;
  reason: UserMemberNumberHistoryReason;
  importSession: Types.ObjectId | null;
  changedBy: Types.ObjectId | null;
};

type MemberNumberRecord = {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  customId?: string;
  memberNumber?: number;
  memberNumberHistory?: MemberNumberHistoryRecord[];
  importMetadata?: { rolledBackAt?: Date | null };
  isAccessGranted?: boolean;
  tenantRole?: string;
  roles?: string[];
  updatedAt?: Date;
};

export class UserMemberNumberTransitionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "UserMemberNumberTransitionError";
    this.code = code;
  }
}

const toObjectId = (value: IdLike, label: string): Types.ObjectId => {
  const candidate = String(value ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(candidate)) {
    throw new UserMemberNumberTransitionError(
      `${label} must be a valid object ID.`,
      "MEMBER_NUMBER_ID_INVALID",
    );
  }
  return new mongoose.Types.ObjectId(candidate);
};

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    Number((error as { code?: unknown }).code) === 11000,
  );

const selectTransitionRecord = async ({
  tenantId,
  userId,
  session,
}: {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  session: ClientSession | null;
}): Promise<MemberNumberRecord | null> =>
  UserModel.findOne({ _id: userId, tenant: tenantId })
    .select(
      "_id tenant customId memberNumber updatedAt isAccessGranted +tenantRole +roles +memberNumberHistory",
    )
    .session(session)
    .lean()
    .exec() as unknown as Promise<MemberNumberRecord | null>;

const assertImportTransitionCustomer = async ({
  user,
  session,
}: {
  user: MemberNumberRecord;
  session: ClientSession | null;
}): Promise<void> => {
  const protectedLegacyRole = (user.roles ?? []).some(
    (role) => role === LEGACY_ROLE.ADMIN || role === LEGACY_ROLE.MODERATOR,
  );
  const workspaceMembership = await TenantMembershipModel.exists({
    tenant: user.tenant,
    user: user._id,
  }).session(session);

  if (
    (user.tenantRole !== undefined &&
      user.tenantRole !== TENANT_ROLE.CUSTOMER) ||
    protectedLegacyRole ||
    workspaceMembership
  ) {
    throw new UserMemberNumberTransitionError(
      "Workspace team accounts cannot be renumbered by a customer import.",
      "MEMBER_NUMBER_TEAM_ACCOUNT_PROTECTED",
    );
  }
};

/**
 * The only supported mutation seam for an already assigned pottery ID.
 *
 * It deliberately uses an update CAS with validators after validating the
 * complete payload, because the ordinary document save hook rejects
 * reassignment. Customer imports must first move any current owner out of the
 * requested number, then call this helper for the imported customer.
 */
export const transitionUserMemberNumber = async ({
  tenantId: tenantIdInput,
  userId: userIdInput,
  nextMemberNumber,
  expectedMemberNumber,
  reason,
  importSessionId,
  changedBy,
  session = null,
  expectedEpoch,
}: {
  tenantId: IdLike;
  userId: IdLike;
  nextMemberNumber: number;
  expectedMemberNumber: number | null;
  reason: UserMemberNumberHistoryReason;
  importSessionId?: IdLike | null;
  changedBy?: IdLike | null;
  session?: ClientSession | null;
  expectedEpoch?: number;
}): Promise<{
  beforeRecord: MemberNumberRecord;
  afterRecord: MemberNumberRecord;
}> => {
  if (!isValidUserMemberNumber(nextMemberNumber)) {
    throw new UserMemberNumberTransitionError(
      "Next member number must be a positive safe integer.",
      "MEMBER_NUMBER_INVALID",
    );
  }
  if (
    expectedMemberNumber !== null &&
    !isValidUserMemberNumber(expectedMemberNumber)
  ) {
    throw new UserMemberNumberTransitionError(
      "Expected member number must be null or a positive safe integer.",
      "MEMBER_NUMBER_EXPECTATION_INVALID",
    );
  }
  if (!Object.values(USER_MEMBER_NUMBER_HISTORY_REASON).includes(reason)) {
    throw new UserMemberNumberTransitionError(
      "Member-number transition reason is invalid.",
      "MEMBER_NUMBER_REASON_INVALID",
    );
  }

  const tenantId = toObjectId(tenantIdInput, "Tenant ID");
  const userId = toObjectId(userIdInput, "User ID");
  const importSession = importSessionId
    ? toObjectId(importSessionId, "Import session ID")
    : null;
  const actor = changedBy ? toObjectId(changedBy, "Changed-by user ID") : null;
  const allocationEpoch =
    expectedEpoch ??
    (await readUserMemberNumberAllocationEpoch({ tenantId, session }));
  const beforeRecord = await selectTransitionRecord({
    tenantId,
    userId,
    session,
  });

  if (!beforeRecord) {
    throw new UserMemberNumberTransitionError(
      "Customer was not found for member-number transition.",
      "MEMBER_NUMBER_USER_NOT_FOUND",
    );
  }
  await assertImportTransitionCustomer({ user: beforeRecord, session });

  const persistedMemberNumber = isValidUserMemberNumber(
    beforeRecord.memberNumber,
  )
    ? beforeRecord.memberNumber
    : null;
  if (persistedMemberNumber !== expectedMemberNumber) {
    throw new UserMemberNumberTransitionError(
      "Customer member number changed before the transition could be applied.",
      "MEMBER_NUMBER_CAS_MISSED",
    );
  }
  if (persistedMemberNumber === nextMemberNumber) {
    return { beforeRecord, afterRecord: beforeRecord };
  }

  await ensureUserMemberNumberCounterAtLeast({
    tenantId,
    minimum: nextMemberNumber,
    session,
    expectedEpoch: allocationEpoch,
  });

  await assertUserMemberNumberAllocationEpoch({
    tenantId,
    session,
    expectedEpoch: allocationEpoch,
  });

  const replacedAt = new Date();
  const result = await UserModel.updateOne(
    {
      _id: userId,
      tenant: tenantId,
      ...(expectedMemberNumber === null
        ? { memberNumber: null }
        : { memberNumber: expectedMemberNumber }),
    },
    {
      $set: {
        memberNumber: nextMemberNumber,
        updatedAt: replacedAt,
      },
      ...(expectedMemberNumber === null
        ? {}
        : {
            $push: {
              memberNumberHistory: {
                number: expectedMemberNumber,
                replacedAt,
                reason,
                importSession,
                changedBy: actor,
              },
            },
          }),
    },
    {
      runValidators: true,
      ...(session ? { session } : {}),
    },
  ).exec();

  if (result.modifiedCount !== 1) {
    throw new UserMemberNumberTransitionError(
      "Customer member number changed before the transition could be applied.",
      "MEMBER_NUMBER_CAS_MISSED",
    );
  }

  const afterRecord = await selectTransitionRecord({
    tenantId,
    userId,
    session,
  });
  if (!afterRecord) {
    throw new UserMemberNumberTransitionError(
      "Customer disappeared after member-number transition.",
      "MEMBER_NUMBER_USER_NOT_FOUND",
    );
  }

  return { beforeRecord, afterRecord };
};

const numericLegacyCustomId = (value: unknown): number | null => {
  const candidate = String(value ?? "").trim();
  if (!/^\d+$/.test(candidate)) return null;
  const memberNumber = Number(candidate);
  return isValidUserMemberNumber(memberNumber) ? memberNumber : null;
};

const legacyCandidateIsUnambiguous = async ({
  tenantId,
  userId,
  candidate,
  session,
}: {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  candidate: number;
  session: ClientSession | null;
}): Promise<boolean> => {
  const memberOwner = await UserModel.collection.findOne(
    {
      _id: { $ne: userId },
      tenant: tenantId,
      $or: [
        { memberNumber: candidate },
        { "memberNumberHistory.number": candidate },
      ],
    },
    {
      projection: { _id: 1 },
      ...(session ? { session } : {}),
    },
  );
  const legacyOwners = await UserModel.collection
    .aggregate(
      [
        {
          $match: {
            _id: { $ne: userId },
            tenant: tenantId,
            customId: { $type: "string", $regex: /^\d+$/ },
          },
        },
        {
          $project: {
            numericCustomId: {
              $convert: {
                input: "$customId",
                to: "double",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
        { $match: { numericCustomId: candidate } },
        { $limit: 1 },
      ],
      { ...(session ? { session } : {}) },
    )
    .toArray();

  return !memberOwner && legacyOwners.length === 0;
};

const currentMemberNumber = async ({
  tenantId,
  userId,
  session,
}: {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  session: ClientSession | null;
}): Promise<number | null> => {
  const current = await UserModel.findOne({ _id: userId, tenant: tenantId })
    .select("memberNumber")
    .session(session)
    .lean()
    .exec();
  return isValidUserMemberNumber(current?.memberNumber)
    ? current.memberNumber
    : null;
};

const assignInitialMemberNumber = async ({
  tenantId,
  user,
  preferredMemberNumber,
  session,
  expectedEpoch,
}: {
  tenantId: Types.ObjectId;
  user: MemberNumberRecord;
  preferredMemberNumber: number | null;
  session: ClientSession | null;
  expectedEpoch: number;
}): Promise<number | null> => {
  let memberNumber = preferredMemberNumber;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (memberNumber === null) {
      memberNumber = await allocateUserMemberNumber({
        tenantId,
        session,
        expectedEpoch,
      });
    }

    await assertUserMemberNumberAllocationEpoch({
      tenantId,
      session,
      expectedEpoch,
    });
    try {
      const result = await UserModel.collection.updateOne(
        {
          _id: user._id,
          tenant: tenantId,
          memberNumber: null,
          "importMetadata.rolledBackAt": null,
        },
        {
          $set: {
            memberNumber,
            updatedAt: new Date(),
          },
        },
        { ...(session ? { session } : {}) },
      );

      if (result.modifiedCount === 1) return memberNumber;
      return currentMemberNumber({ tenantId, userId: user._id, session });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      memberNumber = null;
    }
  }

  throw new UserMemberNumberTransitionError(
    "A unique member number could not be assigned.",
    "MEMBER_NUMBER_ALLOCATION_FAILED",
  );
};

/**
 * Lazily initializes additive member numbers for records created before the
 * rollout. It is safe to call repeatedly and concurrently. Anonymous inactive
 * checkout placeholders deliberately remain unnumbered until claimed.
 */
export const ensureUserMemberNumbers = async ({
  tenantId: tenantIdInput,
  userIds,
  session = null,
}: {
  tenantId: IdLike;
  userIds: readonly IdLike[];
  session?: ClientSession | null;
}): Promise<Map<string, number | null>> => {
  const tenantId = toObjectId(tenantIdInput, "Tenant ID");
  const ids = [
    ...new Map(
      userIds.map((value) => {
        const id = toObjectId(value, "User ID");
        return [id.toHexString(), id] as const;
      }),
    ).values(),
  ];
  if (ids.length === 0) return new Map();

  const users = (await UserModel.find({
    _id: { $in: ids },
    tenant: tenantId,
  })
    .select("_id tenant customId memberNumber isAccessGranted +importMetadata")
    .session(session)
    .lean()
    .exec()) as unknown as MemberNumberRecord[];
  const result = new Map<string, number | null>();
  const missingRealUsers = users.filter((user) => {
    const key = String(user._id);
    if (isValidUserMemberNumber(user.memberNumber)) {
      result.set(key, user.memberNumber);
      return false;
    }
    if (isInactiveGeneratedGuest(user)) {
      result.set(key, null);
      return false;
    }
    if (user.importMetadata?.rolledBackAt) {
      result.set(key, null);
      return false;
    }
    return true;
  });

  if (missingRealUsers.length === 0) return result;

  return withUserMemberNumberAllocationEpoch(
    { tenantId, session },
    async (expectedEpoch) => {
      const highWaterMark = await tenantMemberNumberHighWaterMark({
        collection: UserModel.collection,
        tenantId,
        session,
      });
      await ensureUserMemberNumberCounterAtLeast({
        tenantId,
        minimum: highWaterMark,
        session,
        expectedEpoch,
      });

      for (const user of missingRealUsers) {
        const legacyCandidate = numericLegacyCustomId(user.customId);
        const preferredMemberNumber =
          legacyCandidate !== null &&
          (await legacyCandidateIsUnambiguous({
            tenantId,
            userId: user._id,
            candidate: legacyCandidate,
            session,
          }))
            ? legacyCandidate
            : null;
        const assigned = await assignInitialMemberNumber({
          tenantId,
          user,
          preferredMemberNumber,
          session,
          expectedEpoch,
        });
        result.set(String(user._id), assigned);
      }

      return result;
    },
  );
};

export const ensureUserMemberNumber = async ({
  tenantId,
  userId,
  session = null,
}: {
  tenantId: IdLike;
  userId: IdLike;
  session?: ClientSession | null;
}): Promise<number | null> => {
  const numbers = await ensureUserMemberNumbers({
    tenantId,
    userIds: [userId],
    session,
  });
  return numbers.get(String(userId)) ?? null;
};
