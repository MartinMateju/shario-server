import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  assertInvoiceLocationAccess,
  buildInvoiceLocationScopeFilter,
  canAccessInvoiceLocations,
} from "@/modules/invoice/invoice.access.js";

const LOCATION_A = "64b000000000000000000001";
const LOCATION_B = "64b000000000000000000002";
const LOCATION_C = "64b000000000000000000003";

describe("invoice location access", () => {
  it("allows an unrestricted workspace user to access locationless invoices", () => {
    expect(canAccessInvoiceLocations([], null)).toBe(true);
    expect(canAccessInvoiceLocations([LOCATION_A, LOCATION_C], null)).toBe(true);
  });

  it("denies locationless invoices to every location-restricted user", () => {
    expect(canAccessInvoiceLocations([], [LOCATION_A])).toBe(false);
    expect(() => assertInvoiceLocationAccess([], [LOCATION_A])).toThrowError(
      expect.objectContaining({
        statusCode: 404,
        code: "INVOICE_NOT_FOUND",
      }),
    );
  });

  it("requires every invoice location to be within the user's allowed subset", () => {
    expect(
      canAccessInvoiceLocations(
        [LOCATION_A, LOCATION_B, LOCATION_A],
        [LOCATION_A, LOCATION_B],
      ),
    ).toBe(true);

    expect(
      canAccessInvoiceLocations(
        [LOCATION_A, LOCATION_C],
        [LOCATION_A, LOCATION_B],
      ),
    ).toBe(false);
  });

  it("builds no Mongo location restriction for an unrestricted user", () => {
    expect(buildInvoiceLocationScopeFilter(null)).toEqual({});
  });

  it("builds a subset filter that excludes locationless and mixed-scope invoices", () => {
    const filter = buildInvoiceLocationScopeFilter([
      LOCATION_A,
      LOCATION_B,
    ]) as {
      "locationIds.0": { $exists: boolean };
      locationIds: {
        $not: {
          $elemMatch: {
            $nin: mongoose.Types.ObjectId[];
          };
        };
      };
    };

    expect(filter["locationIds.0"]).toEqual({ $exists: true });
    expect(
      filter.locationIds.$not.$elemMatch.$nin.map((id) => String(id)),
    ).toEqual([LOCATION_A, LOCATION_B]);
  });

  it("returns an impossible filter when no allowed identifier is valid", () => {
    expect(buildInvoiceLocationScopeFilter(["not-an-object-id"])).toEqual({
      _id: { $exists: false },
    });
  });
});
