import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  assertOrderLocationAccess,
  buildOrderLocationScopeFilter,
  buildOrderReadLocationFilter,
  canAccessOrderLocations,
} from "@/modules/order/order.access.js";

const LOCATION_A = "64b000000000000000000001";
const LOCATION_B = "64b000000000000000000002";
const LOCATION_C = "64b000000000000000000003";

describe("order location access", () => {
  it("allows every order, including locationless legacy orders, for all-location access", () => {
    expect(canAccessOrderLocations([], null)).toBe(true);
    expect(canAccessOrderLocations([LOCATION_A, LOCATION_C], null)).toBe(true);
  });

  it("hides locationless orders from selected-location members", () => {
    expect(canAccessOrderLocations([], [LOCATION_A])).toBe(false);
    expect(() => assertOrderLocationAccess([], [LOCATION_A])).toThrowError(
      expect.objectContaining({
        statusCode: 404,
        code: "ORDER_NOT_FOUND",
      }),
    );
  });

  it("requires every distinct order location to be allowed", () => {
    expect(
      canAccessOrderLocations(
        [LOCATION_A, LOCATION_B, LOCATION_A],
        [LOCATION_A, LOCATION_B],
      ),
    ).toBe(true);

    expect(
      canAccessOrderLocations(
        [LOCATION_A, LOCATION_C],
        [LOCATION_A, LOCATION_B],
      ),
    ).toBe(false);
  });

  it("adds no Mongo restriction for all-location access", () => {
    expect(buildOrderLocationScopeFilter(null)).toEqual({});
  });

  it("builds a strict subset predicate that excludes locationless and mixed-scope orders", () => {
    const filter = buildOrderLocationScopeFilter([
      LOCATION_A,
      LOCATION_B,
    ]) as {
      "locationIds.0": { $exists: boolean };
      locationIds: {
        $not: {
          $elemMatch: { $nin: mongoose.Types.ObjectId[] };
        };
      };
    };

    expect(filter["locationIds.0"]).toEqual({ $exists: true });
    expect(
      filter.locationIds.$not.$elemMatch.$nin.map((id) => String(id)),
    ).toEqual([LOCATION_A, LOCATION_B]);
  });

  it("fails closed when an explicit allow-list has no valid identifiers", () => {
    expect(buildOrderLocationScopeFilter([])).toEqual({
      _id: { $exists: false },
    });
    expect(buildOrderLocationScopeFilter(["not-an-object-id"])).toEqual({
      _id: { $exists: false },
    });
  });

  it("keeps an explicit location filter separate from the mandatory strict scope", () => {
    const filter = buildOrderReadLocationFilter(
      [LOCATION_A, LOCATION_B],
      LOCATION_A,
    ) as Record<string, any>;

    expect(filter.locationIds.$not.$elemMatch.$nin.map(String)).toEqual([
      LOCATION_A,
      LOCATION_B,
    ]);
    expect(filter.$and).toEqual([{ locationIds: LOCATION_A }]);
  });
});
