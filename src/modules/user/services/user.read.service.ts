import { notFound } from "../../../shared/http/httpErrors.js";
import { buildUsersFilterQuery, buildUsersSortQuery } from "../user.query.js";
import { createUserRepository } from "@/modules/user/user.repository.js";
import { normalizeEmail } from "../user.utils.js";
import { PLATFORM_ROLE, TENANT_ROLE } from "../user.constants.js";
import { serializeCustomer } from "../user.serializers.js";
import { withWorkspaceContact, type ContactUser } from "../user.guest-contact.js";
import {
  ensureUserMemberNumber,
  ensureUserMemberNumbers,
} from "../user-member-number.assignment.service.js";
import { parseUserMemberNumber } from "../user-member-number.service.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import { withCustomerDirectoryMetrics } from "./user.directory-metrics.service.js";

export type ListUsersWithFiltersInput = {
  search?: string;
  customId?: string;
  memberNumber?: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  telephone?: string;
  tenantRole?: string;
  page?: number | string;
  limit?: number | string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
};

const withEnsuredMemberNumbers = async <T extends Record<string, any> & ContactUser>({
  tenantId,
  users,
}: {
  tenantId: string;
  users: T[];
}) => {
  const numbers = await ensureUserMemberNumbers({
    tenantId,
    userIds: users.map((user) => user._id).filter(Boolean),
  });

  return users.map((user) => {
    const assigned = numbers.get(String(user._id));
    return assigned === undefined || assigned === null
      ? withWorkspaceContact(user)
      : withWorkspaceContact({ ...user, memberNumber: assigned });
  });
};

// A safety ceiling, not a real page size: this endpoint predates
// listUsersWithFilters (the paginated GET /users/filter) and still returns
// a bare array, so callers built against it aren't expecting an envelope.
// The cap only protects against an unbounded response for a tenant whose
// customer count has grown past what any legitimate caller needs in one
// shot; anything requiring real pagination should use listUsersWithFilters.
const LIST_USERS_SAFETY_LIMIT = 2000;

const customerAccountFilter = () => ({
  tenantRole: TENANT_ROLE.CUSTOMER,
  platformRole: { $in: [PLATFORM_ROLE.NONE, null] },
});

export const listUsers = async ({
  tenantId,
  tenantRole,
  access,
}: {
  tenantId: string;
  tenantRole?: typeof TENANT_ROLE.CUSTOMER;
  access?: ResolvedWorkspaceAccess | null;
}) => {
  const users = await createUserRepository({ tenantId }).find(
    tenantRole === TENANT_ROLE.CUSTOMER ? customerAccountFilter() : {},
    {
      sort: { createdAt: -1 },
      limit: LIST_USERS_SAFETY_LIMIT,
      includeGuestContact: true,
    },
  );

  const numberedUsers = await withEnsuredMemberNumbers({ tenantId, users: users as any[] });
  return withCustomerDirectoryMetrics({ tenantId, users: numberedUsers, access });
};

export const getCustomerById = async ({
  tenantId,
  customerId,
}: {
  tenantId: string;
  customerId: string;
}) => {
  await ensureUserMemberNumber({ tenantId, userId: customerId });

  const customer = await createUserRepository({ tenantId }).findOne(
    {
      _id: customerId,
      ...customerAccountFilter(),
    },
    { includeGuestContact: true },
  );

  if (!customer) {
    notFound({
      message: "Customer not found.",
      code: "CUSTOMER_NOT_FOUND",
    });
  }

  return serializeCustomer(customer);
};

export const getUserByCustomIdOrContact = async ({
  tenantId,
  value,
}: {
  tenantId: string;
  value: string;
}) => {
  const repository = createUserRepository({ tenantId });

  const values = value.includes(",")
    ? value.replace(/\s+/g, "").split(",").filter(Boolean)
    : [value];

  const memberNumbers = values
    .map(parseUserMemberNumber)
    .filter((candidate): candidate is number => candidate !== null);

  let users = await repository.find({
    $or: [
      { customId: { $in: values } },
      ...(memberNumbers.length > 0
        ? [
            { memberNumber: { $in: memberNumbers } },
            { "memberNumberHistory.number": { $in: memberNumbers } },
          ]
        : []),
    ],
  }, { includeGuestContact: true });

  if (!users.length) {
    users = await repository.find(
      {
        $or: [
          { email: normalizeEmail(value) },
          { "guestContact.email": normalizeEmail(value), isAccessGranted: false },
        ],
      },
      { includeGuestContact: true },
    );
  }

  if (!users.length) {
    users = await repository.find({
      phone: { $regex: value, $options: "i" },
    }, { includeGuestContact: true });
  }

  if (!users.length) {
    notFound("No users found");
  }

  return withEnsuredMemberNumbers({ tenantId, users: users as any[] });
};

export const listUsersWithFilters = async ({
  tenantId,
  input,
  access,
}: {
  tenantId: string;
  input: ListUsersWithFiltersInput;
  access?: ResolvedWorkspaceAccess | null;
}) => {
  const pageNumber = Math.max(Number(input.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
  const skip = (pageNumber - 1) * pageSize;

  const filter = buildUsersFilterQuery(input);
  const sort = buildUsersSortQuery(input.sortBy, input.sortOrder);

  const repository = createUserRepository({ tenantId });

  const [users, totalCount] = await Promise.all([
    repository.find(filter, {
      sort,
      skip,
      limit: pageSize,
      includeGuestContact: true,
    }),
    repository.count(filter),
  ]);
  const numberedUsers = await withEnsuredMemberNumbers({
    tenantId,
    users: users as any[],
  });

  return {
    data: await withCustomerDirectoryMetrics({ tenantId, users: numberedUsers, access }),
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
    currentPage: pageNumber,
    pageSize,
    sortBy: input.sortBy ?? "createdAt",
    sortOrder: input.sortOrder ?? "desc",
  };
};

export const lookupUser = async ({
  tenantId,
  search,
}: {
  tenantId: string;
  search: string;
}) => {
  const repository = createUserRepository({ tenantId });
  const parsedMemberNumber = parseUserMemberNumber(search);

  // A transferred number can still equal its former owner's immutable
  // numeric customId. Resolve the canonical current owner before consulting
  // any legacy identity so an exact #N lookup is deterministic.
  let user =
    parsedMemberNumber === null
      ? null
      : await repository.findOne(
          { memberNumber: parsedMemberNumber },
          { includeGuestContact: true },
        );

  if (!user) {
    user = await repository.findOne({
      $or: [
        { email: normalizeEmail(search) },
        { customId: search },
        { firstname: { $regex: search, $options: "i" } },
        { lastname: { $regex: search, $options: "i" } },
      ],
    }, { includeGuestContact: true });
  }

  if (!user && parsedMemberNumber !== null) {
    user = await repository.findOne({
      "memberNumberHistory.number": parsedMemberNumber,
    }, { includeGuestContact: true });
  }

  if (!user) {
    notFound("Uživatel nebyl nalezen.");
  }

  const memberNumber = await ensureUserMemberNumber({
    tenantId,
    userId: user._id,
  });
  return withWorkspaceContact(
    memberNumber === null ? user : { ...user, memberNumber },
  );
};
