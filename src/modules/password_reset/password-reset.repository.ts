import mongoose, {
  type ClientSession,
} from "mongoose";

import { PASSWORD_RESET_STATUS } from "./password-reset.constants.js";
import { PasswordReset } from "./password-reset.model.js";
import type { PasswordResetDocument } from "./password-reset.types.js";

const toObjectId = (
  value: string,
): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(value);

const withSession = <T extends {
  session(session: ClientSession): T;
}>(
  query: T,
  session?: ClientSession | null,
): T => (session ? query.session(session) : query);

const ACTIVE_STATUSES = [
  PASSWORD_RESET_STATUS.PENDING,
  PASSWORD_RESET_STATUS.VERIFIED,
] as const;

export const passwordResetRepository = {
  async invalidateActiveForUser(
    tenantId: string,
    userId: string,
    session?: ClientSession | null,
  ): Promise<void> {
    const query = PasswordReset.updateMany(
      {
        tenant: toObjectId(tenantId),
        user: toObjectId(userId),
        status: {
          $in: ACTIVE_STATUSES,
        },
      },
      {
        $set: {
          status: PASSWORD_RESET_STATUS.EXPIRED,
        },
        $unset: {
          resetTokenHash: 1,
        },
      },
    );

    await withSession(query, session).exec();
  },

  // Retained as a compatibility alias for older callers.
  async deletePendingForUser(
    tenantId: string,
    userId: string,
  ): Promise<void> {
    await this.invalidateActiveForUser(
      tenantId,
      userId,
    );
  },

  async create(input: {
    tenantId: string;
    userId: string;
    email: string;
    otpHash: string;
    expiresAt: Date;
  }): Promise<PasswordResetDocument> {
    return PasswordReset.create({
      tenant: toObjectId(input.tenantId),
      user: toObjectId(input.userId),
      email: input.email,
      otpHash: input.otpHash,
      expiresAt: input.expiresAt,
      status: PASSWORD_RESET_STATUS.PENDING,
    });
  },

  async findLatestPendingByEmail(
    tenantId: string,
    email: string,
  ): Promise<PasswordResetDocument | null> {
    return PasswordReset.findOne({
      tenant: toObjectId(tenantId),
      email,
      status: PASSWORD_RESET_STATUS.PENDING,
    })
      .select("+otpHash")
      .sort({ createdAt: -1 })
      .exec();
  },

  async incrementAttemptsIfPending(input: {
    tenantId: string;
    resetId: string;
    now: Date;
  }): Promise<boolean> {
    const result = await PasswordReset.updateOne(
      {
        _id: toObjectId(input.resetId),
        tenant: toObjectId(input.tenantId),
        status: PASSWORD_RESET_STATUS.PENDING,
        expiresAt: {
          $gt: input.now,
        },
        $expr: {
          $lt: ["$attempts", "$maxAttempts"],
        },
      },
      {
        $inc: {
          attempts: 1,
        },
      },
    ).exec();

    return result.modifiedCount === 1;
  },

  async verifyPending(input: {
    tenantId: string;
    resetId: string;
    resetTokenHash: string;
    resetTokenExpiresAt: Date;
    now: Date;
  }): Promise<PasswordResetDocument | null> {
    return PasswordReset.findOneAndUpdate(
      {
        _id: toObjectId(input.resetId),
        tenant: toObjectId(input.tenantId),
        status: PASSWORD_RESET_STATUS.PENDING,
        expiresAt: {
          $gt: input.now,
        },
        $expr: {
          $lt: ["$attempts", "$maxAttempts"],
        },
      },
      {
        $set: {
          status: PASSWORD_RESET_STATUS.VERIFIED,
          verifiedAt: input.now,
          resetTokenHash: input.resetTokenHash,
          resetTokenExpiresAt:
            input.resetTokenExpiresAt,
        },
      },
      {
        returnDocument: "after",
      },
    ).exec();
  },

  async expirePending(input: {
    tenantId: string;
    resetId: string;
  }): Promise<void> {
    await PasswordReset.updateOne(
      {
        _id: toObjectId(input.resetId),
        tenant: toObjectId(input.tenantId),
        status: PASSWORD_RESET_STATUS.PENDING,
      },
      {
        $set: {
          status: PASSWORD_RESET_STATUS.EXPIRED,
        },
      },
    ).exec();
  },

  async consumeVerified(input: {
    tenantId: string;
    resetTokenHash: string;
    now: Date;
    session?: ClientSession | null;
  }): Promise<PasswordResetDocument | null> {
    const query = PasswordReset.findOneAndUpdate(
      {
        tenant: toObjectId(input.tenantId),
        status: PASSWORD_RESET_STATUS.VERIFIED,
        resetTokenHash: input.resetTokenHash,
        resetTokenExpiresAt: {
          $gt: input.now,
        },
      },
      {
        $set: {
          status: PASSWORD_RESET_STATUS.USED,
          usedAt: input.now,
        },
        $unset: {
          resetTokenHash: 1,
        },
      },
      {
        returnDocument: "after",
      },
    ).select("+resetTokenHash");

    return withSession(
      query,
      input.session,
    ).exec();
  },

  // Compatibility helpers retained for isolated legacy consumers.
  async markVerified(id: string): Promise<void> {
    await PasswordReset.updateOne(
      {
        _id: toObjectId(id),
        status: PASSWORD_RESET_STATUS.PENDING,
      },
      {
        $set: {
          status: PASSWORD_RESET_STATUS.VERIFIED,
          verifiedAt: new Date(),
        },
      },
    ).exec();
  },

  async incrementAttempts(id: string): Promise<void> {
    await PasswordReset.updateOne(
      {
        _id: toObjectId(id),
        status: PASSWORD_RESET_STATUS.PENDING,
      },
      {
        $inc: {
          attempts: 1,
        },
      },
    ).exec();
  },

  async markUsed(id: string): Promise<void> {
    await PasswordReset.updateOne(
      {
        _id: toObjectId(id),
        status: PASSWORD_RESET_STATUS.VERIFIED,
      },
      {
        $set: {
          status: PASSWORD_RESET_STATUS.USED,
          usedAt: new Date(),
        },
      },
    ).exec();
  },
};
