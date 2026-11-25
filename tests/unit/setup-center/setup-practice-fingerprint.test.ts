import { describe, expect, it } from "vitest";

import { practiceFingerprint } from "@/modules/setup-center/setup-practice-fingerprint.js";

const configuration = () => ({
  product: {
    _id: "product-1",
    type: "workshop",
    kind: "open-studio",
    bookingMode: "public",
    price: 200,
    currency: "CZK",
    maxNumberOfParticipants: 8,
    isActive: true,
  } as any,
  location: {
    _id: "location-1",
    isActive: true,
    booking: { enabled: true },
    openingHours: {
      monday: { isOpen: true, openTime: "09:00", closeTime: "18:00" },
    },
  } as any,
});

describe("practice configuration fingerprint", () => {
  it("ignores booking lock counters, timestamps, names and administrative metadata", () => {
    const before = configuration();
    const after = structuredClone(before);
    Object.assign(after.product, {
      updatedAt: new Date(),
      name: "Renamed",
      imageSrc: "/new.jpg",
    });
    Object.assign(after.location, {
      updatedAt: new Date(),
      name: "Renamed",
      notes: "Internal note",
    });
    after.location.booking.capacityRevision = 42;
    expect(practiceFingerprint(after)).toBe(practiceFingerprint(before));
  });

  it("normalizes default values and unordered activity capacities", () => {
    const before = configuration();
    before.location.booking.activityCapacities = [
      { activity: "WORKSTATION", capacity: 2 },
      { activity: "SHARED_TABLE", capacity: 4 },
    ];
    const after = structuredClone(before);
    after.product.extraCharge = 0;
    after.product.location = null;
    Object.assign(after.location.booking, {
      timezone: "Europe/Prague",
      slotStepMinutes: 30,
      minBookingMinutes: 60,
      maxBookingMinutes: 360,
      globalCapacity: 1,
      allowPublicSoloOverlap: false,
      maxPublicSoloOverlaps: 1,
      privateSessionBlocksAll: true,
      groupBookingBlocksAll: true,
      activitySelectionMode: "OPTIONAL",
    });
    after.location.booking.activityCapacities.reverse();
    after.location.openingHours.tuesday = {
      isOpen: false,
      openTime: "06:00",
      closeTime: "24:00",
    };
    expect(practiceFingerprint(after)).toBe(practiceFingerprint(before));
  });

  it.each([
    [
      "price",
      (value: any) => {
        value.product.price = 250;
      },
    ],
    [
      "product capacity",
      (value: any) => {
        value.product.maxNumberOfParticipants = 10;
      },
    ],
    [
      "booking mode",
      (value: any) => {
        value.product.bookingMode = "private";
      },
    ],
    [
      "product location",
      (value: any) => {
        value.product.location = "location-2";
      },
    ],
    [
      "location capacity",
      (value: any) => {
        value.location.booking.globalCapacity = 5;
      },
    ],
    [
      "slot duration",
      (value: any) => {
        value.location.booking.slotStepMinutes = 15;
      },
    ],
    [
      "activity policy",
      (value: any) => {
        value.location.booking.activitySelectionMode = "REQUIRED";
      },
    ],
    [
      "opening hours",
      (value: any) => {
        value.location.openingHours.monday.closeTime = "20:00";
      },
    ],
  ] as const)("changes after a real %s change", (_label, change) => {
    const before = configuration();
    const after = structuredClone(before);
    change(after);
    expect(practiceFingerprint(after)).not.toBe(practiceFingerprint(before));
  });
});
