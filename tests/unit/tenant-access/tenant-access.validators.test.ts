import { describe, expect, it } from "vitest";

import {
  WORKSPACE_GUIDE_DEFINITIONS,
} from "../../../src/modules/workspace-guides/workspace-guide.constants.js";
import {
  isWorkspacePermission,
  WORKSPACE_PERMISSION,
} from "../../../src/modules/tenant-access/tenant-access.permissions.js";
import {
  createTeamMemberSchema,
  updateTeamMemberSchema,
  workspacePreferencesInputSchema,
} from "../../../src/modules/tenant-access/tenant-access.validators.js";

describe("tenant access wire validation", () => {
  it("catalogues the workspace configuration route permission", () => {
    expect(WORKSPACE_PERMISSION.WORKSPACE_CONFIGURATION_MANAGE).toBe(
      "workspace.configuration.manage",
    );
    expect(
      isWorkspacePermission(
        WORKSPACE_PERMISSION.WORKSPACE_CONFIGURATION_MANAGE,
      ),
    ).toBe(true);
  });

  it("accepts roleKey as the canonical team member field", () => {
    const result = createTeamMemberSchema.parse({
      email: " Team.Member@Example.com ",
      roleKey: "manager",
    });

    expect(result.email).toBe("team.member@example.com");
    expect(result.roleKey).toBe("manager");
    expect(result.locationAccess).toEqual({ mode: "all", locationIds: [] });
    expect(result).not.toHaveProperty("role");
  });

  it("accepts legacy role but normalizes it to roleKey", () => {
    const result = createTeamMemberSchema.parse({
      email: "staff@example.com",
      role: "staff",
    });

    expect(result.roleKey).toBe("staff");
    expect(result).not.toHaveProperty("role");
  });

  it("rejects conflicting role and roleKey values", () => {
    expect(() =>
      updateTeamMemberSchema.parse({
        roleKey: "manager",
        role: "viewer",
      }),
    ).toThrow();
  });

  it("requires a custom role id when the role key is custom", () => {
    expect(() =>
      createTeamMemberSchema.parse({
        email: "custom@example.com",
        roleKey: "custom",
      }),
    ).toThrow();
  });

  it("accepts a persistent Overview Launch Center dismissal", () => {
    expect(
      workspacePreferencesInputSchema.parse({
        overviewLaunchCenterDismissed: true,
      }).overviewLaunchCenterDismissed,
    ).toBe(true);

    expect(() =>
      workspacePreferencesInputSchema.parse({
        overviewLaunchCenterDismissed: "true",
      }),
    ).toThrow();
  });

  it("accepts versioned product tour completion and celebration state", () => {
    expect(
      workspacePreferencesInputSchema.parse({
        productTour: {
          version: 1,
          status: "completed",
          lastStep: "settings",
        },
        firstBookingCelebrationSeen: true,
      }),
    ).toMatchObject({
      productTour: {
        version: 1,
        status: "completed",
        lastStep: "settings",
      },
      firstBookingCelebrationSeen: true,
    });

    expect(() =>
      workspacePreferencesInputSchema.parse({
        productTour: {
          version: 1,
          status: "completed",
          lastStep: "overview",
        },
      }),
    ).toThrow();

    expect(() =>
      workspacePreferencesInputSchema.parse({
        productTour: {
          version: 2,
          status: "skipped",
          lastStep: "navigation",
        },
      }),
    ).toThrow();
  });

  it("accepts every current closed contextual guide state", () => {
    for (const [guideId, definition] of Object.entries(
      WORKSPACE_GUIDE_DEFINITIONS,
    )) {
      const parsed = workspacePreferencesInputSchema.parse({
        contextualGuides: {
          [guideId]: {
            version: definition.version,
            status: "completed",
            lastStep: definition.terminalStep,
          },
        },
      });

      expect(parsed.contextualGuides?.[guideId]).toEqual({
        version: definition.version,
        status: "completed",
        lastStep: definition.terminalStep,
      });
    }
  });

  it("rejects unknown, historical, future, and inconsistent guide writes", () => {
    for (const contextualGuides of [
      {
        unknown_guide: {
          version: 1,
          status: "skipped",
          lastStep: "first",
        },
      },
      {
        first_booking: {
          version: 2,
          status: "skipped",
          lastStep: "calendar",
        },
      },
      {
        studio_flow: {
          version: 1,
          status: "completed",
          lastStep: "profiles",
        },
      },
      {
        memberships: {
          version: 1,
          status: "completed",
          lastStep: "vouchers",
        },
      },
      {
        studio_flow: {
          version: 2,
          status: "skipped",
          lastStep: "profiles",
        },
      },
      {
        first_offer: {
          version: 1,
          status: "completed",
          lastStep: "offer_types",
        },
      },
      {
        data_import: {
          version: 1,
          status: "skipped",
          lastStep: "unregistered",
        },
      },
    ]) {
      expect(() =>
        workspacePreferencesInputSchema.parse({ contextualGuides }),
      ).toThrow();
    }
  });

  it("keeps workspace preference updates inside /app", () => {
    expect(() =>
      workspacePreferencesInputSchema.parse({
        defaultLandingPage: "https://example.com",
      }),
    ).toThrow();

    expect(
      workspacePreferencesInputSchema.parse({
        defaultLandingPage: "/app/calendar",
      }).defaultLandingPage,
    ).toBe("/app/calendar");
  });
});
