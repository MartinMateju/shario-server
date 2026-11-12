import dayjs from "dayjs";
import { activeBookingParticipants } from "./booking.attendance-read.js";

import BookingModel from "@/modules/booking/booking.model.js";
import {
  bookingUsesActivityCapacity,
  getBookingCapacityUsed,
  getCourseScheduledCapacity,
  isCourseCapacityBooking,
  loadCourseCapacityForBookings,
} from "@/modules/booking/booking.course-capacity.js";
import {
  CLASS_BOOKING_TAGS,
  INTERNAL_STUDIO_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
  BOOKING_TAG,
  PAYMENT_STATUS,
  PLANNED_ACTIVITY,
  type PlannedActivity,
} from "@/modules/booking/booking.constants.js";
import {
  isActiveCapacityBooking,
  getConcurrentBookingSnapshots,
  validateOpenStudioAvailabilityOrThrow,
} from "@/modules/checkout/services/checkout.capacity.service.js";
import LocationModel from "@/modules/location/location.model.js";
import {
  LOCATION_ACTIVITY_SELECTION_MODE,
  type LocationActivitySelectionMode,
} from "@/modules/location/location.constants.js";
import { resolveLocationActivitySelectionMode } from "@/modules/location/location.utils.js";
import ProductModel from "@/modules/product/product.model.js";
import { assertStudioProductLocation } from "@/modules/product/product-location.policy.js";
import {
  LEGACY_BOOKING_PRODUCT_TYPE,
  PRODUCT_TYPE,
  type ProductType,
} from "@/modules/product/product.constants.js";
import {
  toProductCatalogDto,
  resolveRequestedOpenStudioBookingMode,
  resolveProductPublicCapacityLimit,
} from "@/modules/product/product.utils.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";
import {
  deriveCustomerTenantCapabilities,
  getEffectiveCustomerPricingMode,
  type CustomerPricingMode,
  type TenantForCustomerCapabilities,
} from "@/modules/tenants/tenant-customer-capabilities.js";
import {
  DEFAULT_TIMEZONE,
  parseDateStringInTimezone,
} from "@/shared/time/time.utils.js";
import { buildLocationOpeningWindow } from "@/modules/location/location-opening-hours.js";
import { badRequest, forbidden, notFound } from "@/shared/http/httpErrors.js";

const PUBLIC_TIMED_PRODUCT_TYPES = [
  PRODUCT_TYPE.WORKSHOP,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP,
  LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_WORKSHOP,
] as const;

const PUBLIC_BOOKING_CAPABILITY_PRODUCT_TYPES = [
  PRODUCT_TYPE.WORKSHOP,
  PRODUCT_TYPE.SERVICE,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP,
] as const;

const PUBLIC_FIRING_CAPABILITY_PRODUCT_TYPES = [PRODUCT_TYPE.SERVICE] as const;

type PublicLocation = {
  id: string;
  name: string;
  slug: string;
  isPrimary: boolean;
  pricingMode: CustomerPricingMode | null;
  effectivePricingMode: CustomerPricingMode | null;
  customerCapabilities: { myWork: boolean };
  address: {
    line1: string;
    line2: string;
    city: string;
    postalCode: string;
    country: string;
  };
  contact: {
    email: string;
    phone: string;
  };
  booking: {
    enabled: boolean;
    timeZone: string;
    timezone: string;
    globalCapacity: number;
    slotStepMinutes: number;
    minBookingMinutes: number;
    maxBookingMinutes: number;
    allowPublicOverlap: boolean;
    allowPublicSoloOverlap: boolean;
    groupBookingBlocksAll: boolean;
    maxConcurrentOpenStudioBookings: number;
    maxPublicOverlaps: number;
    maxPublicSoloOverlaps: number;
    activitySelectionMode: LocationActivitySelectionMode;
    activityCapacities: Array<{
      activity: string;
      capacity: number;
    }>;
  };
  openingHours: Record<string, unknown>;
  publicInstructions: string;
};

const resolvePublicBookingTimeZone = (value: unknown): string => {
  const candidate = String(value ?? "").trim();

  if (!candidate) return DEFAULT_TIMEZONE;

  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

export const serializePublicBookingLocation = (
  location: any,
  tenant?: TenantForCustomerCapabilities,
): PublicLocation => ({
  id: String(location._id),
  name: String(location.name ?? ""),
  slug: String(location.slug ?? ""),
  isPrimary: location.isPrimary === true,
  pricingMode: getEffectiveCustomerPricingMode(undefined, location),
  effectivePricingMode: getEffectiveCustomerPricingMode(tenant, location),
  customerCapabilities: deriveCustomerTenantCapabilities(tenant, location),
  address: {
    line1: String(location.address?.line1 ?? ""),
    line2: String(location.address?.line2 ?? ""),
    city: String(location.address?.city ?? ""),
    postalCode: String(location.address?.postalCode ?? ""),
    country: String(location.address?.country ?? ""),
  },
  contact: {
    email: String(location.contact?.email ?? ""),
    phone: String(location.contact?.phone ?? ""),
  },
  booking: (() => {
    const timeZone = resolvePublicBookingTimeZone(location.booking?.timezone);
    const allowPublicOverlap =
      location.booking?.allowPublicOverlap ??
      location.booking?.allowPublicSoloOverlap === true;
    const maxConcurrentOpenStudioBookings = Math.max(
      1,
      Number(
        location.booking?.maxConcurrentOpenStudioBookings ??
          location.booking?.maxPublicOverlaps ??
          location.booking?.maxPublicSoloOverlaps,
      ) || 1,
    );
    const activityCapacities = Array.isArray(
      location.booking?.activityCapacities,
    )
      ? location.booking.activityCapacities
          .map((entry: any) => ({
            activity: String(entry?.activity ?? "").trim(),
            capacity: Math.max(1, Math.floor(Number(entry?.capacity) || 1)),
          }))
          .filter((entry: { activity: string }) => Boolean(entry.activity))
      : [];

    return {
      enabled: location.booking?.enabled === true,
      timeZone,
      timezone: timeZone,
      globalCapacity: Math.max(
        1,
        Math.floor(Number(location.booking?.globalCapacity) || 1),
      ),
      slotStepMinutes: Math.max(
        15,
        Number(location.booking?.slotStepMinutes ?? 30),
      ),
      minBookingMinutes: Math.max(
        15,
        Number(location.booking?.minBookingMinutes ?? 60),
      ),
      maxBookingMinutes: Math.max(
        15,
        Number(location.booking?.maxBookingMinutes ?? 360),
      ),
      allowPublicOverlap: Boolean(allowPublicOverlap),
      allowPublicSoloOverlap: Boolean(allowPublicOverlap),
      groupBookingBlocksAll: location.booking?.groupBookingBlocksAll !== false,
      maxConcurrentOpenStudioBookings,
      maxPublicOverlaps: maxConcurrentOpenStudioBookings,
      maxPublicSoloOverlaps: maxConcurrentOpenStudioBookings,
      activitySelectionMode: resolveLocationActivitySelectionMode(
        location.booking?.activitySelectionMode,
      ),
      activityCapacities,
    };
  })(),
  openingHours:
    location.openingHours && typeof location.openingHours === "object"
      ? location.openingHours
      : {},
  publicInstructions: String(location.access?.publicInstructions ?? ""),
});

const assertTimedBookingModule = ({
  tenant,
  productType,
}: {
  tenant: TenantDocument;
  productType: string;
}): void => {
  const modules = tenant.modules;

  if (modules?.[TENANT_MODULE.PAYMENTS] !== true) {
    forbidden({
      message: "Online booking is unavailable for this workspace.",
      code: "TENANT_MODULE_REQUIRED",
    });
  }

  if (
    productType === PRODUCT_TYPE.SERVICE &&
    modules?.[TENANT_MODULE.BOOKINGS] !== true &&
    modules?.[TENANT_MODULE.FIRING] !== true
  ) {
    forbidden({
      message: "This service is unavailable for this workspace.",
      code: "TENANT_MODULE_REQUIRED",
    });
  }

  if (
    productType !== PRODUCT_TYPE.SERVICE &&
    modules?.[TENANT_MODULE.BOOKINGS] !== true
  ) {
    forbidden({
      message: "Studio booking is unavailable for this workspace.",
      code: "TENANT_MODULE_REQUIRED",
    });
  }
};

const assertPublicBookingModule = (tenant: TenantDocument): void => {
  if (
    tenant.modules?.[TENANT_MODULE.PAYMENTS] !== true ||
    (tenant.modules?.[TENANT_MODULE.BOOKINGS] !== true &&
      tenant.modules?.[TENANT_MODULE.FIRING] !== true)
  ) {
    forbidden({
      message: "Studio booking is unavailable for this workspace.",
      code: "TENANT_MODULE_REQUIRED",
    });
  }
};

const getPublicBookingCapabilityProductTypes = (
  tenant: TenantDocument,
): readonly ProductType[] =>
  tenant.modules?.[TENANT_MODULE.BOOKINGS] === true
    ? PUBLIC_BOOKING_CAPABILITY_PRODUCT_TYPES
    : PUBLIC_FIRING_CAPABILITY_PRODUCT_TYPES;

const assertPublicBookingProduct = async (
  tenant: TenantDocument,
): Promise<void> => {
  const product = await ProductModel.exists({
    tenant: tenant._id,
    isActive: true,
    maxNumberOfParticipants: { $ne: null },
    type: { $in: getPublicBookingCapabilityProductTypes(tenant) },
  });

  if (!product) {
    notFound({
      message: "Studio booking is unavailable for this workspace.",
      code: "PUBLIC_BOOKING_UNAVAILABLE",
    });
  }
};

const CUSTOMER_AVAILABILITY_RANGE_DAYS = 90;
const CUSTOMER_AVAILABILITY_RANGE_MS =
  CUSTOMER_AVAILABILITY_RANGE_DAYS * 24 * 60 * 60 * 1_000;

const toId = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id?: unknown })._id ?? "");
  }

  return String(value ?? "");
};

const CUSTOMER_CLASS_BOOKING_TAGS = new Set<string>(CLASS_BOOKING_TAGS);
const CUSTOMER_OPEN_STUDIO_BOOKING_TAGS = new Set<string>(
  OPEN_STUDIO_BOOKING_TAGS,
);

const toCalendarCustomerId = (customer: any): string | null => {
  const memberNumber = Number(customer?.memberNumber);
  if (Number.isSafeInteger(memberNumber) && memberNumber > 0) {
    return String(memberNumber);
  }

  const customId =
    typeof customer?.customId === "string" ? customer.customId.trim() : "";
  return customId && customId !== "GUEST" ? customId : null;
};

export const serializeCustomerAvailabilityBooking = (booking: any) => {
  const id = toId(booking._id ?? booking.id);
  const productId = toId(booking.bookingProduct);
  const locationId = toId(booking.location);
  const tag = String(booking.tag ?? "");
  const isOpenStudio = CUSTOMER_OPEN_STUDIO_BOOKING_TAGS.has(tag.toLowerCase());
  const participants = activeBookingParticipants(booking);
  // Class/private-studio authors schedule sessions; they are not customers.
  const customers = isOpenStudio && booking.attendanceManaged !== true
    ? [booking.author, ...participants]
    : participants;
  const customerIds = [
    ...new Set(
      customers.map(toCalendarCustomerId).filter((id): id is string => !!id),
    ),
  ];
  const guestCount = Number(
    booking.numberOfGuests ?? (isOpenStudio ? 1 : participants.length),
  );
  const participantCount = Number.isFinite(guestCount)
    ? Math.max(isOpenStudio ? 1 : 0, Math.floor(guestCount))
    : isOpenStudio
      ? 1
      : 0;
  const isCourse = isCourseCapacityBooking(booking);
  const reservedCapacity = isCourse ? getBookingCapacityUsed(booking) : null;

  return {
    _id: id,
    id,
    bookingProduct: productId || null,
    productId: productId || null,
    location: locationId,
    locationId,
    start: booking.start,
    end: booking.end,
    numberOfGuests: Math.max(
      1,
      Math.floor(Number(booking.numberOfGuests ?? 1)),
    ),
    participantCount,
    ...(isCourse
      ? {
          maxNumberOfParticipants: getCourseScheduledCapacity(booking),
          capacityUsed: Number.isFinite(reservedCapacity) ? reservedCapacity : null,
          courseCapacityUnavailable: getCourseScheduledCapacity(booking) === null,
          ...(typeof booking.courseEquipmentRequired === "boolean"
            ? { courseEquipmentRequired: booking.courseEquipmentRequired }
            : {}),
        }
      : {}),
    customerIds,
    bookingMode: booking.bookingMode ? String(booking.bookingMode) : null,
    publicCapacityLimit: booking.publicCapacityLimit ?? null,
    bookingType: booking.bookingType ? String(booking.bookingType) : null,
    plannedActivity: booking.plannedActivity
      ? String(booking.plannedActivity)
      : null,
    tag: tag === "extension-hold" ? "open-studio" : tag,
    status: String(booking.status ?? ""),
    paymentStatus: booking.paymentStatus ? String(booking.paymentStatus) : null,
    paymentExpiresAt: booking.paymentExpiresAt ?? null,
  };
};

const CANCELLED_BOOKING_STATUSES = new Set(["cancelled", "canceled"]);

const hasActiveAvailabilityPayment = (booking: any, now: Date): boolean => {
  const paymentStatus = String(booking?.paymentStatus ?? "").toUpperCase();

  if (!paymentStatus || paymentStatus === PAYMENT_STATUS.CONFIRMED) return true;
  if (paymentStatus !== PAYMENT_STATUS.PENDING_PAYMENT) return false;

  const expiresAt = new Date(booking?.paymentExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
};

const isCustomerAvailabilityBooking = (
  booking: any,
  now: Date,
  visibleFrom: Date = now,
): boolean => {
  const tag = String(booking?.tag ?? "").toLowerCase();
  const status = String(booking?.status ?? "").toLowerCase();

  if (CANCELLED_BOOKING_STATUSES.has(status) || booking?.archive === true) return false;

  if (!CUSTOMER_CLASS_BOOKING_TAGS.has(tag)) {
    return isActiveCapacityBooking(booking, now);
  }

  const startTime = new Date(booking?.start).getTime();
  const endTime = new Date(booking?.end).getTime();

  return (
    hasActiveAvailabilityPayment(booking, now) &&
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    endTime > visibleFrom.getTime()
  );
};

const validateCustomerAvailabilityRange = (start: Date, end: Date): void => {
  const startTime = start.getTime();
  const endTime = end.getTime();

  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    endTime <= startTime ||
    endTime - startTime > CUSTOMER_AVAILABILITY_RANGE_MS
  ) {
    badRequest({
      message: `Availability range must be between 1 minute and ${CUSTOMER_AVAILABILITY_RANGE_DAYS} days.`,
      code: "CUSTOMER_AVAILABILITY_RANGE_INVALID",
    });
  }
};

/**
 * Tenant-scoped occupancy catalog for the authenticated customer calendar.
 * The endpoint exposes today's and future bookings at active, bookable
 * locations, including customer reference IDs used on the shared calendar.
 * It never returns customer names, contact information or internal notes.
 */
export const listCustomerBookingAvailability = async ({
  tenant,
  from,
  to,
  locationId,
  now = new Date(),
}: {
  tenant: TenantDocument;
  from?: Date;
  to?: Date;
  locationId?: string;
  now?: Date;
}) => {
  // Validate explicit ranges before reading location metadata. With no from
  // date, the range starts at the selected studio's midnight, resolved below.
  const initialStart = from ?? now;
  if (from || (to && !Number.isFinite(to.getTime()))) {
    validateCustomerAvailabilityRange(
      initialStart,
      to ?? new Date(initialStart.getTime() + CUSTOMER_AVAILABILITY_RANGE_MS),
    );
  }
  const locations = await LocationModel.find({
    tenant: tenant._id,
    isActive: true,
    "booking.enabled": true,
    ...(locationId ? { _id: locationId } : {}),
  })
    .select("_id booking.timezone")
    .lean()
    .exec();
  const locationIds = locations.map((location) => location._id);

  if (locationIds.length === 0) {
    return { bookings: [] };
  }

  const timeZone = resolvePublicBookingTimeZone(
    (locationId ? locations[0]?.booking?.timezone : undefined) ||
      tenant.settings?.timezone,
  );
  const startOfToday = dayjs(now).tz(timeZone).startOf("day").toDate();
  const requestedStart = from ?? startOfToday;
  const requestedEnd =
    to ?? new Date(requestedStart.getTime() + CUSTOMER_AVAILABILITY_RANGE_MS);
  validateCustomerAvailabilityRange(requestedStart, requestedEnd);

  if (requestedEnd.getTime() <= startOfToday.getTime()) {
    badRequest({
      message: "Availability must include today or a future time.",
      code: "CUSTOMER_AVAILABILITY_RANGE_INVALID",
    });
  }

  const effectiveStart = new Date(
    Math.max(requestedStart.getTime(), startOfToday.getTime()),
  );
  const bookings = await BookingModel.find({
    tenant: tenant._id,
    location: { $in: locationIds },
    start: { $lt: requestedEnd },
    end: { $gt: effectiveStart },
    tag: {
      $in: [
        "extension-hold", ...OPEN_STUDIO_BOOKING_TAGS,
        ...CLASS_BOOKING_TAGS,
        ...INTERNAL_STUDIO_BOOKING_TAGS,
      ],
    },
  })
    .select(
      "_id bookingProduct location start end numberOfGuests publicCapacityLimit customerChoiceBooking capacityReservations waitlistCapacityHolds bookingMode bookingType plannedActivity courseEquipmentRequired tag status archive paymentStatus paymentExpiresAt attendanceManaged author.memberNumber author.customId participants.memberNumber participants.customId participants.attendanceStatus",
    )
    .sort({ start: 1 })
    .lean()
    .exec();

  await loadCourseCapacityForBookings({ bookings, tenantId: tenant._id });

  return {
    bookings: bookings
      .filter((booking) =>
        isCustomerAvailabilityBooking(booking, now, effectiveStart),
      )
      .map(serializeCustomerAvailabilityBooking),
  };
};

const listCustomerSafeLocations = async (
  tenant: TenantDocument,
  { bookingEnabledOnly }: { bookingEnabledOnly: boolean },
) => {
  const locations = await LocationModel.find({
    tenant: tenant._id,
    isActive: true,
    ...(bookingEnabledOnly ? { "booking.enabled": true } : {}),
  })
    .select(
      "name slug isPrimary pricingMode address contact booking.enabled booking.timezone booking.globalCapacity booking.slotStepMinutes booking.minBookingMinutes booking.maxBookingMinutes booking.allowPublicOverlap booking.allowPublicSoloOverlap booking.groupBookingBlocksAll booking.maxConcurrentOpenStudioBookings booking.maxPublicOverlaps booking.maxPublicSoloOverlaps booking.activitySelectionMode booking.activityCapacities openingHours access.publicInstructions",
    )
    .sort({ isPrimary: -1, name: 1 })
    .lean()
    .exec();

  return {
    locations: locations.map((location) =>
      serializePublicBookingLocation(location, tenant),
    ),
  };
};

/**
 * Authenticated portal catalog. It intentionally does not depend on public-site
 * publication and exposes every active studio through the same whitelisted DTO
 * used by public booking. Booking availability remains restricted separately.
 */
export const listCustomerBookingLocations = (tenant: TenantDocument) =>
  listCustomerSafeLocations(tenant, { bookingEnabledOnly: false });

export const listPublicBookingLocations = async (tenant: TenantDocument) => {
  assertPublicBookingModule(tenant);

  return listCustomerSafeLocations(tenant, { bookingEnabledOnly: true });
};

const PUBLIC_OCCUPANCY_MAX_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1_000;

const dateOnlyOrdinal = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? Math.floor(timestamp / DAY_MS)
    : null;
};

const addCalendarDays = (value: string, days: number): string | null => {
  const ordinal = dateOnlyOrdinal(value);
  if (ordinal === null) return null;

  return new Date((ordinal + days) * DAY_MS).toISOString().slice(0, 10);
};

const occupancyRangeError = (): never =>
  badRequest({
    message: `Occupancy range must contain between 1 and ${PUBLIC_OCCUPANCY_MAX_DAYS} days.`,
    code: "PUBLIC_BOOKING_OCCUPANCY_RANGE_INVALID",
  });

const getPublicOccupancyRange = ({
  from,
  to,
  timeZone,
}: {
  from: string;
  to: string;
  timeZone: string;
}): { start: Date; end: Date } => {
  const fromDay = dateOnlyOrdinal(from);
  const toDay = dateOnlyOrdinal(to);

  if (
    fromDay === null ||
    toDay === null ||
    toDay < fromDay ||
    toDay - fromDay + 1 > PUBLIC_OCCUPANCY_MAX_DAYS
  ) {
    return occupancyRangeError();
  }

  const endExclusiveDate = addCalendarDays(to, 1);
  if (!endExclusiveDate) return occupancyRangeError();

  try {
    const start = parseDateStringInTimezone(from, timeZone)?.utc().toDate();
    const end = parseDateStringInTimezone(endExclusiveDate, timeZone)
      ?.utc()
      .toDate();

    if (!start || !end || end.getTime() <= start.getTime()) {
      return occupancyRangeError();
    }

    return { start, end };
  } catch {
    return occupancyRangeError();
  }
};

const mergeOccupancyIntervals = (
  intervals: Array<{ start: Date; end: Date }>,
): Array<{ start: Date; end: Date; kind: "occupied" }> => {
  const sorted = [...intervals].sort(
    (left, right) => left.start.getTime() - right.start.getTime(),
  );
  const merged: Array<{ start: Date; end: Date; kind: "occupied" }> = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];

    if (!previous || interval.start.getTime() >= previous.end.getTime()) {
      merged.push({ ...interval, kind: "occupied" });
      continue;
    }

    if (interval.end.getTime() > previous.end.getTime()) {
      previous.end = interval.end;
    }
  }

  return merged;
};

/**
 * Anonymous, privacy-safe occupancy range. Booking rows are used only to
 * derive generic occupied intervals; identifiers, counts, activities and
 * payment state never cross the public response boundary.
 */
export const listPublicBookingOccupancy = async ({
  tenant,
  locationId,
  from,
  to,
  now = new Date(),
}: {
  tenant: TenantDocument;
  locationId: string;
  from: string;
  to: string;
  now?: Date;
}) => {
  assertPublicBookingModule(tenant);
  await assertPublicBookingProduct(tenant);

  const location = await LocationModel.findOne({
    _id: locationId,
    tenant: tenant._id,
    isActive: true,
    "booking.enabled": true,
  })
    .select(
      "name slug isActive isPrimary pricingMode address contact booking openingHours access.publicInstructions",
    )
    .lean()
    .exec();

  if (!location) {
    notFound({
      message: "Studio location not found.",
      code: "PUBLIC_LOCATION_NOT_FOUND",
    });
  }

  const timeZone = resolvePublicBookingTimeZone(location.booking?.timezone);
  const range = getPublicOccupancyRange({ from, to, timeZone });

  if (range.end.getTime() <= now.getTime()) {
    return {
      location: serializePublicBookingLocation(location, tenant),
      from,
      to,
      timeZone,
      blocks: [],
    };
  }

  const effectiveStart = new Date(
    Math.max(range.start.getTime(), now.getTime()),
  );
  const bookings = await BookingModel.find({
    tenant: tenant._id,
    location: location._id,
    start: { $lt: range.end },
    end: { $gt: effectiveStart },
    tag: {
      $in: [
        "extension-hold", ...OPEN_STUDIO_BOOKING_TAGS,
        ...CLASS_BOOKING_TAGS,
        ...INTERNAL_STUDIO_BOOKING_TAGS,
      ],
    },
  })
    .select("start end tag status archive paymentStatus paymentExpiresAt -_id")
    .sort({ start: 1, end: 1 })
    .lean()
    .exec();

  const intervals = bookings
    .filter((booking) => isCustomerAvailabilityBooking(booking, now))
    .map((booking) => {
      const start = new Date(booking.start).getTime();
      const end = new Date(booking.end).getTime();

      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
      }

      const clippedStart = Math.max(start, range.start.getTime());
      const clippedEnd = Math.min(end, range.end.getTime());

      return clippedEnd > clippedStart
        ? {
            start: new Date(clippedStart),
            end: new Date(clippedEnd),
          }
        : null;
    })
    .filter(
      (interval): interval is { start: Date; end: Date } => interval !== null,
    );

  return {
    location: serializePublicBookingLocation(location, tenant),
    from,
    to,
    timeZone,
    blocks: mergeOccupancyIntervals(intervals),
  };
};

const overlaps = (
  booking: { start?: unknown; end?: unknown },
  start: Date,
  end: Date,
): boolean => {
  const bookingStart = new Date(booking.start as never).getTime();
  const bookingEnd = new Date(booking.end as never).getTime();

  return (
    Number.isFinite(bookingStart) &&
    Number.isFinite(bookingEnd) &&
    bookingStart < end.getTime() &&
    bookingEnd > start.getTime()
  );
};

const guestCount = getBookingCapacityUsed;

const resolveAvailabilityPlannedActivity = ({
  location,
  plannedActivity,
}: {
  location: any;
  plannedActivity?: PlannedActivity;
}): PlannedActivity => {
  const activitySelectionMode = resolveLocationActivitySelectionMode(
    location.booking?.activitySelectionMode,
  );

  if (
    activitySelectionMode === LOCATION_ACTIVITY_SELECTION_MODE.HIDDEN ||
    !plannedActivity ||
    plannedActivity === PLANNED_ACTIVITY.UNDEFINED
  ) {
    return PLANNED_ACTIVITY.UNDEFINED;
  }

  const activityIsOffered = (location.booking?.activityCapacities || []).some(
    (entry: any) => String(entry?.activity) === plannedActivity,
  );

  if (!activityIsOffered) {
    badRequest({
      message: "The selected activity is not offered at this location.",
      code: "BOOKING_ACTIVITY_NOT_AVAILABLE",
    });
  }

  return plannedActivity;
};

const getConfiguredActivityCapacity = (
  location: any,
  plannedActivity: PlannedActivity,
): number | null => {
  if (plannedActivity === PLANNED_ACTIVITY.UNDEFINED) return null;

  const match = (location.booking?.activityCapacities || []).find(
    (entry: any) => String(entry?.activity) === plannedActivity,
  );

  return match ? Math.max(1, Math.floor(Number(match.capacity) || 1)) : null;
};

const calculateRemainingCapacityAtTime = ({
  location,
  bookings,
  start,
  end,
  productCapacity,
  publicCapacityLimit,
  customerChoiceBooking,
  bookingMode,
  plannedActivity,
  available,
}: {
  location: any;
  bookings: any[];
  start: Date;
  end: Date;
  productCapacity: number;
  publicCapacityLimit: number | null;
  customerChoiceBooking: boolean;
  bookingMode: "public" | "private";
  plannedActivity: PlannedActivity;
  available: boolean;
}): { remainingCapacity: number; remainingBookings: number } => {
  if (!available) return { remainingCapacity: 0, remainingBookings: 0 };

  const overlapping = bookings.filter(
    (booking) =>
      isActiveCapacityBooking(booking) && overlaps(booking, start, end),
  );
  const occupied = overlapping.reduce(
    (total, booking) => total + guestCount(booking),
    0,
  );
  const globalRemaining = Math.max(
    0,
    Number(location.booking?.globalCapacity ?? 1) - occupied,
  );
  const configuredActivityCapacity = getConfiguredActivityCapacity(
    location,
    plannedActivity,
  );
  const activityOccupied =
    configuredActivityCapacity === null ||
    (bookingMode === "private" && customerChoiceBooking)
      ? 0
      : overlapping
          .filter(
            (booking) =>
              bookingUsesActivityCapacity(booking, plannedActivity),
          )
          .reduce((total, booking) => total + guestCount(booking), 0);
  const activityRemaining =
    configuredActivityCapacity === null ||
    (bookingMode === "private" && customerChoiceBooking)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, configuredActivityCapacity - activityOccupied);
  const remainingPeople = Math.max(
    0,
    Math.min(
      globalRemaining,
      productCapacity || globalRemaining,
      activityRemaining,
      ...(bookingMode === "public"
        ? [
            publicCapacityLimit,
            ...overlapping
              .filter((booking) => !isCourseCapacityBooking(booking))
              .map((booking) => booking.publicCapacityLimit),
          ]
            .filter((limit) => Number.isSafeInteger(limit) && limit > 0)
            .map((limit) => Math.max(0, Number(limit) - occupied))
        : []),
    ),
  );

  if (bookingMode === "private") {
    return {
      remainingCapacity: remainingPeople,
      remainingBookings: overlapping.length > 0 ? 0 : 1,
    };
  }

  const allowPublicOverlap =
    location.booking?.allowPublicOverlap ??
    location.booking?.allowPublicSoloOverlap === true;
  const overlapLimit = allowPublicOverlap
    ? Math.max(
        1,
        Number(
          location.booking?.maxConcurrentOpenStudioBookings ??
            location.booking?.maxPublicOverlaps ??
            location.booking?.maxPublicSoloOverlaps,
        ) || 1,
      )
    : 1;
  const remainingBookings = Math.max(
    0,
    overlapLimit - overlapping.filter((booking) => !isCourseCapacityBooking(booking)).length,
  );

  return {
    remainingCapacity: remainingBookings === 0 ? 0 : remainingPeople,
    remainingBookings,
  };
};

export const calculateOpenStudioRemainingCapacity = (
  input: Parameters<typeof calculateRemainingCapacityAtTime>[0],
) => {
  const snapshots = getConcurrentBookingSnapshots({
    booking: {
      location: input.location._id,
      start: input.start,
      end: input.end,
    },
    bookings: input.bookings,
  });
  const capacities = snapshots.map((bookings) =>
    calculateRemainingCapacityAtTime({ ...input, bookings }),
  );
  return {
    remainingCapacity: Math.min(
      ...capacities.map((capacity) => capacity.remainingCapacity),
    ),
    remainingBookings: Math.min(
      ...capacities.map((capacity) => capacity.remainingBookings),
    ),
  };
};

export const getPublicBookingAvailability = async ({
  tenant,
  locationId,
  productId,
  date,
  plannedActivity,
  bookingMode: requestedBookingMode,
  numberOfGuests = 1,
  now = new Date(),
}: {
  tenant: TenantDocument;
  locationId: string;
  productId: string;
  date: string;
  plannedActivity?: PlannedActivity;
  bookingMode?: "public" | "private";
  numberOfGuests?: number;
  now?: Date;
}) => {
  const [location, product] = await Promise.all([
    LocationModel.findOne({
      _id: locationId,
      tenant: tenant._id,
      isActive: true,
      "booking.enabled": true,
    })
      .select(
        "name slug isActive isPrimary pricingMode address contact booking openingHours access.publicInstructions",
      )
      .lean()
      .exec(),
    ProductModel.findOne({
      _id: productId,
      tenant: tenant._id,
      isActive: true,
      isArchived: { $ne: true },
      type: { $in: PUBLIC_TIMED_PRODUCT_TYPES },
    }).exec(),
  ]);

  if (!location) {
    notFound({
      message: "Studio location not found.",
      code: "PUBLIC_LOCATION_NOT_FOUND",
    });
  }

  if (!product) {
    notFound({
      message: "Product not found.",
      code: "PUBLIC_PRODUCT_NOT_FOUND",
    });
  }

  assertStudioProductLocation(product, locationId);

  assertTimedBookingModule({
    tenant,
    productType: String(product.type),
  });

  const bookingMode = resolveRequestedOpenStudioBookingMode(
    product,
    requestedBookingMode,
  );

  if (!bookingMode) {
    badRequest({
      message: "Choose a public or private booking.",
      code: "OPEN_STUDIO_BOOKING_MODE_REQUIRED",
    });
  }

  const timeZone = resolvePublicBookingTimeZone(location.booking?.timezone);
  const parsedDate = parseDateStringInTimezone(date, timeZone);

  if (!parsedDate) {
    notFound({
      message: "Booking date is invalid.",
      code: "PUBLIC_BOOKING_DATE_INVALID",
    });
  }

  const dayKey = parsedDate.format("dddd").toLowerCase();
  const hours = (location.openingHours as Record<string, any>)?.[dayKey];
  const publicLocation = serializePublicBookingLocation(location, tenant);

  if (!hours?.isOpen) {
    return {
      location: publicLocation,
      product: toProductCatalogDto(product),
      date,
      timeZone,
      slots: [],
    };
  }

  const range = buildLocationOpeningWindow({
    date,
    hours,
    timezone: timeZone,
  });

  if (!range) {
    return {
      location: publicLocation,
      product: toProductCatalogDto(product),
      date,
      timeZone,
      slots: [],
    };
  }

  const bookings = await BookingModel.find({
    tenant: tenant._id,
    location: location._id,
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
  await loadCourseCapacityForBookings({ bookings, tenantId: tenant._id });
  const stepMs =
    Math.max(15, Number(location.booking?.slotStepMinutes ?? 30)) * 60 * 1000;
  const durationMs =
    Math.max(15, Number(location.booking?.minBookingMinutes ?? 60)) * 60 * 1000;
  const productCapacity =
    product.bookingMode === "customer-choice"
      ? Number(location.booking?.globalCapacity ?? 1)
      : Math.max(1, Number(product.maxNumberOfParticipants ?? 1));
  const publicCapacityLimit =
    bookingMode === "public"
      ? resolveProductPublicCapacityLimit(product)
      : null;
  const effectivePlannedActivity = resolveAvailabilityPlannedActivity({
    location,
    plannedActivity,
  });
  const locationById = new Map([[String(location._id), location]]);
  const slots: Array<{
    start: Date;
    end: Date;
    available: boolean;
    remainingCapacity: number;
    remainingBookings: number;
  }> = [];

  for (
    let startMs = range.start.getTime();
    startMs + durationMs <= range.end.getTime();
    startMs += stepMs
  ) {
    const start = new Date(startMs);
    const end = new Date(startMs + durationMs);

    if (start.getTime() <= now.getTime()) continue;

    let available = numberOfGuests <= productCapacity;

    try {
      validateOpenStudioAvailabilityOrThrow({
        openStudioBookings: [
          {
            location: location._id,
            start,
            end,
            numberOfGuests,
            bookingMode,
            bookingType: bookingMode,
            publicCapacityLimit,
            customerChoiceBooking: product.bookingMode === "customer-choice",
            plannedActivity: effectivePlannedActivity,
            tag: BOOKING_TAG.OPEN_STUDIO,
          },
        ],
        currentBookings: bookings,
        locationById,
      });
    } catch {
      available = false;
    }

    const capacity = calculateOpenStudioRemainingCapacity({
      location,
      bookings,
      start,
      end,
      productCapacity,
      publicCapacityLimit,
      customerChoiceBooking: product.bookingMode === "customer-choice",
      bookingMode,
      plannedActivity: effectivePlannedActivity,
      available,
    });

    slots.push({
      start,
      end,
      available,
      ...capacity,
    });
  }

  return {
    location: publicLocation,
    product: toProductCatalogDto(product),
    date,
    timeZone,
    slots,
  };
};
