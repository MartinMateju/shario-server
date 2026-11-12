import type { ClientSession } from "mongoose";

import User from "./user.model.js";
import { USER_SELECT_SAFE } from "./user.constants.js";
import type {
  CreateUserInput,
  IdLike,
  RepositoryContext,
  UserDocument,
  UserFilter,
  UserFindOptions,
} from "./user.types.js";
import { toObjectId } from "@/shared/helpers/helper.js";

type UserRepositoryOptions = RepositoryContext;

const applySession = <
  TQuery extends { session: (session: ClientSession) => TQuery },
>(
  query: TQuery,
  session: ClientSession | null,
): TQuery => (session ? query.session(session) : query);

export const createUserRepository = ({
  tenantId,
  session = null,
}: UserRepositoryOptions) => {
  if (!tenantId) throw new Error("UserRepository requires tenantId");

  const scope = (filter: UserFilter = {}): UserFilter => ({
    ...filter,
    tenant: tenantId,
  });

  return {
    scope,

    find(filter: UserFilter = {}, options: UserFindOptions = {}) {
      const query = User.find(scope(filter) as never);

      query.select(options.select ?? USER_SELECT_SAFE);

      if (options.sort) query.sort(options.sort);
      if (options.skip !== undefined) query.skip(options.skip);
      if (options.limit !== undefined) query.limit(options.limit);
      if (options.includePassword) query.select("+password");
      if (options.includeGuestContact) query.select("+guestContact");
      if (options.includePrivateRoles)
        query.select("+roles +platformRole +tenantRole");

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findOne(filter: UserFilter = {}, options: UserFindOptions = {}) {
      const query = User.findOne(scope(filter) as never);

      query.select(options.select ?? USER_SELECT_SAFE);

      if (options.includePassword) query.select("+password");
      if (options.includeGuestContact) query.select("+guestContact");
      if (options.includePrivateRoles)
        query.select("+roles +platformRole +tenantRole");

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findById(id: IdLike, options: UserFindOptions = {}) {
      return this.findOne({ _id: id }, options);
    },

    findByEmail(email: string, options: UserFindOptions = {}) {
      return this.findOne({ email }, options);
    },

    findDocumentById(id: IdLike, options: UserFindOptions = {}) {
      return this.findOne({ _id: id }, { ...options, lean: false });
    },

    async findByTenantAndEmailForPasswordReset(
      tenantId: string,
      email: string,
    ) {
      return User.findOne({
        tenant: toObjectId(tenantId),
        email,
      })
        .select("_id email")
        .exec();
    },

    async updatePasswordForTenantUser(input: {
      tenantId: string;
      userId: string;
      hashedPassword: string;
    }) {
      return User.updateOne(
        {
          _id: toObjectId(input.userId),
          tenant: toObjectId(input.tenantId),
        },
        {
          $set: {
            password: input.hashedPassword,
            refreshToken: [],
          },
          $inc: {
            sessionVersion: 1,
          },
        },
      ).exec();
    },

    count(filter: UserFilter = {}) {
      const query = User.countDocuments(scope(filter) as never);
      applySession(query, session);
      return query.exec();
    },

    create(input: CreateUserInput) {
      return User.create(
        [
          {
            ...input,
            tenant: tenantId,
          },
        ],
        session ? { session } : undefined,
      ).then(([user]) => user);
    },

    save(document: UserDocument) {
      if (!document.tenant) document.tenant = tenantId as never;
      return document.save(session ? { session } : undefined);
    },

    deleteById(id: IdLike) {
      const query = User.deleteOne(scope({ _id: id }) as never);
      applySession(query, session);
      return query.exec();
    },
  };
};

export type UserRepository = ReturnType<typeof createUserRepository>;
