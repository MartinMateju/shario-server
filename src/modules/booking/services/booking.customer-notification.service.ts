import { logger } from "@/config/logger.js";
import { createHash } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import type { CommunicationEmailLogDocument } from "@/modules/communication-email-logs/communication-email-log.types.js";
import BookingModel from "../booking.model.js";
import LocationModel from "@/modules/location/location.model.js";
import ProductModel from "@/modules/product/product.model.js";
import { Order } from "@/modules/order/order.model.js";
import UserModel from "@/modules/user/user.model.js";
import {
  getCustomerContactEmail,
  getGuestContact,
} from "@/modules/user/user.guest-contact.js";
import {
  COMMUNICATION_CONTENT_LOCALE,
  getCommunicationIntlLocale,
  resolveCommunicationContentLocale,
  type CommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";
import { resolveCustomerBookingLink } from "../customer-booking-link.service.js";

type CustomerBookingLifecycleEvent = "cancelled" | "rescheduled" | "extended";

type CustomerBookingSummary = {
  id?: unknown;
  start?: unknown;
  end?: unknown;
  product?: {
    name?: unknown;
  } | null;
  location?: {
    id?: unknown;
    name?: unknown;
    timezone?: unknown;
  } | null;
};

type RecordCustomerBookingLifecycleEmailInput = {
  tenantId: string;
  userId: string;
  event: CustomerBookingLifecycleEvent;
  booking: CustomerBookingSummary;
  refundAmount?: number;
  refundCurrency?: string;
  refundType?: string;
  refundCardAmountMinor?: number;
  refundVoucherAmountMinor?: number;
  refundExtraCreditAmount?: number;
  transitionKey?: string;
  courseCancellation?: { orderId: string; quantity: number };
  session?: ClientSession;
};

const safeText = (value: unknown, fallback: string): string => {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
};

const localizedText = (
  value: unknown,
  locale: CommunicationContentLocale,
  fallback: string,
): string => {
  if (typeof value === "string") return value.trim() || fallback;
  if (value && typeof value === "object") {
    const localized = value as Record<string, unknown>;
    const keys =
      locale === "cs" ? ["CZ", "cs", "EN", "en"] : ["EN", "en", "CZ", "cs"];
    for (const key of keys) {
      const candidate = localized[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  return fallback;
};

const formatBookingRange = (
  startValue: unknown,
  endValue: unknown,
  timezoneValue: unknown,
  locale: CommunicationContentLocale,
): string => {
  const start = new Date(startValue as never);
  const end = new Date(endValue as never);
  const timeZone = safeText(timezoneValue, "Europe/Prague");

  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) {
    return "";
  }

  try {
    const formatLocale = getCommunicationIntlLocale(locale);
    const dateFormatter = new Intl.DateTimeFormat(formatLocale, {
      timeZone,
      dateStyle: "medium",
    });
    const timeFormatter = new Intl.DateTimeFormat(formatLocale, {
      timeZone,
      timeStyle: "short",
    });

    return `${dateFormatter.format(start)}, ${timeFormatter.format(start)}–${timeFormatter.format(end)}`;
  } catch {
    return `${start.toISOString()}–${end.toISOString()}`;
  }
};

/**
 * Record an immutable transactional email in the same transaction as the
 * booking change. The worker sends it after commit, independently of custom
 * automations, and can recover a temporarily unavailable queue/provider.
 */
export const recordCustomerBookingLifecycleEmail = async ({
  tenantId,
  userId,
  event,
  booking,
  refundAmount = 0,
  refundCurrency = "",
  refundType = "",
  refundCardAmountMinor = 0,
  refundVoucherAmountMinor = 0,
  refundExtraCreditAmount = 0,
  transitionKey,
  courseCancellation,
  session,
}: RecordCustomerBookingLifecycleEmailInput): Promise<CommunicationEmailLogDocument | null> => {
  if (["rescheduled", "extended"].includes(event) && !transitionKey) {
    throw new Error("Reschedule email requires a booking transition key.");
  }
  if (courseCancellation && event !== "cancelled") {
    throw new Error("Course participant notices require a cancellation.");
  }
  const user = await UserModel.findOne({
    _id: userId,
    tenant: tenantId,
  })
    .select("email customId isAccessGranted +guestContact")
    .session(session ?? null)
    .lean()
    .exec();

  const to = getCustomerContactEmail(user);
  if (!to) return null;
  const guestContact = getGuestContact(user);

  const bookingLink = await resolveCustomerBookingLink(tenantId, session);
  const locale = resolveCommunicationContentLocale(
    guestContact?.locale || bookingLink?.locale,
  );
  const czech = locale === COMMUNICATION_CONTENT_LOCALE.CS;
  const studioName = safeText(
    booking.location?.name,
    czech ? "Vaše studio" : "Your studio",
  );
  const productName = localizedText(
    booking.product?.name,
    locale,
    czech ? "Rezervace studia" : "Studio booking",
  );
  const bookingRange = formatBookingRange(
    booking.start,
    booking.end,
    booking.location?.timezone,
    locale,
  );
  const normalizedCurrency = String(refundCurrency || "").toUpperCase();
  const formattedRefund =
    refundAmount > 0 && normalizedCurrency
      ? new Intl.NumberFormat(czech ? "cs-CZ" : "en-GB", {
          style: "currency",
          currency: normalizedCurrency,
        }).format(refundAmount)
      : "";
  const refundLine =
    event === "cancelled" && refundType === "membership_credit"
      ? czech
        ? "Členský kredit byl obnoven."
        : "Your membership credit was restored."
      : event === "cancelled" && formattedRefund
        ? refundType === "original_payment"
          ? czech
            ? [
                refundVoucherAmountMinor > 0
                  ? "Část hrazená poukazem byla vrácena na původní poukaz se stejnou platností, nebo do kreditní peněženky, pokud už byl poukaz převeden na kredit."
                  : "",
                refundCardAmountMinor > 0
                  ? "Vrácení části hrazené kartou bylo zařazeno ke zpracování."
                  : "",
              ]
                .filter(Boolean)
                .join(" ")
            : [
                refundVoucherAmountMinor > 0
                  ? "Voucher-funded value was returned to the original voucher with the same expiry, or to the studio-credit wallet if the voucher had already been converted."
                  : "",
                refundCardAmountMinor > 0
                  ? "The card-funded refund has been queued for processing."
                  : "",
              ]
                .filter(Boolean)
                .join(" ")
          : czech
            ? `${formattedRefund} bylo vráceno jako kredit studia.`
            : `${formattedRefund} was returned as studio credit.`
        : "";
  const subject =
    event === "extended" ? `${studioName} | ${czech ? "Rezervace prodloužena" : "Booking extended"}` :
    event === "rescheduled"
      ? `${studioName} | ${czech ? "Rezervace přesunuta" : "Booking rescheduled"}`
      : `${studioName} | ${czech ? "Rezervace zrušena" : "Booking cancelled"}`;
  const introduction = event === "extended"
    ? (czech ? "Vaše rezervace byla úspěšně prodloužena. Začátek rezervace a přístupový kód zůstávají stejné." : "Your booking has been extended successfully. Its start time and entry code are unchanged.")
    : courseCancellation
    ? czech
      ? "Vaše účast na kurzu byla zrušena. Ostatních účastníků se toto oznámení netýká."
      : "Your places in this class have been cancelled. This notice does not cancel other participants' places."
    : event === "rescheduled"
      ? czech
        ? "Vaše rezervace byla úspěšně přesunuta."
        : "Your booking has been moved successfully."
      : czech
        ? "Vaše rezervace byla úspěšně zrušena."
        : "Your booking has been cancelled successfully.";

  const occurrenceKey = `booking:${String(booking.id)}:${event}${courseCancellation ? `:order:${courseCancellation.orderId}` : ""}${transitionKey ? `:${transitionKey}` : ""}`;
  const deduplicationKey = createHash("sha256")
    .update(`${tenantId}:${occurrenceKey}`)
    .digest("hex");
  const existing = await CommunicationEmailLogModel.findOne({
    tenant: tenantId,
    deduplicationKey,
  })
    .session(session ?? null)
    .exec();
  if (existing) return existing;
  const log = new CommunicationEmailLogModel({
    tenant: new mongoose.Types.ObjectId(tenantId),
    automation: null,
    user: new mongoose.Types.ObjectId(userId),
    recipientEmail: to,
    subject,
    body: [
      introduction,
      "",
      `${czech ? "Rezervace" : "Booking"}: ${productName}`,
      bookingRange ? `${czech ? "Čas" : "Time"}: ${bookingRange}` : null,
      `Studio: ${studioName}`,
      courseCancellation
        ? `${czech ? "Počet zrušených míst" : "Cancelled places"}: ${courseCancellation.quantity}`
        : null,
      refundLine || null,
      event === "cancelled" && refundExtraCreditAmount > 0 && normalizedCurrency
        ? (czech ? `${new Intl.NumberFormat("cs-CZ", { style: "currency", currency: normalizedCurrency }).format(refundExtraCreditAmount)} za prodloužení bylo vráceno jako kredit studia.` : `${new Intl.NumberFormat("en-GB", { style: "currency", currency: normalizedCurrency }).format(refundExtraCreditAmount)} was returned as studio credit for added time.`)
        : null,
      "",
      guestContact
        ? czech
          ? "Pro další změny kontaktujte studio."
          : "For further changes, contact the studio."
        : bookingLink
          ? `${czech ? "Spravovat rezervace" : "Manage bookings"}: ${bookingLink.url}`
          : czech
            ? "Aktuální rezervace najdete ve svém zákaznickém portálu."
            : "You can view your current bookings in your customer portal.",
      "",
      czech
        ? "Tento e-mail byl odeslán automaticky službou shario.io."
        : "This email was sent automatically by shario.io.",
    ]
      .filter(Boolean)
      .join("\n"),
    contentFormat: "plain",
    locale,
    purpose: "transactional",
    allowanceClass: "essential_system",
    emailType:
      event === "cancelled" ? "bookingCancelled" : event === "extended" ? "bookingExtended" : "bookingRescheduled",
    status: "scheduled",
    scheduledFor: new Date(),
    deduplicationKey,
    occurrenceKey,
    relatedEntityId: new mongoose.Types.ObjectId(String(booking.id)),
    relatedEntityType: "booking",
    location: booking.location?.id || null,
    appliesToAllLocations: false,
    sourceOrderId: courseCancellation?.orderId || null,
    sourceScheduledAt:
      event === "rescheduled" ? new Date(booking.start as never) : null,
  });
  return log.save({ session });
};

/** Snapshot trusted booking data within the committing mutation. */
const recordBookingLifecycleEmailFromSourceInSession = async (
  input: Omit<
    RecordCustomerBookingLifecycleEmailInput,
    "booking" | "session"
  > & { bookingId: string },
  session: ClientSession,
): Promise<CommunicationEmailLogDocument | null> => {
  const booking = await BookingModel.findOne({
    _id: input.bookingId,
    tenant: input.tenantId,
    ...(input.courseCancellation
      ? { tag: { $in: ["class", "course"] } }
      : { createdBy: input.userId }),
  })
    .populate({
      path: "bookingProduct",
      model: ProductModel,
      match: { tenant: input.tenantId },
      select: "name",
    })
    .populate({
      path: "location",
      model: LocationModel,
      match: { tenant: input.tenantId },
      select: "name booking.timezone",
    })
    .session(session)
    .lean()
    .exec();
  if (!booking)
    throw new Error("Booking lifecycle email source was not found.");
  const location = booking.location as unknown as {
    _id?: unknown;
    name?: unknown;
    booking?: { timezone?: unknown };
  } | null;
  return recordCustomerBookingLifecycleEmail({
    ...input,
    session,
    booking: {
      id: booking._id,
      start: booking.start,
      end: booking.end,
      product: booking.bookingProduct as unknown as { name?: unknown },
      location: location
        ? {
            id: location._id,
            name: location.name,
            timezone: location.booking?.timezone,
          }
        : null,
    },
  });
};

export const recordBookingLifecycleEmailInSession = (
  input: Omit<
    RecordCustomerBookingLifecycleEmailInput,
    "booking" | "session" | "courseCancellation"
  > & { bookingId: string },
  session: ClientSession,
) => recordBookingLifecycleEmailFromSourceInSession(input, session);

/** Shared Class sessions belong to staff; the cancelled paid order owns its notice. */
export const recordCourseParticipantCancellationEmailInSession = async (
  input: Omit<
    RecordCustomerBookingLifecycleEmailInput,
    "booking" | "session" | "courseCancellation" | "event" | "transitionKey"
  > & { bookingId: string; orderId: string },
  session: ClientSession,
): Promise<CommunicationEmailLogDocument | null> => {
  const order = await Order.findOne({
    _id: input.orderId,
    tenant: input.tenantId,
    createdBy: input.userId,
    isPaid: true,
    status: "processed_order",
    "courseBookings.bookingId": input.bookingId,
  })
    .select("courseCancellations")
    .session(session)
    .lean()
    .exec();
  const cancellation = order?.courseCancellations?.find(
    (entry) => String(entry.bookingId) === input.bookingId,
  );
  if (
    !cancellation ||
    !(cancellation.quantity > 0) ||
    !cancellation.refundedAt
  ) {
    throw new Error(
      "Course cancellation email has no committed order cancellation.",
    );
  }
  return recordBookingLifecycleEmailFromSourceInSession(
    {
      ...input,
      event: "cancelled",
      courseCancellation: {
        orderId: input.orderId,
        quantity: cancellation.quantity,
      },
    },
    session,
  );
};

/** Queue only after commit. A queue outage leaves a recoverable scheduled log. */
export const dispatchBookingLifecycleEmailSafely = async (
  log: CommunicationEmailLogDocument | null | undefined,
): Promise<void> => {
  if (
    !log ||
    !["pending", "scheduled", "queued", "failed"].includes(log.status)
  )
    return;
  const tenantId = String(log.tenant);
  const emailLogId = String(log._id);
  try {
    const { enqueueCommunicationEmail } =
      await import("@/infrastructure/queues/communication-email.queue.js");
    const queued = await enqueueCommunicationEmail(
      {
        tenantId,
        emailLogId,
        userId: String(log.user),
        relatedEntityId: String(log.relatedEntityId),
      },
      String(log.deduplicationKey),
    );
    if (queued.queueAccepted) {
      await communicationEmailLogRepository.markQueued(tenantId, emailLogId);
    } else if (["completed", "unknown"].includes(queued.state)) {
      await communicationEmailLogRepository.markQueueStateAmbiguous(
        tenantId,
        emailLogId,
        queued.state,
      );
    }
  } catch (error) {
    logger.error(
      { err: error, tenantId, emailLogId },
      "Booking lifecycle email is persisted; queue recovery will retry dispatch.",
    );
  }
};
