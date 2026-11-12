import { createHash } from "node:crypto";

import mongoose from "mongoose";
import { CLASS_BOOKING_TAGS } from "@/modules/booking/booking.constants.js";
import { hasActiveOrderAttendance } from "@/modules/booking/booking.attendance-read.js";

import { enqueueCommunicationEmail } from "@/infrastructure/queues/communication-email.queue.js";
import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import {
  CommunicationConsentModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import { isCommunicationAllowed } from "@/modules/communications/services/consent.service.js";
import EmailTemplate from "@/modules/email-template/email-template.model.js";
import {
  normalizeEmailLocale,
  selectLocalizedEmailContent,
} from "@/modules/email-template/email-template.rendering.js";
import UserModel from "@/modules/user/user.model.js";
import { getBookingAutomationSourceAnchor } from "./communication-automation-schedule.service.js";

type ResolvedRecipient = {
  userId?: string;
  email: string;
  name: string;
  locale: "cs" | "en";
  allowed: boolean;
  reason: string;
};

const normalizeEmail = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase();

const fullName = (user: Record<string, any>): string =>
  [user.firstname || user.firstName, user.lastname || user.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

const getId = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value || "");
};

const deduplicateRecipients = (recipients: ResolvedRecipient[]) => {
  const byEmail = new Map<string, ResolvedRecipient>();
  for (const recipient of recipients) {
    if (recipient.email && !byEmail.has(recipient.email)) {
      byEmail.set(recipient.email, recipient);
    }
  }
  return [...byEmail.values()];
};

const applyDeliveryPolicy = async (
  tenantId: string,
  recipients: ResolvedRecipient[],
  purpose: "transactional" | "marketing",
): Promise<ResolvedRecipient[]> => {
  const userIds = recipients
    .map((recipient) => recipient.userId)
    .filter(Boolean);
  const emails = recipients.map((recipient) => recipient.email);
  const [consents, suppressions] = await Promise.all([
    userIds.length
      ? CommunicationConsentModel.find({
          tenantId,
          customerId: { $in: userIds },
          channel: "email",
          purpose,
        }).lean()
      : [],
    CommunicationSuppressionModel.find({
      tenantId,
      channel: "email",
      identity: { $in: emails },
      active: true,
    }).lean(),
  ]);
  const consentByUser = new Map(
    consents.map((consent: any) => [String(consent.customerId), consent]),
  );
  const suppressed = new Set(
    suppressions.map((item: any) => normalizeEmail(item.identity)),
  );

  return recipients.map((recipient) => {
    const decision = isCommunicationAllowed({
      channel: "email",
      purpose,
      consent: recipient.userId ? consentByUser.get(recipient.userId) : null,
      suppressed: suppressed.has(recipient.email),
    });
    return { ...recipient, allowed: decision.allowed, reason: decision.reason };
  });
};

export const resolveAutomationRecipients = async ({
  tenantId,
  automation,
  booking,
  sourceRecipientUserId,
  sourceLocale,
  sourceOrderId,
}: {
  tenantId: string;
  automation: Record<string, any>;
  booking?: Record<string, any> | null;
  sourceRecipientUserId?: unknown;
  sourceLocale?: unknown;
  sourceOrderId?: unknown;
}): Promise<ResolvedRecipient[]> => {
  const purpose =
    automation.purpose === "marketing" ? "marketing" : "transactional";
  if (booking) {
    const bookingRecipients: ResolvedRecipient[] = [];
    for (const order of Array.isArray(booking.orders) ? booking.orders : []) {
      if (sourceOrderId && getId(order) !== getId(sourceOrderId)) continue;
      if (
        ["beforeBooking", "beforePurchase"].includes(
          String(automation.scheduleType),
        ) &&
        (CLASS_BOOKING_TAGS as readonly string[]).includes(String(booking.tag)) &&
        !hasActiveOrderAttendance(booking, getId(order))
      )
        continue;
      const user = order?.createdBy;
      if (
        order?.isPaid !== true ||
        !user ||
        typeof user !== "object" ||
        !user._id ||
        !user.email ||
        (user.tenant && String(user.tenant) !== tenantId) ||
        (user.tenantRole && user.tenantRole !== "customer") ||
        user.isAccessGranted === false
      ) {
        continue;
      }
      bookingRecipients.push({
        userId: String(user._id),
        email: normalizeEmail(user.email),
        name: fullName(user),
        locale: normalizeEmailLocale(
          booking.language || automation.defaultLocale,
        ),
        allowed: true,
        reason: "paid_booking_purchaser",
      });
    }
    const uniquePurchasers = deduplicateRecipients(bookingRecipients);
    if (uniquePurchasers.length) {
      return applyDeliveryPolicy(tenantId, uniquePurchasers, purpose);
    }
    if (sourceOrderId || (CLASS_BOOKING_TAGS as readonly string[]).includes(booking.tag)) {
      return [];
    }
  }
  const derivedRecipientId = sourceRecipientUserId || booking?.createdBy;
  if (derivedRecipientId) {
    const user = await UserModel.findOne({
      _id: derivedRecipientId,
      tenant: tenantId,
      tenantRole: "customer",
      isAccessGranted: { $ne: false },
    })
      .select("firstname lastname email customId +tenantRole isAccessGranted")
      .lean();
    if (!user?.email) return [];
    return applyDeliveryPolicy(
      tenantId,
      [
        {
          userId: String(user._id),
          email: normalizeEmail(user.email),
          name: fullName(user as any),
          locale: normalizeEmailLocale(
            sourceLocale || booking?.language || automation.defaultLocale,
          ),
          allowed: true,
          reason: "not_evaluated",
        },
      ],
      purpose,
    );
  }

  if (automation.sendToAllRecipients) {
    const users = await UserModel.find({
      tenant: tenantId,
      tenantRole: "customer",
      isAccessGranted: { $ne: false },
      email: { $exists: true, $ne: "" },
    })
      .select("firstname lastname email customId")
      .sort({ _id: 1 })
      .limit(10_001)
      .lean();
    if (users.length > 10_000) {
      throw new Error(
        "Automation audience exceeds 10,000 recipients; split the audience into smaller segments.",
      );
    }
    const recipients = users.map((user: any) => ({
      userId: String(user._id),
      email: normalizeEmail(user.email),
      name: fullName(user),
      locale: normalizeEmailLocale(automation.defaultLocale),
      allowed: true,
      reason: "not_evaluated",
    }));
    return applyDeliveryPolicy(
      tenantId,
      deduplicateRecipients(recipients),
      purpose,
    );
  }

  const definitions = Array.isArray(automation.recipients)
    ? automation.recipients
    : [];
  const userIds = definitions
    .map((item: any) => getId(item.user))
    .filter(Boolean);
  const customIds = definitions
    .map((item: any) => String(item.customId || ""))
    .filter(Boolean);
  const emails = definitions
    .map((item: any) => normalizeEmail(item.email))
    .filter(Boolean);
  const users =
    userIds.length || customIds.length || emails.length
      ? await UserModel.find({
          tenant: tenantId,
          tenantRole: "customer",
          isAccessGranted: { $ne: false },
          email: { $exists: true, $ne: "" },
          $or: [
            ...(userIds.length ? [{ _id: { $in: userIds } }] : []),
            ...(customIds.length ? [{ customId: { $in: customIds } }] : []),
            ...(emails.length ? [{ email: { $in: emails } }] : []),
          ],
        })
          .select("firstname lastname email customId")
          .lean()
      : [];
  const byId = new Map<string, Record<string, any>>(
    (users as any[]).map((user: any) => [String(user._id), user]),
  );
  const byCustomId = new Map<string, Record<string, any>>(
    (users as any[]).map((user: any) => [String(user.customId || ""), user]),
  );
  const byEmail = new Map<string, Record<string, any>>(
    (users as any[]).map((user: any) => [normalizeEmail(user.email), user]),
  );
  const resolved = definitions.map((definition: any) => {
    const definitionUserId = getId(definition.user);
    const definitionCustomId = String(definition.customId || "");
    const user = definitionUserId
      ? byId.get(definitionUserId)
      : definitionCustomId
        ? byCustomId.get(definitionCustomId)
        : byEmail.get(normalizeEmail(definition.email));
    const unresolvedIdentity = Boolean(
      !user && (definitionUserId || definitionCustomId),
    );
    return {
      userId: user ? String(user._id) : undefined,
      email: unresolvedIdentity
        ? ""
        : normalizeEmail(user ? user.email : definition.email),
      name: String(user ? fullName(user) : definition.name || "").trim(),
      locale: normalizeEmailLocale(
        definition.locale || automation.defaultLocale,
      ),
      allowed: true,
      reason: "explicit_recipient",
    } as ResolvedRecipient;
  });
  const unique = deduplicateRecipients(resolved);
  return applyDeliveryPolicy(tenantId, unique, purpose);
};

const resolveContentSource = async (
  tenantId: string,
  automation: Record<string, any>,
): Promise<Record<string, any>> => {
  const templateId = getId(automation.templateId);
  if (!templateId || !mongoose.Types.ObjectId.isValid(templateId))
    return automation;

  const template = await EmailTemplate.findOne({
    _id: templateId,
    tenant: tenantId,
    isActive: true,
  }).lean();
  if (!template)
    throw new Error("Selected email template is missing or inactive.");

  const wrap = (content: unknown) =>
    [template.headerHtml, content, template.footerHtml]
      .filter(Boolean)
      .join("\n");
  const templateVariants = Object.fromEntries(
    Object.entries((template as any).contentVariants || {}).map(
      ([locale, variant]: [string, any]) => [
        locale,
        {
          ...variant,
          htmlContent: wrap(variant?.htmlContent || variant?.body || ""),
        },
      ],
    ),
  );
  const automationVariants = automation.contentVariants || {};
  const hasInlineContentOverride = Boolean(
    String(automation.htmlContent || automation.body || "").trim() ||
      Object.values(automationVariants).some((variant: any) =>
        String(variant?.htmlContent || variant?.body || "").trim(),
      ),
  );
  const hasInlineMessageOverride = Boolean(
    hasInlineContentOverride ||
      String(automation.subject || "").trim() ||
      Object.values(automationVariants).some((variant: any) =>
        String(variant?.subject || "").trim(),
      ),
  );
  const contentVariants = Object.fromEntries(
    [
      ...new Set([
        ...Object.keys(templateVariants),
        ...Object.keys(automationVariants),
      ]),
    ].map((locale) => {
      const base = (templateVariants as any)[locale] || {};
      const override = automationVariants[locale] || {};
      return [
        locale,
        {
          ...base,
          ...override,
          htmlContent: override.htmlContent
            ? wrap(override.htmlContent)
            : base.htmlContent,
        },
      ];
    }),
  );
  return {
    ...template,
    subject: automation.subject || template.subject,
    htmlContent: wrap(automation.htmlContent || template.htmlContent),
    body: automation.body || template.body,
    format: hasInlineContentOverride
      ? automation.format || template.format
      : template.format,
    contentVariants,
    defaultLocale: hasInlineMessageOverride
      ? automation.defaultLocale || template.defaultLocale
      : template.defaultLocale,
  };
};

export type AutomationDeliverySource = {
  entity: Record<string, any>;
  entityType: "booking" | "pottery-piece" | "user";
  recipientUserId?: unknown;
  locale?: unknown;
  scheduledAt?: Date;
  orderId?: unknown;
};

export const buildAutomationDeliveryKey = (parts: unknown[]): string =>
  createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex");

export const materializeAutomationDeliveries = async ({
  tenantId,
  automation,
  scheduledFor,
  occurrenceKey,
  booking = null,
  source = null,
}: {
  tenantId: string;
  automation: Record<string, any>;
  scheduledFor: Date;
  occurrenceKey: string;
  booking?: Record<string, any> | null;
  source?: AutomationDeliverySource | null;
}): Promise<{ queued: number; suppressed: number; existing: number }> => {
  if (automation.purpose === "marketing") {
    throw new Error(
      "Marketing automation delivery is disabled until unsubscribe management is enabled.",
    );
  }
  const normalizedSource: AutomationDeliverySource | null =
    source ||
    (booking
      ? {
          entity: booking,
          entityType: "booking",
          recipientUserId: booking.createdBy,
          locale: booking.language,
          scheduledAt: getBookingAutomationSourceAnchor(
            { scheduleType: String(automation.scheduleType) },
            booking,
          ) ?? undefined,
        }
      : null);
  const contentSource = await resolveContentSource(tenantId, automation);
  const recipients = await resolveAutomationRecipients({
    tenantId,
    automation: {
      ...automation,
      defaultLocale: contentSource.defaultLocale || automation.defaultLocale,
    },
    booking,
    sourceRecipientUserId: normalizedSource?.recipientUserId,
    sourceLocale: normalizedSource?.locale,
    sourceOrderId: normalizedSource?.orderId,
  });
  const purpose =
    automation.purpose === "marketing" ? "marketing" : "transactional";
  const result = { queued: 0, suppressed: 0, existing: 0 };

  for (const recipient of recipients) {
    if (!recipient.email) continue;
    const selected = selectLocalizedEmailContent(
      contentSource,
      recipient.locale,
    );
    const deduplicationKey = buildAutomationDeliveryKey([
      tenantId,
      automation._id,
      occurrenceKey,
      recipient.userId
        ? `user:${recipient.userId}`
        : `email:${recipient.email}`,
    ]);
    const { log, created } =
      await communicationEmailLogRepository.upsertScheduled({
        tenant: new mongoose.Types.ObjectId(tenantId),
        automation: new mongoose.Types.ObjectId(String(automation._id)),
        user: recipient.userId
          ? new mongoose.Types.ObjectId(recipient.userId)
          : null,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        subject: selected.subject,
        htmlContent: selected.htmlContent,
        body: selected.body,
        contentFormat: selected.format,
        emailType: automation.scheduleType,
        status: recipient.allowed ? "scheduled" : "suppressed",
        scheduledFor,
        location: automation.location
          ? new mongoose.Types.ObjectId(getId(automation.location))
          : null,
        appliesToAllLocations: Boolean(automation.appliesToAllLocations),
        relatedEntityId: normalizedSource?.entity?._id
          ? new mongoose.Types.ObjectId(String(normalizedSource.entity._id))
          : null,
        relatedEntityType:
          normalizedSource?.entityType || "automation-occurrence",
        senderEmail: automation.senderEmail
          ? new mongoose.Types.ObjectId(getId(automation.senderEmail))
          : null,
        deduplicationKey,
        occurrenceKey,
        locale: selected.locale,
        purpose,
        sourceScheduledAt: normalizedSource?.scheduledAt || scheduledFor,
        sourceOrderId: normalizedSource?.orderId
          ? new mongoose.Types.ObjectId(getId(normalizedSource.orderId))
          : null,
        cancelReason: recipient.allowed ? "" : recipient.reason,
        canceledAt: recipient.allowed ? null : new Date(),
      } as any);

    if (!recipient.allowed) {
      result.suppressed += created ? 1 : 0;
      continue;
    }
    if (
      !created &&
      [
        "sent",
        "sending",
        "queued",
        "scheduled",
        "ambiguous",
        "canceled",
        "suppressed",
      ].includes(String(log.status))
    ) {
      result.existing += 1;
      continue;
    }

    const enqueued = await enqueueCommunicationEmail(
      {
        tenantId,
        emailLogId: String(log._id),
        automationId: String(automation._id),
        ...(recipient.userId ? { userId: recipient.userId } : {}),
        ...(normalizedSource?.entity?._id
          ? { relatedEntityId: String(normalizedSource.entity._id) }
          : {}),
      },
      deduplicationKey,
    );
    if (!enqueued.queueAccepted) {
      if (["completed", "unknown"].includes(String(enqueued.state))) {
        await communicationEmailLogRepository.markQueueStateAmbiguous(
          tenantId,
          String(log._id),
          String(enqueued.state),
        );
      }
      result.existing += 1;
      continue;
    }
    await communicationEmailLogRepository.markQueued(tenantId, String(log._id));
    if (enqueued.newlyQueued) result.queued += 1;
    else result.existing += 1;
  }

  return result;
};
