import mongoose, { type ClientSession } from "mongoose";

import Booking from "@/modules/booking/booking.model.js";
import { publishCustomerWaitlistNotification } from "@/modules/customer-notifications/index.js";

import { WAITLIST_EMAIL_TYPE } from "./waitlist.constants.js";
import { WaitlistEntryModel } from "./waitlist.model.js";

const CUSTOMER_EVENT_BY_OUTBOX_TYPE = {
  [WAITLIST_EMAIL_TYPE.JOINED]: "joined",
  [WAITLIST_EMAIL_TYPE.OFFERED]: "offered",
  [WAITLIST_EMAIL_TYPE.EXPIRED]: "expired",
  [WAITLIST_EMAIL_TYPE.WITHDRAWN]: "withdrawn",
  [WAITLIST_EMAIL_TYPE.CANCELLED]: "cancelled",
  [WAITLIST_EMAIL_TYPE.CONFIRMED]: "confirmed",
  [WAITLIST_EMAIL_TYPE.REFUNDED]: "refunded",
} as const;

type CustomerWaitlistOutboxType = keyof typeof CUSTOMER_EVENT_BY_OUTBOX_TYPE;

type WaitlistAudienceEntry = {
  _id?: unknown;
  tenant?: unknown;
  customer?: unknown;
  courseSession?: unknown;
  source?: unknown;
  joinedAt?: unknown;
  offeredAt?: unknown;
  terminalAt?: unknown;
  confirmedAt?: unknown;
  refundSnapshot?: { refundedAt?: unknown } | null;
};

type PublishWaitlistCustomerNotificationInput = {
  tenantId: string;
  type: (typeof WAITLIST_EMAIL_TYPE)[keyof typeof WAITLIST_EMAIL_TYPE];
  deduplicationKey: string;
  session?: ClientSession | null;
  entry?: WaitlistAudienceEntry | null;
  entryId?: unknown;
  occurredAt?: Date;
};

const isCustomerOutboxType = (
  type: PublishWaitlistCustomerNotificationInput["type"],
): type is CustomerWaitlistOutboxType =>
  Object.hasOwn(CUSTOMER_EVENT_BY_OUTBOX_TYPE, type);

const toValidDate = (value: unknown): Date | undefined => {
  const date = value ? new Date(value as Date | string | number) : null;
  return date && Number.isFinite(date.getTime()) ? date : undefined;
};

const occurrenceFor = (
  type: CustomerWaitlistOutboxType,
  entry: WaitlistAudienceEntry,
): Date | undefined =>
  type === WAITLIST_EMAIL_TYPE.JOINED
    ? toValidDate(entry.joinedAt)
    : type === WAITLIST_EMAIL_TYPE.OFFERED
      ? toValidDate(entry.offeredAt)
      : type === WAITLIST_EMAIL_TYPE.CONFIRMED
        ? (toValidDate(entry.confirmedAt) ?? toValidDate(entry.terminalAt))
        : type === WAITLIST_EMAIL_TYPE.REFUNDED
          ? (toValidDate(entry.refundSnapshot?.refundedAt) ??
            toValidDate(entry.terminalAt))
          : toValidDate(entry.terminalAt);

/**
 * Bridges a durable waitlist transition into the authenticated customer inbox.
 * Guest rows are deliberately ineligible; the notification publisher performs
 * the final active-user and tenant checks using the same MongoDB session.
 */
export const publishWaitlistCustomerNotificationForEntry = async (
  input: PublishWaitlistCustomerNotificationInput,
) => {
  if (
    !isCustomerOutboxType(input.type) ||
    !mongoose.isValidObjectId(input.tenantId) ||
    !input.deduplicationKey.trim()
  ) {
    return { eligibleRecipientCount: 0, createdCount: 0, duplicateCount: 0 };
  }

  let entry = input.entry ?? null;
  if (!entry) {
    if (!mongoose.isValidObjectId(String(input.entryId ?? ""))) {
      return {
        eligibleRecipientCount: 0,
        createdCount: 0,
        duplicateCount: 0,
      };
    }
    const query = WaitlistEntryModel.findOne({
      _id: new mongoose.Types.ObjectId(String(input.entryId)),
      tenant: new mongoose.Types.ObjectId(input.tenantId),
      source: "customer",
      customer: { $type: "objectId" },
    }).select(
      "_id tenant customer courseSession source joinedAt offeredAt terminalAt confirmedAt refundSnapshot.refundedAt",
    );
    if (input.session) query.session(input.session);
    entry = await query.lean().exec();
  }

  const entryId = String(entry?._id ?? "");
  const recipientUserId = String(entry?.customer ?? "");
  if (
    entry?.source !== "customer" ||
    (entry?.tenant && String(entry.tenant) !== input.tenantId) ||
    !mongoose.isValidObjectId(entryId) ||
    !mongoose.isValidObjectId(recipientUserId)
  ) {
    return { eligibleRecipientCount: 0, createdCount: 0, duplicateCount: 0 };
  }

  let locationId: string | undefined;
  const courseSessionId = String(entry.courseSession ?? "");
  if (mongoose.isValidObjectId(courseSessionId)) {
    const bookingQuery = Booking.findOne({
      _id: new mongoose.Types.ObjectId(courseSessionId),
      tenant: new mongoose.Types.ObjectId(input.tenantId),
    }).select("location");
    if (input.session) bookingQuery.session(input.session);
    const booking = await bookingQuery.lean().exec();
    const candidateLocationId = String(booking?.location ?? "");
    if (mongoose.isValidObjectId(candidateLocationId)) {
      locationId = candidateLocationId;
    }
  }

  return publishCustomerWaitlistNotification({
    tenantId: input.tenantId,
    recipientUserId,
    entryId,
    ...(locationId ? { locationId } : {}),
    type: CUSTOMER_EVENT_BY_OUTBOX_TYPE[input.type],
    deduplicationKey: input.deduplicationKey.trim(),
    session: input.session,
    occurredAt: input.occurredAt ?? occurrenceFor(input.type, entry),
  });
};
