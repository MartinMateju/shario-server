import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildOperations: vi.fn(),
  locationExists: vi.fn(),
  canAccessLocation: vi.fn(),
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: { exists: mocks.locationExists },
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  canAccessWorkspaceLocation: mocks.canAccessLocation,
}));
vi.mock("@/modules/ai/services/ai-data.service.js", () => ({
  buildWorkspaceAssistantContext: vi.fn(),
  buildWorkspaceOperationalContext: mocks.buildOperations,
}));

import { buildStudioOperationalContextSnapshot } from "@/modules/ai/services/studio-context.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

describe("briefing-safe studio context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildOperations.mockResolvedValue({
      generatedAt: "2026-08-03T08:00:00.000Z",
      coverage: { available: ["bookings"], unavailable: [], complete: true },
    });
  });

  it("removes source permissions when the corresponding tenant module is disabled", async () => {
    const now = new Date("2026-08-03T08:00:00.000Z");
    const access = {
      tenantId: TENANT_ID,
      userId: USER_ID,
      status: "active",
      permissions: [
        WORKSPACE_PERMISSION.BOOKINGS_VIEW,
        WORKSPACE_PERMISSION.INVENTORY_VIEW,

        WORKSPACE_PERMISSION.ORDERS_VIEW,
        WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
      ],
      locationAccess: { mode: "all", locationIds: [] },
    };

    await buildStudioOperationalContextSnapshot({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access as any,
      timezone: "Europe/Prague",
      now,
      modules: {
        bookings: true,
        inventory: false,
        firing: false,
        payments: false,
        communications: false,
        staff_tasks: false,
      },
    });

    expect(mocks.buildOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        now,
        access: expect.objectContaining({
          permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
        }),
      }),
    );
  });
});
