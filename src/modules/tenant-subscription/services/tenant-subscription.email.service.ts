import { createHash } from "node:crypto";

import { logger } from "@/config/logger.js";
import { sendEmail } from "@/infrastructure/email/nodemailer.client.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import {
  resolveRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import {
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
} from "@/modules/tenant-access/tenant-access.constants.js";

import {
  TENANT_TRIAL_REMINDER_DAYS,
} from "../tenant-subscription.email.constants.js";
import { getTrialEndingBillingEmailIntent } from "../tenant-subscription.email-intent.js";
import {
  claimNextTenantBillingEmailDelivery,
  enqueueTenantBillingEmailDelivery,
  markTenantBillingEmailFailed,
  markTenantBillingEmailSent,
} from "../tenant-subscription.email.repository.js";
import { buildTenantBillingEmail } from "../tenant-subscription.email.templates.js";
import type {
  TenantBillingEmailIntent,
  TenantBillingEmailLocale,
} from "../tenant-subscription.email.types.js";
import { findTenantTrialsEndingBetween } from "../tenant-subscription.repository.js";
import type { TenantSubscriptionDocument } from "../tenant-subscription.types.js";
import { getTenantBillingUrl } from "../tenant-subscription.urls.js";

const isTenantBillingEmailEnabled = (): boolean =>
  process.env.TENANT_BILLING_EMAILS_ENABLED?.trim().toLowerCase() === "true";

const getMessageId = (deliveryKey: string): string => {
  const digest = createHash("sha256").update(deliveryKey).digest("hex");
  const senderDomain = process.env.EMAIL_USER?.split("@")[1] || "shario.io";

  return `<tenant-billing-${digest}@${senderDomain}>`;
};

export const enqueueTenantBillingEmail = async ({
  subscription,
  intent,
}: {
  subscription: TenantSubscriptionDocument;
  intent: TenantBillingEmailIntent;
}): Promise<boolean> => {
  if (!isTenantBillingEmailEnabled()) return false;

  const tenantId = String(subscription.tenant);
  const tenant = await getTenantOrThrow(tenantId);
  const ownerMembership = await TenantMembershipModel.findOne({
    tenant: tenantId,
    status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
    role: WORKSPACE_ROLE.OWNER,
  })
    .sort({ createdAt: 1, _id: 1 })
    .populate({
      path: "user",
      select: "firstname lastname email",
    })
    .lean()
    .exec();
  const owner =
    ownerMembership?.user && typeof ownerMembership.user === "object"
      ? ownerMembership.user as unknown as {
          firstname?: string;
          lastname?: string;
          email?: string;
        }
      : null;

  if (!owner?.email) {
    logger.warn(
      { tenantId, billingEmailType: intent.type },
      "Tenant billing email skipped because no owner email was found.",
    );
    return false;
  }

  const locale: TenantBillingEmailLocale = resolveRolloutEligibleAppLocale(
    tenant.settings.adminLanguage ?? tenant.settings.defaultLanguage,
  );
  const recipientName =
    [owner.firstname, owner.lastname].filter(Boolean).join(" ").trim() ||
    owner.email;

  await enqueueTenantBillingEmailDelivery({
    deliveryKey: intent.deliveryKey,
    tenantId,
    type: intent.type,
    priority: intent.priority,
    recipient: String(owner.email).trim().toLowerCase(),
    locale,
    payload: {
      recipientName,
      tenantName: tenant.name,
      billingUrl: getTenantBillingUrl({ tenantSlug: tenant.slug, locale }),
      timezone: tenant.settings.timezone || "UTC",
      trialEndsAt: subscription.trialEndsAt?.toISOString(),
      graceEndsAt: subscription.graceEndsAt?.toISOString(),
      nextPaymentAttemptAt: subscription.nextPaymentAttemptAt?.toISOString(),
      attemptCount: subscription.paymentRetryCount ?? 0,
    },
  });

  return true;
};

export const enqueueUpcomingTenantTrialEndingEmails = async (): Promise<{
  matched: number;
  enqueued: number;
}> => {
  if (!isTenantBillingEmailEnabled()) return { matched: 0, enqueued: 0 };

  const now = new Date();
  const reminderCutoff = new Date(
    now.getTime() + TENANT_TRIAL_REMINDER_DAYS * 24 * 60 * 60 * 1000,
  );
  const subscriptions = await findTenantTrialsEndingBetween({
    startsAfter: now,
    endsBefore: reminderCutoff,
  });
  let enqueued = 0;

  for (const subscription of subscriptions) {
    if (!subscription.trialEndsAt) continue;

    const queued = await enqueueTenantBillingEmail({
      subscription,
      intent: getTrialEndingBillingEmailIntent({
        subscriptionId: String(subscription._id),
        trialEndsAt: subscription.trialEndsAt,
      }),
    });

    if (queued) enqueued += 1;
  }

  return { matched: subscriptions.length, enqueued };
};

export const processTenantBillingEmailOutbox = async ({
  limit = 20,
}: {
  limit?: number;
} = {}): Promise<{ sent: number; failed: number }> => {
  if (!isTenantBillingEmailEnabled()) return { sent: 0, failed: 0 };

  const batchLimit = Math.min(Math.max(limit, 1), 100);
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < batchLimit; index += 1) {
    const delivery = await claimNextTenantBillingEmailDelivery();

    if (!delivery) break;

    try {
      const content = buildTenantBillingEmail({
        type: delivery.type,
        locale: delivery.locale,
        payload: delivery.payload,
      });
      const result = await sendEmail({
        to: delivery.recipient,
        subject: content.subject,
        text: content.text,
        html: content.html,
        messageId: getMessageId(delivery.deliveryKey),
        ...(process.env.EMAIL_REPLY_TO?.trim()
          ? { replyTo: process.env.EMAIL_REPLY_TO.trim() }
          : {}),
        headers: {
          "X-Shario-Notification": delivery.type,
        },
      });

      await markTenantBillingEmailSent(String(delivery._id), result.messageId);
      sent += 1;

      logger.info(
        {
          tenantId: String(delivery.tenant),
          billingEmailType: delivery.type,
          attempts: delivery.attempts,
        },
        "Tenant billing email sent.",
      );
    } catch (error) {
      await markTenantBillingEmailFailed(delivery, error);
      failed += 1;

      logger.warn(
        {
          err: error,
          tenantId: String(delivery.tenant),
          billingEmailType: delivery.type,
          attempts: delivery.attempts,
        },
        "Tenant billing email delivery failed and was rescheduled.",
      );
    }
  }

  return { sent, failed };
};
