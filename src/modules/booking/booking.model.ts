import mongoose from "mongoose";

import { bookingSchema } from "./booking.schema.js";
import type { Booking, BookingModel } from "./booking.types.js";

const Booking =
  (mongoose.models.Booking as BookingModel | undefined) ||
  mongoose.model<Booking, BookingModel>("Booking", bookingSchema);

export default Booking;