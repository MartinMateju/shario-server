import mongoose, {
  type ClientSession,
} from "mongoose";

import {
  VERIFICATION_PURPOSE,
  VERIFICATION_STATUS,
} from "./user-verification.constants.js";
import { VerificationToken } from "./user-verification.model.js";
import type {
  IdLike,
  VerificationTokenDocument,
} from "./user-verification.types.js";

const toObjectId = (
  value: IdLike,
): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(
    String(value),
  );

const withSession = <T extends {
  session(session: ClientSession): T;
}>(
  query: T,
  session?: ClientSession | null,
): T => (session ? query.session(session) : query);

export const verificationRepository = {
  async deletePendingEmailTokens(
    tenantId: IdLike,
    userId: IdLike,
  ): Promise<void> {
    /*
     * Keep an audit trail while making every prior link unusable immediately.
     * The method name is retained for compatibility with the previous module.
     */
    await VerificationToken.updateMany(
      {
        tenant: toObjectId(
          tenantId,
        ),
        user: toObjectId(userId),
        purpose:
          VERIFICATION_PURPOSE.EMAIL_VERIFICATION,
        status:
          VERIFICATION_STATUS.PENDING,
      },
      {
        $set: {
          status:
            VERIFICATION_STATUS.EXPIRED,
          failedAt: new Date(),
          failureReason:
            "Superseded by a newer verification request.",
        },
      },
    ).exec();
  },

  async createEmailToken(input: {
    tenantId: IdLike;
    userId: IdLike;
    hashedToken: string;
    expiresAt: Date;
  }): Promise<VerificationTokenDocument> {
    return VerificationToken.create({
      tenant: toObjectId(
        input.tenantId,
      ),
      user: toObjectId(
        input.userId,
      ),
      purpose:
        VERIFICATION_PURPOSE.EMAIL_VERIFICATION,
      hashedToken:
        input.hashedToken,
      expiresAt: input.expiresAt,
      status:
        VERIFICATION_STATUS.PENDING,
    });
  },

  async consumePendingEmailToken(input: {
    tenantId: IdLike;
    hashedToken: string;
    now: Date;
    session?: ClientSession | null;
  }): Promise<VerificationTokenDocument | null> {
    const query =
      VerificationToken.findOneAndUpdate(
        {
          tenant: toObjectId(
            input.tenantId,
          ),
          purpose:
            VERIFICATION_PURPOSE.EMAIL_VERIFICATION,
          hashedToken:
            input.hashedToken,
          status:
            VERIFICATION_STATUS.PENDING,
          expiresAt: {
            $gt: input.now,
          },
        },
        {
          $set: {
            status:
              VERIFICATION_STATUS.VERIFIED,
            verifiedAt: input.now,
            failureReason: "",
          },
        },
        {
          returnDocument: "after",
        },
      );

    return withSession(
      query,
      input.session,
    ).exec();
  },

  // Compatibility helpers retained for isolated legacy callers.
  async findPendingEmailToken(
    tenantId: IdLike,
    userId: IdLike,
  ): Promise<VerificationTokenDocument | null> {
    return VerificationToken.findOne({
      tenant: toObjectId(
        tenantId,
      ),
      user: toObjectId(userId),
      purpose:
        VERIFICATION_PURPOSE.EMAIL_VERIFICATION,
      status:
        VERIFICATION_STATUS.PENDING,
    })
      .select("+hashedToken")
      .exec();
  },

  async markVerified(
    id: IdLike,
  ): Promise<void> {
    await VerificationToken.updateOne(
      {
        _id: toObjectId(id),
        status:
          VERIFICATION_STATUS.PENDING,
      },
      {
        $set: {
          status:
            VERIFICATION_STATUS.VERIFIED,
          verifiedAt: new Date(),
          failureReason: "",
        },
      },
    ).exec();
  },

  async markFailed(
    id: IdLike,
    reason: string,
  ): Promise<void> {
    await VerificationToken.updateOne(
      {
        _id: toObjectId(id),
        status:
          VERIFICATION_STATUS.PENDING,
      },
      {
        $set: {
          status:
            VERIFICATION_STATUS.FAILED,
          failedAt: new Date(),
          failureReason: reason,
        },
      },
    ).exec();
  },

  async markExpired(
    id: IdLike,
  ): Promise<void> {
    await VerificationToken.updateOne(
      {
        _id: toObjectId(id),
        status:
          VERIFICATION_STATUS.PENDING,
      },
      {
        $set: {
          status:
            VERIFICATION_STATUS.EXPIRED,
          failedAt: new Date(),
          failureReason:
            "Verification token expired.",
        },
      },
    ).exec();
  },
};
