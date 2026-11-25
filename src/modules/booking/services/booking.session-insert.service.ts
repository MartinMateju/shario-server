import mongoose from "mongoose";

import Booking from "@/modules/booking/booking.model.js";
import { loadCourseCapacityForBookings } from "@/modules/booking/booking.course-capacity.js";
import { validateOpenStudioAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";
import Location from "@/modules/location/location.model.js";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";

/**
 * Insert staff-created Class sessions and Private Studio blocks.
 *
 * Uses the same serialization point as checkout and the booking editor (the
 * location's capacityRevision) and the same availability validator, so a new
 * session cannot be placed on top of existing bookings or race a customer
 * checkout for the same time.
 */
export const insertCalendarSessionsWithConflictCheck = async ({
  tenantId,
  locationId,
  records,
}: {
  tenantId: string;
  locationId: string;
  records: Array<Record<string, any>>;
}): Promise<Array<{ _id: unknown }>> => {
  if (!records.length) return [];

  const tenant = new mongoose.Types.ObjectId(tenantId);
  const location = new mongoose.Types.ObjectId(locationId);
  const docs = records.map((record) => ({
    ...record,
    _id: record._id ?? new mongoose.Types.ObjectId(),
    tenant,
  }));
  const rangeStart = new Date(
    Math.min(...docs.map((doc: any) => new Date(doc.start).getTime())),
  );
  const rangeEnd = new Date(
    Math.max(...docs.map((doc: any) => new Date(doc.end).getTime())),
  );

  const session = await mongoose.startSession();
  let inserted: Array<{ _id: unknown }> = [];

  try {
    await session.withTransaction(async () => {
      const locked = await Location.updateOne(
        { _id: location, tenant, isActive: true, "booking.enabled": true },
        { $inc: { "booking.capacityRevision": 1 } },
        { session },
      ).exec();
      if (locked.matchedCount !== 1) {
        badRequest("Studio location is not available for bookings.");
      }

      const lockedLocation = await Location.findOne({ _id: location, tenant })
        .session(session)
        .lean()
        .exec();
      const currentBookings = await Booking.find({
        tenant,
        location,
        start: { $lt: rangeEnd },
        end: { $gt: rangeStart },
      })
        .session(session)
        .lean()
        .exec();

      await loadCourseCapacityForBookings({
        bookings: [...docs, ...currentBookings] as never,
        tenantId,
        session,
      });

      try {
        validateOpenStudioAvailabilityOrThrow({
          openStudioBookings: docs,
          currentBookings,
          locationById: new Map([[String(location), lockedLocation]]),
        });
      } catch (error) {
        if ((error as any)?.statusCode === 409) {
          conflict({
            code: "BOOKING_SESSION_CONFLICT",
            message:
              "A session overlaps an existing booking at this location. Choose another time or move the existing booking first.",
            details: (error as any)?.details,
          });
        }
        throw error;
      }

      inserted = (await Booking.insertMany(docs, {
        ordered: true,
        session,
      })) as Array<{ _id: unknown }>;
    });
  } finally {
    await session.endSession();
  }

  return inserted;
};
