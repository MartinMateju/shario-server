import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { deleteBookingRequiresCancellation } from "@/modules/booking/controllers/booking.delete-deprecation.controller.js";

const app = express();
app.use(express.json());
app.delete("/bookings", deleteBookingRequiresCancellation);

describe("legacy admin booking deletion", () => {
  it("is a non-mutating 410 tombstone for paid and confirmed bookings", async () => {
    const response = await request(app)
      .delete("/bookings")
      .send({
        id: "64b000000000000000000403",
        status: "processed",
        paymentStatus: "CONFIRMED",
        orderId: "64b000000000000000000404",
      })
      .expect(410);

    expect(response.body).toEqual({
      message:
        "Bookings cannot be deleted. Use the cancellation workflow so payment and booking history remain consistent.",
      code: "BOOKING_DELETE_REQUIRES_CANCELLATION",
      cancellationEndpoint: "PATCH /bookings/cancel",
    });
  });
});
