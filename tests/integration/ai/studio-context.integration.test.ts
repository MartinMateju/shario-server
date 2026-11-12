import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getWorkspaceFactFallback } from "../../../src/modules/ai/services/assistant.service.js";
import { buildStudioContextSnapshot } from "../../../src/modules/ai/services/studio-context.service.js";
import LocationModel from "../../../src/modules/location/location.model.js";
import { WORKSPACE_PERMISSION } from "../../../src/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "../../../src/modules/tenant-access/tenant-access.types.js";
import TenantModel from "../../../src/modules/tenants/tenant.model.js";
import UserModel from "../../../src/modules/user/user.model.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const describeMongoIntegration =
  process.env.RUN_MONGO_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const workspaceAccess = ({
  tenantId,
  userId,
  locationIds,
}: {
  tenantId: string;
  userId: string;
  locationIds: string[];
}): ResolvedWorkspaceAccess => ({
  membershipId: "507f1f77bcf86cd799439099",
  tenantId,
  userId,
  status: "active",
  role: "owner",
  customRoleId: null,
  customRoleName: null,
  permissions: [WORKSPACE_PERMISSION.LOCATIONS_VIEW],
  locationAccess: { mode: "selected", locationIds },
  workspaceProfile: {
    jobTitle: "Owner",
    displayName: "Martin Owner",
    calendarColor: "",
  },
  preferences: {
    language: "cs",
    displayTimezone: "Europe/Prague",
    defaultLocation: locationIds[0] || null,
    defaultCalendarView: "month",
    weekStartsOn: 1,
    defaultLandingPage: "",
    contextualGuides: {},
    notifications: {
      bookingAssigned: true,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: true,
      inApp: true,
    },
  },
  accessVersion: 1,
  isPlatformBypass: false,
});

describeMongoIntegration("Studio Context Service", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    await LocationModel.syncIndexes();
  });
  beforeEach(clearTestDatabase);
  afterAll(disconnectTestDatabase);

  it("joins tenant identity and selected locations without crossing tenants", async () => {
    const [tenantA, tenantB] = await TenantModel.create([
      {
        name: "Studio Grohova",
        slug: "studio-grohova",
        settings: {
          defaultLanguage: "CZ",
          currency: "CZK",
          timezone: "Europe/Prague",
        },
      },
      {
        name: "Hidden Studio",
        slug: "hidden-studio",
        settings: {
          defaultLanguage: "EN",
          currency: "EUR",
          timezone: "Europe/Berlin",
        },
      },
    ]);
    const user = await UserModel.create({
      tenant: tenantA._id,
      firstname: "Martin",
      lastname: "Owner",
      email: "studio-context@example.test",
      password: "safe-password-123",
      customId: "U-AI-CONTEXT-1",
      tenantRole: "owner",
    });
    const [locationA, locationB] = await LocationModel.create([
      {
        tenant: tenantA._id,
        name: "Grohova",
        slug: "grohova",
        code: "GROHOVA",
        isPrimary: true,
        address: { line1: "Grohova 102/3", city: "Brno", country: "CZ" },
      },
      {
        tenant: tenantB._id,
        name: "Hidden location",
        slug: "hidden-location",
        code: "HIDDEN",
        isPrimary: true,
      },
    ]);
    const access = workspaceAccess({
      tenantId: String(tenantA._id),
      userId: String(user._id),
      locationIds: [String(locationA._id)],
    });

    const snapshot = await buildStudioContextSnapshot({
      tenantId: String(tenantA._id),
      userId: String(user._id),
      access,
      profile: "core",
      now: new Date("2026-08-02T10:00:00.000Z"),
    });

    expect(snapshot).toMatchObject({
      contextVersion: "studio-context-v1",
      profile: "core",
      studio: {
        name: "Studio Grohova",
        settings: {
          currency: "CZK",
          timezone: "Europe/Prague",
        },
      },
      actor: { firstName: "Martin", lastName: "Owner" },
      locations: {
        total: 1,
        items: [
          expect.objectContaining({
            id: String(locationA._id),
            name: "Grohova",
          }),
        ],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("Hidden Studio");
    expect(JSON.stringify(snapshot)).not.toContain("Hidden location");
    expect(
      getWorkspaceFactFallback({
        question: "Jak se jmenuje moje studio?",
        locale: "cs",
        facts: snapshot,
      })?.answer,
    ).toBe("Vaše studio se jmenuje „Studio Grohova“.");

    const allLocationsAccess = {
      ...access,
      locationAccess: { mode: "all" as const, locationIds: [] },
    };
    await expect(
      buildStudioContextSnapshot({
        tenantId: String(tenantA._id),
        userId: String(user._id),
        access: allLocationsAccess,
        locationId: String(locationB._id),
        profile: "core",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
