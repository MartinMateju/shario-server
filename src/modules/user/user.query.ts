import mongoose from "mongoose";

import { TENANT_ROLE } from "./user.constants.js";
import { parseUserMemberNumber } from "./user-member-number.service.js";
import { escapeRegex } from "./user.utils.js";

export type UserFilterInput = {
  search?: string;
  customId?: string;
  memberNumber?: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  telephone?: string;
  tenantRole?: string;
};

export const buildUsersFilterQuery = (input: UserFilterInput) => {
  const filter: Record<string, unknown> = {};
  const andConditions: Record<string, unknown>[] = [];

  const tenantRole = String(input.tenantRole ?? "")
    .trim()
    .toLowerCase();

  if (
    tenantRole &&
    Object.values(TENANT_ROLE).includes(
      tenantRole as (typeof TENANT_ROLE)[keyof typeof TENANT_ROLE],
    )
  ) {
    filter.tenantRole = tenantRole;
  }

  const memberId = String(input.memberNumber ?? input.customId ?? "").trim();
  if (memberId) {
    const customIdMatch = {
      customId: {
        $regex: escapeRegex(memberId),
        $options: "i",
      },
    };
    const parsedMemberNumber = parseUserMemberNumber(memberId);

    if (
      parsedMemberNumber !== null &&
      Number.isSafeInteger(parsedMemberNumber) &&
      parsedMemberNumber > 0
    ) {
      andConditions.push({
        $or: [
          customIdMatch,
          { memberNumber: parsedMemberNumber },
          { "memberNumberHistory.number": parsedMemberNumber },
        ],
      });
    } else {
      filter.customId = {
        $regex: escapeRegex(memberId),
        $options: "i",
      };
    }
  }

  if (input.firstname?.trim()) {
    filter.firstname = {
      $regex: escapeRegex(input.firstname.trim()),
      $options: "i",
    };
  }

  if (input.lastname?.trim()) {
    filter.lastname = {
      $regex: escapeRegex(input.lastname.trim()),
      $options: "i",
    };
  }

  if (input.email?.trim()) {
    const emailMatch = {
      $regex: escapeRegex(input.email.trim().toLowerCase()), $options: "i",
    };
    andConditions.push({
      $or: [{ email: emailMatch }, { "guestContact.email": emailMatch }],
    });
  }

  if (input.telephone?.trim()) {
    filter.phone = {
      $regex: escapeRegex(input.telephone.trim()),
      $options: "i",
    };
  }

  if (input.search?.trim()) {
    const term = input.search.trim();
    const safe = escapeRegex(term);

    const orConditions: Record<string, unknown>[] = [
      { customId: { $regex: safe, $options: "i" } },
      { firstname: { $regex: safe, $options: "i" } },
      { lastname: { $regex: safe, $options: "i" } },
      { email: { $regex: safe, $options: "i" } },
      { "guestContact.email": { $regex: safe, $options: "i" } },
      { phone: { $regex: safe, $options: "i" } },
    ];

    const memberNumber = parseUserMemberNumber(term);
    if (memberNumber !== null) {
      orConditions.push(
        { memberNumber },
        { "memberNumberHistory.number": memberNumber },
      );
    }

    if (mongoose.Types.ObjectId.isValid(term)) {
      orConditions.push({ _id: new mongoose.Types.ObjectId(term) });
    }

    andConditions.push({ $or: orConditions });
  }

  if (andConditions.length > 0) filter.$and = andConditions;

  return filter;
};

export const buildUsersSortQuery = (
  sortBy = "createdAt",
  sortOrder = "desc",
): Record<string, 1 | -1> => {
  const direction = sortOrder === "asc" ? 1 : -1;

  const sort: Record<string, 1 | -1> = {};

  switch (sortBy) {
    case "customId":
    case "memberNumber":
      sort.memberNumber = direction;
      break;

    case "firstname":
    case "lastname":
    case "email":
    case "createdAt":
      sort[sortBy] = direction;
      break;

    case "credits":
      sort.moneyCredits = direction;
      break;

    default:
      sort.createdAt = -1;
      break;
  }

  sort._id = -1;

  return sort;
};
