import { describe, expect, it } from "vitest";

import {
  assertAnyLocationWithinWorkspaceScope,
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  getEffectiveLocationFilter,
} from "../../../src/modules/tenant-access/services/location-scope.service.js";

describe("workspace operational location scope", () => {
  it("allows every location when the scope is unrestricted", () => {
    expect(
      assertLocationIdsWithinWorkspaceScope(["location-a"], null),
    ).toEqual(["location-a"]);
    expect(() => assertCanAccessAllWorkspaceLocations(null)).not.toThrow();
  });

  it("rejects a location outside an explicit allow-list", () => {
    expect(() =>
      assertLocationIdsWithinWorkspaceScope(
        ["location-b"],
        ["location-a"],
      ),
    ).toThrow("Location not found");
  });

  it("requires at least one overlap for multi-location resources", () => {
    expect(
      assertAnyLocationWithinWorkspaceScope(
        ["location-a", "location-b"],
        ["location-b"],
      ),
    ).toEqual(["location-a", "location-b"]);

    expect(() =>
      assertAnyLocationWithinWorkspaceScope(
        ["location-a"],
        ["location-b"],
      ),
    ).toThrow("Location not found");
  });

  it("intersects requested list filters with the assignment", () => {
    expect(getEffectiveLocationFilter(undefined, ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
    expect(getEffectiveLocationFilter("b", ["a", "b"])).toEqual(["b"]);
    expect(getEffectiveLocationFilter("c", ["a", "b"])).toEqual([]);
    expect(getEffectiveLocationFilter(undefined, null)).toBeNull();
  });
});

