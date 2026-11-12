import { describe, expect, it } from "vitest";

import {
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
} from "../../../src/modules/tenant-access/tenant-access.constants.js";
import {
  getAllowedWorkspaceLocationIds,
} from "../../../src/modules/tenant-access/services/authorization.service.js";
import type { ResolvedWorkspaceAccess } from "../../../src/modules/tenant-access/tenant-access.types.js";

const access = {
  status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  locationAccess: {
    mode: LOCATION_ACCESS_MODE.ALL,
    locationIds: [],
  },
} as ResolvedWorkspaceAccess;

describe("workspace location query scope", () => {
  it("returns null for unrestricted location access", () => {
    expect(getAllowedWorkspaceLocationIds(access)).toBeNull();
  });

  it("returns a deduplicated selected-location filter", () => {
    expect(
      getAllowedWorkspaceLocationIds({
        ...access,
        locationAccess: {
          mode: LOCATION_ACCESS_MODE.SELECTED,
          locationIds: ["location-a", "location-a", "location-b"],
        },
      }),
    ).toEqual(["location-a", "location-b"]);
  });

  it("fails closed for inactive or missing access", () => {
    expect(getAllowedWorkspaceLocationIds(null)).toEqual([]);
    expect(
      getAllowedWorkspaceLocationIds({
        ...access,
        status: TENANT_MEMBERSHIP_STATUS.SUSPENDED,
      }),
    ).toEqual([]);
  });
});
