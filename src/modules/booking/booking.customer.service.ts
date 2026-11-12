import mongoose from "mongoose";
import { canExtendBooking } from "./booking.extension.policy.js";

import {
  accessCodeNotificationRepository,
  accessCodeRepository,
  createAccessCodeNotificationRepository,
} from "@/modules/access-codes/access-code.repository.js";
import OrderModel from "@/modules/order/order.model.js";
import { ORDER_STATUS } from "@/modules/order/order.constants.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { emitWorkspaceNotificationEvent } from "@/modules/workspace-notifications/workspace-notification.events.js";
import { publishCustomerBookingLifecycleNotificationSafely } from "@/modules/customer-notifications/index.js";
import LocationModel from "@/modules/location/location.model.js";
import UserModel from "@/modules/user/user.model.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";
import { buildLocationOpeningWindow, findLocationOpeningWindow } from "@/modules/location/location-opening-hours.js";
import { parseDateStringInTimezone } from "@/shared/time/time.utils.js";

import BookingModel from "./booking.model.js";
import { loadCourseCapacityForBookings } from "./booking.course-capacity.js";
import { calculateOpenStudioRemainingCapacity } from "./booking.public.service.js";
import {
  BOOKING_STATUS,
  CLASS_BOOKING_TAGS,
  INTERNAL_STUDIO_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "./booking.constants.js";
import {
  isActiveCapacityBooking,
  validateOpenStudioAvailabilityOrThrow,
} from "@/modules/checkout/services/checkout.capacity.service.js";
import { cancelBookingWithRefund } from "./services/booking.refund.service.js";
import { getBookingPaymentRefunds } from "./services/booking-payment-refund.service.js";
import { randomUUID } from "node:crypto";
import {
  recordBookingLifecycleEmailInSession,
  dispatchBookingLifecycleEmailSafely,
} from "./services/booking.customer-notification.service.js";
import type { CommunicationEmailLogDocument } from "@/modules/communication-email-logs/communication-email-log.types.js";
import {
  customerReservationScopeFilter,
  getCustomerReservationState,
  type CustomerReservationContext,
} from "./booking.customer-reservation.js";

const toId = (value: unknown): string =>
  String((value as { _id?: unknown } | null)?._id ?? value ?? "").trim();

const customerBookingLocationId = (booking: Record<string, any>): string =>
  String(
    booking?.location?.id ??
      booking?.location?._id ??
      booking?.locationId ??
      booking?.location ??
      "",
  ).trim();

export const assertCustomerAccount = async ({
  tenantId,
  userId,
  requireAccessGranted = true,
  allowWorkspaceIdentity = false,
}: {
  tenantId: string;
  userId: string;
  requireAccessGranted?: boolean;
  allowWorkspaceIdentity?: boolean;
}) => {
  const user = await UserModel.findOne({
    _id: userId,
    tenant: tenantId,
    ...(requireAccessGranted ? { isAccessGranted: true } : {}),
  })
    .select("+tenantRole +platformRole")
    .lean()
    .exec();

  if (!user) {
    notFound({
      message: "Customer account not found.",
      code: "CUSTOMER_ACCOUNT_NOT_FOUND",
    });
  }

  if (
    String(user.platformRole || "none") !== "none" ||
    (!allowWorkspaceIdentity && String(user.tenantRole) !== "customer")
  ) {
    forbidden({
      message: "A customer account is required.",
      code: "CUSTOMER_ACCOUNT_REQUIRED",
    });
  }
};

const customerCourseOrders = async ({
  tenantId,
  userId,
}: {
  tenantId: string;
  userId: string;
}) =>
  OrderModel.find({
    tenant: tenantId,
    createdBy: userId,
    isPaid: true,
    status: ORDER_STATUS.PROCESSED,
    courseBookings: { $exists: true, $ne: [] },
  })
    .select("_id courseBookings")
    .lean()
    .exec();

const courseQuantityMap = (orders: any[]): Map<string, number> => {
  const quantities = new Map<string, number>();

  for (const order of orders) {
    for (const item of order.courseBookings || []) {
      const bookingId = toId(item.bookingId);
      const quantity = Number(item.quantity);

      if (bookingId && Number.isSafeInteger(quantity) && quantity > 0) {
        quantities.set(bookingId, (quantities.get(bookingId) || 0) + quantity);
      }
    }
  }

  return quantities;
};

const customerPaidStudioBookingIds = async ({
  tenantId,
  userId,
  bookingId,
}: {
  tenantId: string;
  userId: string;
  bookingId?: string;
}): Promise<Set<string>> => {
  const orders = await OrderModel.find({
    tenant: tenantId,
    createdBy: userId,
    isPaid: true,
    workshopBookings: bookingId || { $exists: true, $ne: [] },
  })
    .select("workshopBookings")
    .lean()
    .exec();

  return new Set(
    orders
      .flatMap((order) => (order.workshopBookings || []).map(toId))
      .filter((id) => mongoose.isValidObjectId(id)),
  );
};

const bookingPopulate = [
  {
    path: "bookingProduct",
    select: "name description type kind bookingMode imageSrc currency",
  },
  {
    path: "location",
    select:
      "name slug address booking.timezone booking.doorCodeMinutesBefore access.publicInstructions",
  },
];

type CustomerBookingCapabilitySource = {
  tag?: unknown;
  status?: unknown;
  paymentStatus?: unknown;
  start?: unknown;
  end?: unknown;
  extensionPaymentPendingUntil?: unknown;
  accessCodeDelivered?: unknown;
  accessCodeModificationLocked?: unknown;
  accessCodeCustomerModificationLockedAt?: unknown;
  accessCodeDelivery?: {
    status?: unknown;
    leaseExpiresAt?: unknown;
  } | null;
};

export const getCustomerBookingCapabilities = (
  booking: CustomerBookingCapabilitySource,
  now = new Date(),
) => {
  const tag = String(booking.tag || "").toLowerCase();
  const status = String(booking.status || "").toLowerCase();
  const paymentStatus = String(booking.paymentStatus || "").toUpperCase();
  const startsAt = new Date(booking.start as never).getTime();
  const isFuture = Number.isFinite(startsAt) && startsAt > now.getTime();
  const isOpenStudio = (OPEN_STUDIO_BOOKING_TAGS as readonly string[]).includes(
    tag,
  );
  const isPaidAndProcessed =
    status === BOOKING_STATUS.PROCESSED &&
    paymentStatus === PAYMENT_STATUS.CONFIRMED;
  const accessCodeDelivered = booking.accessCodeDelivered === true;
  const bookingDeliveryStatus = String(
    booking.accessCodeDelivery?.status || "idle",
  );
  const bookingDeliveryLease = new Date(
    booking.accessCodeDelivery?.leaseExpiresAt as never,
  ).getTime();
  const bookingDeliveryLocked =
    bookingDeliveryStatus === "sent" ||
    bookingDeliveryStatus === "delivery_unknown" ||
    (bookingDeliveryStatus === "processing" &&
      Number.isFinite(bookingDeliveryLease) &&
      bookingDeliveryLease > now.getTime());
  const accessCodeModificationLocked =
    booking.accessCodeModificationLocked === true ||
    Boolean(booking.accessCodeCustomerModificationLockedAt) ||
    accessCodeDelivered ||
    bookingDeliveryLocked;
  const extensionPending = new Date(booking.extensionPaymentPendingUntil as never).getTime() > now.getTime();
  const isActive =
    status !== BOOKING_STATUS.CANCELLED && status !== BOOKING_STATUS.COMPLETED;

  return {
    canExtend: canExtendBooking(booking, now),
    hasPendingExtension: extensionPending,
    canCancel:
      isOpenStudio &&
      isActive &&
      isFuture &&
      isPaidAndProcessed &&
      !accessCodeModificationLocked && !extensionPending,
    canReschedule:
      isOpenStudio &&
      isActive &&
      isFuture &&
      isPaidAndProcessed &&
      !accessCodeModificationLocked && !extensionPending,
  };
};

type RescheduleLocation = {
  booking?: {
    timezone?: unknown;
    slotStepMinutes?: unknown;
  };
  openingHours?: Record<
    string,
    {
      isOpen?: boolean;
      openTime?: unknown;
      closeTime?: unknown;
    }
  >;
};

const getZonedBookingParts = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: String(values.weekday || "").toLowerCase(),
    second: Number(values.second),
  };
};

export const buildCustomerRescheduleRange = ({
  requestedStart,
  currentStart,
  currentEnd,
  location,
  now = new Date(),
}: {
  requestedStart: Date;
  currentStart: Date;
  currentEnd: Date;
  location: RescheduleLocation;
  now?: Date;
}) => {
  const start = new Date(requestedStart);
  const originalStart = new Date(currentStart);
  const originalEnd = new Date(currentEnd);
  const durationMs = originalEnd.getTime() - originalStart.getTime();

  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs % 60_000 !== 0
  ) {
    badRequest({
      message: "The booking time is invalid.",
      code: "CUSTOMER_BOOKING_RESCHEDULE_TIME_INVALID",
    });
  }

  if (start.getTime() <= now.getTime()) {
    conflict({
      message: "The booking can only be moved to a future time.",
      code: "CUSTOMER_BOOKING_RESCHEDULE_IN_PAST",
    });
  }

  const end = new Date(start.getTime() + durationMs);
  const timeZone = String(location.booking?.timezone || "Europe/Prague");
  const startParts = getZonedBookingParts(start, timeZone);
  const endParts = getZonedBookingParts(end, timeZone);
  const stepMinutes = Math.max(
    15,
    Number(location.booking?.slotStepMinutes || 30),
  );

  if (
    startParts.second !== 0 ||
    start.getUTCMilliseconds() !== 0 ||
    endParts.second !== 0 ||
    end.getUTCMilliseconds() !== 0
  ) {
    badRequest({
      message: "The selected time must align with the studio booking grid.",
      code: "CUSTOMER_BOOKING_RESCHEDULE_STEP_INVALID",
      details: { stepMinutes },
    });
  }

  const openingRange = findLocationOpeningWindow({
    start,
    end,
    openingHours: location.openingHours,
    timezone: timeZone,
  });

  if (
    !openingRange ||
    start.getTime() < openingRange.start.getTime() ||
    end.getTime() > openingRange.end.getTime()
  ) {
    conflict({
      message: "The selected time is outside studio opening hours.",
      code: "CUSTOMER_BOOKING_RESCHEDULE_OUTSIDE_HOURS",
    });
  }

  if (
    (start.getTime() - openingRange.start.getTime()) %
      (stepMinutes * 60_000) !==
    0
  ) {
    badRequest({
      message: "The selected time must align with the studio booking grid.",
      code: "CUSTOMER_BOOKING_RESCHEDULE_STEP_INVALID",
      details: { stepMinutes },
    });
  }

  return {
    start,
    end,
    durationMinutes: durationMs / 60_000,
  };
};

export const serializeCustomerBooking = (
  booking: any,
  courseQuantity?: number,
  accessCodeConfigured = false,
  accessCodeDelivered = false,
  accessCodeModificationLocked = accessCodeDelivered,
  reservationContext: CustomerReservationContext = {},
) => {
  const location =
    booking.location && typeof booking.location === "object"
      ? booking.location
      : null;
  const product =
    booking.bookingProduct && typeof booking.bookingProduct === "object"
      ? booking.bookingProduct
      : null;
  const status = String(booking.status || "");
  const bookingDeliveryStatus = String(
    booking.accessCodeDelivery?.status || "idle",
  );
  const bookingDeliveryLease = new Date(
    booking.accessCodeDelivery?.leaseExpiresAt || 0,
  ).getTime();
  const effectiveAccessCodeDelivered =
    accessCodeDelivered || bookingDeliveryStatus === "sent";
  const effectiveModificationLock =
    accessCodeModificationLocked ||
    Boolean(booking.accessCodeCustomerModificationLockedAt) ||
    effectiveAccessCodeDelivered ||
    bookingDeliveryStatus === "delivery_unknown" ||
    (bookingDeliveryStatus === "processing" &&
      bookingDeliveryLease > Date.now());
  const isCourse = (CLASS_BOOKING_TAGS as readonly string[]).includes(
    String(booking.tag),
  );
  const participantCount = isCourse
    ? Math.max(1, Number(courseQuantity) || 1)
    : Math.max(1, Number(booking.numberOfGuests) || 1);
  const capabilities = getCustomerBookingCapabilities({
    ...booking,
    accessCodeDelivered: effectiveAccessCodeDelivered,
    accessCodeModificationLocked: effectiveModificationLock,
  });
  const reservationState = getCustomerReservationState(
    booking,
    reservationContext,
  );

  return {
    id: toId(booking),
    type: isCourse ? "course" : "studio",
    kind: isCourse ? "class" : "open-studio",
    tag: String(booking.tag || ""),
    status,
    paymentStatus: isCourse
      ? PAYMENT_STATUS.CONFIRMED
      : String(booking.paymentStatus || ""),
    paymentExpiresAt: booking.paymentExpiresAt ?? null,
    reservationState,
    isActiveReservation:
      reservationState === "confirmed" ||
      reservationState === "awaiting_payment",
    start: booking.start,
    end: booking.end,
    participantCount,
    bookingType: String(booking.bookingType || ""),
    bookingMode: String(booking.bookingMode || booking.bookingType || ""),
    publicCapacityLimit: booking.publicCapacityLimit ?? null,
    customerChoiceBooking: booking.customerChoiceBooking === true,
    plannedActivity: String(booking.plannedActivity || "UNDEFINED"),
    ...capabilities,
    product: product
      ? {
          id: toId(product),
          name: product.name,
          description: product.description,
          type: product.type,
          kind: product.kind,
          bookingMode: product.bookingMode,
          imageSrc: product.imageSrc,
          currency: product.currency,
        }
      : { id: toId(booking.bookingProduct) },
    location: location
      ? {
          id: toId(location),
          name: location.name,
          slug: location.slug,
          address: location.address,
          timezone: location.booking?.timezone,
          arrival: {
            publicInstructions: String(
              location.access?.publicInstructions || "",
            ),
            accessCodeDeliveryMinutesBefore: Math.max(
              0,
              Number(location.booking?.doorCodeMinutesBefore ?? 15),
            ),
            accessCodeDeliveryEnabled: accessCodeConfigured === true,
            accessCodeDelivered: effectiveAccessCodeDelivered === true,
            accessCodeIssuanceStarted: effectiveModificationLock === true,
          },
        }
      : {
          id: toId(booking.location),
          arrival: {
            publicInstructions: "",
            accessCodeDeliveryMinutesBefore: 15,
            accessCodeDeliveryEnabled: false,
            accessCodeDelivered: false,
            accessCodeIssuanceStarted: false,
          },
        },
  };
};

type ListCustomerBookingsInput = {
  tenantId: string;
  userId: string;
  scope?: "upcoming" | "history" | "all";
  page?: number;
  limit?: number;
  allowedLocationIds?: readonly string[] | null;
};

type InternalListCustomerBookingsInput = ListCustomerBookingsInput & {
  requireAccessGranted?: boolean;
  allowWorkspaceIdentity?: boolean;
};

type ListMyBookingsInput = Omit<
  ListCustomerBookingsInput,
  "allowedLocationIds"
> & {
  locationId?: string;
};

const listCustomerBookings = async ({
  tenantId,
  userId,
  scope = "upcoming",
  page = 1,
  limit = 20,
  allowedLocationIds = null,
  requireAccessGranted = true,
  allowWorkspaceIdentity = false,
}: InternalListCustomerBookingsInput) => {
  await assertCustomerAccount({
    tenantId,
    userId,
    requireAccessGranted,
    allowWorkspaceIdentity,
  });

  const [orders, paidStudioBookingIds] = await Promise.all([
    customerCourseOrders({ tenantId, userId }),
    customerPaidStudioBookingIds({ tenantId, userId }),
  ]);
  const quantities = courseQuantityMap(orders);
  const courseIds = [...quantities.keys()].map(
    (id) => new mongoose.Types.ObjectId(id),
  );
  const now = new Date();
  const scopeFilter = customerReservationScopeFilter(
    scope,
    now,
    [...paidStudioBookingIds].map((id) => new mongoose.Types.ObjectId(id)),
  );
  const ownership: Record<string, unknown>[] = [
    {
      createdBy: userId,
      tag: { $in: OPEN_STUDIO_BOOKING_TAGS },
    },
  ];

  if (courseIds.length > 0) {
    ownership.push({
      _id: { $in: courseIds },
      tag: { $in: CLASS_BOOKING_TAGS },
    });
  }

  const normalizedPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = {
    tenant: tenantId,
    $or: ownership,
    ...scopeFilter,
    ...(Array.isArray(allowedLocationIds)
      ? { location: { $in: [...allowedLocationIds] } }
      : {}),
  };
  const [bookings, totalCount] = await Promise.all([
    BookingModel.find(filter)
      .select(
        "_id bookingProduct location start end status paymentStatus paymentExpiresAt numberOfGuests publicCapacityLimit customerChoiceBooking capacityReservations bookingMode bookingType plannedActivity tag extensionPaymentPendingUntil accessCodeDelivery accessCodeCustomerModificationLockedAt",
      )
      .populate(bookingPopulate)
      .sort({ start: scope === "history" ? -1 : 1 })
      .skip((normalizedPage - 1) * pageSize)
      .limit(pageSize)
      .lean()
      .exec(),
    BookingModel.countDocuments(filter).exec(),
  ]);
  const accessCodeValidity =
    await accessCodeRepository.findUsableLocationValidity(
      tenantId,
      bookings.map((booking) => toId(booking.location)).filter(Boolean),
      now,
    );
  const deliveredBookingIds = new Set(
    await accessCodeNotificationRepository.findDeliveredBookingIds({
      tenantId,
      bookingIds: bookings.map((booking) => toId(booking)).filter(Boolean),
    }),
  );
  const modificationLockedBookingIds = new Set(
    await accessCodeNotificationRepository.findModificationLockedBookingIds({
      tenantId,
      bookingIds: bookings.map((booking) => toId(booking)).filter(Boolean),
      now,
    }),
  );
  const hasAccessCodeForBooking = (booking: any): boolean => {
    const expiresAt = accessCodeValidity.get(toId(booking.location));
    const bookingEnd = new Date(booking.end).getTime();

    return Boolean(
      expiresAt &&
      Number.isFinite(bookingEnd) &&
      expiresAt.getTime() > bookingEnd,
    );
  };

  return {
    bookings: bookings.map((booking) =>
      serializeCustomerBooking(
        booking,
        quantities.get(toId(booking)),
        hasAccessCodeForBooking(booking),
        deliveredBookingIds.has(toId(booking)),
        modificationLockedBookingIds.has(toId(booking)),
        { now, hasPaidOrder: paidStudioBookingIds.has(toId(booking)) },
      ),
    ),
    totalCount,
    currentPage: normalizedPage,
    pageSize,
    totalPages: Math.ceil(totalCount / pageSize),
  };
};

export const listMyBookings = async ({
  locationId,
  ...input
}: ListMyBookingsInput) =>
  listCustomerBookings({
    ...input,
    allowedLocationIds: locationId ? [locationId] : null,
    requireAccessGranted: true,
    allowWorkspaceIdentity: true,
  });

export const listCustomerBookingsForWorkspace = async (
  input: ListCustomerBookingsInput,
) => listCustomerBookings({ ...input, requireAccessGranted: false });

export const getMyBooking = async ({
  tenantId,
  userId,
  bookingId,
}: {
  tenantId: string;
  userId: string;
  bookingId: string;
}) => {
  await assertCustomerAccount({
    tenantId,
    userId,
    allowWorkspaceIdentity: true,
  });

  if (!mongoose.isValidObjectId(bookingId)) {
    notFound({
      message: "Booking not found.",
      code: "CUSTOMER_BOOKING_NOT_FOUND",
    });
  }

  const [booking, orders] = await Promise.all([
    BookingModel.findOne({
      _id: bookingId,
      tenant: tenantId,
    })
      .select(
        "_id createdBy bookingProduct location start end status paymentStatus paymentExpiresAt numberOfGuests publicCapacityLimit customerChoiceBooking capacityReservations bookingMode bookingType plannedActivity tag extensionPaymentPendingUntil accessCodeDelivery accessCodeCustomerModificationLockedAt",
      )
      .populate(bookingPopulate)
      .lean()
      .exec(),
    customerCourseOrders({ tenantId, userId }),
  ]);

  if (!booking) {
    notFound({
      message: "Booking not found.",
      code: "CUSTOMER_BOOKING_NOT_FOUND",
    });
  }

  const quantities = courseQuantityMap(orders);
  const isOwnedOpenStudio =
    toId(booking.createdBy) === userId &&
    (OPEN_STUDIO_BOOKING_TAGS as readonly string[]).includes(
      String(booking.tag),
    );
  const courseQuantity = quantities.get(bookingId);

  if (!isOwnedOpenStudio && !courseQuantity) {
    notFound({
      message: "Booking not found.",
      code: "CUSTOMER_BOOKING_NOT_FOUND",
    });
  }

  const paidStudioBookingIds = isOwnedOpenStudio
    ? await customerPaidStudioBookingIds({ tenantId, userId, bookingId })
    : new Set<string>();

  const accessCodeValidity =
    await accessCodeRepository.findUsableLocationValidity(
      tenantId,
      [toId(booking.location)].filter(Boolean),
    );
  const accessCodeDelivered =
    await accessCodeNotificationRepository.hasDeliveredForBooking({
      tenantId,
      bookingId,
    });
  const accessCodeModificationLocked =
    await accessCodeNotificationRepository.hasModificationLockForBooking({
      tenantId,
      bookingId,
    });
  const accessCodeExpiresAt = accessCodeValidity.get(toId(booking.location));
  const bookingEnd = new Date(booking.end).getTime();

  const customerBooking = serializeCustomerBooking(
    booking,
    courseQuantity,
    Boolean(
      accessCodeExpiresAt &&
      Number.isFinite(bookingEnd) &&
      accessCodeExpiresAt.getTime() > bookingEnd,
    ),
    accessCodeDelivered,
    accessCodeModificationLocked,
    { hasPaidOrder: paidStudioBookingIds.has(bookingId) },
  );
  // A Class session is shared by customers; expose refunds only on an owned
  // Open Studio booking, never another participant's purchase information.
  if (isOwnedOpenStudio && booking.status === BOOKING_STATUS.CANCELLED) {
    const refunds = await getBookingPaymentRefunds({ tenantId, bookingId });
    if (refunds.length)
      return { ...customerBooking, refunds, refund: refunds[0] };
  }
  return customerBooking;
};

export const getMyBookingRescheduleAvailability = async ({
  tenantId,
  userId,
  bookingId,
  date,
  now = new Date(),
}: {
  tenantId: string;
  userId: string;
  bookingId: string;
  date: string;
  now?: Date;
}) => {
  await assertCustomerAccount({
    tenantId,
    userId,
    allowWorkspaceIdentity: true,
  });

  if (!mongoose.isValidObjectId(bookingId)) {
    notFound({
      message: "Booking not found.",
      code: "CUSTOMER_BOOKING_NOT_FOUND",
    });
  }

  const booking = await BookingModel.findOne({
    _id: bookingId,
    tenant: tenantId,
    createdBy: userId,
    tag: { $in: OPEN_STUDIO_BOOKING_TAGS },
  })
    .select(
      "_id location start end status paymentStatus numberOfGuests publicCapacityLimit customerChoiceBooking capacityReservations bookingMode bookingType plannedActivity tag extensionPaymentPendingUntil accessCodeDelivery accessCodeCustomerModificationLockedAt",
    )
    .lean()
    .exec();

  if (!booking) {
    notFound({
      message: "Booking not found.",
      code: "CUSTOMER_BOOKING_NOT_FOUND",
    });
  }

  const accessCodeModificationLocked =
    await accessCodeNotificationRepository.hasModificationLockForBooking({
      tenantId,
      bookingId,
      now,
    });
  const capabilities = getCustomerBookingCapabilities(
    {
      ...booking,
      accessCodeModificationLocked,
    },
    now,
  );

  if (!capabilities.canReschedule) {
    conflict({
      message: "This booking cannot be moved.",
      code: "CUSTOMER_BOOKING_RESCHEDULE_NOT_ALLOWED",
    });
  }

  const locationId = toId(booking.location);
  const location = await LocationModel.findOne({
    _id: locationId,
    tenant: tenantId,
    isActive: true,
    "booking.enabled": true,
  })
    .select("name slug isActive booking openingHours")
    .lean()
    .exec();

  if (!location) {
    conflict({
      message: "The booking location is no longer available.",
      code: "LOCATION_NOT_AVAILABLE",
    });
  }

  const timeZone = String(location.booking?.timezone || "Europe/Prague");
  const parsedDate = parseDateStringInTimezone(date, timeZone);

  if (!parsedDate) {
    badRequest({
      message: "The booking date is invalid.",
      code: "CUSTOMER_BOOKING_RESCHEDULE_DATE_INVALID",
    });
  }

  const dayKey = parsedDate.format("dddd").toLowerCase();
  const hours = (
    location.openingHours as Record<
      string,
      {
        isOpen?: boolean;
        openTime?: string;
        closeTime?: string;
      }
    >
  )?.[dayKey];

  if (!hours?.isOpen) {
    return { bookingId, date, timeZone, slots: [] };
  }

  const range = buildLocationOpeningWindow({
    date,
    hours,
    timezone: timeZone,
  });

  if (!range) {
    return { bookingId, date, timeZone, slots: [] };
  }

  const durationMs =
    new Date(booking.end).getTime() - new Date(booking.start).getTime();
  const stepMs =
    Math.max(15, Number(location.booking?.slotStepMinutes || 30)) * 60_000;
  const currentBookings = await BookingModel.find({
    _id: { $ne: booking._id },
    tenant: tenantId,
    location: locationId,
    start: { $lt: range.end },
    end: { $gt: range.start },
    tag: {
      $in: ["extension-hold", ...OPEN_STUDIO_BOOKING_TAGS, ...CLASS_BOOKING_TAGS, ...INTERNAL_STUDIO_BOOKING_TAGS],
    },
  })
    .select(
      "_id bookingProduct location start end numberOfGuests publicCapacityLimit customerChoiceBooking capacityReservations waitlistCapacityHolds bookingMode bookingType plannedActivity courseEquipmentRequired tag status archive paymentStatus paymentExpiresAt",
    )
    .lean()
    .exec();
  await loadCourseCapacityForBookings({ bookings: currentBookings, tenantId });
  const activeBookings = currentBookings.filter((candidate) =>
    isActiveCapacityBooking(candidate, now),
  );
  const locationById = new Map([[locationId, location]]);
  const slots: Array<{
    start: Date;
    end: Date;
    available: boolean;
    remainingCapacity: number;
  }> = [];

  for (
    let startMs = range.start.getTime();
    startMs + durationMs <= range.end.getTime();
    startMs += stepMs
  ) {
    const start = new Date(startMs);
    const end = new Date(startMs + durationMs);

    if (start <= now) continue;

    let available = true;

    try {
      validateOpenStudioAvailabilityOrThrow({
        openStudioBookings: [
          {
            _id: booking._id,
            location: booking.location,
            start,
            end,
            numberOfGuests: booking.numberOfGuests,
            bookingMode: booking.bookingMode ?? booking.bookingType,
            bookingType: booking.bookingType,
            publicCapacityLimit: booking.publicCapacityLimit,
            customerChoiceBooking: booking.customerChoiceBooking,
            capacityReservations: booking.capacityReservations,
            plannedActivity: booking.plannedActivity,
            tag: booking.tag,
            status: booking.status,
            paymentStatus: booking.paymentStatus,
          },
        ],
        currentBookings: activeBookings,
        locationById,
      });
    } catch {
      available = false;
    }

    const capacity = calculateOpenStudioRemainingCapacity({
      location,
      bookings: activeBookings,
      start,
      end,
      available,
      productCapacity: Number(location.booking?.globalCapacity || 1),
      bookingMode: booking.bookingMode ?? booking.bookingType,
      publicCapacityLimit: booking.publicCapacityLimit ?? null,
      customerChoiceBooking: booking.customerChoiceBooking === true,
      plannedActivity: booking.plannedActivity,
    });

    slots.push({
      start,
      end,
      available,
      remainingCapacity: capacity.remainingCapacity,
    });
  }

  return {
    bookingId,
    date,
    timeZone,
    durationMinutes: durationMs / 60_000,
    slots,
  };
};

export const cancelMyBooking = async ({
  tenantId,
  userId,
  bookingId,
}: {
  tenantId: string;
  userId: string;
  bookingId: string;
}) => {
  await assertCustomerAccount({
    tenantId,
    userId,
    allowWorkspaceIdentity: true,
  });

  if (!mongoose.isValidObjectId(bookingId)) {
    notFound({
      message: "Booking not found.",
      code: "CUSTOMER_BOOKING_NOT_FOUND",
    });
  }

  const current = await getMyBooking({
    tenantId,
    userId,
    bookingId,
  });

  if (current.status === BOOKING_STATUS.CANCELLED) {
    const refunds = await getBookingPaymentRefunds({ tenantId, bookingId });
    return {
      booking: current,
      refundAmount: 0,
      ...(refunds.length
        ? { refunds, refundType: "original_payment", refund: refunds[0] }
        : {}),
      message: "Booking was already cancelled.",
      idempotent: true,
    };
  }

  if (!current.canCancel) {
    conflict({
      message:
        current.location?.arrival?.accessCodeDelivered === true
          ? "This booking can no longer be cancelled because its access code has already been issued."
          : "This booking cannot be cancelled.",
      code: "CUSTOMER_BOOKING_CANCEL_NOT_ALLOWED",
    });
  }

  const rawResult = (await cancelBookingWithRefund({
    tenantId,
    bookingId,
    userId,
  })) as Record<string, any>;
  const booking = await getMyBooking({
    tenantId,
    userId,
    bookingId,
  });
  const { booking: _unsafeBooking, ...refund } = rawResult;
  const locationId = customerBookingLocationId(booking);
  emitWorkspaceNotificationEvent({
    tenantId,
    actorUserId: userId,
    requiredPermission: WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    preferenceKey: "bookingCancelled",
    ...(locationId ? { locationId } : {}),
    eventType: "booking.cancelled",
    severity: "warning",
    title: {
      en: "Booking cancelled",
      cs: "Rezervace byla zrušena",
    },
    message: {
      en: "A customer cancelled a booking. Review the booking and refund details.",
      cs: "Zákazník zrušil rezervaci. Zkontrolujte rezervaci a údaje o vrácení platby.",
    },
    actionUrl: "/app/bookings",
    sourceType: "booking",
    sourceId: bookingId,
    deduplicationKey: `booking:${bookingId}:cancelled`,
    groupKey: "booking.cancelled",
  });

  return {
    ...refund,
    booking,
  };
};

export const rescheduleMyBooking = async ({
  tenantId,
  userId,
  bookingId,
  start,
  now = new Date(),
}: {
  tenantId: string;
  userId: string;
  bookingId: string;
  start: Date;
  now?: Date;
}) => {
  await assertCustomerAccount({
    tenantId,
    userId,
    allowWorkspaceIdentity: true,
  });

  if (!mongoose.isValidObjectId(bookingId)) {
    notFound({
      message: "Booking not found.",
      code: "CUSTOMER_BOOKING_NOT_FOUND",
    });
  }

  const session = await mongoose.startSession();
  const transitionKey = randomUUID();
  let lifecycleEmail: CommunicationEmailLogDocument | null = null;

  try {
    await session.withTransaction(async () => {
      lifecycleEmail = null;
      const booking = await BookingModel.findOne({
        _id: bookingId,
        tenant: tenantId,
        createdBy: userId,
      })
        .select(
          "_id tenant createdBy bookingProduct location start end status paymentStatus numberOfGuests publicCapacityLimit customerChoiceBooking capacityReservations bookingMode bookingType plannedActivity tag wasReminderSent extensionPaymentPendingUntil accessCodeDelivery accessCodeCustomerModificationLockedAt",
        )
        .session(session)
        .exec();

      if (!booking) {
        notFound({
          message: "Booking not found.",
          code: "CUSTOMER_BOOKING_NOT_FOUND",
        });
      }

      const accessCodeDelivered = await createAccessCodeNotificationRepository({
        tenantId,
        session,
      }).hasDeliveredForBooking(booking._id);
      const accessCodeModificationLocked =
        await createAccessCodeNotificationRepository({
          tenantId,
          session,
        }).hasModificationLockForBooking(booking._id, now);
      const capabilities = getCustomerBookingCapabilities(
        {
          ...booking.toObject(),
          accessCodeDelivered,
          accessCodeModificationLocked,
        },
        now,
      );

      if (!capabilities.canReschedule) {
        conflict({
          message: "This booking cannot be moved.",
          code: "CUSTOMER_BOOKING_RESCHEDULE_NOT_ALLOWED",
        });
      }

      const locationId = toId(booking.location);
      const locked = await LocationModel.updateOne(
        {
          _id: locationId,
          tenant: tenantId,
          isActive: true,
          "booking.enabled": true,
        },
        {
          $inc: {
            "booking.capacityRevision": 1,
          },
        },
        { session },
      ).exec();

      if (locked.matchedCount !== 1) {
        conflict({
          message: "The booking location is no longer available.",
          code: "LOCATION_NOT_AVAILABLE",
        });
      }

      const location = await LocationModel.findOne({
        _id: locationId,
        tenant: tenantId,
        isActive: true,
        "booking.enabled": true,
      })
        .select("booking openingHours isActive")
        .session(session)
        .lean()
        .exec();

      if (!location) {
        conflict({
          message: "The booking location is no longer available.",
          code: "LOCATION_NOT_AVAILABLE",
        });
      }

      const nextRange = buildCustomerRescheduleRange({
        requestedStart: start,
        currentStart: new Date(booking.start),
        currentEnd: new Date(booking.end),
        location,
        now,
      });
      const currentBookings = await BookingModel.find({
        _id: { $ne: booking._id },
        tenant: tenantId,
        location: locationId,
        start: { $lt: nextRange.end },
        end: { $gt: nextRange.start },
        tag: {
          $in: ["extension-hold", ...OPEN_STUDIO_BOOKING_TAGS, ...CLASS_BOOKING_TAGS, ...INTERNAL_STUDIO_BOOKING_TAGS],
        },
      })
        .select(
          "_id bookingProduct location start end numberOfGuests publicCapacityLimit customerChoiceBooking capacityReservations waitlistCapacityHolds bookingMode bookingType plannedActivity courseEquipmentRequired tag status archive paymentStatus paymentExpiresAt",
        )
        .session(session)
        .lean()
        .exec();

      await loadCourseCapacityForBookings({ bookings: currentBookings, tenantId, session });
      validateOpenStudioAvailabilityOrThrow({
        openStudioBookings: [
          {
            _id: booking._id,
            location: booking.location,
            start: nextRange.start,
            end: nextRange.end,
            numberOfGuests: booking.numberOfGuests,
            bookingMode: booking.bookingMode ?? booking.bookingType,
            bookingType: booking.bookingType,
            publicCapacityLimit: booking.publicCapacityLimit,
            customerChoiceBooking: booking.customerChoiceBooking,
            capacityReservations: booking.capacityReservations,
            plannedActivity: booking.plannedActivity,
            tag: booking.tag,
            status: booking.status,
            paymentStatus: booking.paymentStatus,
          },
        ],
        currentBookings: currentBookings.filter((candidate) =>
          isActiveCapacityBooking(candidate, now),
        ),
        locationById: new Map([[locationId, location]]),
      });

      // Retrying a successful move to the same slot is not a new lifecycle event.
      if (
        new Date(booking.start).getTime() === nextRange.start.getTime() &&
        new Date(booking.end).getTime() === nextRange.end.getTime()
      )
        return;
      booking.start = nextRange.start;
      booking.end = nextRange.end;
      booking.wasReminderSent = false;
      booking.accessCodeDelivery = {
        status: "idle",
        claimToken: "",
        leaseExpiresAt: null,
        deliveredAt: null,
      };
      await booking.save({ session });

      await createAccessCodeNotificationRepository({
        tenantId,
        session,
      }).rearmForReschedule({
        bookingId: booking._id,
        bookingStart: nextRange.start,
      });
      lifecycleEmail = await recordBookingLifecycleEmailInSession(
        {
          tenantId,
          userId,
          bookingId,
          event: "rescheduled",
          transitionKey,
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const booking = await getMyBooking({
    tenantId,
    userId,
    bookingId,
  });

  const locationId = customerBookingLocationId(booking);
  const rescheduledStart = new Date(booking.start).toISOString();
  emitWorkspaceNotificationEvent({
    tenantId,
    actorUserId: userId,
    requiredPermission: WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    preferenceKey: "bookingAssigned",
    ...(locationId ? { locationId } : {}),
    eventType: "booking.rescheduled",
    severity: "info",
    title: {
      en: "Booking rescheduled",
      cs: "Rezervace byla přesunuta",
    },
    message: {
      en: "A customer moved a booking to a new time.",
      cs: "Zákazník přesunul rezervaci na nový čas.",
    },
    actionUrl: "/app/bookings",
    sourceType: "booking",
    sourceId: bookingId,
    deduplicationKey: `booking:${bookingId}:rescheduled:${rescheduledStart}`,
    groupKey: "booking.rescheduled",
  });

  await publishCustomerBookingLifecycleNotificationSafely({
    tenantId,
    recipientUserId: userId,
    bookingId,
    ...(locationId ? { locationId } : {}),
    event: "rescheduled",
    transitionKey: rescheduledStart,
  });

  await dispatchBookingLifecycleEmailSafely(lifecycleEmail);

  return booking;
};
