import { describe, expect, it } from "vitest";

import {
  getAutomationCapacity,
  getAutomationLimitBasis,
  getTeamAccountCapacity,
} from "@/modules/tenants/tenant-plan-usage.js";

describe("V2 plan usage capacity", () => {
  it("counts owners/admins and staff in the shared team-account allowance", () => {
    expect(
      getTeamAccountCapacity({
        planVersion: 2,
        activeAdmins: 1,
        activeStaff: 1,
        wasActive: false,
        willBeActive: true,
        limit: 3,
      }),
    ).toMatchObject({ current: 2, next: 3, exceeded: false });

    expect(
      getTeamAccountCapacity({
        planVersion: 2,
        activeAdmins: 1,
        activeStaff: 2,
        wasActive: false,
        willBeActive: true,
        limit: 3,
      }),
    ).toMatchObject({ current: 3, next: 4, exceeded: true });
  });

  it("preserves V1's separate seat-limit interpretation", () => {
    expect(
      getTeamAccountCapacity({
        planVersion: 1,
        activeAdmins: 5,
        activeStaff: 15,
        wasActive: false,
        willBeActive: true,
        limit: 15,
      }).exceeded,
    ).toBe(false);
  });

  it("enforces V2 custom-automation definitions without reinterpreting V1", () => {
    expect(
      getAutomationCapacity({ planVersion: 2, current: 2, limit: 3 }).reached,
    ).toBe(false);
    expect(
      getAutomationCapacity({ planVersion: 2, current: 3, limit: 3 }).reached,
    ).toBe(true);
    expect(
      getAutomationCapacity({ planVersion: 1, current: 1_000, limit: 3 })
        .reached,
    ).toBe(false);
  });

  it("switches V3 automation limits from definitions to active slots", () => {
    expect(getAutomationLimitBasis(1)).toBe("none");
    expect(getAutomationLimitBasis(2)).toBe("definitions");
    expect(getAutomationLimitBasis(3)).toBe("active");
  });
});

