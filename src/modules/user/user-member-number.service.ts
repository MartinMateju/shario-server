import mongoose, { type ClientSession } from "mongoose";

import UserMemberNumberCounterModel from "./user-member-number-counter.model.js";

export const USER_MEMBER_NUMBER_COUNTER_KEY = "member-number";

export const USER_MEMBER_NUMBER_HISTORY_REASON = {
  CUSTOMER_IMPORT_CONFLICT: "customer_import_conflict",
  CUSTOMER_IMPORT_ASSIGNMENT: "customer_import_assignment",
  MEMBER_NUMBER_REPAIR: "member_number_repair",
} as const;

export type UserMemberNumberHistoryReason =
  (typeof USER_MEMBER_NUMBER_HISTORY_REASON)[keyof typeof USER_MEMBER_NUMBER_HISTORY_REASON];

export const isValidUserMemberNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Parses the public pottery-ID representation. `234` and `#234` are aliases,
 * while padded values such as `0234` remain distinct legacy custom IDs and
 * must never silently resolve to member number 234.
 */
export const parseUserMemberNumber = (value: unknown): number | null => {
  const candidate = String(value ?? "").trim();
  const match = candidate.match(/^#?([1-9]\d*)$/);
  if (!match) return null;

  const memberNumber = Number(match[1]);
  return isValidUserMemberNumber(memberNumber) ? memberNumber : null;
};

export const formatUserMemberNumber = (value: unknown): string | null => {
  const memberNumber = isValidUserMemberNumber(value)
    ? value
    : parseUserMemberNumber(value);
  return memberNumber === null ? null : `#${memberNumber}`;
};

export const getPreferredUserMemberIdentifier = (user: {
  customId?: unknown;
  memberNumber?: unknown;
}): string =>
  isValidUserMemberNumber(user.memberNumber)
    ? String(user.memberNumber)
    : String(user.customId ?? "").trim();

/**
 * Compares public member-number aliases without normalizing legacy IDs. This
 * makes `#234` and `234` equivalent but deliberately keeps `0234` distinct.
 */
export const areUserMemberIdentifiersEquivalent = (
  left: unknown,
  right: unknown,
): boolean => {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  if (!leftText || !rightText) return false;
  if (leftText.toLowerCase() === rightText.toLowerCase()) return true;

  const leftNumber = parseUserMemberNumber(leftText);
  const rightNumber = parseUserMemberNumber(rightText);
  return (
    leftNumber !== null && rightNumber !== null && leftNumber === rightNumber
  );
};

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    Number((error as { code?: unknown }).code) === 11000,
  );

const normalizeCounterFloor = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "Member-number counter floor must be a non-negative safe integer.",
    );
  }

  return value;
};

const counterFilter = (tenantId: mongoose.Types.ObjectId | string) => {
  const candidate = String(tenantId).trim();
  if (!mongoose.Types.ObjectId.isValid(candidate)) {
    throw new Error("Member-number allocation requires a valid tenant ID.");
  }

  const canonicalTenantId = new mongoose.Types.ObjectId(candidate);
  return {
    _id: `${USER_MEMBER_NUMBER_COUNTER_KEY}:${canonicalTenantId.toHexString()}`,
    tenant: canonicalTenantId,
    key: USER_MEMBER_NUMBER_COUNTER_KEY,
  };
};

type AllocationContext = {
  tenantId: mongoose.Types.ObjectId | string;
  session?: ClientSession | null;
};

export class UserMemberNumberAllocationPausedError extends Error {
  readonly code = "MEMBER_NUMBER_ALLOCATION_PAUSED";
  readonly statusCode = 503;
  readonly status = "fail";
  readonly isOperational = true;

  constructor() {
    super(
      "Member-number allocation is temporarily paused. Please try again shortly.",
    );
    this.name = "UserMemberNumberAllocationPausedError";
  }
}

export class UserMemberNumberAllocationEpochChangedError extends Error {
  readonly code = "MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED";
  readonly statusCode = 503;
  readonly status = "fail";
  readonly isOperational = true;

  constructor() {
    super(
      "Member-number allocation changed. Please retry with current member data.",
    );
    this.name = "UserMemberNumberAllocationEpochChangedError";
  }
}

/** Capture this BEFORE reading any automatically inferred allocation floor. */
export const readUserMemberNumberAllocationEpoch = async ({
  tenantId,
  session = null,
}: AllocationContext): Promise<number> => {
  const counter = await UserMemberNumberCounterModel.findOne(
    counterFilter(tenantId),
  )
    .select("allocationEpoch allocationPausedUntil repairLock")
    .session(session)
    .lean()
    .exec();
  if (
    counter?.repairLock != null ||
    (counter?.allocationPausedUntil &&
      new Date(counter.allocationPausedUntil).getTime() > Date.now())
  ) {
    throw new UserMemberNumberAllocationPausedError();
  }
  return normalizeCounterFloor(counter?.allocationEpoch ?? 0);
};

const allocationFilter = (
  tenantId: AllocationContext["tenantId"],
  expectedEpoch: number,
) => ({
  ...counterFilter(tenantId),
  $and: [
    expectedEpoch === 0
      ? {
          $or: [
            { allocationEpoch: 0 },
            { allocationEpoch: { $exists: false } },
          ],
        }
      : { allocationEpoch: expectedEpoch },
    { repairLock: null },
    {
      $or: [
        { allocationPausedUntil: null },
        { allocationPausedUntil: { $lte: new Date() } },
      ],
    },
  ],
});

const throwAllocationGuardFailure = async (
  context: AllocationContext,
): Promise<never> => {
  // Distinguish the repair barrier from an epoch change; a barrier must not
  // spin through retries while an operator is draining outstanding saves.
  await readUserMemberNumberAllocationEpoch(context);
  throw new UserMemberNumberAllocationEpochChangedError();
};

export const assertUserMemberNumberAllocationEpoch = async ({
  expectedEpoch,
  ...context
}: AllocationContext & { expectedEpoch: number }): Promise<void> => {
  if ((await readUserMemberNumberAllocationEpoch(context)) !== expectedEpoch) {
    throw new UserMemberNumberAllocationEpochChangedError();
  }
};

/** Re-run the entire floor read after repair, never just the stale $max. */
export const withUserMemberNumberAllocationEpoch = async <T>(
  context: AllocationContext,
  operation: (expectedEpoch: number) => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const expectedEpoch = await readUserMemberNumberAllocationEpoch(context);
    try {
      return await operation(expectedEpoch);
    } catch (error) {
      if (
        !(error instanceof UserMemberNumberAllocationEpochChangedError) ||
        context.session?.inTransaction() ||
        attempt === 3
      ) {
        throw error;
      }
    }
  }
  throw new UserMemberNumberAllocationEpochChangedError();
};

/**
 * Raises a counter within one allocation epoch. Callers with a computed floor
 * must pass the epoch captured before reading that floor. An omitted epoch is
 * reserved for explicit requested/imported numbers, not cached database data.
 */
export const ensureUserMemberNumberCounterAtLeast = async ({
  tenantId,
  minimum = 0,
  session = null,
  expectedEpoch,
}: {
  tenantId: mongoose.Types.ObjectId | string;
  minimum?: number;
  session?: ClientSession | null;
  expectedEpoch?: number;
}): Promise<void> => {
  const floor = normalizeCounterFloor(minimum);
  const epoch =
    expectedEpoch === undefined
      ? await readUserMemberNumberAllocationEpoch({ tenantId, session })
      : normalizeCounterFloor(expectedEpoch);
  const filter = allocationFilter(tenantId, epoch);

  const existing = await UserMemberNumberCounterModel.updateOne(
    filter,
    { $max: { value: floor } },
    { runValidators: true, ...(session ? { session } : {}) },
  ).exec();
  if (existing.matchedCount === 1) return;

  // Check before a possible insert so an active barrier produces a retryable
  // error instead of a duplicate-key error that aborts a transaction.
  await assertUserMemberNumberAllocationEpoch({
    tenantId,
    session,
    expectedEpoch: epoch,
  });

  try {
    const result = await UserMemberNumberCounterModel.updateOne(
      filter,
      {
        $setOnInsert: { ...counterFilter(tenantId), allocationEpoch: epoch },
        $max: { value: floor },
      },
      {
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: false,
        ...(session ? { session } : {}),
      },
    ).exec();
    if (result.matchedCount !== 1 && result.upsertedCount !== 1) {
      await throwAllocationGuardFailure({ tenantId, session });
    }
  } catch (error) {
    if (!isDuplicateKeyError(error) || session) throw error;

    // Two tenants can never share this document. A duplicate here only means
    // another request won the first-upsert race, so repair the winner.
    const result = await UserMemberNumberCounterModel.updateOne(
      filter,
      { $max: { value: floor } },
      {
        runValidators: true,
        ...(session ? { session } : {}),
      },
    ).exec();
    if (result.matchedCount !== 1) {
      await throwAllocationGuardFailure({ tenantId, session });
    }
  }
};

/**
 * Allocates a monotonically increasing tenant-scoped number. Gaps are allowed
 * after failed non-transactional writes; allocated values are never recycled.
 */
export const allocateUserMemberNumber = async ({
  tenantId,
  minimum = 0,
  session = null,
  expectedEpoch,
}: {
  tenantId: mongoose.Types.ObjectId | string;
  minimum?: number;
  session?: ClientSession | null;
  expectedEpoch?: number;
}): Promise<number> => {
  const epoch =
    expectedEpoch === undefined
      ? await readUserMemberNumberAllocationEpoch({ tenantId, session })
      : normalizeCounterFloor(expectedEpoch);
  await ensureUserMemberNumberCounterAtLeast({
    tenantId,
    minimum,
    session,
    expectedEpoch: epoch,
  });

  for (let attempt = 0; attempt < 128; attempt += 1) {
    const counter = await UserMemberNumberCounterModel.findOneAndUpdate(
      allocationFilter(tenantId, epoch),
      { $inc: { value: 1 } },
      {
        returnDocument: "after",
        includeResultMetadata: false,
        runValidators: true,
        ...(session ? { session } : {}),
      },
    ).exec();

    if (!counter) {
      await throwAllocationGuardFailure({ tenantId, session });
    }

    const memberNumber = Number(counter?.value);
    if (!Number.isSafeInteger(memberNumber) || memberNumber < 1) {
      throw new Error("Member-number allocation failed.");
    }

    // Retired numbers no longer raise the floor, but still identify physical
    // pottery. Consume them if the sequence eventually reaches them rather
    // than assigning the historical mark to somebody else. Use the raw
    // collection here to avoid the User schema's allocator import cycle.
    const historicalOwner = await mongoose.connection
      .collection("users")
      .findOne(
        {
          tenant: counterFilter(tenantId).tenant,
          "memberNumberHistory.number": memberNumber,
        },
        { projection: { _id: 1 }, ...(session ? { session } : {}) },
      );
    if (!historicalOwner) return memberNumber;
  }

  throw Object.assign(
    new Error(
      "Member-number allocation encountered too many reserved historical IDs. Please retry.",
    ),
    {
      code: "MEMBER_NUMBER_RESERVED_RANGE_LIMIT",
      statusCode: 503,
      isOperational: true,
    },
  );
};

export const isInactiveGeneratedGuest = (user: {
  customId?: unknown;
  isAccessGranted?: unknown;
}): boolean =>
  user.isAccessGranted === false &&
  /^G-[a-f0-9]{20}$/i.test(String(user.customId ?? ""));

/**
 * Confirms the exact code a person read or wrote. Numeric lookup may parse the
 * value to locate a user, but it must never silently accept a differently
 * formatted physical mark such as `0234` for member number `234`.
 */
export const matchesUserMemberIdentifier = (
  user: {
    customId?: unknown;
    memberNumber?: unknown;
    memberNumberHistory?: { number?: unknown }[];
  },
  value: unknown,
): boolean => {
  const candidate = String(value ?? "").trim();
  if (!candidate) return false;

  const parsedMemberNumber = parseUserMemberNumber(candidate);
  if (
    parsedMemberNumber !== null &&
    (user.memberNumber === parsedMemberNumber ||
      user.memberNumberHistory?.some(
        (entry) => entry.number === parsedMemberNumber,
      ))
  ) {
    return true;
  }

  return String(user.customId ?? "").trim() === candidate;
};
