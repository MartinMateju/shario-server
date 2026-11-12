import { describe, expect, it } from "vitest";

import {
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
} from "../../../src/modules/tenant-access/tenant-access.constants.js";
import { assertActorCanGrantLocationAccess } from "../../../src/modules/tenant-access/services/team.service.js";
import type { ResolvedWorkspaceAccess } from "../../../src/modules/tenant-access/tenant-access.types.js";

const buildActor = (
  mode: "all" | "selected",
  locationIds: string[] = [],
) =>
  ({
    status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
    role: WORKSPACE_ROLE.ADMIN,
    locationAccess: { mode, locationIds },
    isPlatformBypass: false,
  }) as ResolvedWorkspaceAccess;

describe("workspace location grant boundaries", () => {
  it("allows an unrestricted actor to grant all locations", () => {
    expect(() =>
      assertActorCanGrantLocationAccess(buildActor(LOCATION_ACCESS_MODE.ALL), {
        mode: LOCATION_ACCESS_MODE.ALL,
        locationIds: [],
      }),
    ).not.toThrow();
  });

  it("allows a restricted actor to grant a subset of its locations", () => {
    expect(() =>
      assertActorCanGrantLocationAccess(
        buildActor(LOCATION_ACCESS_MODE.SELECTED, ["location-a", "location-b"]),
        {
          mode: LOCATION_ACCESS_MODE.SELECTED,
          locationIds: ["location-a"],
        },
      ),
    ).not.toThrow();
  });

  it("rejects escalation from selected locations to all locations", () => {
    expect(() =>
      assertActorCanGrantLocationAccess(
        buildActor(LOCATION_ACCESS_MODE.SELECTED, ["location-a"]),
        {
          mode: LOCATION_ACCESS_MODE.ALL,
          locationIds: [],
        },
      ),
    ).toThrow("cannot grant access");
  });

  it("rejects locations outside the actor's own assignment", () => {
    expect(() =>
      assertActorCanGrantLocationAccess(
        buildActor(LOCATION_ACCESS_MODE.SELECTED, ["location-a"]),
        {
          mode: LOCATION_ACCESS_MODE.SELECTED,
          locationIds: ["location-b"],
        },
      ),
    ).toThrow("cannot grant access");
  });
});
