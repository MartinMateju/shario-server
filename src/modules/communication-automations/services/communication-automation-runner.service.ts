import { randomUUID } from "node:crypto";

import { logger } from "@/config/logger.js";
import BookingModel from "@/modules/booking/booking.model.js";
import {
  CLASS_BOOKING_TAGS,
  INTERNAL_STUDIO_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
} from "@/modules/booking/booking.constants.js";
import { CommunicationSettingsModel } from "@/modules/communications/communications.models.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import UserModel from "@/modules/user/user.model.js";
import OrderModel from "@/modules/order/order.model.js";

import {
  BOOKING_COMMUNICATION_SCHEDULE_TYPES,
  COMMUNICATION_CONNECTED_PRODUCT_TYPE,
  COMMUNICATION_SCHEDULE_TYPE,
  EVENT_COMMUNICATION_SCHEDULE_TYPES,
  RECURRING_COMMUNICATION_SCHEDULE_TYPES,
} from "../communication-automation.constants.js";
import { communicationAutomationRepository } from "../communication-automation.repository.js";
import { isCommunicationAutomationLocationScopeValid } from "../communication-automation.utils.js";
import { materializeAutomationDeliveries } from "./communication-automation-delivery.service.js";
import {
  COMMUNICATION_EVENT_RECOVERY_WINDOW_MS,
  calculateNextAutomationRun,
  getAutomationEventScanCursor,
  getBookingAutomationAnchorField,
  getBookingAutomationScheduledFor,
  getBookingAutomationSourceAnchor,
  getBookingConfirmationScheduledFor,
  moveAfterAutomationQuietHours,
} from "./communication-automation-schedule.service.js";

type ProcessingResult = {
  queued: number;
  suppressed: number;
  skipped: number;
};

type RunAutomatedCommunicationsResult = ProcessingResult & {
  checked: number;
  failed: number;
};

const CLAIM_DURATION_MS = 5 * 60_000;
const MAX_EVENTS_PER_SCAN = 2_000;

const objectId = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value || "");
};

const tenantTimezone = (tenant: Record<string, any>): string =>
  String(tenant.settings?.timezone || "Europe/Prague");

const offsetMilliseconds = (automation: Record<string, any>): number =>
  Math.max(0, Number(automation.minutesOffset || 0)) * 60_000;

const afterEventScheduledFor = (
  automation: Record<string, any>,
  anchor: Date,
): Date => new Date(anchor.getTime() + offsetMilliseconds(automation));

const getAfterEventAnchorWindow = (
  automation: Record<string, any>,
  cursor: Date,
  now: Date,
) => {
  const offset = offsetMilliseconds(automation);
  return {
    lower: new Date(cursor.getTime() - offset),
    upper: new Date(now.getTime() - offset),
  };
};

const processClaimedScan = async (
  automation: Record<string, any>,
  now: Date,
  scan: (
    claimedAutomation: Record<string, any>,
    cursor: Date,
  ) => Promise<ProcessingResult>,
): Promise<ProcessingResult> => {
  const claimToken = randomUUID();
  const claimedDocument = await communicationAutomationRepository.claimEventScan({
    id: String(automation._id),
    claimToken,
    now,
    claimUntil: new Date(now.getTime() + CLAIM_DURATION_MS),
  });
  if (!claimedDocument) return { queued: 0, suppressed: 0, skipped: 1 };

  const claimed = typeof claimedDocument.toObject === "function"
    ? claimedDocument.toObject()
    : claimedDocument as unknown as Record<string, any>;
  const cursor = getAutomationEventScanCursor(claimed, now);

  try {
    const result = await scan(claimed, cursor);
    await communicationAutomationRepository.completeEventScan({
      id: String(automation._id),
      claimToken,
      scannedThrough: now,
    });
    return result;
  } catch (error) {
    await communicationAutomationRepository.releaseRun(
      String(automation._id),
      claimToken,
      error instanceof Error ? error.message : "Unknown event scanner error.",
    );
    throw error;
  }
};

const bookingFilterForAutomation = (
  automation: Record<string, any>,
  cursor: Date,
  now: Date,
) => {
  const offset = offsetMilliseconds(automation);
  const dateField = getBookingAutomationAnchorField(automation.scheduleType);
  if (!dateField) return null;
  const before = dateField === "start";
  const lowerAnchor = new Date(cursor.getTime() + (before ? offset : -offset));
  const upperAnchor = new Date(now.getTime() + (before ? offset : -offset));
  const recoveryAnchor = new Date(
    now.getTime() -
      COMMUNICATION_EVENT_RECOVERY_WINDOW_MS +
      (before ? offset : -offset),
  );
  const query: Record<string, any> = {
    tenant: automation.tenant,
    archive: { $ne: true },
    status: { $ne: "cancelled" },
    paymentStatus: "CONFIRMED",
    [dateField]: { $gt: recoveryAnchor, $lte: upperAnchor },
    $or: [
      { [dateField]: { $gt: lowerAnchor, $lte: upperAnchor } },
      { updatedAt: { $gt: cursor } },
    ],
  };

  return addBookingProductAndLocationFilter(query, automation);
};

const addBookingProductAndLocationFilter = (
  query: Record<string, any>,
  automation: Record<string, any>,
) => {
  if (!isCommunicationAutomationLocationScopeValid(automation)) return null;
  // Imported bookings remain operational while their notifications are owned
  // by the source system. This also covers confirmations from imported orders.
  query["atelierKleiMigration.suppressHistoricalNotifications"] = { $ne: true };
  if (!automation.appliesToAllLocations) {
    query.location = objectId(automation.location);
  }
  const tagsByProductType: Record<string, readonly string[]> = {
    [COMMUNICATION_CONNECTED_PRODUCT_TYPE.WORKSHOP]: OPEN_STUDIO_BOOKING_TAGS,
    [COMMUNICATION_CONNECTED_PRODUCT_TYPE.COURSE]: CLASS_BOOKING_TAGS,
    [COMMUNICATION_CONNECTED_PRODUCT_TYPE.PRIVATE_SESSION]:
      INTERNAL_STUDIO_BOOKING_TAGS,
  };
  const tags = tagsByProductType[automation.connectedProductType];
  if (tags) {
    query.tag = { $in: tags };
  } else if (
    ![
      COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL,
      COMMUNICATION_CONNECTED_PRODUCT_TYPE.BOOKING,
    ].includes(automation.connectedProductType as never)
  ) {
    return null;
  }

  return query;
};

// A class booking is a shared session created by staff. Its creation date is
// not the customer's booking event; each paid order is a separate occurrence.
const processBookingConfirmationAutomation = async (
  automation: Record<string, any>,
  now: Date,
): Promise<ProcessingResult> => processClaimedScan(automation, now, async (claimed, cursor) => {
  const baseQuery = addBookingProductAndLocationFilter({
    tenant: claimed.tenant,
    archive: { $ne: true },
    status: { $nin: ["cancelled", "canceled"] },
    paymentStatus: "CONFIRMED",
  }, claimed);
  if (!baseQuery) return { queued: 0, suppressed: 0, skipped: 1 };
  const window = getAfterEventAnchorWindow(claimed, cursor, now);
  const activatedAt = new Date(claimed.activatedAt || now);
  if (Number.isNaN(activatedAt.getTime())) {
    return { queued: 0, suppressed: 0, skipped: 1 };
  }
  const orders = await OrderModel.find({
    tenant: claimed.tenant,
    isPaid: true,
    status: "processed_order",
    bookingExtension: null,
    paidAt: {
      $gte: activatedAt,
      $gt: new Date(
        now.getTime() - COMMUNICATION_EVENT_RECOVERY_WINDOW_MS -
          offsetMilliseconds(claimed),
      ),
      $lte: window.upper,
    },
    $or: [
      { paidAt: { $gt: window.lower, $lte: window.upper } },
      { updatedAt: { $gt: cursor } },
    ],
  })
    .populate({
      path: "createdBy",
      model: UserModel,
      match: {
        tenant: claimed.tenant,
        tenantRole: "customer",
        isAccessGranted: { $ne: false },
      },
      select: "firstname lastname email customId tenant +tenantRole isAccessGranted",
    })
    .sort({ paidAt: 1, _id: 1 })
    .limit(MAX_EVENTS_PER_SCAN + 1)
    .lean();
  if (orders.length > MAX_EVENTS_PER_SCAN) {
    throw new Error(
      `More than ${MAX_EVENTS_PER_SCAN} booking confirmations are due; process a dedicated backfill before resuming the automation.`,
    );
  }
  const result: ProcessingResult = { queued: 0, suppressed: 0, skipped: 0 };
  for (const order of orders as any[]) {
    const scheduledFor = getBookingConfirmationScheduledFor(claimed as any, order);
    if (
      !scheduledFor || scheduledFor > now ||
      !order.createdBy?._id || !order.createdBy.email
    ) {
      result.skipped += 1;
      continue;
    }
    const bookings = await BookingModel.find({ ...baseQuery, orders: order._id })
      .sort({ _id: 1 })
      .limit(MAX_EVENTS_PER_SCAN + 1)
      .lean();
    if (bookings.length > MAX_EVENTS_PER_SCAN) {
      throw new Error(
        `More than ${MAX_EVENTS_PER_SCAN} bookings belong to a confirmation order.`,
      );
    }
    const confirmedAt = new Date(order.paidAt);
    for (const booking of bookings as any[]) {
      const materialized = await materializeAutomationDeliveries({
        tenantId: String(claimed.tenant),
        automation: claimed,
        scheduledFor,
        occurrenceKey: [
          claimed.scheduleType,
          String(booking._id),
          String(order._id),
          confirmedAt.toISOString(),
        ].join(":"),
        booking: { ...booking, orders: [order] },
        source: {
          entity: booking,
          entityType: "booking",
          locale: booking.language,
          orderId: order._id,
          scheduledAt: confirmedAt,
        },
      });
      result.queued += materialized.queued;
      result.suppressed += materialized.suppressed;
      result.skipped += materialized.existing;
    }
  }
  return result;
});

const processBookingAutomation = async (
  automation: Record<string, any>,
  now: Date,
): Promise<ProcessingResult> => processClaimedScan(
  automation,
  now,
  async (claimed, cursor) => {
    const query = bookingFilterForAutomation(claimed, cursor, now);
    if (!query) return { queued: 0, suppressed: 0, skipped: 1 };
    const bookings = await BookingModel.find(query)
      .populate({
        path: "orders",
        model: OrderModel,
        match: { tenant: claimed.tenant, isPaid: true },
        select:
          "_id tenant createdBy isPaid grossAmountMinor expectedAmountMinor paidAmountMinor currency",
        populate: {
          path: "createdBy",
          model: UserModel,
          match: {
            tenant: claimed.tenant,
            tenantRole: "customer",
            isAccessGranted: { $ne: false },
          },
          select:
            "firstname lastname email customId tenant +tenantRole isAccessGranted",
        },
      })
      .sort({ start: 1, _id: 1 })
      .limit(MAX_EVENTS_PER_SCAN + 1)
      .lean();
    if (bookings.length > MAX_EVENTS_PER_SCAN) {
      throw new Error(
        `More than ${MAX_EVENTS_PER_SCAN} booking occurrences are due; process a dedicated backfill before resuming the automation.`,
      );
    }

    const result: ProcessingResult = { queued: 0, suppressed: 0, skipped: 0 };
    for (const booking of bookings as any[]) {
      const scheduledFor = getBookingAutomationScheduledFor(claimed as any, booking);
      if (!scheduledFor || scheduledFor.getTime() > now.getTime()) {
        result.skipped += 1;
        continue;
      }
      const sourceAnchor = getBookingAutomationSourceAnchor(
        claimed as any,
        booking,
      )!;
      const occurrenceKey = [
        claimed.scheduleType,
        String(booking._id),
        sourceAnchor.toISOString(),
      ].join(":");
      const materialized = await materializeAutomationDeliveries({
        tenantId: String(claimed.tenant),
        automation: claimed,
        scheduledFor,
        occurrenceKey,
        booking,
        source: {
          entity: booking,
          entityType: "booking",
          locale: booking.language,
          scheduledAt: sourceAnchor,
        },
      });
      result.queued += materialized.queued;
      result.suppressed += materialized.suppressed;
      result.skipped += materialized.existing;
    }
    return result;
  },
);

const processRegistrationAutomation = async (
  automation: Record<string, any>,
  now: Date,
): Promise<ProcessingResult> => processClaimedScan(
  automation,
  now,
  async (claimed, cursor) => {
    if (
      !claimed.appliesToAllLocations ||
      claimed.connectedProductType !== COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL
    ) {
      return { queued: 0, suppressed: 0, skipped: 1 };
    }
    const window = getAfterEventAnchorWindow(claimed, cursor, now);
    const activatedAt = new Date(claimed.activatedAt || "");
    if (!Number.isFinite(activatedAt.getTime())) {
      return { queued: 0, suppressed: 0, skipped: 1 };
    }
    const users = await UserModel.find({
      tenant: claimed.tenant,
      tenantRole: "customer",
      isAccessGranted: { $ne: false },
      // The delay and recovery overlap must never widen the registration
      // audience to customers from before the current activation.
      createdAt: { $gte: activatedAt, $gt: window.lower, $lte: window.upper },
      email: { $exists: true, $ne: "" },
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(MAX_EVENTS_PER_SCAN + 1)
      .lean();
    if (users.length > MAX_EVENTS_PER_SCAN) {
      throw new Error(
        `More than ${MAX_EVENTS_PER_SCAN} registrations are due; process a dedicated backfill before resuming the automation.`,
      );
    }

    const result: ProcessingResult = { queued: 0, suppressed: 0, skipped: 0 };
    for (const user of users as any[]) {
      const anchor = new Date(user.createdAt);
      const materialized = await materializeAutomationDeliveries({
        tenantId: String(claimed.tenant),
        automation: claimed,
        scheduledFor: afterEventScheduledFor(claimed, anchor),
        occurrenceKey: `${claimed.scheduleType}:${user._id}:${anchor.toISOString()}`,
        source: {
          entity: user,
          entityType: "user",
          recipientUserId: user._id,
          scheduledAt: anchor,
        },
      });
      result.queued += materialized.queued;
      result.suppressed += materialized.suppressed;
      result.skipped += materialized.existing;
    }
    return result;
  },
);

const processEventAutomation = (
  automation: Record<string, any>,
  now: Date,
): Promise<ProcessingResult> => {
  if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_REGISTRATION) {
    return processRegistrationAutomation(automation, now);
  }
  return Promise.resolve({ queued: 0, suppressed: 0, skipped: 1 });
};

const processRecurringAutomation = async ({
  automation,
  tenant,
  settings,
  now,
}: {
  automation: Record<string, any>;
  tenant: Record<string, any>;
  settings?: Record<string, any> | null;
  now: Date;
}): Promise<ProcessingResult> => {
  if (automation.appliesToAllLocations === false) {
    return { queued: 0, suppressed: 0, skipped: 1 };
  }
  const timezone = tenantTimezone(tenant);
  const scheduledFor = automation.nextRunAt
    ? new Date(automation.nextRunAt)
    : calculateNextAutomationRun(
        automation as any,
        timezone,
        new Date(now.getTime() - 60_000),
      );
  if (!scheduledFor) return { queued: 0, suppressed: 0, skipped: 1 };

  if (!automation.nextRunAt) {
    const initialized = await communicationAutomationRepository.initializeNextRun(
      String(automation._id),
      scheduledFor,
    );
    if (!initialized) return { queued: 0, suppressed: 0, skipped: 1 };
  }
  if (scheduledFor.getTime() > now.getTime()) {
    return { queued: 0, suppressed: 0, skipped: 1 };
  }

  if (automation.respectQuietHours !== false) {
    const deliveryTimezone = settings?.businessHours?.timezone || timezone;
    const deferredUntil = moveAfterAutomationQuietHours(
      scheduledFor,
      settings?.quietHours,
      deliveryTimezone,
    );
    if (deferredUntil.getTime() > now.getTime()) {
      await communicationAutomationRepository.rescheduleNextRun(
        String(automation._id),
        scheduledFor,
        deferredUntil,
      );
      return { queued: 0, suppressed: 0, skipped: 1 };
    }
  }

  const claimToken = randomUUID();
  const claimed = await communicationAutomationRepository.claimRun({
    id: String(automation._id),
    scheduledFor,
    claimToken,
    now,
    claimUntil: new Date(now.getTime() + CLAIM_DURATION_MS),
  });
  if (!claimed) return { queued: 0, suppressed: 0, skipped: 1 };

  try {
    const occurrenceKey = `${automation.scheduleType}:${scheduledFor.toISOString()}`;
    const materialized = await materializeAutomationDeliveries({
      tenantId: String(automation.tenant),
      automation,
      scheduledFor,
      occurrenceKey,
    });
    const oneTime =
      automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.ONE_TIME_EMAIL;
    const nextRunAt = oneTime
      ? null
      : calculateNextAutomationRun(
          automation as any,
          timezone,
          new Date(scheduledFor.getTime() + 1_000),
        );
    await communicationAutomationRepository.completeRun({
      id: String(automation._id),
      claimToken,
      scheduledFor,
      nextRunAt,
      deactivate: oneTime,
    });
    return {
      queued: materialized.queued,
      suppressed: materialized.suppressed,
      skipped: materialized.existing,
    };
  } catch (error) {
    await communicationAutomationRepository.releaseRun(
      String(automation._id),
      claimToken,
      error instanceof Error ? error.message : "Unknown automation runner error.",
    );
    throw error;
  }
};

export const runAutomatedCommunications = async (
  now = new Date(),
): Promise<RunAutomatedCommunicationsResult> => {
  const result: RunAutomatedCommunicationsResult = {
    checked: 0,
    queued: 0,
    skipped: 0,
    suppressed: 0,
    failed: 0,
  };
  const pageSize = 500;
  let afterId: string | undefined;
  while (true) {
    const automations = await communicationAutomationRepository.listRunnablePage({
      afterId,
      limit: pageSize,
    });
    if (!automations.length) break;
    result.checked += automations.length;
    const tenantIds = [
      ...new Set(automations.map((item) => String(item.tenant))),
    ];
    const [tenants, settings] = await Promise.all([
      TenantModel.find({
        _id: { $in: tenantIds },
        status: "active",
        "modules.automations": true,
        "modules.communications": true,
      })
        .select("_id settings modules limits status")
        .lean(),
      CommunicationSettingsModel.find({ tenantId: { $in: tenantIds } })
        .select("tenantId quietHours businessHours.timezone")
        .lean(),
    ]);
    const tenantById = new Map(
      tenants.map((tenant: any) => [String(tenant._id), tenant]),
    );
    const settingsByTenant = new Map(
      settings.map((item: any) => [String(item.tenantId), item]),
    );

    for (const document of automations) {
      const automation = typeof document.toObject === "function"
        ? document.toObject()
        : document as unknown as Record<string, any>;
      const tenantId = String(automation.tenant);
      const tenant = tenantById.get(tenantId);
      if (!tenant) {
        result.skipped += 1;
        continue;
      }
      if (automation.purpose === "marketing") {
        result.skipped += 1;
        continue;
      }

      try {
        let processed: ProcessingResult;
        if (automation.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_BOOKING_CREATED) {
          processed = await processBookingConfirmationAutomation(automation, now);
        } else if (BOOKING_COMMUNICATION_SCHEDULE_TYPES.has(automation.scheduleType)) {
          processed = await processBookingAutomation(automation, now);
        } else if (EVENT_COMMUNICATION_SCHEDULE_TYPES.has(automation.scheduleType)) {
          processed = await processEventAutomation(automation, now);
        } else if (RECURRING_COMMUNICATION_SCHEDULE_TYPES.has(automation.scheduleType)) {
          processed = await processRecurringAutomation({
            automation,
            tenant,
            settings: settingsByTenant.get(tenantId),
            now,
          });
        } else {
          processed = { queued: 0, suppressed: 0, skipped: 1 };
        }
        result.queued += processed.queued;
        result.suppressed += processed.suppressed;
        result.skipped += processed.skipped;
      } catch (error) {
        result.failed += 1;
        logger.error(
          { err: error, automationId: String(automation._id), tenantId },
          "Failed to process communication automation.",
        );
      }
    }

    afterId = String(automations[automations.length - 1]._id);
    if (automations.length < pageSize) break;
  }

  return result;
};
