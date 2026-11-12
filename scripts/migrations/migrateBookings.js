import { legacyLocationToLocationId } from "./helpers.js";

import Booking from "../../models/Booking.js";

export const migrateBookings = async ({ tenant, locations }) => {
  const bookings = await Booking.find({}).lean();

  let updated = 0;
  let skipped = 0;

  for (const booking of bookings) {
    const update = {};

    if (!booking.tenant) {
      update.tenant = tenant._id;
    }

    const mappedLocationId = legacyLocationToLocationId(
      booking.location,
      locations,
    );

    if (mappedLocationId) {
      update.location = mappedLocationId;
    }

    if (!Object.keys(update).length) {
      skipped += 1;
      continue;
    }

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: update,
      },
    );

    updated += 1;
  }

  console.log("Bookings migrated:", updated);
  console.log("Bookings skipped:", skipped);
};
