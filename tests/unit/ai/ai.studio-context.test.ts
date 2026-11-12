import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildContext: vi.fn(),
  buildOperationalContext: vi.fn(),
  canAccessLocation: vi.fn(),
  locationExists: vi.fn(),
}));

vi.mock("@/modules/ai/services/ai-data.service.js", () => ({
  STUDIO_CONTEXT_VERSION: "studio-context-v1",
  buildWorkspaceAssistantContext: mocks.buildContext,
  buildWorkspaceOperationalContext: mocks.buildOperationalContext,
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: { exists: mocks.locationExists },
}));

vi.mock("@/modules/tenant-access/index.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    canAccessWorkspaceLocation: mocks.canAccessLocation,
  };
});

import {
  buildStudioOperationalContextSnapshot,
  buildStudioContextSnapshot,
  STUDIO_CONTEXT_VERSION,
} from "@/modules/ai/services/studio-context.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";

const input = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  locationId: LOCATION_ID,
  profile: "core" as const,
  access: {
    status: "active",
    tenantId: TENANT_ID,
    userId: USER_ID,
    locationAccess: { mode: "all", locationIds: [] },
  } as any,
};

describe("Studio Context Service boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canAccessLocation.mockReturnValue(true);
    mocks.locationExists.mockResolvedValue({ _id: LOCATION_ID });
    mocks.buildContext.mockResolvedValue({
      contextVersion: STUDIO_CONTEXT_VERSION,
      profile: "core",
      generatedAt: "2026-08-02T10:00:00.000Z",
      coverage: {
        available: ["studio", "actor", "locations"],
        omitted: [],
        unavailable: [],
        complete: true,
      },
    });
    mocks.buildOperationalContext.mockResolvedValue({
      generatedAt: "2026-08-02T10:00:00.000Z",
      coverage: { available: ["bookings"], unavailable: [], complete: true },
    });
  });

  it("validates the selected location inside the tenant before building", async () => {
    await expect(buildStudioContextSnapshot(input)).resolves.toMatchObject({
      contextVersion: STUDIO_CONTEXT_VERSION,
      profile: "core",
    });
    expect(mocks.canAccessLocation).toHaveBeenCalledWith(
      input.access,
      LOCATION_ID,
    );
    expect(mocks.locationExists).toHaveBeenCalledWith({
      _id: LOCATION_ID,
      tenant: TENANT_ID,
    });
    expect(mocks.buildContext).toHaveBeenCalledWith(input);
  });

  it("fails closed when the resolved access does not match the request", async () => {
    await expect(
      buildStudioContextSnapshot({
        ...input,
        tenantId: "507f1f77bcf86cd799439099",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.canAccessLocation).not.toHaveBeenCalled();
    expect(mocks.locationExists).not.toHaveBeenCalled();
    expect(mocks.buildContext).not.toHaveBeenCalled();
  });

  it("returns the same not-found boundary for inaccessible locations", async () => {
    mocks.canAccessLocation.mockReturnValue(false);

    await expect(buildStudioContextSnapshot(input)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.locationExists).not.toHaveBeenCalled();
    expect(mocks.buildContext).not.toHaveBeenCalled();
  });

  it("does not build context for a location from another tenant", async () => {
    mocks.locationExists.mockResolvedValue(null);

    await expect(buildStudioContextSnapshot(input)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.buildContext).not.toHaveBeenCalled();
  });

  it("converts a missing workspace from the builder into a typed boundary error", async () => {
    mocks.buildContext.mockRejectedValueOnce(new Error("Workspace not found."));

    await expect(buildStudioContextSnapshot(input)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("removes customer visibility from operational context when the module is disabled", async () => {
    const operationalInput = {
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: {
        ...input.access,
        permissions: [
          WORKSPACE_PERMISSION.BOOKINGS_VIEW,
          WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
        ],
      },
      modules: {
        bookings: true,
        customers: false,
      },
    };

    await buildStudioOperationalContextSnapshot(operationalInput as any);

    expect(mocks.buildOperationalContext).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: expect.objectContaining({
          permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
        }),
      }),
    );
    expect(operationalInput.access.permissions).toContain(
      WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
    );
  });
});
