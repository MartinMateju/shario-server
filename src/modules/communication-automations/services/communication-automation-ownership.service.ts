import CommunicationAutomationModel from "@/modules/communication-automations/communication-automation.model.js";
import CommunicationEmailLogModel from "@/modules/communication-email-logs/communication-email-log.model.js";
import EmailTemplateModel from "@/modules/email-template/email-template.model.js";
import {
  hasDeliverableEmailTemplateContent,
  selectLocalizedEmailContent,
} from "@/modules/email-template/email-template.rendering.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  COMMUNICATION_EVENT_RECOVERY_WINDOW_MS,
  getAutomationEventScanCursor,
  getBookingAutomationScheduledFor,
} from "./communication-automation-schedule.service.js";

const BOOKING_REMINDER_TYPES = ["beforeBooking", "beforePurchase"];
const OWNED_DELIVERY_STATUSES = [
  "scheduled",
  "queued",
  "sending",
  "sent",
  "failed",
  "suppressed",
];

const id = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value || "");
};

const hasInlineContent = (automation: Record<string, any>): boolean => {
  const selected = selectLocalizedEmailContent(
    automation,
    automation.defaultLocale,
  );
  return Boolean(
    selected.subject.trim() &&
    String(selected.htmlContent || selected.body || "").trim(),
  );
};

export const isBookingReminderOccurrenceScannable = ({
  automation,
  bookingStart,
  bookingUpdatedAt,
  now = new Date(),
}: {
  automation: Record<string, any>;
  bookingStart: Date | string;
  bookingUpdatedAt?: Date | string | null;
  now?: Date;
}): boolean => {
  const scheduledFor = getBookingAutomationScheduledFor(automation as any, {
    start: bookingStart,
  });
  if (!scheduledFor) return false;

  const recoveryFloor = new Date(
    now.getTime() - COMMUNICATION_EVENT_RECOVERY_WINDOW_MS,
  );
  if (scheduledFor.getTime() <= recoveryFloor.getTime()) return false;

  const cursor = getAutomationEventScanCursor(automation, now);
  if (scheduledFor.getTime() > cursor.getTime()) return true;

  const updatedAt = bookingUpdatedAt ? new Date(bookingUpdatedAt) : null;
  return Boolean(
    updatedAt &&
    !Number.isNaN(updatedAt.getTime()) &&
    scheduledFor.getTime() <= now.getTime() &&
    updatedAt.getTime() > cursor.getTime(),
  );
};

export const isReadyBookingReminderOwner = ({
  automation,
  activeTemplateIds = new Set<string>(),
}: {
  automation: Record<string, any>;
  activeTemplateIds?: Set<string>;
}): boolean => {
  const sender = automation.senderEmail;
  if (
    !sender ||
    typeof sender !== "object" ||
    sender.isActive !== true ||
    sender.provider !== "postmark_managed" ||
    !sender.replyToEmail ||
    !sender.replyToVerifiedAt ||
    !sender.providerServerId ||
    !sender.providerProvisionedAt ||
    sender.providerProvisioningStatus !== "ready"
  ) {
    return false;
  }

  const templateId = id(automation.templateId);
  return templateId
    ? activeTemplateIds.has(templateId)
    : hasInlineContent(automation);
};

export const hasCommunicationAutomationBookingReminderOwner = async ({
  tenantId,
  bookingId,
  bookingStart,
  bookingUpdatedAt,
  locationId,
  productType = "course",
  now = new Date(),
}: {
  tenantId: string;
  bookingId: string;
  bookingStart: Date | string;
  bookingUpdatedAt?: Date | string | null;
  locationId?: string;
  productType?: string;
  now?: Date;
}): Promise<boolean> => {
  const materializedDelivery = await CommunicationEmailLogModel.exists({
    tenant: tenantId,
    relatedEntityId: bookingId,
    relatedEntityType: "booking",
    emailType: { $in: BOOKING_REMINDER_TYPES },
    purpose: { $ne: "marketing" },
    status: { $in: OWNED_DELIVERY_STATUSES },
  } as any);
  if (materializedDelivery) return true;

  const tenant = await TenantModel.exists({
    _id: tenantId,
    status: "active",
    "modules.communications": true,
    "modules.automations": true,
  });
  if (!tenant) return false;

  const locationScope = locationId
    ? [
        { appliesToAllLocations: true },
        { appliesToAllLocations: { $exists: false } },
        { appliesToAllLocations: false, location: locationId },
      ]
    : [
        { appliesToAllLocations: true },
        { appliesToAllLocations: { $exists: false } },
      ];
  const candidates = await CommunicationAutomationModel.find({
    tenant: tenantId,
    isActive: true,
    automationStatus: "active",
    purpose: { $ne: "marketing" },
    scheduleType: { $in: BOOKING_REMINDER_TYPES },
    connectedProductType: { $in: ["all", "booking", productType] },
    $or: locationScope,
  } as any)
    .populate({
      path: "senderEmail",
      match: {
        tenant: tenantId,
        isActive: true,
        provider: "postmark_managed",
        replyToEmail: { $ne: "" },
        replyToVerifiedAt: { $ne: null },
        providerServerId: { $ne: null },
        providerProvisionedAt: { $ne: null },
        providerProvisioningStatus: "ready",
      },
      select:
        "_id isActive provider replyToEmail replyToVerifiedAt providerServerId providerProvisionedAt providerProvisioningStatus",
    })
    .lean<any[]>()
    .exec();
  if (!candidates.length) return false;

  const templateIds = candidates
    .map((item) => id(item.templateId))
    .filter(Boolean);
  const activeTemplates = templateIds.length
    ? await EmailTemplateModel.find({
        _id: { $in: templateIds },
        tenant: tenantId,
        isActive: true,
      })
        .select(
          "_id category subject htmlContent body format defaultLocale contentVariants",
        )
        .lean<any[]>()
        .exec()
    : [];
  const activeTemplateIds = new Set<string>(
    activeTemplates
      .filter((template) => hasDeliverableEmailTemplateContent(template))
      .map((template) => String(template._id)),
  );

  return candidates.some(
    (automation) =>
      isReadyBookingReminderOwner({ automation, activeTemplateIds }) &&
      isBookingReminderOccurrenceScannable({
        automation,
        bookingStart,
        bookingUpdatedAt,
        now,
      }),
  );
};
