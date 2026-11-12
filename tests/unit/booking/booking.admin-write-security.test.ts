import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBookingRepository: vi.fn(),
  createUserRepository: vi.fn(),
  findBookingById: vi.fn(),
  findUserById: vi.fn(),
  saveBooking: vi.fn(),
}));

vi.mock("@/modules/booking/booking.repository.js", () => ({
  createBookingRepository: mocks.createBookingRepository,
}));

vi.mock("@/modules/user/user.repository.js", () => ({
  createUserRepository: mocks.createUserRepository,
}));

import { updateBookingByAdmin } from "@/modules/booking/services/booking.write.service.js";

const TENANT_ID = "64b000000000000000000401";
const ACTOR_ID = "64b000000000000000000402";
const BOOKING_ID = "64b000000000000000000403";

describe("legacy admin booking update boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createBookingRepository.mockReturnValue({
      findById: mocks.findBookingById,
      save: mocks.saveBooking,
    });
    mocks.createUserRepository.mockReturnValue({
      findById: mocks.findUserById,
    });
  });

  it.each([
    ["status", "cancelled"],
    ["paymentStatus", "CONFIRMED"],
    ["start", "2026-08-10T08:00:00.000Z"],
    ["end", "2026-08-10T10:00:00.000Z"],
    ["numberOfHours", 2],
    ["numberOfGuests", 20],
    ["participants", [{ firstname: "Injected" }]],
    ["capacityReservations", []],
    ["location", "64b000000000000000000499"],
    ["orders", []],
    ["createdBy", "64b000000000000000000498"],
    ["userId", "64b000000000000000000497"],
  ])(
    "rejects protected field %s before any repository access",
    async (field, value) => {
      await expect(
        updateBookingByAdmin({
          tenantId: TENANT_ID,
          actorUserId: ACTOR_ID,
          input: {
            id: BOOKING_ID,
            [field]: value,
          },
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "BOOKING_UPDATE_REQUIRES_DEDICATED_WORKFLOW",
        details: { fields: [field] },
      });

      expect(mocks.createBookingRepository).not.toHaveBeenCalled();
      expect(mocks.createUserRepository).not.toHaveBeenCalled();
      expect(mocks.saveBooking).not.toHaveBeenCalled();
    },
  );

  it("updates only note and lecturer metadata", async () => {
    const booking = {
      _id: BOOKING_ID,
      status: "processed",
      paymentStatus: "CONFIRMED",
      start: new Date("2026-08-12T08:00:00.000Z"),
      end: new Date("2026-08-12T10:00:00.000Z"),
      numberOfGuests: 2,
      note: "Old note",
      lecturer: "Old lecturer",
    };
    mocks.findUserById.mockResolvedValue({ _id: ACTOR_ID });
    mocks.findBookingById.mockResolvedValue(booking);
    mocks.saveBooking.mockImplementation(async (value) => value);

    const result = await updateBookingByAdmin({
      tenantId: TENANT_ID,
      actorUserId: ACTOR_ID,
      input: {
        id: BOOKING_ID,
        note: "Bring an apron",
        lecturer: "Alex",
      },
    });

    expect(mocks.findUserById).toHaveBeenCalledWith(ACTOR_ID, {
      select: "_id",
      lean: false,
    });
    expect(mocks.findBookingById).toHaveBeenCalledWith(BOOKING_ID, {
      lean: false,
    });
    expect(mocks.saveBooking).toHaveBeenCalledWith(booking);
    expect(result).toBe(booking);
    expect(booking).toMatchObject({
      note: "Bring an apron",
      lecturer: "Alex",
      status: "processed",
      paymentStatus: "CONFIRMED",
      numberOfGuests: 2,
    });
  });

  it("rejects non-string metadata before any repository access", async () => {
    await expect(
      updateBookingByAdmin({
        tenantId: TENANT_ID,
        actorUserId: ACTOR_ID,
        input: {
          id: BOOKING_ID,
          note: { $set: { status: "cancelled" } },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BOOKING_METADATA_INVALID",
      details: { field: "note" },
    });

    expect(mocks.createBookingRepository).not.toHaveBeenCalled();
    expect(mocks.saveBooking).not.toHaveBeenCalled();
  });
});
