import mongoose, { type Types } from "mongoose";

import { badRequest } from "../../../shared/http/httpErrors.js";
import { getNumberOfHours } from "@/modules/booking/booking.utils.js";
import {
  buildUTCBookingRangeFromLocalInputs,
  parseDateStringInTimezone,
  parseTimeString,
} from "@/shared/time/time.utils.js";
import {
  BOOKING_STATUS,
  BOOKING_TAG,
  BOOKING_TYPE,
  CLASS_BOOKING_TAGS,
  DEFAULT_LANGUAGE,
  type BookingLanguage,
  type BookingTag,
  PAYMENT_STATUS,
  SUPPORTED_LANGUAGES,
} from "@/modules/booking/booking.constants.js";
import { createBookingRepository } from "@/modules/booking/booking.repository.js";
import { locationRepository } from "@/modules/location/location.repository.js";
import { createOrderRepository } from "@/modules/order/order.repository.js";
import { createProductRepository } from "@/modules/product/product.repository.js";
import { PRODUCT_KIND } from "@/modules/product/product-kind-v2.contract.js";
import { resolveProductKindV2 } from "@/modules/product/product.utils.js";
import { assertStudioProductLocation } from "@/modules/product/product-location.policy.js";
import { createUserRepository } from "@/modules/user/user.repository.js";
import type {
  Booking as BookingEntity,
  IdLike,
  TenantId,
} from "../booking.types.js";

const sameId = (a: unknown, b: unknown): boolean =>
  String(a ?? "") === String(b ?? "");

const toIdString = (value: IdLike | TenantId): string => String(value);

const toObjectId = (value: IdLike | TenantId): Types.ObjectId => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return new mongoose.Types.ObjectId(String(value));
};

const toDecimal128 = (value: number): Types.Decimal128 => {
  return mongoose.Types.Decimal128.fromString(String(value));
};

type CreateCourseBookingInput = {
  createdBy?: IdLike;
  dates?: string[];
  startTime?: string;
  endTime?: string;
  bookingProduct?: IdLike;
  bookingRefs?: unknown[];
  lecturer?: string;
  isRoot?: boolean;
  description?: string;
  note?: string;
  locationId?: IdLike;
  language?: BookingLanguage;
};

type CreateCourseBookingRecordsArgs = {
  tenantId: TenantId;
  input: CreateCourseBookingInput;
};

type CourseBookingInsert = Partial<BookingEntity>;

export const createCourseBookingRecords = async ({
  tenantId,
  input,
}: CreateCourseBookingRecordsArgs) => {
  const {
    createdBy,
    dates,
    startTime,
    endTime,
    bookingProduct,
    bookingRefs,
    lecturer,
    isRoot,
    description,
    note,
    locationId,
    language,
  } = input;

  if (
    !createdBy ||
    !dates ||
    !startTime ||
    !endTime ||
    !bookingProduct ||
    !locationId
  ) {
    badRequest("Missing mandatory params");
  }

  if (!Array.isArray(dates) || dates.length === 0) {
    badRequest("Booking date is missing");
  }

  if (!mongoose.Types.ObjectId.isValid(String(locationId))) {
    badRequest("Invalid location id");
  }

  if (!parseTimeString(startTime) || !parseTimeString(endTime)) {
    badRequest("Invalid start or end time");
  }

  const tenantIdString = toIdString(tenantId);
  const createdByString = toIdString(createdBy);
  const bookingProductString = toIdString(bookingProduct);

  const userRepository = createUserRepository({ tenantId: tenantIdString });
  const productRepository = createProductRepository({
    tenantId: tenantIdString,
  });
  const bookingRepository = createBookingRepository({
    tenantId: tenantIdString,
  });

  const [user, product, location] = await Promise.all([
    userRepository.findById(createdBy, {
      lean: false,
      includePrivateRoles: true,
    }),
    productRepository.findById(bookingProductString, {
      lean: false,
    }),
    locationRepository.findByIdForTenant(tenantIdString, String(locationId)),
  ]);

  if (!user) badRequest("User not found");
  if (!product) badRequest("Booking product not found!");
  if (!location?.isActive || !location.booking?.enabled) {
    badRequest("Studio location is not available for bookings.");
  }

  assertStudioProductLocation(product, locationId);

  const locationTimezone = location.booking.timezone;

  const normalizedLanguage: BookingLanguage = SUPPORTED_LANGUAGES.includes(
    language as BookingLanguage,
  )
    ? (language as BookingLanguage)
    : DEFAULT_LANGUAGE;

  const productKind = resolveProductKindV2(product);
  let tag: BookingTag;

  if (productKind === PRODUCT_KIND.PRIVATE_STUDIO) {
    tag = BOOKING_TAG.PRIVATE_STUDIO;
  } else if (productKind === PRODUCT_KIND.CLASS) {
    tag = BOOKING_TAG.CLASS;
  } else {
    badRequest(
      "Only Class and Private Studio products can create calendar sessions.",
    );
  }

  const records: CourseBookingInsert[] = dates.map((date) => {
    const parsedDate = parseDateStringInTimezone(date, locationTimezone);

    if (!parsedDate) {
      badRequest(`Invalid date in dates array: ${date}`);
    }

    const range = buildUTCBookingRangeFromLocalInputs({
      date,
      startTime,
      endTime,
      timezone: locationTimezone,
    });

    if (!range) {
      badRequest(`Failed to create booking range for date: ${date}`);
    }

    return {
      createdBy: toObjectId(createdByString),
      createdAt: new Date(),
      start: range.start,
      end: range.end,
      bookingProduct: toObjectId(bookingProduct),
      author: {
        name: user.firstname,
        customId: user.customId,
        memberNumber: user.memberNumber ?? undefined,
      },
      numberOfHours: toDecimal128(getNumberOfHours(range.start, range.end)),
      lecturer,
      language: normalizedLanguage,
      description,
      status: BOOKING_STATUS.PROCESSED,
      paymentStatus: PAYMENT_STATUS.CONFIRMED,
      tag,
      bookingType: BOOKING_TYPE.PRIVATE,
      bookingMode: null,
      bookingRefs: bookingRefs as never,
      isRoot,
      note,
      location: toObjectId(locationId),
    } as CourseBookingInsert;
  });

  const result = await bookingRepository.insertMany(records);

  return {
    count: result.length,
    ids: result.map((booking) => booking._id),
  };
};

type ReconcileCourseBookingParticipantsArgs = {
  tenantId: TenantId;
};

type CourseParticipantInput = {
  firstname: string;
  lastname: string;
  customId?: string;
  memberNumber?: number;
  order: Types.ObjectId;
};

export const reconcileCourseBookingParticipants = async ({
  tenantId,
}: ReconcileCourseBookingParticipantsArgs) => {
  const now = new Date();
  const tenantIdString = toIdString(tenantId);

  const bookingRepository = createBookingRepository({
    tenantId: tenantIdString,
  });
  const orderRepository = createOrderRepository({ tenantId: tenantIdString });
  const userRepository = createUserRepository({ tenantId: tenantIdString });

  const bookings = await bookingRepository.find(
    {
      tag: { $in: CLASS_BOOKING_TAGS },
      archive: false,
      start: { $gte: now },
      $expr: {
        $ne: [{ $size: "$participants" }, "$numberOfGuests"],
      },
    },
    {
      select: "_id participants numberOfGuests orders bookingProduct",
      lean: true,
    },
  );

  let updated = 0;

  for (const booking of bookings) {
    if (!booking.orders?.length) continue;
    if ((booking.numberOfGuests ?? 0) <= 0) continue;
    if ((booking.participants?.length ?? 0) > 0) continue;

    const participants: CourseParticipantInput[] = [];

    for (const orderId of booking.orders) {
      const order = await orderRepository.findById(orderId);

      if (!order?.cart || order.isPaid !== true) continue;

      const author = await userRepository.findById(order.createdBy, {
        select: "firstname lastname customId memberNumber",
        lean: true,
      });

      if (!author) continue;

      const bookingItem = (order.cart.cartItems || []).find((cartItem: any) => {
        const productId = cartItem.product?._id || cartItem.product;
        return sameId(productId, booking.bookingProduct);
      });

      if (!bookingItem) continue;

      const quantity = Number(bookingItem.quantity || 0);

      if (!Number.isFinite(quantity) || quantity <= 0) continue;

      participants.push({
        firstname: author.firstname,
        lastname: author.lastname,
        customId: author.customId,
        memberNumber: author.memberNumber ?? undefined,
        order: toObjectId(orderId),
      });

      for (let index = 1; index < quantity; index += 1) {
        participants.push({
          firstname: `${author.firstname}_guest_${index}`,
          lastname: `${author.lastname}_guest_${index}`,
          customId: author.customId,
          memberNumber: author.memberNumber ?? undefined,
          order: toObjectId(orderId),
        });
      }
    }

    if (participants.length > 0) {
      await bookingRepository.updateMany(
        { _id: booking._id },
        {
          $set: {
            participants,
          },
        },
      );

      updated += 1;
    }
  }

  return {
    checked: bookings.length,
    updated,
  };
};
