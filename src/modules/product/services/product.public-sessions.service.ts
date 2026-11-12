import { buildCoursePublicationLocationFilter } from "../product.course-content.js";
import BookingModel from "@/modules/booking/booking.model.js";
import { Types } from "mongoose";
import type { ProductCatalogDto } from "../product.types.js";
import { getPublicCourseLocationIds } from "./product.course-location.service.js";
import {
  BOOKING_STATUS,
  CLASS_BOOKING_TAGS,
} from "@/modules/booking/booking.constants.js";
import { PUBLIC_COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";
import { createProductRepository } from "@/modules/product/product.repository.js";
import { toProductCatalogDto } from "@/modules/product/product.utils.js";
import { notFound } from "@/shared/http/httpErrors.js";
import { getPublicWaitlistAvailability } from "@/modules/waitlist/waitlist.policy.js";

const publicLocation = (location: any) => ({
  id: String(location?._id ?? ""),
  name: String(location?.name ?? ""),
  slug: String(location?.slug ?? ""),
  address: {
    line1: String(location?.address?.line1 ?? ""),
    line2: String(location?.address?.line2 ?? ""),
    city: String(location?.address?.city ?? ""),
    postalCode: String(location?.address?.postalCode ?? ""),
    country: String(location?.address?.country ?? ""),
  },
  timeZone: String(location?.booking?.timezone ?? ""),
});

const parseDateBoundary = (
  value: string | undefined,
  fallback: Date,
  endOfDay = false,
): Date => {
  if (!value) return fallback;

  const date = new Date(
    `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`,
  );
  return Number.isNaN(date.getTime()) ? fallback : date;
};

export const listPublicCourseSessions = async ({
  tenantId,
  productId,
  locationId,
  from,
  to,
  limit,
  now = new Date(),
}: {
  tenantId: string;
  productId: string;
  locationId?: string;
  from?: string;
  to?: string;
  limit: number;
  now?: Date;
}) => {
  const productRepository = createProductRepository({ tenantId });
  const product = await productRepository.findOne(
    {
      _id: productId,
      ...(buildCoursePublicationLocationFilter(locationId) ?? {}),
      type: { $in: PUBLIC_COURSE_PRODUCT_TYPES },
      isActive: true,
      isArchived: { $ne: true },
    },
    { lean: false },
  );

  if (!product) {
    notFound({
      message: "Class not found.",
      code: "PUBLIC_COURSE_NOT_FOUND",
    });
  }

  const activeLocationIds = await getPublicCourseLocationIds(
    tenantId,
    locationId,
  );
  const scope = product.courseContent?.locationIds;
  const locationIds = scope?.length
    ? activeLocationIds.filter((id) => scope.includes(id))
    : activeLocationIds;
  const startBoundary = new Date(
    Math.max(now.getTime(), parseDateBoundary(from, now).getTime()),
  );
  const endBoundary = parseDateBoundary(
    to,
    new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000),
    true,
  );
  const sessions = await BookingModel.find({
    tenant: tenantId,
    bookingProduct: product._id,
    location: { $in: locationIds },
    tag: { $in: CLASS_BOOKING_TAGS },
    archive: { $ne: true },
    status: { $ne: BOOKING_STATUS.CANCELLED },
    start: {
      $gte: startBoundary,
      $lte: endBoundary,
    },
  })
    .select(
      "_id bookingProduct location start end language lecturer numberOfGuests capacityReservations waitlistCapacityHolds waitlistConfig",
    )
    .populate({
      path: "location",
      match: {
        tenant: tenantId,
        isActive: true,
      },
      select: "name slug address booking.timezone",
    })
    .sort({ start: 1 })
    .limit(limit)
    .lean()
    .exec();
  return {
    product: toProductCatalogDto(product),
    sessions: sessions
      .filter(
        (session: any) =>
          session.location &&
          String(session.bookingProduct) === String(product._id),
      )
      .map((session: any) => toPublicCourseSession(session, product, now)),
  };
};

const toPublicCourseSession = (session: any, product: any, now: Date) => {
  const capacity = Math.max(0, Number(product.maxNumberOfParticipants ?? 0));
  const confirmedCount = Math.max(
    0,
    Math.floor(Number(session.numberOfGuests ?? 0)),
  );
  const reservedCount = (session.capacityReservations ?? [])
    .filter(
      (reservation: any) =>
        new Date(reservation?.expiresAt).getTime() > now.getTime(),
    )
    .reduce(
      (total: number, reservation: any) =>
        total + Math.max(0, Math.floor(Number(reservation?.quantity ?? 0))),
      0,
    );
  const waitlistHeldCount = (session.waitlistCapacityHolds ?? []).filter(
    (hold: any) => new Date(hold?.expiresAt).getTime() > now.getTime(),
  ).length;
  const remainingCapacity = Math.max(
    0,
    capacity - confirmedCount - reservedCount - waitlistHeldCount,
  );
  const waitlist = getPublicWaitlistAvailability({
    session,
    product,
    now,
  });

  return {
    id: String(session._id),
    start: session.start,
    end: session.end,
    language: String(session.language ?? ""),
    lecturer: String(session.lecturer ?? ""),
    location: publicLocation(session.location),
    capacity,
    remainingCapacity,
    available: remainingCapacity > 0,
    waitlist,
  };
};

/**
 * One aggregate per catalog page, rather than a session query per course.
 * Read existing bookings only; checkout remains the authority for reserving seats.
 */
export const addNextCourseSessions = async ({
  tenantId,
  locationId,
  products,
  now = new Date(),
}: {
  tenantId: string;
  locationId?: string;
  products: ProductCatalogDto[];
  now?: Date;
}) => {
  const locationIds = await getPublicCourseLocationIds(tenantId, locationId);
  if (!products.length || !locationIds.length) {
    return products.map((product) => ({ ...product, nextSession: null }));
  }
  const productIds = products.map((product) => new Types.ObjectId(product.id));
  const sessions = await BookingModel.aggregate([
    {
      $match: {
        tenant: new Types.ObjectId(tenantId),
        bookingProduct: { $in: productIds },
        ...(products.some(
          (product) => product.courseContent?.locationIds?.length,
        )
          ? {
              $or: products.map((product) => ({
                bookingProduct: new Types.ObjectId(product.id),
                ...(product.courseContent?.locationIds?.length
                  ? {
                      location: {
                        $in: product.courseContent.locationIds.map(
                          (id) => new Types.ObjectId(id),
                        ),
                      },
                    }
                  : {}),
              })),
            }
          : {}),
        location: { $in: locationIds.map((id) => new Types.ObjectId(id)) },
        tag: { $in: CLASS_BOOKING_TAGS },
        archive: { $ne: true },
        status: { $ne: BOOKING_STATUS.CANCELLED },
        start: {
          $gte: now,
          $lte: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000),
        },
      },
    },
    { $sort: { start: 1, _id: 1 } },
    { $group: { _id: "$bookingProduct", session: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$session" } },
    {
      $project: {
        _id: 1,
        bookingProduct: 1,
        location: 1,
        start: 1,
        end: 1,
        language: 1,
        lecturer: 1,
        numberOfGuests: 1,
        capacityReservations: 1,
        waitlistCapacityHolds: 1,
        waitlistConfig: 1,
      },
    },
  ]).exec();
  const populated = await BookingModel.populate(sessions, {
    path: "location",
    match: { tenant: tenantId, isActive: true },
    select: "name slug address booking.timezone",
  });
  const byProduct = new Map(
    populated.map((session: any) => [String(session.bookingProduct), session]),
  );
  return products.map((product) => {
    const session: any = byProduct.get(product.id);
    return {
      ...product,
      nextSession: session?.location
        ? toPublicCourseSession(session, product, now)
        : null,
    };
  });
};
