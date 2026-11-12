import type { ClientSession } from "mongoose";

import UserModel from "@/modules/user/user.model.js";
import {
  getRefreshTokenStorageCandidates,
  hashRefreshTokenForStorage,
} from "@/modules/auth/auth.utils.js";
import { REFRESH_TOKEN_SESSION_LIMIT } from "@/modules/auth/auth.constants.js";
import type {
  IdLike,
  RepositoryContext,
  UserDocument,
} from "@/modules/user/user.types.js";

type AuthRepositoryOptions = RepositoryContext;

type UserWithPassword = UserDocument & {
  password: string;
};

type UserWithRefreshTokens = UserDocument & {
  refreshToken: string[];
};

const existingRefreshTokens = {
  $ifNull: ["$refreshToken", []],
};

const withoutRefreshTokens = (
  input: Record<string, unknown>,
  excludedTokens: string[],
) => ({
  $filter: {
    input,
    as: "token",
    cond: {
      $not: [
        {
          $in: ["$$token", excludedTokens],
        },
      ],
    },
  },
});

const appendBoundedRefreshToken = (
  input: Record<string, unknown>,
  storedRefreshToken: string,
) => ({
  $slice: [
    {
      $concatArrays: [input, [storedRefreshToken]],
    },
    -REFRESH_TOKEN_SESSION_LIMIT,
  ],
});

export const createAuthRepository = ({
  tenantId,
  session = null,
}: AuthRepositoryOptions) => {
  if (!tenantId) {
    throw new Error("AuthRepository requires tenantId");
  }

  const scope = (filter: Record<string, unknown> = {}) => ({
    ...filter,
    tenant: tenantId,
  });

  const applySession = <
    TQuery extends {
      session: (session: ClientSession) => TQuery;
    },
  >(
    query: TQuery,
  ): TQuery => {
    return session ? query.session(session) : query;
  };

  return {
    scope,

    findByEmailWithSecrets(email: string): Promise<UserWithPassword | null> {
      const query = UserModel.findOne(scope({ email })).select(
        ["+password", "+tenantRole", "+platformRole", "+sessionVersion"].join(
          " ",
        ),
      );

      applySession(query);

      return query.exec() as Promise<UserWithPassword | null>;
    },

    findByRefreshTokenWithSecrets(
      refreshToken: string,
    ): Promise<UserWithRefreshTokens | null> {
      const query = UserModel.findOne(
        scope({
          refreshToken: {
            $in: getRefreshTokenStorageCandidates(refreshToken),
          },
        }),
      ).select(
        [
          "+refreshToken",
          "+tenantRole",
          "+platformRole",
          "+sessionVersion",
        ].join(" "),
      );

      applySession(query);

      return query.exec() as Promise<UserWithRefreshTokens | null>;
    },

    addRefreshTokenToUser({
      userId,
      refreshToken,
    }: {
      userId: IdLike;
      refreshToken: string;
    }): Promise<void> {
      const storedRefreshToken = hashRefreshTokenForStorage(refreshToken);
      const excludedTokens = getRefreshTokenStorageCandidates(refreshToken);

      const query = UserModel.updateOne(
        scope({ _id: userId }),
        [
          {
            $set: {
              refreshToken: appendBoundedRefreshToken(
                withoutRefreshTokens(existingRefreshTokens, excludedTokens),
                storedRefreshToken,
              ),
              lastLoginAt: "$$NOW",
            },
          },
        ],
        {
          updatePipeline: true,
        },
      );

      applySession(query);

      return query.exec().then(() => undefined);
    },

    removeRefreshTokenFromUser(refreshToken: string): Promise<void> {
      const storedCandidates = getRefreshTokenStorageCandidates(refreshToken);

      const query = UserModel.updateOne(
        scope({
          refreshToken: {
            $in: storedCandidates,
          },
        }),
        {
          $pull: {
            refreshToken: {
              $in: storedCandidates,
            },
          },
        },
      );

      applySession(query);

      return query.exec().then(() => undefined);
    },

    rotateRefreshToken({
      userId,
      oldRefreshToken,
      newRefreshToken,
    }: {
      userId: IdLike;
      oldRefreshToken?: string;
      newRefreshToken: string;
    }): Promise<void> {
      const storedNewRefreshToken = hashRefreshTokenForStorage(newRefreshToken);
      const excludedTokens = [
        ...getRefreshTokenStorageCandidates(newRefreshToken),
        ...(oldRefreshToken
          ? getRefreshTokenStorageCandidates(oldRefreshToken)
          : []),
      ];

      const query = UserModel.updateOne(
        scope({ _id: userId }),
        [
          {
            $set: {
              refreshToken: appendBoundedRefreshToken(
                withoutRefreshTokens(existingRefreshTokens, excludedTokens),
                storedNewRefreshToken,
              ),
              lastLoginAt: "$$NOW",
            },
          },
        ],
        {
          updatePipeline: true,
        },
      );

      applySession(query);

      return query.exec().then(() => undefined);
    },

    /**
     * Consumes exactly one stored refresh token and replaces it with exactly
     * one successor. Including the old token in the update predicate closes
     * the race where two concurrent refresh requests both pass an earlier
     * read and create two valid successor sessions.
     */
    compareAndSwapRefreshToken({
      userId,
      oldRefreshToken,
      newRefreshToken,
    }: {
      userId: IdLike;
      oldRefreshToken: string;
      newRefreshToken: string;
    }): Promise<boolean> {
      const oldStoredCandidates =
        getRefreshTokenStorageCandidates(oldRefreshToken);
      const storedNewRefreshToken = hashRefreshTokenForStorage(newRefreshToken);
      const excludedTokens = [
        ...oldStoredCandidates,
        ...getRefreshTokenStorageCandidates(newRefreshToken),
      ];

      const query = UserModel.updateOne(
        scope({
          _id: userId,
          refreshToken: {
            $in: oldStoredCandidates,
          },
        }),
        [
          {
            $set: {
              refreshToken: appendBoundedRefreshToken(
                withoutRefreshTokens(existingRefreshTokens, excludedTokens),
                storedNewRefreshToken,
              ),
              lastLoginAt: "$$NOW",
            },
          },
        ],
        {
          updatePipeline: true,
        },
      );

      applySession(query);

      return query.exec().then((result) => result.modifiedCount === 1);
    },

    createTenantUser(input: Record<string, unknown>): Promise<UserDocument> {
      const user = new UserModel({
        ...input,
        tenant: tenantId,
      });

      return user
        .save(session ? { session } : undefined)
        .then((savedUser) => savedUser as UserDocument);
    },
  };
};

export type AuthRepository = ReturnType<typeof createAuthRepository>;
