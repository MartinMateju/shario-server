import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  matchesReportLocation,
  orderLocationFilter,
} from "@/modules/reports/reports.scope.js";

const objectId = () => new mongoose.Types.ObjectId().toString();

describe("report location isolation", () => {
  it("keeps the every-location allow-list when a requested location is present", () => {
    const allowed = objectId();
    const filter = orderLocationFilter({
      requestedLocationId: allowed,
      locationIds: [allowed],
      allowedLocationIds: [allowed],
      unrestricted: false,
    });

    expect(filter).toMatchObject({
      "locationIds.0": { $exists: true },
      locationIds: {
        $not: {
          $elemMatch: { $nin: [expect.any(mongoose.Types.ObjectId)] },
        },
      },
      $and: [{ locationIds: allowed }],
    });
  });

  it("fails closed for an empty assigned-location scope", () => {
    expect(
      orderLocationFilter({
        requestedLocationId: null,
        locationIds: [],
        allowedLocationIds: [],
        unrestricted: false,
      }),
    ).toEqual({ _id: { $exists: false } });
    expect(
      matchesReportLocation(objectId(), {
        requestedLocationId: null,
        locationIds: [],
        allowedLocationIds: [],
        unrestricted: false,
      }),
    ).toBe(false);
  });
});

