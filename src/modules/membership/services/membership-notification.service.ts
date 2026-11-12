import { randomUUID } from "node:crypto";
import type mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import { sendManagedTenantEmail as sendEmail } from "@/infrastructure/email/managed-email.service.js";
import UserModel from "@/modules/user/user.model.js";
import { publishCustomerMembershipNotification } from "@/modules/customer-notifications/index.js";
import MembershipNotificationModel from "../membership-notification.schema.js";

const templates = {
  activated: {
    subject: "Your membership is active",
    message:
      "Your membership payment was confirmed and your benefits are ready.",
  },
  renewed: {
    subject: "Your membership renewed",
    message:
      "Your latest membership payment was confirmed and your new-period benefits are ready.",
  },
  assigned: {
    subject: "Your membership is active",
    message: "Your studio has assigned a membership to your account.",
  },
  payment_failed: {
    subject: "Membership payment needs attention",
    message:
      "We could not collect your latest membership payment. Please update your billing details.",
  },
  cancellation_scheduled: {
    subject: "Membership cancellation scheduled",
    message:
      "Your membership will remain available until the end of the current period.",
  },
  cancelled: {
    subject: "Membership cancelled",
    message: "Your membership has been cancelled.",
  },
  resumed: {
    subject: "Membership cancellation removed",
    message: "Your membership will continue renewing.",
  },
} satisfies Record<string, { subject: string; message: string }>;

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

export type MembershipNotificationIntent = {
  tenantId: string;
  userId: string;
  membershipId: string;
  type: keyof typeof templates;
  intentKey: string;
  session?: mongoose.ClientSession;
};

export const enqueueMembershipNotification = async (
  input: MembershipNotificationIntent,
): Promise<void> => {
  let userQuery = UserModel.findOne({
    _id: input.userId,
    tenant: input.tenantId,
  })
    .select("email firstname")
    .lean();
  if (input.session) userQuery = userQuery.session(input.session);
  const user = await userQuery.exec();
  await publishCustomerMembershipNotification({
    tenantId: input.tenantId,
    recipientUserId: input.userId,
    membershipId: input.membershipId,
    type: input.type,
    deduplicationKey: `membership:${input.intentKey}`,
    session: input.session,
  });
  if (!user?.email) return;
  const template = templates[input.type];
  const name = escapeHtml(String(user.firstname || "").trim());
  const html = `<p>${name ? `Hello ${name},` : "Hello,"}</p><p>${template.message}</p>`;
  await MembershipNotificationModel.updateOne(
    { intentKey: input.intentKey },
    {
      $setOnInsert: {
        tenant: input.tenantId,
        user: input.userId,
        membership: input.membershipId,
        intentKey: input.intentKey,
        type: input.type,
        recipient: user.email,
        subject: template.subject,
        html,
        status: "pending",
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, ...(input.session ? { session: input.session } : {}) },
  ).exec();
};

export const enqueueMembershipNotificationSafely = async (
  input: Parameters<typeof enqueueMembershipNotification>[0],
): Promise<void> => {
  try {
    await enqueueMembershipNotification(input);
  } catch (error) {
    logger.error(
      { err: error, membershipId: input.membershipId, type: input.type },
      "Failed to enqueue membership notification.",
    );
  }
};

export const processMembershipNotificationOutbox = async (
  limit = 25,
): Promise<number> => {
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const token = randomUUID();
    const notification = await MembershipNotificationModel.findOneAndUpdate(
      {
        $or: [
          {
            status: { $in: ["pending", "failed"] },
            nextAttemptAt: { $lte: now },
          },
          { status: "sending", claimExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "sending",
          claimToken: token,
          claimExpiresAt: new Date(now.getTime() + 5 * 60_000),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after", sort: { nextAttemptAt: 1, createdAt: 1 } },
    ).exec();
    if (!notification) break;
    try {
      await sendEmail({
        tenantId: String(notification.tenant),
        to: notification.recipient,
        subject: notification.subject,
        html: notification.html,
      });
      await MembershipNotificationModel.updateOne(
        { _id: notification._id, status: "sending", claimToken: token },
        {
          $set: {
            status: "sent",
            sentAt: new Date(),
            claimToken: "",
            claimExpiresAt: null,
            lastError: "",
          },
        },
      ).exec();
    } catch (error) {
      const delayMinutes = Math.min(
        60,
        2 ** Math.min(notification.attempts, 6),
      );
      await MembershipNotificationModel.updateOne(
        { _id: notification._id, status: "sending", claimToken: token },
        {
          $set: {
            status: "failed",
            claimToken: "",
            claimExpiresAt: null,
            nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
            lastError: String(
              error instanceof Error ? error.message : error,
            ).slice(0, 2000),
          },
        },
      ).exec();
    }
    processed += 1;
  }
  return processed;
};
