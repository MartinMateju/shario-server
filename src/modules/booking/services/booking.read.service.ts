import mongoose, { type Types } from "mongoose";
import dayjs from "dayjs";
import { z } from "zod";

import { badRequest, unauthorized } from "@/shared/http/httpErrors.js";
import { DEFAULT_TIMEZONE } from "@/shared/time/time.utils.js";
import { locationRepository } from "@/modules/location/location.repository.js";
import { createOrderRepository } from "@/modules/order/order.repository.js";
import { createProductRepository } from "@/modules/product/product.repository.js";
import { createStaffRepository } from "@/modules/staff/staff.repository.js";
import { findTenantById } from "@/modules/tenants/tenant.repository.js";
import { createUserRepository } from "@/modules/user/user.repository.js";

import {
  BOOKING_STATUS,
  BOOKING_TAG,
  CLASS_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "../booking.constants.js";
import { createBookingRepository } from "../booking.repository.js";
import type { TenantId } from "../booking.types.js";
import { activeBookingParticipants } from "../booking.attendance-read.js";

type IdLike = string | Types.ObjectId;

type ListBookingsArgs = {
  tenantId: TenantId;
  locationId?: string;
  allowedLocationIds?: readonly string[] | null;
};

type ListBookingsWithFiltersInput = {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  endAfter?: string;
  lecturerId?: string;
  productId?: string;
  authorId?: string;
  paymentStatus?: string;
  locationId?: string;
  page?: number | string;
  limit?: number | string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  allowedLocationIds?: readonly string[] | null;
};

const isValidObjectId = (value: unknown): value is string =>
  typeof value === "string" && mongoose.isValidObjectId(value);

const toObjectId = (value: IdLike): Types.ObjectId =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));

const parsePositiveInt = (
  value: unknown,
  fallback: number,
  max = 100,
): number => {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  return Math.min(parsed, max);
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseDate = (value?: string): Date | null => {
  if (!value) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
};

const endAfterSchema = z.iso.datetime({ offset: true });

const validTimezone = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() }).format();
    return value.trim();
  } catch {
    return null;
  }
};

const resolveSummaryTimezone = async (
  tenantId: TenantId,
  locationId?: string,
): Promise<string> => {
  if (locationId) {
    const location = await locationRepository.findByIdForTenant(
      String(tenantId),
      locationId,
    );
    const timezone = validTimezone(location?.booking?.timezone);
    if (timezone) return timezone;
  }

  const tenant = await findTenantById(String(tenantId));
  return validTimezone(tenant?.settings?.timezone) ?? DEFAULT_TIMEZONE;
};

const emptyBookingsPage = (currentPage: number, pageSize: number) => ({
  bookings: [],
  totalCount: 0,
  totalPages: 0,
  currentPage,
  pageSize,
  summary: {
    totalBookings: 0,
    todayBookings: 0,
    awaitingPaymentBookings: 0,
  },
});

export const listVisibleBookings = ({
  tenantId,
  locationId,
  allowedLocationIds,
}: ListBookingsArgs) => {
  if (locationId && !isValidObjectId(locationId)) {
    badRequest("Invalid locationId.");
  }

  const bookingRepository = createBookingRepository({ tenantId });

  return bookingRepository.find(
    {
      tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
      status: { $ne: BOOKING_STATUS.CANCELLED },
      paymentStatus: PAYMENT_STATUS.CONFIRMED,
      start: { $gte: new Date(Date.now() - 8 * 60 * 60 * 1000) },
      ...(isValidObjectId(locationId)
        ? { location: toObjectId(locationId) }
        : Array.isArray(allowedLocationIds)
          ? { location: { $in: allowedLocationIds.map(toObjectId) } }
          : {}),
    },
    {
      sort: { start: 1 },
      populate: [
        { path: "location", select: "name slug code address booking.timezone" },
      ],
    },
  );
};

// A safety ceiling, not real pagination: this endpoint returns a bare
// array (unlike listBookingsWithFilters/POST /bookings/filter, which is
// the paginated version), so callers built against it aren't expecting an
// envelope. The 31-day window already bounds it in the common case; this
// just protects a busy tenant/location from an unbounded response.
const LIST_BOOKING_HISTORY_SAFETY_LIMIT = 2000;

export const listBookingHistory = ({
  tenantId,
  locationId,
  allowedLocationIds,
}: ListBookingsArgs) => {
  if (locationId && !isValidObjectId(locationId)) {
    badRequest("Invalid locationId.");
  }

  const bookingRepository = createBookingRepository({ tenantId });

  return bookingRepository.find(
    {
      status: { $ne: BOOKING_STATUS.CANCELLED },
      start: { $gte: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
      ...(isValidObjectId(locationId)
        ? { location: toObjectId(locationId) }
        : Array.isArray(allowedLocationIds)
          ? { location: { $in: allowedLocationIds.map(toObjectId) } }
          : {}),
    },
    {
      sort: { start: -1 },
      limit: LIST_BOOKING_HISTORY_SAFETY_LIMIT,
      populate: [
        { path: "location", select: "name slug code address booking.timezone" },
      ],
    },
  );
};

export const listCourseBookings = ({
  tenantId,
  allowedLocationIds,
}: {
  tenantId: TenantId;
  allowedLocationIds?: readonly string[] | null;
}) => {
  const bookingRepository = createBookingRepository({ tenantId });

  return bookingRepository.find(
    {
      tag: { $in: CLASS_BOOKING_TAGS },
      start: { $gte: new Date(Date.now() - 25_000_000) },
      ...(Array.isArray(allowedLocationIds)
        ? { location: { $in: allowedLocationIds.map(toObjectId) } }
        : {}),
    },
    {
      select:
        "-createdAt -createdBy -description -isActive -isPrivate -updatedAt -bookingCourse -bookingStatus -totalPrice -isPaid -quantity -label",
      sort: { start: 1 },
      populate: [
        { path: "location", select: "name slug code address booking.timezone" },
      ],
    },
  );
};

export const listUserBookings = async ({
  tenantId,
  userId,
}: {
  tenantId: TenantId;
  userId?: string;
}) => {
  if (!isValidObjectId(userId)) unauthorized();

  const uid = toObjectId(userId);
  const now = new Date();

  const bookingRepository = createBookingRepository({ tenantId });
  const userRepository = createUserRepository({ tenantId });
  const orderRepository = createOrderRepository({ tenantId });

  const user = await userRepository.findById(uid, {
    select: { customId: 1 },
  });

  if (!user?.customId) unauthorized();

  const [userOrders, workshopBookings] = await Promise.all([
    orderRepository.find({
      createdBy: uid,
      isPaid: true,
      courseBookings: { $exists: true, $ne: [] },
    }),

    bookingRepository.find(
      {
        createdBy: uid,
        tag: { $in: OPEN_STUDIO_BOOKING_TAGS },
        status: BOOKING_STATUS.PROCESSED,
        paymentStatus: PAYMENT_STATUS.CONFIRMED,
        start: { $gte: now },
      },
      {
        sort: { start: 1 },
        populate: [
          {
            path: "location",
            select: "name slug code address booking.timezone",
          },
        ],
      },
    ),
  ]);

  const qtyByCourseBookingId = new Map<string, number>();
  const userOrderIds = new Set(userOrders.map((order) => String(order._id)));

  for (const order of userOrders) {
    for (const courseBooking of order.courseBookings || []) {
      const bookingId = courseBooking?.bookingId
        ? String(courseBooking.bookingId)
        : "";

      const quantity = Number(courseBooking?.quantity) || 0;

      if (bookingId && quantity > 0) {
        qtyByCourseBookingId.set(
          bookingId,
          (qtyByCourseBookingId.get(bookingId) || 0) + quantity,
        );
      }
    }
  }

  const courseBookings = await bookingRepository.find(
    {
      tag: { $in: CLASS_BOOKING_TAGS },
      start: { $gte: now },
      participants: {
        $elemMatch: {
          customId: user.customId,
          order: { $exists: true },
          attendanceStatus: { $ne: "removed" },
        },
      },
    },
    {
      sort: { start: 1 },
      populate: [
        { path: "location", select: "name slug code address booking.timezone" },
      ],
    },
  );

  const courses = courseBookings
    .map((booking) => {
      let quantity = qtyByCourseBookingId.get(String(booking._id));

      if (booking.attendanceManaged === true) {
        quantity = activeBookingParticipants(booking).filter(
          (participant) =>
            participant.order && userOrderIds.has(String(participant.order)),
        ).length;
      }

      if (!quantity && booking.attendanceManaged !== true) {
        const participantCount = activeBookingParticipants(booking).filter(
          (participant) =>
            participant?.customId === user.customId &&
            participant?.order &&
            userOrderIds.has(String(participant.order)),
        ).length;

        quantity = participantCount > 0 ? participantCount : 1;
      }

      return {
        ...booking,
        quantity,
      };
    })
    .filter((booking) => Number(booking.quantity) > 0);

  return {
    workshops: workshopBookings,
    courses,
  };
};

export const listBookingsWithFilters = async ({
  tenantId,
  input,
}: {
  tenantId: TenantId;
  input: ListBookingsWithFiltersInput;
}) => {
  const bookingRepository = createBookingRepository({ tenantId });
  const userRepository = createUserRepository({ tenantId });
  const productRepository = createProductRepository({ tenantId });
  const staffRepository = createStaffRepository({ tenantId });

  const {
    search = "",
    dateFrom,
    dateTo,
    endAfter,
    lecturerId,
    productId,
    authorId,
    paymentStatus,
    locationId,
    page = 1,
    limit = 8,
    sortBy = "start",
    sortOrder = "desc",
    allowedLocationIds,
  } = input;

  const pageNumber = parsePositiveInt(page, 1, 10_000);
  const pageSize = parsePositiveInt(limit, 8, 100);
  const skip = (pageNumber - 1) * pageSize;

  const filter: Record<string, unknown> = {};

  if (endAfter !== undefined) {
    const parsed = endAfterSchema.safeParse(endAfter);
    if (!parsed.success) badRequest("Invalid endAfter timestamp.");

    // Keep in-progress bookings until their end, without changing explicit
    // start-date filters. Legacy records without an end cannot match.
    filter.end = { $gt: new Date(parsed.data) };
  }

  const locationValue = locationId?.trim();

  if (locationValue) {
    if (!mongoose.isValidObjectId(locationValue)) {
      badRequest("Invalid locationId.");
    }

    if (
      Array.isArray(allowedLocationIds) &&
      !allowedLocationIds.some((id) => String(id) === locationValue)
    ) {
      return emptyBookingsPage(pageNumber, pageSize);
    }

    filter.location = toObjectId(locationValue);
  } else if (Array.isArray(allowedLocationIds)) {
    filter.location = { $in: allowedLocationIds.map(toObjectId) };
  }

  const searchValue = search.trim();

  if (searchValue) {
    if (mongoose.isValidObjectId(searchValue)) {
      const objectId = toObjectId(searchValue);

      filter.$or = [
        { _id: objectId },
        { bookingProduct: objectId },
        { createdBy: objectId },
      ];
    } else {
      const safeSearch = escapeRegex(searchValue);
      const parsedMemberNumber = /^\d+$/.test(searchValue)
        ? Number(searchValue)
        : null;
      const memberNumber =
        parsedMemberNumber !== null &&
        Number.isSafeInteger(parsedMemberNumber) &&
        parsedMemberNumber > 0
          ? parsedMemberNumber
          : null;
      const textMatch = { $regex: safeSearch, $options: "i" };
      // Resolve related records inside this tenant; the booking query still
      // intersects the selected/authorized location and every other filter.
      const [matchingCustomers, matchingProducts] = await Promise.all([
        userRepository.find(
          {
            $or: [
              { firstname: textMatch },
              { lastname: textMatch },
              { email: textMatch },
              { customId: textMatch },
              {
                $expr: {
                  $regexMatch: {
                    input: {
                      $concat: [
                        { $ifNull: ["$firstname", ""] },
                        " ",
                        { $ifNull: ["$lastname", ""] },
                      ],
                    },
                    regex: safeSearch,
                    options: "i",
                  },
                },
              },
              ...(memberNumber !== null ? [{ memberNumber }] : []),
            ],
          },
          { select: "_id" },
        ),
        productRepository.find(
          { $or: [{ name: textMatch }, { label: textMatch }] },
          { select: "_id" },
        ),
      ]);

      filter.$or = [
        { "author.name": textMatch },
        { "author.email": textMatch },
        { "author.customId": textMatch },
        { lecturer: textMatch },
        ...(memberNumber !== null
          ? [{ "author.memberNumber": memberNumber }]
          : []),
        {
          createdBy: { $in: matchingCustomers.map((customer) => customer._id) },
        },
        {
          bookingProduct: {
            $in: matchingProducts.map((product) => product._id),
          },
        },
      ];
    }
  }

  const fromDate = parseDate(dateFrom);
  const toDate = parseDate(dateTo);

  if (fromDate || toDate) {
    const startFilter: Record<string, Date> = {};

    if (fromDate) startFilter.$gte = fromDate;

    if (toDate) {
      toDate.setHours(23, 59, 59, 999);
      startFilter.$lte = toDate;
    }

    filter.start = startFilter;
  }

  const lecturerValue = lecturerId?.trim();

  if (lecturerValue) {
    if (mongoose.isValidObjectId(lecturerValue)) {
      const lecturer = await staffRepository.findMemberById(lecturerValue, {
        select: "firstName lastName",
      });

      if (!lecturer) {
        return emptyBookingsPage(pageNumber, pageSize);
      }

      const fullName = `${lecturer.firstName ?? ""} ${
        lecturer.lastName ?? ""
      }`.trim();

      if (!fullName) {
        return emptyBookingsPage(pageNumber, pageSize);
      }

      filter.lecturer = fullName;
    } else {
      filter.lecturer = {
        $regex: escapeRegex(lecturerValue),
        $options: "i",
      };
    }
  }

  const productValue = productId?.trim();

  if (productValue && mongoose.isValidObjectId(productValue)) {
    filter.bookingProduct = toObjectId(productValue);
  }

  const authorValue = authorId?.trim();

  if (authorValue) {
    if (mongoose.isValidObjectId(authorValue)) {
      filter.createdBy = toObjectId(authorValue);
    } else {
      const parsedMemberNumber = /^\d+$/.test(authorValue)
        ? Number(authorValue)
        : null;
      const user = await userRepository.findOne(
        parsedMemberNumber !== null &&
          Number.isSafeInteger(parsedMemberNumber) &&
          parsedMemberNumber > 0
          ? {
              $or: [
                { memberNumber: parsedMemberNumber },
                { customId: authorValue },
              ],
            }
          : { customId: authorValue },
        { select: "_id" },
      );

      if (!user) {
        return emptyBookingsPage(pageNumber, pageSize);
      }

      filter.createdBy = user._id;
    }
  }

  const paymentStatusValue = paymentStatus?.trim();

  if (paymentStatusValue) {
    filter.paymentStatus = paymentStatusValue;
  }

  const allowedSortFields = new Set(["start", "end", "createdAt"]);
  const safeSortBy = allowedSortFields.has(sortBy) ? sortBy : "start";

  type SortDirection = 1 | -1;

  const sortDirection: SortDirection = sortOrder === "asc" ? 1 : -1;

  const sort: Record<string, SortDirection> = {
    [safeSortBy]: sortDirection,
  };

  const timezone = await resolveSummaryTimezone(tenantId, locationValue);
  const today = dayjs().tz(timezone);

  // Summary counts cover the same filtered records as the table, before
  // pagination. Intersect the extra criteria so date/payment filters remain
  // in force, including when they exclude today's or unpaid bookings.
  const [bookings, totalCount, todayBookings, awaitingPaymentBookings] =
    await Promise.all([
      bookingRepository.find(filter, {
        sort,
        skip,
        limit: pageSize,
        populate: [
          {
            path: "bookingProduct",
            select: "name label kind type price currency",
          },
          {
            path: "createdBy",
            select: "firstname lastname customId memberNumber email",
          },
          {
            path: "location",
            select: "name slug code address booking.timezone",
          },
        ],
      }),
      bookingRepository.count(filter),
      bookingRepository.count({
        $and: [
          filter,
          {
            start: {
              $gte: today.startOf("day").toDate(),
              $lte: today.endOf("day").toDate(),
            },
          },
        ],
      }),
      bookingRepository.count({
        $and: [filter, { paymentStatus: PAYMENT_STATUS.PENDING_PAYMENT }],
      }),
    ]);

  return {
    bookings,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
    currentPage: pageNumber,
    pageSize,
    summary: {
      totalBookings: totalCount,
      todayBookings,
      awaitingPaymentBookings,
    },
  };
};
