import { buildBookingFixture } from "../fixtures/booking.fixture.js";

export class BookingBuilder {
  constructor() {
    this.data = buildBookingFixture();
  }

  withTenant(tenant) {
    this.data.tenant = tenant?._id || tenant;
    return this;
  }

  withUser(user) {
    this.data.createdBy = user?._id || user;
    if (user?.firstname || user?.customId) {
      this.data.author = {
        name: user.firstname || user.email || "Test User",
        customId: user.customId || "10001",
      };
    }
    return this;
  }

  withProduct(product) {
    this.data.bookingProduct = product?._id || product;
    return this;
  }

  at(start, end) {
    this.data.start = new Date(start);
    this.data.end = new Date(end);
    return this;
  }

  tomorrow() {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(9, 0, 0, 0);

    const end = new Date(start);
    end.setUTCHours(10, 0, 0, 0);

    this.data.start = start;
    this.data.end = end;
    return this;
  }

  grohova() {
    this.data.location = "grohova";
    return this;
  }

  vaclavska() {
    this.data.location = "vaclavska";
    return this;
  }

  public() {
    this.data.bookingType = "public";
    return this;
  }

  private() {
    this.data.bookingType = "private";
    return this;
  }

  workshop() {
    this.data.tag = "workshop";
    return this;
  }

  course() {
    this.data.tag = "course";
    return this;
  }

  pending() {
    this.data.paymentStatus = "PENDING_PAYMENT";
    this.data.status = "pending";
    return this;
  }

  confirmed() {
    this.data.paymentStatus = "CONFIRMED";
    this.data.status = "processed";
    return this;
  }

  cancelled() {
    this.data.status = "cancelled";
    return this;
  }

  withGuests(numberOfGuests) {
    this.data.numberOfGuests = numberOfGuests;
    return this;
  }

  withParticipants(participants) {
    this.data.participants = participants;
    this.data.numberOfGuests = participants.length;
    return this;
  }

  withOverrides(overrides = {}) {
    this.data = { ...this.data, ...overrides };
    return this;
  }

  build() {
    return { ...this.data };
  }
}
