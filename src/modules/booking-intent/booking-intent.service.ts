import crypto from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import mongoose from "mongoose";
import { assertStudioProductLocation } from "@/modules/product/product-location.policy.js";

import BookingModel from "@/modules/booking/booking.model.js";
import { loadCourseCapacityForBookings } from "@/modules/booking/booking.course-capacity.js";
import { resolveLocationBookingPlannedActivity } from "@/modules/booking/booking.activity-policy.js";
import {
  BOOKING_STATUS,
  BOOKING_TAG,
  CLASS_BOOKING_TAGS,
  INTERNAL_STUDIO_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import {
  isActiveCapacityBooking,
  validateOpenStudioAvailabilityOrThrow,
} from "@/modules/checkout/services/checkout.capacity.service.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";
import { requireExpectedVoucherQuote } from "@/modules/checkout/checkout.voucher.validation.js";
import LocationModel from "@/modules/location/location.model.js";
import MembershipEntitlementBalanceModel from "@/modules/membership/membership-entitlement-balance.schema.js";
import {
  MEMBERSHIP_ALLOWANCE_UNIT,
  MEMBERSHIP_BENEFIT_TYPE,
  MEMBERSHIP_STATUS,
} from "@/modules/membership/membership.constants.js";
import { membershipRepository } from "@/modules/membership/membership.repository.js";
import { resolveMembershipProductDiscount } from "@/modules/membership/services/membership-discount.service.js";
import { membershipAllowsLocation } from "@/modules/membership/membership.location-policy.js";
import { applyMembershipDiscountToOrderLines } from "@/modules/checkout/services/checkout.discount.service.js";
import { unavailablePersonalCourseDiscounts } from "@/modules/checkout/services/checkout.membership-course.service.js";
import ProductModel from "@/modules/product/product.model.js";
import {
  COURSE_PRODUCT_TYPES,
  LEGACY_BOOKING_PRODUCT_TYPE,
  PUBLIC_PRODUCT_TYPES,
  PRODUCT_TYPE,
} from "@/modules/product/product.constants.js";
import {
  PRODUCT_KIND,
  type ProductKind,
} from "@/modules/product/product-kind-v2.contract.js";
import {
  resolveProductKindV2,
  resolveRequestedOpenStudioBookingMode,
  resolveProductPublicCapacityLimit,
  resolveProductPrivateBookingSurcharge,
} from "@/modules/product/product.utils.js";
import { assertProductKindEntitledForTenant } from "@/modules/product/product-plan-entitlements.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";
import UserModel from "@/modules/user/user.model.js";
import { resolveCreditBalanceMinor } from "@/modules/money-credit/money-credit.balance.js";
import {
  fromCurrencyMinorUnits,
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import {
  resolveRolloutEligibleAppLocale,
  type RolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";
import { AppError } from "@/shared/http/AppError.js";
import { buildUTCBookingRangeFromLocalInputs } from "@/shared/time/time.utils.js";
import { resolveTenantCommerceOrigin } from "@/modules/checkout/checkout.urls.js";

import BookingIntentModel from "./booking-intent.model.js";
import type {
  CheckoutBookingIntentInput,
  CreateBookingIntentInput,
} from "./booking-intent.validators.js";

const INTENT_TTL_SECONDS = 30 * 60;
const CHECKOUT_LEASE_MS = 2 * 60 * 1000;
const TOKEN_ISSUER = "shario-api";
const TOKEN_AUDIENCE = "booking-intent";

type IntentTokenPayload = JwtPayload & {
  typ: "booking_intent";
  jti: string;
  tenant: string;
  tenantSlug: string;
};

type CanonicalPayload = {
  productId: string;
  locationId: string | null;
  courseSlotId: string | null;
  start: Date | null;
  end: Date | null;
  quantity: number;
  numberOfGuests: number;
  bookingMode: "public" | "private" | undefined;
  bookingType: "public" | "private" | undefined;
  plannedActivity: "WORKSTATION" | "SHARED_TABLE" | "UNDEFINED";
  locale: RolloutEligibleAppLocale;
};

const toId = (value: unknown): string =>
  String((value as { _id?: unknown } | null)?._id ?? value ?? "").trim();

const getIntentSecret = (): string => {
  const secret = String(
    process.env.BOOKING_INTENT_SECRET || process.env.ACCESS_TOKEN_SECRET || "",
  ).trim();

  if (secret.length < 32) {
    throw new Error(
      "BOOKING_INTENT_SECRET or ACCESS_TOKEN_SECRET must contain at least 32 characters.",
    );
  }

  return secret;
};

const hashJson = (value: unknown): string =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const signIntentToken = ({
  jti,
  tenantId,
  tenantSlug,
}: {
  jti: string;
  tenantId: string;
  tenantSlug: string;
}): string =>
  jwt.sign(
    {
      typ: "booking_intent",
      jti,
      tenant: tenantId,
      tenantSlug,
    } satisfies IntentTokenPayload,
    getIntentSecret(),
    {
      algorithm: "HS256",
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      expiresIn: INTENT_TTL_SECONDS,
    },
  );

const verifyIntentToken = (token: string): IntentTokenPayload => {
  try {
    const decoded = jwt.verify(token, getIntentSecret(), {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });

    if (
      typeof decoded === "string" ||
      decoded.typ !== "booking_intent" ||
      typeof decoded.jti !== "string" ||
      typeof decoded.tenant !== "string" ||
      typeof decoded.tenantSlug !== "string"
    ) {
      badRequest({
        message: "Booking intent is invalid or has expired.",
        code: "INVALID_BOOKING_INTENT",
      });
    }

    return decoded as IntentTokenPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError({
        statusCode: 410,
        message: "Booking intent has expired.",
        code: "BOOKING_INTENT_EXPIRED",
      });
    }

    if (
      error instanceof jwt.JsonWebTokenError ||
      error instanceof jwt.NotBeforeError
    ) {
      badRequest({
        message: "Booking intent is invalid or has expired.",
        code: "INVALID_BOOKING_INTENT",
      });
    }

    throw error;
  }
};

const canonicalizeInput = (
  input: CreateBookingIntentInput,
): CanonicalPayload => ({
  productId: input.productId,
  locationId: input.locationId ?? null,
  courseSlotId: input.courseSlotId ?? null,
  start: input.start ? new Date(input.start) : null,
  end: input.end ? new Date(input.end) : null,
  quantity: input.quantity,
  numberOfGuests: input.numberOfGuests,
  bookingMode: input.bookingMode,
  bookingType: input.bookingMode,
  plannedActivity: input.plannedActivity,
  locale: input.locale,
});

const isCourseType = (type: unknown, kind?: unknown): boolean =>
  kind === PRODUCT_KIND.CLASS ||
  (COURSE_PRODUCT_TYPES as readonly string[]).includes(String(type ?? ""));

const isTimedType = (type: unknown, kind?: unknown): boolean => {
  if (kind === PRODUCT_KIND.OPEN_STUDIO) return true;
  const normalized = String(type ?? "");

  return (
    normalized === PRODUCT_TYPE.WORKSHOP ||
    normalized === PRODUCT_TYPE.SERVICE ||
    normalized === LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP ||
    normalized === LEGACY_BOOKING_PRODUCT_TYPE.PRIVATE_WORKSHOP
  );
};

const assertBookingIntentModules = ({
  tenant,
  productType,
  productKind,
}: {
  tenant: TenantDocument;
  productType: unknown;
  productKind?: ProductKind | null;
}): void => {
  const modules = tenant.modules;
  const type = String(productType ?? "");

  assertProductKindEntitledForTenant({ tenant, kind: productKind ?? null });

  if (modules?.[TENANT_MODULE.PAYMENTS] !== true) {
    forbidden({
      message: "Online booking is unavailable for this workspace.",
      code: "TENANT_MODULE_REQUIRED",
      details: { requiredModule: TENANT_MODULE.PAYMENTS },
    });
  }

  if (
    isCourseType(type, productKind) &&
    modules?.[TENANT_MODULE.COURSES] !== true
  ) {
    forbidden({
      message: "Class booking is unavailable for this workspace.",
      code: "TENANT_MODULE_REQUIRED",
      details: { requiredModule: TENANT_MODULE.COURSES },
    });
  }

  if (
    type === PRODUCT_TYPE.SERVICE &&
    modules?.[TENANT_MODULE.BOOKINGS] !== true &&
    modules?.[TENANT_MODULE.FIRING] !== true
  ) {
    forbidden({
      message: "This service is unavailable for this workspace.",
      code: "TENANT_MODULE_REQUIRED",
      details: {
        requiredModules: [TENANT_MODULE.BOOKINGS, TENANT_MODULE.FIRING],
      },
    });
  }

  if (
    isTimedType(type, productKind) &&
    type !== PRODUCT_TYPE.SERVICE &&
    modules?.[TENANT_MODULE.BOOKINGS] !== true
  ) {
    forbidden({
      message: "Studio booking is unavailable for this workspace.",
      code: "TENANT_MODULE_REQUIRED",
      details: { requiredModule: TENANT_MODULE.BOOKINGS },
    });
  }
};

type ZonedParts = {
  date: string;
  weekday: string;
  minuteOfDay: number;
  second: number;
};

const getZonedParts = (date: Date, timeZone: string): ZonedParts => {
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
  const hour = Number(values.hour);
  const minute = Number(values.minute);

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: String(values.weekday || "").toLowerCase(),
    minuteOfDay: hour * 60 + minute,
    second: Number(values.second),
  };
};

const assertTimedRange = ({
  payload,
  location,
  now,
}: {
  payload: CanonicalPayload;
  location: any;
  now: Date;
}): { durationMinutes: number; billingBlocks: number } => {
  if (!payload.start || !payload.end) {
    badRequest({
      message: "A start and end time are required.",
      code: "BOOKING_TIME_REQUIRED",
    });
  }

  const startMs = payload.start.getTime();
  const endMs = payload.end.getTime();

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    badRequest({
      message: "The selected booking time is invalid.",
      code: "BOOKING_TIME_INVALID",
    });
  }

  if (startMs <= now.getTime()) {
    conflict({
      message: "The selected booking time is in the past.",
      code: "BOOKING_TIME_IN_PAST",
    });
  }

  const durationMs = endMs - startMs;
  const durationMinutes = durationMs / 60_000;

  if (!Number.isSafeInteger(durationMinutes)) {
    badRequest({
      message: "Booking duration must use whole minutes.",
      code: "BOOKING_DURATION_INVALID",
    });
  }

  const minMinutes = Math.max(
    15,
    Number(location.booking?.minBookingMinutes ?? 60),
  );
  const maxMinutes = Math.max(
    minMinutes,
    Number(location.booking?.maxBookingMinutes ?? 360),
  );
  const stepMinutes = Math.max(
    15,
    Number(location.booking?.slotStepMinutes ?? 30),
  );

  if (
    durationMinutes < minMinutes ||
    durationMinutes > maxMinutes ||
    durationMinutes % stepMinutes !== 0
  ) {
    badRequest({
      message: "The selected booking duration is not allowed.",
      code: "BOOKING_DURATION_INVALID",
      details: { minMinutes, maxMinutes, stepMinutes },
    });
  }

  const timeZone = String(location.booking?.timezone || "Europe/Prague");
  const startParts = getZonedParts(payload.start, timeZone);
  const endParts = getZonedParts(payload.end, timeZone);

  if (
    startParts.minuteOfDay % stepMinutes !== 0 ||
    startParts.second !== 0 ||
    payload.start.getUTCMilliseconds() !== 0 ||
    endParts.second !== 0 ||
    payload.end.getUTCMilliseconds() !== 0
  ) {
    badRequest({
      message: "The selected time must align with the studio booking grid.",
      code: "BOOKING_TIME_STEP_INVALID",
      details: { stepMinutes },
    });
  }

  const openingHours = location.openingHours?.[startParts.weekday];

  if (!openingHours?.isOpen) {
    conflict({
      message: "The studio is closed at the selected time.",
      code: "BOOKING_OUTSIDE_OPENING_HOURS",
    });
  }

  const openingRange = buildUTCBookingRangeFromLocalInputs({
    date: startParts.date,
    startTime: String(openingHours.openTime || "06:00"),
    endTime:
      String(openingHours.closeTime || "24:00") === "24:00"
        ? "00:00"
        : String(openingHours.closeTime),
    timezone: timeZone,
  });

  if (
    !openingRange ||
    startMs < openingRange.start.getTime() ||
    endMs > openingRange.end.getTime()
  ) {
    conflict({
      message: "The selected time is outside studio opening hours.",
      code: "BOOKING_OUTSIDE_OPENING_HOURS",
    });
  }

  return {
    durationMinutes,
    billingBlocks: Math.ceil(durationMinutes / 30),
  };
};

const buildQuote = async ({
  tenantId,
  payload,
  userId,
  now = new Date(),
}: {
  tenantId: string;
  payload: CanonicalPayload;
  userId?: string;
  now?: Date;
}) => {
  const [tenant, product] = await Promise.all([
    TenantModel.findById(tenantId)
      .select("settings.currency modules plan planVersion")
      .exec(),
    ProductModel.findOne({
      _id: payload.productId,
      tenant: tenantId,
      isActive: true,
      isArchived: { $ne: true },
      type: { $in: PUBLIC_PRODUCT_TYPES },
    }).exec(),
  ]);

  if (!tenant || !product) {
    notFound({
      message: "The selected booking product is unavailable.",
      code: "BOOKING_PRODUCT_NOT_FOUND",
    });
  }

  const productKind = resolveProductKindV2(product);

  assertBookingIntentModules({
    tenant,
    productType: product.type,
    productKind,
  });

  const currency = normalizeStudioCommerceCurrency(product.currency);
  const tenantCurrency = normalizeStudioCommerceCurrency(
    tenant.settings?.currency,
  );

  if (currency !== tenantCurrency) {
    badRequest({
      message: "Product currency does not match the studio currency.",
      code: "TENANT_PRODUCT_CURRENCY_MISMATCH",
    });
  }

  let location: any = null;
  let courseSlot: any = null;
  let durationMinutes = 0;
  let billableUnits = 0;
  let participantCount = payload.numberOfGuests;

  if (isCourseType(product.type, productKind)) {
    if (!payload.courseSlotId) {
      badRequest({
        message: "A Class session is required.",
        code: "BOOKING_COURSE_SLOT_REQUIRED",
      });
    }

    courseSlot = await BookingModel.findOne({
      _id: payload.courseSlotId,
      tenant: tenantId,
      bookingProduct: product._id,
      tag: { $in: CLASS_BOOKING_TAGS },
      archive: { $ne: true },
      status: { $ne: BOOKING_STATUS.CANCELLED },
      start: { $gt: now },
    })
      .select(
        "_id location start end numberOfGuests capacityReservations bookingProduct",
      )
      .lean()
      .exec();

    if (!courseSlot) {
      conflict({
        message: "The selected Class session is no longer available.",
        code: "BOOKING_COURSE_SLOT_UNAVAILABLE",
      });
    }

    const capacity = Number(product.maxNumberOfParticipants);
    const held = (courseSlot.capacityReservations || []).reduce(
      (sum: number, reservation: any) =>
        new Date(reservation.expiresAt).getTime() > now.getTime()
          ? sum + Math.max(0, Number(reservation.quantity) || 0)
          : sum,
      0,
    );
    const occupied = Math.max(0, Number(courseSlot.numberOfGuests) || 0);
    const available = Math.max(0, capacity - occupied - held);

    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      payload.quantity > available
    ) {
      conflict({
        message: "The selected Class does not have enough available places.",
        code: "BOOKING_COURSE_CAPACITY_EXCEEDED",
        details: { available, requested: payload.quantity },
      });
    }

    billableUnits = payload.quantity;
    participantCount = payload.quantity;
    payload.numberOfGuests = payload.quantity;
    payload.bookingMode = "public";
    payload.bookingType = "public";
    payload.plannedActivity = "UNDEFINED";
    payload.locationId = toId(courseSlot.location);
    payload.start = new Date(courseSlot.start);
    payload.end = new Date(courseSlot.end);
    durationMinutes = Math.max(
      0,
      Math.round((payload.end.getTime() - payload.start.getTime()) / 60_000),
    );

    location = await LocationModel.findOne({
      _id: payload.locationId,
      tenant: tenantId,
      isActive: true,
    })
      .select("name slug address booking.timezone")
      .lean()
      .exec();

    if (!location) {
      conflict({
        message: "The Class location is no longer available.",
        code: "BOOKING_COURSE_LOCATION_UNAVAILABLE",
      });
    }
  } else if (isTimedType(product.type, productKind)) {
    if (!payload.locationId) {
      badRequest({
        message: "A studio location is required.",
        code: "BOOKING_LOCATION_REQUIRED",
      });
    }

    assertStudioProductLocation(product, payload.locationId);

    location = await LocationModel.findOne({
      _id: payload.locationId,
      tenant: tenantId,
      isActive: true,
      "booking.enabled": true,
    })
      .select("name slug isActive address booking openingHours")
      .lean()
      .exec();

    if (!location) {
      notFound({
        message: "The selected studio location is unavailable.",
        code: "BOOKING_LOCATION_NOT_FOUND",
      });
    }

    const normalizedRange = assertTimedRange({
      payload,
      location,
      now,
    });
    durationMinutes = normalizedRange.durationMinutes;

    /*
     * Booking semantics come from the persisted product policy. The browser
     * cannot relax overlap rules, and party size never changes the mode.
     */
    const productBookingMode = resolveRequestedOpenStudioBookingMode(
      product,
      payload.bookingMode,
    );

    if (!productBookingMode) {
      badRequest({
        message: "Open Studio does not have a booking mode configured.",
        code: "OPEN_STUDIO_BOOKING_MODE_REQUIRED",
      });
    }

    payload.bookingMode = productBookingMode;
    payload.bookingType = productBookingMode;

    payload.plannedActivity = resolveLocationBookingPlannedActivity({
      location,
      plannedActivity: payload.plannedActivity,
    });

    const maxParticipants = Number(product.maxNumberOfParticipants ?? 1);

    if (
      payload.numberOfGuests > maxParticipants &&
      product.bookingMode !== "customer-choice"
    ) {
      conflict({
        message: "The selected product does not allow this many guests.",
        code: "BOOKING_PRODUCT_CAPACITY_EXCEEDED",
        details: {
          maximum: maxParticipants,
          requested: payload.numberOfGuests,
        },
      });
    }

    const currentBookings = await BookingModel.find({
      tenant: tenantId,
      location: payload.locationId,
      start: { $lt: payload.end },
      end: { $gt: payload.start },
      tag: {
        $in: [...OPEN_STUDIO_BOOKING_TAGS, ...CLASS_BOOKING_TAGS, ...INTERNAL_STUDIO_BOOKING_TAGS],
      },
    })
      .select(
        "bookingProduct location start end numberOfGuests publicCapacityLimit customerChoiceBooking capacityReservations waitlistCapacityHolds bookingMode bookingType plannedActivity courseEquipmentRequired tag status archive paymentStatus paymentExpiresAt",
      )
      .lean()
      .exec();

    await loadCourseCapacityForBookings({ bookings: currentBookings, tenantId });
    validateOpenStudioAvailabilityOrThrow({
      openStudioBookings: [
        {
          location: payload.locationId,
          start: payload.start,
          end: payload.end,
          numberOfGuests: payload.numberOfGuests,
          bookingMode: payload.bookingMode,
          bookingType: payload.bookingType,
          customerChoiceBooking: product.bookingMode === "customer-choice",
          publicCapacityLimit:
            payload.bookingMode === "public"
              ? resolveProductPublicCapacityLimit(product)
              : null,
          plannedActivity: payload.plannedActivity,
          tag: BOOKING_TAG.OPEN_STUDIO,
        },
      ],
      currentBookings: currentBookings.filter((booking) =>
        isActiveCapacityBooking(booking, now),
      ),
      locationById: new Map([[payload.locationId, location]]),
    });

    billableUnits = normalizedRange.billingBlocks * payload.numberOfGuests;
  } else {
    badRequest({
      message: "This product cannot be booked with a booking intent.",
      code: "BOOKING_PRODUCT_TYPE_UNSUPPORTED",
    });
  }

  const unitPriceMajor =
    Number(product.price) +
    (product.bookingMode !== "customer-choice" &&
      !isCourseType(product.type, productKind) &&
      payload.numberOfGuests === 1 &&
      payload.bookingType === "private"
      ? Number(product.extraCharge || 0)
      : 0);
  const unitPriceMinor = toCurrencyMinorUnits(unitPriceMajor, currency);
  const privateBookingSurchargeMinor =
    payload.bookingMode === "private"
      ? toCurrencyMinorUnits(resolveProductPrivateBookingSurcharge(product), currency)
      : 0;
  const subtotalAmountMinor =
    unitPriceMinor * billableUnits + privateBookingSurchargeMinor;

  if (!Number.isSafeInteger(subtotalAmountMinor) || subtotalAmountMinor < 0) {
    badRequest({
      message: "The server-calculated booking price is invalid.",
      code: "BOOKING_PRICE_INVALID",
    });
  }

  const discount = userId
    ? await resolveMembershipProductDiscount({
        tenantId,
        userId,
        orderLocationIds: payload.locationId ? [payload.locationId] : [],
      })
    : null;
  const courseId = courseSlot ? toId(courseSlot) : "";
  const blockedCourses = discount?.memberOnly && userId && courseId
    ? await unavailablePersonalCourseDiscounts({ tenantId, userId, bookingIds: [courseId] })
    : new Set<string>();
  const isPrivateChoice = product.bookingMode === "customer-choice" && payload.bookingMode === "private";
  const { amountMinor: discountAmountMinor } = applyMembershipDiscountToOrderLines({
    discount,
    lineItems: [{ product: toId(product), booking: courseId, locationIds: payload.locationId ? [payload.locationId] : [], unitGrossMinor: isPrivateChoice ? subtotalAmountMinor : unitPriceMinor, quantity: isPrivateChoice ? 1 : billableUnits, taxRateBps: 0 }],
    eligibleCourseBookingIds: productKind === PRODUCT_KIND.CLASS && courseId ? new Set([courseId]) : new Set(),
    unavailableCourseBookingIds: blockedCourses,
  });
  const totalAmountMinor = subtotalAmountMinor - discountAmountMinor;

  return {
    quotedAt: now.toISOString(),
    currency,
    unitPriceMinor,
    privateBookingSurchargeMinor,
    billableUnits,
    participantCount,
    durationMinutes,
    subtotalAmountMinor,
    discountAmountMinor,
    totalAmountMinor,
    // Compact aliases used by the customer booking shell.
    subtotalMinor: subtotalAmountMinor,
    discountMinor: discountAmountMinor,
    totalMinor: totalAmountMinor,
    subtotalMajor: fromCurrencyMinorUnits(subtotalAmountMinor, currency),
    totalMajor: fromCurrencyMinorUnits(totalAmountMinor, currency),
    discount: discount && discountAmountMinor > 0
      ? {
          source: "membership",
          label: discount.benefitLabel,
          percentageBps: discount.percentageBps,
        }
      : null,
    product: {
      id: toId(product),
      name: product.name,
      type: product.type,
      kind: productKind,
      bookingMode:
        productKind === PRODUCT_KIND.OPEN_STUDIO ? payload.bookingMode : null,
      currency,
    },
    location: location
      ? {
          id: toId(location),
          name: location.name,
          timezone: location.booking?.timezone,
        }
      : courseSlot?.location
        ? { id: toId(courseSlot.location) }
        : null,
    courseSlot: courseSlot
      ? {
          id: toId(courseSlot),
          start: courseSlot.start,
          end: courseSlot.end,
        }
      : null,
    startsAt: payload.start,
    endsAt: payload.end,
  };
};

export const requireBookingCustomerAccount = async ({
  tenantId,
  userId,
}: {
  tenantId: string;
  userId: string;
}) => {
  const user = await UserModel.findOne({
    _id: userId,
    tenant: tenantId,
    isAccessGranted: true,
  })
    .select(
      "firstname lastname email phone customId moneyCredits moneyCreditsMinor isEmailVerified +tenantRole +platformRole",
    )
    .exec();

  if (!user) {
    notFound({
      message: "Customer account not found.",
      code: "CUSTOMER_ACCOUNT_NOT_FOUND",
    });
  }

  if (String(user.platformRole || "none") !== "none") {
    forbidden({
      message: "Platform accounts cannot complete customer bookings.",
      code: "CUSTOMER_CONTEXT_PLATFORM_ACCOUNT_FORBIDDEN",
    });
  }

  return user;
};

const getMembershipPaymentOptions = async ({
  tenantId,
  userId,
  payload,
  quote,
}: {
  tenantId: string;
  userId: string;
  payload: CanonicalPayload;
  quote: Awaited<ReturnType<typeof buildQuote>>;
}) => {
  const membership = await membershipRepository.findActiveUserMembership(
    tenantId,
    userId,
  );

  if (
    !membership ||
    ![MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED].includes(
      membership.status as never,
    ) ||
    (membership.currentPeriodEnd && membership.currentPeriodEnd <= new Date())
  ) {
    return [];
  }

  if (!membershipAllowsLocation(membership, payload.locationId)) {
    return [];
  }

  const balances = await MembershipEntitlementBalanceModel.find({
    tenant: tenantId,
    user: userId,
    membership: membership._id,
    available: { $gt: 0 },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
    .lean()
    .exec();
  const balanceByKey = new Map(
    balances.map((balance) => [balance.benefitKey, balance]),
  );
  const durationMinutes = Number(quote.durationMinutes || 0);

  return (membership.planSnapshot.benefits || [])
    .filter(
      (benefit: any) => benefit.type === MEMBERSHIP_BENEFIT_TYPE.ALLOWANCE,
    )
    .flatMap((benefit: any) => {
      const balance: any = balanceByKey.get(String(benefit.key));
      const unit = String(benefit.unit || "");
      let required: number | null = null;

      switch (unit) {
        case MEMBERSHIP_ALLOWANCE_UNIT.MINUTE:
          required = Math.max(1, durationMinutes);
          break;
        case MEMBERSHIP_ALLOWANCE_UNIT.HOUR:
          required = Math.max(1, Math.ceil(durationMinutes / 60));
          break;
        case MEMBERSHIP_ALLOWANCE_UNIT.BOOKING:
        case MEMBERSHIP_ALLOWANCE_UNIT.SESSION:
        case MEMBERSHIP_ALLOWANCE_UNIT.VISIT:
          required = 1;
          break;
        case MEMBERSHIP_ALLOWANCE_UNIT.MONEY_MINOR:
          required = quote.totalAmountMinor;
          break;
        default:
          return [];
      }

      const available = Number(balance?.available || 0);
      const requiresMoneyForSurcharge =
        quote.privateBookingSurchargeMinor > 0 &&
        (unit !== MEMBERSHIP_ALLOWANCE_UNIT.MONEY_MINOR ||
          String(benefit.currency || "").toUpperCase() !== quote.currency);
      const personalAllowance = [MEMBERSHIP_ALLOWANCE_UNIT.MINUTE, MEMBERSHIP_ALLOWANCE_UNIT.HOUR].includes(unit as any) || benefit.usageScope === "open_studio" || benefit.memberOnly === true;
      const periodStart = new Date(membership.currentPeriodStart).getTime();
      const periodEnd = new Date(membership.currentPeriodEnd).getTime();
      const withinPaidPeriod = Number.isFinite(periodStart) && Number.isFinite(periodEnd) && new Date(payload.start).getTime() >= periodStart && new Date(payload.end).getTime() <= periodEnd;
      const unavailableReason = personalAllowance && (quote.product.kind !== PRODUCT_KIND.OPEN_STUDIO || quote.product.bookingMode !== "public")
        ? "membership_open_studio_only"
        : personalAllowance && quote.participantCount !== 1
          ? "membership_member_only"
          : personalAllowance && !withinPaidPeriod
            ? "membership_outside_paid_period"
          : requiresMoneyForSurcharge
            ? "private_booking_surcharge_requires_money"
            : available < required ? "membership_insufficient_hours" : null;

      return [
        {
          method: "membership_credits" as const,
          benefitKey: String(benefit.key),
          label: String(benefit.label || benefit.key),
          unit,
          required,
          available,
          coversTotal: unavailableReason === null,
          ...(unavailableReason ? { unavailableReason } : {}),
        },
      ];
    });
};

const getPaymentOptions = async ({
  tenantId,
  user,
  payload,
  quote,
}: {
  tenantId: string;
  user: any;
  payload: CanonicalPayload;
  quote: Awaited<ReturnType<typeof buildQuote>>;
}) => {
  const moneyAvailableMinor = resolveCreditBalanceMinor({
    moneyCreditsMinor: user.moneyCreditsMinor,
    moneyCredits: user.moneyCredits,
    currency: quote.currency as StudioCommerceCurrency,
  });
  const moneyAvailableMajor = fromCurrencyMinorUnits(
    moneyAvailableMinor,
    quote.currency as StudioCommerceCurrency,
  );
  const membershipOptions = await getMembershipPaymentOptions({
    tenantId,
    userId: toId(user),
    payload,
    quote,
  });

  return [
    {
      method: "card" as const,
      available: true,
    },
    {
      method: "money_credits" as const,
      availableMajor: moneyAvailableMajor,
      availableMinor: moneyAvailableMinor,
      totalMajor: quote.totalMajor,
      coversTotal: moneyAvailableMinor >= quote.totalAmountMinor,
    },
    ...membershipOptions,
  ];
};

const tokenRecord = async ({
  token,
  tenantId,
}: {
  token: string;
  tenantId?: string;
}) => {
  const decoded = verifyIntentToken(token);

  if (tenantId && decoded.tenant !== tenantId) {
    notFound({
      message: "Booking intent not found.",
      code: "BOOKING_INTENT_NOT_FOUND",
    });
  }

  const record = await BookingIntentModel.findOne({
    tenant: decoded.tenant,
    tenantSlug: decoded.tenantSlug,
    jti: decoded.jti,
    expiresAt: { $gt: new Date() },
  }).exec();

  if (!record) {
    notFound({
      message: "Booking intent not found.",
      code: "BOOKING_INTENT_NOT_FOUND",
    });
  }

  return { decoded, record };
};

const toCanonicalRecordPayload = (record: any): CanonicalPayload => ({
  productId: toId(record.payload.productId),
  locationId: toId(record.payload.locationId) || null,
  courseSlotId: toId(record.payload.courseSlotId) || null,
  start: record.payload.start ? new Date(record.payload.start) : null,
  end: record.payload.end ? new Date(record.payload.end) : null,
  quantity: Number(record.payload.quantity),
  numberOfGuests: Number(record.payload.numberOfGuests),
  bookingMode:
    record.payload.bookingMode ?? record.payload.bookingType ?? "private",
  bookingType:
    record.payload.bookingMode ?? record.payload.bookingType ?? "private",
  plannedActivity: record.payload.plannedActivity,
  // Booking intents created before the canonical contract may contain `CZ`
  // or a browser locale such as `cs-CZ`. Read them without rewriting the
  // immutable snapshot and expose the canonical locale downstream.
  locale: resolveRolloutEligibleAppLocale(record.payload.locale),
});

const claimIntent = async ({
  token,
  tenantId,
  userId,
}: {
  token: string;
  tenantId: string;
  userId: string;
}) => {
  const { decoded } = await tokenRecord({ token, tenantId });
  const record = await BookingIntentModel.findOneAndUpdate(
    {
      tenant: tenantId,
      jti: decoded.jti,
      expiresAt: { $gt: new Date() },
      $or: [{ claimedBy: null }, { claimedBy: userId }],
    },
    {
      $set: { claimedBy: userId },
    },
    { returnDocument: "after" },
  ).exec();

  if (!record) {
    notFound({
      message: "Booking intent not found.",
      code: "BOOKING_INTENT_NOT_FOUND",
    });
  }

  return record;
};

export const createSignedBookingIntent = async ({
  tenant,
  input,
}: {
  tenant: TenantDocument;
  input: CreateBookingIntentInput;
}) => {
  const tenantId = toId(tenant);
  const payload = canonicalizeInput(input);
  const quote = await buildQuote({ tenantId, payload });
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INTENT_TTL_SECONDS * 1000);

  await BookingIntentModel.create({
    tenant: tenantId,
    tenantSlug: tenant.slug,
    jti,
    payload,
    expiresAt,
  });

  return {
    token: signIntentToken({
      jti,
      tenantId,
      tenantSlug: tenant.slug,
    }),
    expiresAt,
    quote,
  };
};

export const restoreBookingIntent = async ({
  token,
  tenantId,
  userId,
}: {
  token: string;
  tenantId: string;
  userId: string;
}) => {
  const user = await requireBookingCustomerAccount({ tenantId, userId });
  const record = await claimIntent({ token, tenantId, userId });
  const payload = toCanonicalRecordPayload(record);
  // Checkout creation durably records the purchased quote, including pending
  // card payments. Reopening that checkout must not reprice or reassign it
  // from a product that has since changed location or become unavailable.
  const completedQuote = record.checkout?.status === "completed"
    ? record.checkout.response?.quote as Awaited<ReturnType<typeof buildQuote>> | undefined
    : undefined;
  const quote = completedQuote ?? await buildQuote({ tenantId, payload, userId });
  const paymentOptions = await getPaymentOptions({
    tenantId,
    user,
    payload,
    quote,
  });

  return {
    token,
    expiresAt: record.expiresAt,
    intent: {
      productId: payload.productId,
      product: quote.product,
      locationId: payload.locationId,
      location: quote.location,
      courseSlotId: payload.courseSlotId,
      start: payload.start,
      end: payload.end,
      quantity: payload.quantity,
      numberOfGuests: payload.numberOfGuests,
      bookingMode: payload.bookingMode,
      bookingType: payload.bookingType,
      plannedActivity: payload.plannedActivity,
      locale: payload.locale,
    },
    quote,
    paymentOptions,
  };
};

const buildCartItem = (
  payload: CanonicalPayload,
  quote: Awaited<ReturnType<typeof buildQuote>>,
) => ({
  product: {
    _id: payload.productId,
    type: quote.product.type,
    kind: quote.product.kind,
    bookingMode: quote.product.bookingMode,
  },
  quantity: payload.quantity,
  locationId: payload.locationId ?? undefined,
  start: payload.start ?? undefined,
  end: payload.end ?? undefined,
  numberOfGuests: payload.numberOfGuests,
  bookingMode: payload.bookingMode,
  bookingType: payload.bookingType,
  plannedActivity: payload.plannedActivity,
  bookingCourse: payload.courseSlotId ?? undefined,
  language: payload.locale,
});

export const quoteBookingIntentVoucher = async ({ token, tenantId, userId, voucherCode }: {
  token: string; tenantId: string; userId: string; voucherCode: string;
}) => {
  const user = await requireBookingCustomerAccount({ tenantId, userId });
  const record = await claimIntent({ token, tenantId, userId });
  if (record.checkout?.status && record.checkout.status !== "idle") conflict({ code: "CHECKOUT_ALREADY_STARTED", message: "This booking checkout has already started. Complete or resolve its existing payment." });
  const payload = toCanonicalRecordPayload(record);
  const quote = await buildQuote({ tenantId, payload, userId });
  return checkoutService.quoteVoucherCheckout({ tenantId, user, cartItems: [buildCartItem(payload, quote)], voucherCode, currency: quote.currency, membershipDiscountEligible: true });
};

const acquireCheckoutLease = async ({
  record,
  userId,
  idempotencyKey,
  requestHash,
}: {
  record: any;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
}) => {
  const existing = record.checkout;

  if (existing?.status === "manual_review") {
    conflict({
      message:
        "This booking requires manual review before checkout can continue.",
      code: "BOOKING_INTENT_MANUAL_REVIEW_REQUIRED",
    });
  }

  if (existing?.idempotencyKey === idempotencyKey) {
    if (existing.requestHash !== requestHash) {
      conflict({
        message: "This idempotency key was used for a different request.",
        code: "IDEMPOTENCY_KEY_CONFLICT",
      });
    }

    if (existing.status === "completed" && existing.response) {
      return { replay: existing.response, leaseToken: "" };
    }
  } else if (existing?.status === "completed") {
    conflict({
      message: "This booking intent has already been checked out.",
      code: "BOOKING_INTENT_ALREADY_USED",
    });
  }

  const now = new Date();

  if (existing?.status === "processing") {
    const leaseExpiresAt = existing.leaseExpiresAt
      ? new Date(existing.leaseExpiresAt)
      : null;
    const hasLiveLease =
      leaseExpiresAt &&
      Number.isFinite(leaseExpiresAt.getTime()) &&
      leaseExpiresAt > now;

    if (hasLiveLease) {
      conflict({
        message: "This booking checkout is already being processed.",
        code: "BOOKING_INTENT_CHECKOUT_IN_PROGRESS",
      });
    }

    /*
     * A caught failure that was fully compensated explicitly resets the
     * intent to idle. Therefore a stale processing lease means the process
     * disappeared at an unknown point and a Stripe Session, credit debit or
     * booking may already exist. Fail closed instead of automatically taking
     * over the lease and risking a duplicate fulfillment.
     */
    await BookingIntentModel.updateOne(
      {
        _id: record._id,
        claimedBy: userId,
        "checkout.status": "processing",
        $or: [
          { "checkout.leaseExpiresAt": null },
          { "checkout.leaseExpiresAt": { $lte: now } },
        ],
      },
      {
        $set: {
          "checkout.status": "manual_review",
          "checkout.leaseExpiresAt": null,
          "checkout.lastErrorCode": "CHECKOUT_PROCESSING_LEASE_EXPIRED",
        },
        $unset: {
          "checkout.leaseToken": 1,
        },
      },
    ).exec();

    conflict({
      message:
        "This booking requires manual review before checkout can continue.",
      code: "BOOKING_INTENT_MANUAL_REVIEW_REQUIRED",
    });
  }

  const leaseToken = crypto.randomUUID();
  const leased = await BookingIntentModel.findOneAndUpdate(
    {
      _id: record._id,
      claimedBy: userId,
      expiresAt: { $gt: now },
      "checkout.status": "idle",
    },
    {
      $set: {
        "checkout.idempotencyKey": idempotencyKey,
        "checkout.requestHash": requestHash,
        "checkout.status": "processing",
        "checkout.leaseToken": leaseToken,
        "checkout.leaseExpiresAt": new Date(now.getTime() + CHECKOUT_LEASE_MS),
        "checkout.lastErrorCode": "",
      },
    },
    { returnDocument: "after" },
  ).exec();

  if (!leased) {
    conflict({
      message: "This booking checkout is already being processed.",
      code: "BOOKING_INTENT_CHECKOUT_IN_PROGRESS",
    });
  }

  return { replay: null, leaseToken };
};

export const checkoutBookingIntent = async ({
  token,
  tenantId,
  userId,
  idempotencyKey,
  input,
  requestOrigin,
}: {
  token: string;
  tenantId: string;
  userId: string;
  idempotencyKey: string;
  input: CheckoutBookingIntentInput;
  requestOrigin?: string;
}) => {
  if (input.voucherCode) requireExpectedVoucherQuote(input.expectedVoucherQuote);
  const user = await requireBookingCustomerAccount({ tenantId, userId });
  const record = await claimIntent({ token, tenantId, userId });
  const requestHash = hashJson({
    paymentMethod: input.paymentMethod,
    ...(input.voucherCode ? { voucherCode: input.voucherCode } : {}),
    ...(input.expectedVoucherQuote ? { expectedVoucherQuote: input.expectedVoucherQuote } : {}),
    membershipBenefitKey: input.membershipBenefitKey ?? null,
    termsAccepted: input.termsAccepted,
    locale: input.locale ?? null,
    origin: input.origin ?? requestOrigin ?? null,
  });
  const lease = await acquireCheckoutLease({
    record,
    userId,
    idempotencyKey,
    requestHash,
  });

  if (lease.replay) {
    return lease.replay;
  }

  let fulfillmentMayExist = false;

  try {
    const payload = toCanonicalRecordPayload(record);
    const quote = await buildQuote({ tenantId, payload, userId });
    const tenant = await TenantModel.findById(tenantId).exec();

    if (!tenant) {
      notFound("Tenant not found.");
    }

    const origin = resolveTenantCommerceOrigin({
      tenant,
      requestedOrigin: String(input.origin || requestOrigin || "").trim(),
    });
    const cartItems = [buildCartItem(payload, quote)];
    let result: any;

    const requiresCard =
      input.paymentMethod === "card" && (quote.totalAmountMinor > 0 || Boolean(input.voucherCode));

    if (requiresCard) {
      result = await checkoutService.createStripeCheckout({
        tenantId,
        user,
        cartItems,
        originUrl: origin,
        currency: quote.currency,
        creditsToApplyMajor: 0,
        locale: input.locale ?? payload.locale,
        membershipDiscountEligible: true,
        idempotencyKey,
        ...(input.voucherCode ? { voucherCode: input.voucherCode } : {}),
        ...(input.expectedVoucherQuote ? { expectedVoucherQuote: input.expectedVoucherQuote } : {}),
      });
    } else if (
      input.paymentMethod === "money_credits" ||
      quote.totalAmountMinor === 0
    ) {
      result = await checkoutService.checkoutWithCredits({
        tenantId,
        user,
        cartItems,
        originUrl: origin,
        paymentSource: "money_credits",
        ...(input.paymentMethod !== "money_credits"
          ? { requireZeroTotal: true }
          : {}),
        idempotencyKey,
        locale: input.locale ?? payload.locale,
      });
    } else {
      const paymentOptions = await getMembershipPaymentOptions({
        tenantId,
        userId,
        payload,
        quote,
      });
      const option = paymentOptions.find(
        (candidate) => candidate.benefitKey === input.membershipBenefitKey,
      );

      if (!option || !option.coversTotal) {
        conflict({
          message:
            "The selected membership allowance cannot cover this booking.",
          code: "MEMBERSHIP_ENTITLEMENT_INSUFFICIENT",
        });
      }

      result = await checkoutService.checkoutWithCredits({
        tenantId,
        user,
        cartItems,
        originUrl: origin,
        paymentSource: "membership_credits",
        membershipBenefitKey: option.benefitKey,
        membershipQuantity: option.required,
        idempotencyKey,
        locale: input.locale ?? payload.locale,
      });
    }

    /*
     * From here onward an external Checkout Session or a fully committed
     * credit booking may exist. If persisting the intent response fails, an
     * automatic retry could create a second payment/booking.
     */
    fulfillmentMayExist = true;

    const response = requiresCard && result.status !== "confirmed"
      ? {
          orderId: toId(result.orderId),
          url: result.url,
          status: "requires_payment",
          quote,
        }
      : {
          orderId: toId(result.orderId),
          status: "confirmed",
          confirmationUrl: result.url,
          quote,
        };

    const completed = await BookingIntentModel.updateOne(
      {
        _id: record._id,
        claimedBy: userId,
        "checkout.leaseToken": lease.leaseToken,
        "checkout.status": "processing",
      },
      {
        $set: {
          "checkout.status": "completed",
          "checkout.response": response,
          "checkout.leaseExpiresAt": null,
        },
        $unset: {
          "checkout.leaseToken": 1,
        },
      },
    ).exec();

    if (completed.modifiedCount !== 1) {
      throw new Error("Booking intent completion lease was lost.");
    }

    return response;
  } catch (error) {
    const requiresManualReview =
      error instanceof AggregateError || fulfillmentMayExist;
    const failureCode =
      error instanceof AggregateError
        ? "CHECKOUT_ROLLBACK_INCOMPLETE"
        : fulfillmentMayExist
          ? "CHECKOUT_FINALIZATION_UNCERTAIN"
          : String((error as { code?: unknown })?.code || "CHECKOUT_FAILED");

    const failureUpdate = await BookingIntentModel.updateOne(
      {
        _id: record._id,
        claimedBy: userId,
        "checkout.leaseToken": lease.leaseToken,
      },
      {
        $set: {
          "checkout.status": requiresManualReview ? "manual_review" : "idle",
          "checkout.leaseExpiresAt": null,
          "checkout.lastErrorCode": failureCode,
        },
        $unset: {
          "checkout.leaseToken": 1,
        },
      },
    ).exec();

    /*
     * If a stale lease was replaced while the payment provider or fulfillment
     * call was running, make the intent terminal unless the replacement
     * already committed a completed response. This deliberately favors a
     * recoverable manual review over a possible duplicate charge.
     */
    if (requiresManualReview && failureUpdate.modifiedCount !== 1) {
      await BookingIntentModel.updateOne(
        {
          _id: record._id,
          claimedBy: userId,
          "checkout.status": { $ne: "completed" },
        },
        {
          $set: {
            "checkout.status": "manual_review",
            "checkout.leaseExpiresAt": null,
            "checkout.lastErrorCode": failureCode,
          },
          $unset: {
            "checkout.leaseToken": 1,
          },
        },
      ).exec();
    }

    throw error;
  }
};

export const bookingIntentService = {
  create: createSignedBookingIntent,
  restore: restoreBookingIntent,
  checkout: checkoutBookingIntent,
  quoteVoucher: quoteBookingIntentVoucher,
};

export default bookingIntentService;
