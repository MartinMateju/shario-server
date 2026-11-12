import Booking from "../../src/modules/booking/booking.model.js";
import {
  buildBookingFixture,
  buildConfirmedWorkshopFixture,
  buildCourseBookingFixture,
} from "../fixtures/booking.fixture.js";

export const bookingFactory = {
  build: buildBookingFixture,
  buildConfirmedWorkshop: buildConfirmedWorkshopFixture,
  buildCourse: buildCourseBookingFixture,

  async create(overrides = {}) {
    return Booking.create(buildBookingFixture(overrides));
  },

  async createConfirmedWorkshop(overrides = {}) {
    return Booking.create(buildConfirmedWorkshopFixture(overrides));
  },

  async createCourse(overrides = {}) {
    return Booking.create(buildCourseBookingFixture(overrides));
  },

  async createMany(records = []) {
    return Booking.insertMany(records.map((record) => buildBookingFixture(record)));
  },
};
