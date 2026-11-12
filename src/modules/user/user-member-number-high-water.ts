import type { ClientSession, Collection, Types } from "mongoose";

import { isValidUserMemberNumber } from "./user-member-number.service.js";

/** A historical numeric alias remains usable for lookup, but no longer sets
 * the allocation floor once its own recorded transition proves retirement. */
export const activeNumericLegacyMemberNumber = (user: {
  customId?: unknown;
  memberNumber?: unknown;
  memberNumberHistory?: { number?: unknown }[];
}): number | null => {
  if (typeof user.customId !== "string" || !/^\d+$/.test(user.customId))
    return null;
  const legacyNumber = Number(user.customId);
  if (!isValidUserMemberNumber(legacyNumber)) return null;
  if (
    isValidUserMemberNumber(user.memberNumber) &&
    user.memberNumber !== legacyNumber &&
    user.memberNumberHistory?.some((entry) => entry.number === legacyNumber)
  ) {
    return null;
  }
  return legacyNumber;
};

export const tenantMemberNumberHighWaterMark = async ({
  collection,
  tenantId,
  session = null,
}: {
  collection: Pick<Collection, "findOne" | "aggregate">;
  tenantId: Types.ObjectId;
  session?: ClientSession | null;
}): Promise<number> => {
  const readNumberedUser = () =>
    collection.findOne(
      { tenant: tenantId, memberNumber: { $type: "number", $gte: 1 } },
      {
        projection: { memberNumber: 1 },
        sort: { memberNumber: -1 },
        ...(session ? { session } : {}),
      },
    );
  const readNumericLegacyUsers = () =>
    collection
      .aggregate(
        [
          {
            $match: {
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
              currentMemberNumber: {
                $cond: [{ $isNumber: "$memberNumber" }, "$memberNumber", 0],
              },
              historicalNumbers: {
                $cond: [
                  { $isArray: "$memberNumberHistory" },
                  "$memberNumberHistory.number",
                  [],
                ],
              },
            },
          },
          {
            $match: {
              numericCustomId: { $gte: 1, $lte: Number.MAX_SAFE_INTEGER },
            },
          },
          {
            $match: {
              $expr: {
                $not: [
                  {
                    $and: [
                      { $gt: ["$currentMemberNumber", 0] },
                      {
                        $lte: ["$currentMemberNumber", Number.MAX_SAFE_INTEGER],
                      },
                      {
                        $eq: [
                          "$currentMemberNumber",
                          { $trunc: "$currentMemberNumber" },
                        ],
                      },
                      { $ne: ["$currentMemberNumber", "$numericCustomId"] },
                      { $in: ["$numericCustomId", "$historicalNumbers"] },
                    ],
                  },
                ],
              },
            },
          },
          { $sort: { numericCustomId: -1 } },
          { $limit: 1 },
        ],
        { ...(session ? { session } : {}) },
      )
      .toArray();
  const [numberedUser, numericLegacyUsers] = session?.inTransaction()
    ? [await readNumberedUser(), await readNumericLegacyUsers()]
    : await Promise.all([readNumberedUser(), readNumericLegacyUsers()]);
  const memberHigh = Number(
    (numberedUser as { memberNumber?: unknown } | null)?.memberNumber,
  );
  const legacyHigh = Number(numericLegacyUsers[0]?.numericCustomId);
  return Math.max(
    isValidUserMemberNumber(memberHigh) ? memberHigh : 0,
    isValidUserMemberNumber(legacyHigh) ? legacyHigh : 0,
  );
};
