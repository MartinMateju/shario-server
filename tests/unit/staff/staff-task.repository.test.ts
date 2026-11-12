import { describe, expect, it } from "vitest";

import { normalizeTaskPatch } from "@/modules/staff/staff.repository.js";

describe("staff task persistence normalization", () => {
  it("clears location when a task explicitly applies to all locations", () => {
    expect(
      normalizeTaskPatch({
        locationId: "507f1f77bcf86cd799439011",
        appliesToAllLocations: true,
      }),
    ).toMatchObject({
      locationId: null,
      appliesToAllLocations: true,
    });
  });

  it("makes a non-null legacy or canonical location authoritative", () => {
    const id = "507f1f77bcf86cd799439011";
    expect(normalizeTaskPatch({ location: id })).toMatchObject({
      locationId: expect.anything(),
      appliesToAllLocations: false,
    });
    expect(
      normalizeTaskPatch({ location: null, locationId: id }),
    ).toMatchObject({
      locationId: expect.anything(),
      appliesToAllLocations: false,
    });
  });

  it("preserves explicit null deadlines and legacy blocked states", () => {
    expect(
      normalizeTaskPatch({
        dueDate: null,
        status: "blocked",
        blockerReason: "Waiting for glaze",
      }),
    ).toMatchObject({
      dueDate: null,
      status: "blocked",
      blockerReason: "Waiting for glaze",
      completedAt: null,
    });
  });
});

