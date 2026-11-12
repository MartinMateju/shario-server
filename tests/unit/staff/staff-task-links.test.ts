import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindOne: vi.fn(),
}));

const query = (value: unknown) => {
  const result: any = {
    select: vi.fn(() => result),
    lean: vi.fn(async () => value),
  };
  return result;
};

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { findOne: mocks.bookingFindOne },
}));

import {
  assertValidStaffTaskLinks,
  filterVisibleStaffTaskLinks,
} from "@/modules/staff/staff-task-links.service.js";

describe("staff task link location scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindOne.mockImplementation(({ _id }) =>
      query({ _id, location: _id === "booking-a" ? "location-a" : "location-b" }),
    );
  });

  it("rejects a B resource on an A-scoped task even for an A+B actor", async () => {
    await expect(
      assertValidStaffTaskLinks({
        tenantId: "tenant-a",
        allowedLocationIds: ["location-a", "location-b"],
        taskLocationId: "location-a",
        links: [
          {
            type: "booking",
            resourceId: "booking-b",
            label: "B booking",
          },
        ],
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STAFF_TASK_LINK_NOT_FOUND",
    });
  });

  it("redacts B links from a global task for an A-only reader", async () => {
    const links = await filterVisibleStaffTaskLinks({
      tenantId: "tenant-a",
      allowedLocationIds: ["location-a"],
      taskLocationId: null,
      links: [
        { type: "booking", resourceId: "booking-a", label: "A booking" },
        { type: "booking", resourceId: "booking-b", label: "B booking" },
      ],
    });

    expect(links).toEqual([
      {
        type: "booking",
        resourceId: "booking-a",
        label: "A booking",
      },
    ]);
  });
});
