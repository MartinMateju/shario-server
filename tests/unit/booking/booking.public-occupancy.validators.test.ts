import { describe, expect, it } from "vitest";

import { publicBookingOccupancyQuerySchema } from "@/modules/booking/booking.public.validators.js";

const LOCATION_ID = "507f1f77bcf86cd799439021";

describe("public booking occupancy query validation", () => {
  it("accepts an inclusive fourteen-day range", () => {
    expect(
      publicBookingOccupancyQuerySchema.parse({
        locationId: LOCATION_ID,
        from: "2026-08-01",
        to: "2026-08-14",
      }),
    ).toEqual({
      locationId: LOCATION_ID,
      from: "2026-08-01",
      to: "2026-08-14",
    });
  });

  it.each([
    {
      locationId: LOCATION_ID,
      from: "2026-08-01",
      to: "2026-08-15",
    },
    {
      locationId: LOCATION_ID,
      from: "2026-08-02",
      to: "2026-08-01",
    },
    {
      locationId: LOCATION_ID,
      from: "2026-02-30",
      to: "2026-03-01",
    },
    {
      locationId: "not-an-object-id",
      from: "2026-08-01",
      to: "2026-08-02",
    },
    {
      locationId: LOCATION_ID,
      from: "2026-08-01",
      to: "2026-08-02",
      tenantId: "507f1f77bcf86cd799439099",
    },
  ])("rejects an invalid or widened query: %o", (query) => {
    expect(publicBookingOccupancyQuerySchema.safeParse(query).success).toBe(
      false,
    );
  });
});
