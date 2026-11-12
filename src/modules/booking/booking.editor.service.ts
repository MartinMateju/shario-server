import { createHash, randomUUID } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";

import Booking from "./booking.model.js";
import Location from "@/modules/location/location.model.js";
import Product from "@/modules/product/product.model.js";
import User from "@/modules/user/user.model.js";
import { MAX_PRODUCT_PARTICIPANTS } from "@/modules/product/product.constants.js";
import { createAccessCodeNotificationRepository } from "@/modules/access-codes/access-code.repository.js";
import { buildCustomerRescheduleRange } from "./booking.customer.service.js";
import { loadCourseCapacityForBookings } from "./booking.course-capacity.js";
import {
  getCourseCapacity,
  validateOpenStudioAvailabilityOrThrow,
} from "@/modules/checkout/services/checkout.capacity.service.js";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";
import {
  recordBookingLifecycleEmailInSession,
  dispatchBookingLifecycleEmailSafely,
} from "./services/booking.customer-notification.service.js";
import type { CommunicationEmailLogDocument } from "@/modules/communication-email-logs/communication-email-log.types.js";
import { promoteWaitlistEntry } from "@/modules/waitlist/waitlist.service.js";

const id = (value: any): string => String(value?._id ?? value ?? "");
const oid = z.string().refine((value) => mongoose.isValidObjectId(value));
const participantInput = z.union([
  z.object({ id: z.string().min(1).max(100) }).strict(),
  z.object({ customerId: oid }).strict(),
  z
    .object({
      name: z.string().trim().min(1).max(160),
      email: z
        .union([z.string().trim().email().max(254), z.literal("")])
        .optional(),
      phone: z.string().trim().max(40).optional(),
    })
    .strict(),
]);
export const bookingEditorInput = z
  .object({
    revision: z.string().min(1).max(100),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
    lecturer: z.string().trim().max(500).optional(),
    note: z.string().trim().max(10000).optional(),
    participants: z
      .array(participantInput)
      .max(MAX_PRODUCT_PARTICIPANTS)
      .optional(),
  })
  .strict();

type Context = { tenantId: string; bookingId: string; now?: Date };
const tags = new Set([
  "open-studio",
  "workshop",
  "class",
  "course",
  "private-studio",
  "private-session",
]);
const course = (booking: any) => ["class", "course"].includes(booking.tag);
const studio = (booking: any) =>
  ["open-studio", "workshop"].includes(booking.tag);
const legacyAttendanceCount = (booking: any) =>
  Math.max(
    studio(booking) && !booking.attendanceManaged ? 1 : 0,
    Math.floor(Number(booking.numberOfGuests) || 0),
  );
const customerFilter = (tenantId: string) => ({
  tenant: tenantId,
  isAccessGranted: true,
  // Staff and owners can also book in customer mode. Match that capability
  // without including platform operators or inactive synthetic guest actors.
  tenantRole: {
    $in: [
      "customer" as const,
      "owner" as const,
      "admin" as const,
      "staff" as const,
    ],
  },
  platformRole: { $in: ["none" as const, null] },
});
const fail = (code: string, message: string): never =>
  conflict({ code, message });
const missing = (): never =>
  notFound({ code: "BOOKING_EDITOR_NOT_FOUND", message: "Booking not found." });
const revision = (booking: any) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        updatedAt: booking.updatedAt,
        version: booking.__v ?? 0,
        start: booking.start,
        end: booking.end,
        note: booking.note,
        lecturer: booking.lecturer,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        participants: booking.participants,
        count: booking.numberOfGuests,
        orders: booking.orders,
        capacityReservations: booking.capacityReservations,
        waitlistCapacityHolds: booking.waitlistCapacityHolds,
        extensionPaymentPendingUntil: booking.extensionPaymentPendingUntil,
        accessCodeDelivery: booking.accessCodeDelivery,
      }),
    )
    .digest("hex");

/** Never invent purchaser identities for legacy unnamed places. */
export const materializeAttendance = (booking: any, owner?: any): any[] => {
  const rows = (booking.participants ?? []).map((row: any, index: number) => ({
    ...(row.toObject?.() ?? row),
    participantId: row.participantId || `legacy-${index}`,
    attendanceStatus: row.attendanceStatus || "active",
    unnamed:
      row.unnamed === true || /_guest_\d+$/i.test(String(row.firstname || "")),
  }));
  const active = rows.filter(
    (row: any) => row.attendanceStatus !== "removed",
  ).length;
  const count = legacyAttendanceCount(booking);
  if (booking.attendanceManaged && active !== count)
    fail(
      "BOOKING_EDIT_ATTENDANCE_REVIEW_REQUIRED",
      "The attendance roster and occupied places differ. Please review this booking before editing.",
    );
  if (active > count)
    fail(
      "BOOKING_EDIT_ATTENDANCE_REVIEW_REQUIRED",
      "The existing participant records exceed occupied places. Please review this booking before editing.",
    );
  for (let index = active; index < count; index += 1) {
    const isOwner =
      studio(booking) && index === 0 && rows.length === 0 && owner;
    rows.push({
      participantId: `legacy-place-${index}`,
      firstname: isOwner ? owner.firstname : "Unnamed participant",
      lastname: isOwner ? owner.lastname || "" : "",
      ...(isOwner
        ? {
            customer: owner._id,
            customId: owner.customId,
            memberNumber: owner.memberNumber,
          }
        : {}),
      unnamed: !isOwner,
      source: "legacy",
      attendanceStatus: "active",
    });
  }
  return rows;
};

const attendanceNeedsReview = (booking: any): boolean => {
  const active = (booking.participants ?? []).filter(
    (row: any) => row.attendanceStatus !== "removed",
  ).length;
  return (
    active > legacyAttendanceCount(booking) ||
    (booking.attendanceManaged === true &&
      active !== Number(booking.numberOfGuests || 0))
  );
};

const loadBooking = async (
  { tenantId, bookingId }: Context,
  session: ClientSession | null = null,
) => {
  if (!mongoose.isValidObjectId(bookingId)) missing();
  const booking = await Booking.findOne({ _id: bookingId, tenant: tenantId })
    .select("+atelierKleiMigration +scheduleChangeHistory")
    .session(session)
    .exec();
  if (!booking || !tags.has(booking.tag)) missing();
  return booking;
};

const customerDto = (customer: any) => ({
  id: id(customer),
  name: [customer.firstname, customer.lastname].filter(Boolean).join(" "),
  ...(customer.memberNumber ? { memberNumber: customer.memberNumber } : {}),
  ...(customer.customId ? { customId: customer.customId } : {}),
  ...(customer.email ? { email: customer.email } : {}),
  ...(customer.phone ? { phone: customer.phone } : {}),
});

export const findBookingEditorCustomer = async (
  context: Context & { identifier: string },
) => {
  await loadBooking(context);
  const value = String(context.identifier || "").trim();
  if (!value || value.length > 80)
    badRequest({
      code: "BOOKING_EDIT_INVALID",
      message: "Enter an exact customer ID.",
    });
  const numeric =
    /^#?\d+$/.test(value) && Number(value.replace(/^#/, "")) > 0
      ? Number(value.replace(/^#/, ""))
      : null;
  const base = customerFilter(context.tenantId);
  const select = "_id firstname lastname memberNumber customId email phone";
  // Current member numbers take precedence over immutable numeric legacy IDs.
  let customer = Number.isSafeInteger(numeric)
    ? await User.findOne({ ...base, memberNumber: numeric })
        .select(select)
        .lean()
        .exec()
    : null;
  if (!customer)
    customer = await User.findOne({ ...base, customId: value })
      .select(select)
      .lean()
      .exec();
  if (!customer)
    notFound({
      code: "BOOKING_EDITOR_CUSTOMER_NOT_FOUND",
      message: "No customer has this ID in your studio.",
    });
  return { customer: customerDto(customer) };
};

const hasPaymentHold = (booking: any, now: Date) =>
  (booking.capacityReservations ?? []).some(
    (hold: any) => new Date(hold.expiresAt) > now,
  ) || new Date(booking.extensionPaymentPendingUntil || 0) > now;

const getCapabilities = async (
  booking: any,
  tenantId: string,
  now: Date,
  session: ClientSession | null = null,
) => {
  const future =
    new Date(booking.start) > now &&
    !booking.archive &&
    !["cancelled", "canceled", "completed"].includes(booking.status) &&
    booking.paymentStatus === "CONFIRMED";
  const pending = hasPaymentHold(booking, now);
  // Course fulfillment can still consume a stored order-backed hold after its
  // expiry until checkout cleanup resolves it. Staff cannot repurpose it.
  const storedCourseReservation =
    course(booking) && (booking.capacityReservations ?? []).length > 0;
  const waitlistOffer = (booking.waitlistCapacityHolds ?? []).some(
    (hold: any) => new Date(hold.expiresAt) > now,
  );
  const rosterReview = attendanceNeedsReview(booking);
  const accessLocked =
    studio(booking) &&
    (booking.accessCodeDelivery?.status === "delivery_unknown" ||
      (booking.accessCodeDelivery?.status === "processing" &&
        new Date(booking.accessCodeDelivery?.leaseExpiresAt || 0) > now) ||
      (await createAccessCodeNotificationRepository({
        tenantId,
        session,
      }).hasInFlightDeliveryForBooking(booking._id, now)));
  return {
    canEdit: true,
    canEditParticipants: future && !pending && !rosterReview,
    canAddParticipants:
      future && !pending && !storedCourseReservation && !rosterReview,
    ...(storedCourseReservation
      ? { addParticipantsReason: "BOOKING_EDIT_PAYMENT_IN_PROGRESS" }
      : {}),
    canReschedule:
      future &&
      !pending &&
      !storedCourseReservation &&
      !waitlistOffer &&
      !accessLocked &&
      !rosterReview,
    ...(rosterReview
      ? {
          participantsReason: "BOOKING_EDIT_ATTENDANCE_REVIEW_REQUIRED",
          scheduleReason: "BOOKING_EDIT_ATTENDANCE_REVIEW_REQUIRED",
        }
      : !future
        ? {
            participantsReason: "BOOKING_EDIT_NOT_ALLOWED",
            scheduleReason: "BOOKING_EDIT_NOT_ALLOWED",
          }
        : pending
          ? {
              participantsReason: "BOOKING_EDIT_PAYMENT_IN_PROGRESS",
              scheduleReason: "BOOKING_EDIT_PAYMENT_IN_PROGRESS",
            }
          : waitlistOffer || storedCourseReservation
            ? { scheduleReason: "BOOKING_EDIT_PAYMENT_IN_PROGRESS" }
            : accessLocked
              ? { scheduleReason: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS" }
              : {}),
    ...(rosterReview
      ? {
          reason:
            "The attendance roster and occupied places differ. Please review this booking before changing attendance or time.",
        }
      : pending
        ? {
            reason:
              "A payment is in progress. Wait for it to finish before changing attendance or time.",
          }
        : storedCourseReservation
          ? {
              reason:
                "A reserved payment place still needs to be resolved before adding participants or changing the session time.",
            }
          : waitlistOffer
            ? {
                reason:
                  "A waitlist place is currently offered. Wait for that offer to finish before changing the session time.",
              }
            : !future
              ? {
                  reason:
                    "Only a future confirmed booking can change attendance or time.",
                }
              : accessLocked
                ? {
                    reason:
                      "Access delivery must finish or be reviewed before changing the booking time.",
                  }
                : {}),
    scheduleNotification: studio(booking) ? "customer_email" : "none",
    preserveDuration: studio(booking),
  };
};

const editorDto = async (
  context: Context,
  booking: any,
  session: ClientSession | null = null,
) => {
  const [location, product, owner] = await Promise.all([
    Location.findOne({ _id: booking.location, tenant: context.tenantId })
      .select("name booking.timezone")
      .session(session)
      .lean()
      .exec(),
    Product.findOne({ _id: booking.bookingProduct, tenant: context.tenantId })
      .select("name kind")
      .session(session)
      .lean()
      .exec(),
    User.findOne({ _id: booking.createdBy, tenant: context.tenantId })
      .select("firstname lastname customId memberNumber")
      .session(session)
      .lean()
      .exec(),
  ]);
  const rows = attendanceNeedsReview(booking)
    ? (booking.participants ?? []).map((row: any, index: number) => ({
        ...(row.toObject?.() ?? row),
        participantId: row.participantId || `legacy-${index}`,
      }))
    : materializeAttendance(booking, owner);
  const participants = rows
    .filter((row: any) => row.attendanceStatus !== "removed")
    .map((row: any) => ({
      id: row.participantId,
      name: row.unnamed
        ? ""
        : row.name || [row.firstname, row.lastname].filter(Boolean).join(" "),
      ...(row.customer ? { customerId: id(row.customer) } : {}),
      ...(row.memberNumber ? { memberNumber: row.memberNumber } : {}),
      ...(row.customId ? { customId: row.customId } : {}),
      ...(row.email ? { email: row.email } : {}),
      ...(row.phone ? { phone: row.phone } : {}),
      unnamed: row.unnamed === true,
    }));
  return {
    booking: {
      id: id(booking),
      start: booking.start,
      end: booking.end,
      lecturer: booking.lecturer || "",
      note: booking.note || "",
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      tag: booking.tag,
      numberOfGuests: legacyAttendanceCount(booking),
      product: product
        ? { id: id(product), name: product.name, kind: (product as any).kind }
        : null,
    },
    participants,
    revision: revision(booking),
    location: {
      id: id(booking.location),
      name: location?.name || "",
      timeZone: location?.booking?.timezone || "Europe/Prague",
    },
    capabilities: await getCapabilities(
      booking,
      context.tenantId,
      context.now ?? new Date(),
      session,
    ),
  };
};

export const getBookingEditor = async (context: Context) =>
  editorDto(context, await loadBooking(context));

export const saveBookingEditor = async (
  context: Context & { actorUserId: string; input: unknown },
) => {
  const parsed = bookingEditorInput.safeParse(context.input);
  if (!parsed.success)
    badRequest({
      code: "BOOKING_EDIT_INVALID",
      message: "The booking changes are invalid.",
      details: { issues: parsed.error.flatten() },
    });
  const input = parsed.data;
  const now = context.now ?? new Date();
  const transitionId = randomUUID();
  const session = await mongoose.startSession();
  let lifecycleEmail: CommunicationEmailLogDocument | null = null;
  let released = 0;
  try {
    await session.withTransaction(async () => {
      lifecycleEmail = null;
      released = 0;
      const booking = await loadBooking(context, session);
      if (revision(booking) !== input.revision)
        fail(
          "BOOKING_EDIT_STALE",
          "This booking changed. Reload it before saving again.",
        );
      const owner = await User.findOne({
        _id: booking.createdBy,
        tenant: context.tenantId,
      })
        .select("firstname lastname customId memberNumber")
        .session(session)
        .lean()
        .exec();
      const needsReview = attendanceNeedsReview(booking);
      const oldRows = needsReview
        ? (booking.participants ?? []).map((row: any, index: number) => ({
            ...(row.toObject?.() ?? row),
            participantId: row.participantId || `legacy-${index}`,
          }))
        : materializeAttendance(booking, owner);
      const activeRows = oldRows.filter(
        (row) => row.attendanceStatus !== "removed",
      );
      const nextRows: any[] = [];
      const retained = new Set<string>();
      for (const entry of input.participants ??
        activeRows.map((row) => ({ id: row.participantId }))) {
        if ("id" in entry) {
          const row = activeRows.find(
            (value) => value.participantId === entry.id,
          );
          if (!row || retained.has(entry.id))
            badRequest({
              code: "BOOKING_EDIT_INVALID",
              message: "An existing participant is invalid or duplicated.",
            });
          retained.add(entry.id);
          nextRows.push(row);
        } else if ("customerId" in entry) {
          const customer = await User.findOne({
            ...customerFilter(context.tenantId),
            _id: entry.customerId,
          })
            .select("firstname lastname memberNumber customId email phone")
            .session(session)
            .lean()
            .exec();
          if (!customer)
            notFound({
              code: "BOOKING_EDITOR_CUSTOMER_NOT_FOUND",
              message: "Customer not found in your studio.",
            });
          if (
            nextRows.some(
              (row) =>
                !row.unnamed &&
                ((row.memberNumber &&
                  row.memberNumber === customer.memberNumber) ||
                  (row.customId && row.customId === customer.customId)),
            )
          )
            badRequest({
              code: "BOOKING_EDIT_INVALID",
              message: "This customer is already in the attendance list.",
            });
          nextRows.push({
            participantId: randomUUID(),
            customer: customer._id,
            firstname: customer.firstname,
            lastname: customer.lastname || "",
            customId: customer.customId,
            memberNumber: customer.memberNumber,
            source: "staff",
            attendanceStatus: "active",
          });
        } else {
          nextRows.push({
            participantId: randomUUID(),
            firstname: entry.name,
            lastname: "",
            name: entry.name,
            email: entry.email || undefined,
            phone: entry.phone || undefined,
            source: "staff",
            attendanceStatus: "active",
          });
        }
      }
      const customers = nextRows
        .filter((row) => row.customer)
        .map((row) => id(row.customer));
      if (new Set(customers).size !== customers.length)
        badRequest({
          code: "BOOKING_EDIT_INVALID",
          message: "A customer can only appear once in the attendance list.",
        });
      for (const row of nextRows.filter(
        (value) => value.source === "staff" && value.customer,
      )) {
        if (
          nextRows.some(
            (other) =>
              other.participantId !== row.participantId &&
              !other.unnamed &&
              ((other.memberNumber &&
                other.memberNumber === row.memberNumber) ||
                (other.customId && other.customId === row.customId)),
          )
        )
          badRequest({
            code: "BOOKING_EDIT_INVALID",
            message: "This customer is already in the attendance list.",
          });
      }
      const rosterChanged =
        nextRows.length !== activeRows.length ||
        nextRows.some(
          (row) =>
            !activeRows.some((old) => old.participantId === row.participantId),
        );
      const start = input.start
        ? new Date(input.start)
        : new Date(booking.start);
      const end = input.end ? new Date(input.end) : new Date(booking.end);
      const scheduleChanged =
        start.getTime() !== new Date(booking.start).getTime() ||
        end.getTime() !== new Date(booking.end).getTime();
      const capabilities = await getCapabilities(
        booking,
        context.tenantId,
        now,
        session,
      );
      if (
        nextRows.length > activeRows.length &&
        !capabilities.canAddParticipants
      )
        fail(
          "BOOKING_EDIT_PAYMENT_IN_PROGRESS",
          capabilities.reason ||
            "A reserved payment place is still being processed.",
        );
      if (
        (rosterChanged && !capabilities.canEditParticipants) ||
        (scheduleChanged && !capabilities.canReschedule)
      )
        fail(
          scheduleChanged &&
            "scheduleReason" in capabilities &&
            capabilities.scheduleReason ===
              "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS"
            ? "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS"
            : hasPaymentHold(booking, now)
              ? "BOOKING_EDIT_PAYMENT_IN_PROGRESS"
              : "BOOKING_EDIT_NOT_ALLOWED",
          capabilities.reason || "This booking cannot be changed.",
        );
      if (rosterChanged && !course(booking) && nextRows.length < 1)
        badRequest({
          code: "BOOKING_EDIT_INVALID",
          message:
            "A studio visit needs at least one participant. Use the cancellation workflow to cancel the whole booking.",
        });

      if (rosterChanged || scheduleChanged) {
        // The same serialization point as checkout/reschedule prevents a staff
        // addition racing another booking for the final available place.
        const locked = await Location.updateOne(
          {
            _id: booking.location,
            tenant: context.tenantId,
            isActive: true,
            "booking.enabled": true,
          },
          { $inc: { "booking.capacityRevision": 1 } },
          { session },
        ).exec();
        if (locked.matchedCount !== 1)
          fail(
            "BOOKING_EDIT_NOT_ALLOWED",
            "The studio location is no longer available.",
          );
        const location = await Location.findOne({
          _id: booking.location,
          tenant: context.tenantId,
        })
          .session(session)
          .lean()
          .exec();
        if (!location) missing();
        if (scheduleChanged) {
          if (
            studio(booking) &&
            end.getTime() - start.getTime() !==
              new Date(booking.end).getTime() -
                new Date(booking.start).getTime()
          )
            fail(
              "BOOKING_EDIT_DURATION_REQUIRES_PAYMENT_WORKFLOW",
              "Moving a paid studio booking must preserve its duration. Use the extension workflow for extra time.",
            );
          // Reuse timezone, opening-hours and grid validation. Class/internal
          // sessions can change duration without altering their sold orders.
          buildCustomerRescheduleRange({
            requestedStart: start,
            currentStart: new Date(booking.start),
            currentEnd: new Date(
              new Date(booking.start).getTime() +
                end.getTime() -
                start.getTime(),
            ),
            location,
            now,
          });
        }
        const candidate: any = {
          ...booking.toObject(),
          start,
          end,
          numberOfGuests: nextRows.length,
        };
        const otherBookings = await Booking.find({
          tenant: context.tenantId,
          location: booking.location,
          _id: { $ne: booking._id },
          start: { $lt: end },
          end: { $gt: start },
        })
          .session(session)
          .lean()
          .exec();
        await loadCourseCapacityForBookings({
          bookings: [candidate, ...otherBookings],
          tenantId: context.tenantId,
          session,
        });
        if (course(booking)) {
          const product = await Product.findOne({
            _id: booking.bookingProduct,
            tenant: context.tenantId,
          })
            .session(session)
            .lean()
            .exec();
          const capacity = getCourseCapacity(product);
          const held = (booking.waitlistCapacityHolds ?? []).filter(
            (hold) => new Date(hold.expiresAt) > now,
          ).length;
          if (
            (scheduleChanged || nextRows.length > activeRows.length) &&
            nextRows.length + held > capacity
          )
            fail(
              "BOOKING_EDIT_CAPACITY_EXCEEDED",
              "The class has no available places for these participants.",
            );
        }
        // Reductions cannot overbook. Legacy schedules may already overlap,
        // so allow attendance reductions without requiring a schedule repair.
        if (scheduleChanged || nextRows.length > activeRows.length) {
          try {
            validateOpenStudioAvailabilityOrThrow({
              openStudioBookings: [candidate],
              currentBookings: otherBookings,
              locationById: new Map([[id(booking.location), location]]),
            });
          } catch (error) {
            if ((error as any)?.statusCode === 409)
              fail("BOOKING_EDIT_CAPACITY_EXCEEDED", (error as Error).message);
            throw error;
          }
        }
      }

      if (rosterChanged) {
        if (booking.financialNumberOfGuests == null)
          booking.financialNumberOfGuests = booking.numberOfGuests;
        booking.participants = [
          ...oldRows.map((row) =>
            row.attendanceStatus === "removed" ||
            retained.has(row.participantId)
              ? row
              : {
                  ...row,
                  attendanceStatus: "removed",
                  removedAt: now,
                  removedBy: new mongoose.Types.ObjectId(context.actorUserId),
                },
          ),
          ...nextRows.filter(
            (row) =>
              !oldRows.some((old) => old.participantId === row.participantId),
          ),
        ] as any;
        booking.attendanceManaged = true;
        booking.attendanceUpdatedBy = new mongoose.Types.ObjectId(
          context.actorUserId,
        );
        booking.numberOfGuests = nextRows.length;
        booking.waitlistJoinRevision =
          Number(booking.waitlistJoinRevision || 0) + 1;
        if (course(booking))
          released = Math.max(0, activeRows.length - nextRows.length);
      }
      if (input.lecturer !== undefined) booking.lecturer = input.lecturer;
      if (input.note !== undefined) booking.note = input.note;
      if (scheduleChanged) {
        const legacyAccessSuppressed =
          booking.atelierKleiMigration?.suppressAccessNotifications === true;
        const priorAccessDeliveryStatus =
          booking.accessCodeDelivery?.status || "idle";
        if (studio(booking)) {
          const hadIssuedAccess =
            priorAccessDeliveryStatus === "sent" ||
            (await createAccessCodeNotificationRepository({
              tenantId: context.tenantId,
              session,
            }).hasDeliveredForBooking(booking._id));
          if (
            (hadIssuedAccess || legacyAccessSuppressed) &&
            !booking.accessCodeCustomerModificationLockedAt
          ) {
            booking.accessCodeCustomerModificationLockedAt = now;
          }
          // This scopes staff ownership to the new occurrence while retaining
          // the original migration provenance and all historical suppression.
          booking.accessCodeStaffRescheduledStart = start;
        }
        booking.scheduleChangeHistory.push({
          transitionId,
          actor: new mongoose.Types.ObjectId(context.actorUserId),
          changedAt: now,
          previousStart: new Date(booking.start),
          previousEnd: new Date(booking.end),
          nextStart: start,
          nextEnd: end,
          priorAccessDeliveryStatus,
          legacyAccessSuppressed,
        });
        booking.start = start;
        booking.end = end;
        booking.numberOfHours = mongoose.Types.Decimal128.fromString(
          String((end.getTime() - start.getTime()) / 3_600_000),
        );
        booking.wasReminderSent = false;
        booking.accessCodeDelivery = {
          status: "idle",
          claimToken: "",
          leaseExpiresAt: null,
          deliveredAt: null,
        };
      }
      booking.increment();
      await booking.save({ session });
      if (scheduleChanged && studio(booking)) {
        await createAccessCodeNotificationRepository({
          tenantId: context.tenantId,
          session,
        }).rearmForReschedule({
          bookingId: booking._id,
          bookingStart: start,
          transitionId,
        });
        lifecycleEmail = await recordBookingLifecycleEmailInSession(
          {
            tenantId: context.tenantId,
            userId: id(booking.createdBy),
            bookingId: id(booking),
            event: "rescheduled",
            transitionKey: transitionId,
          },
          session,
        );
      }
    });
  } finally {
    await session.endSession();
  }
  await dispatchBookingLifecycleEmailSafely(lifecycleEmail);
  for (let index = 0; index < released; index += 1) {
    const promoted = await promoteWaitlistEntry({
      tenantId: context.tenantId,
      sessionId: context.bookingId,
      automatic: true,
      now,
    }).catch(() => null);
    if (!promoted) break;
  }
  return getBookingEditor(context);
};
