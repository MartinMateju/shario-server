import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "64b64c8f4f1c2a3b4c5d6e70";
const ALLOWED_LOCATION_ID = "64b64c8f4f1c2a3b4c5d6e71";
const OTHER_LOCATION_ID = "64b64c8f4f1c2a3b4c5d6e72";

const mocks = vi.hoisted(() => ({
  access: null as any,
  list: vi.fn(),
  getById: vi.fn(),
}));

vi.mock("@/modules/booking/booking.public.service.js", () => ({
  listCustomerBookingLocations: vi.fn(),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: vi.fn(),
}));

vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: (req: any) => req.tenantId,
}));

vi.mock("@/modules/location/services/location.service.js", () => ({
  locationService: {
    list: mocks.list,
    getById: mocks.getById,
  },
}));

vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  canAccessWorkspaceLocation: (access: any, locationId: string) =>
    access.locationAccess.mode === "all" ||
    access.locationAccess.locationIds.includes(locationId),
  getAllowedWorkspaceLocationIds: (access: any) =>
    access.locationAccess.mode === "all"
      ? null
      : access.locationAccess.locationIds,
  hasWorkspacePermission: (access: any, permission: string) =>
    access.permissions.includes(permission),
  resolveWorkspaceAccessForUser: vi.fn(),
}));

import {
  getLocationById,
  getLocations,
} from "@/modules/location/controllers/location.controller.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const scopedAccess = (
  permissions: string[] = [WORKSPACE_PERMISSION.LOCATIONS_VIEW],
) => ({
  status: "active",
  permissions,
  locationAccess: {
    mode: "selected",
    locationIds: [ALLOWED_LOCATION_ID],
  },
});

const app = express();
app.use((req, _res, next) => {
  (req as any).tenantId = TENANT_ID;
  if (mocks.access) {
    (req as any).workspaceAccess = mocks.access;
    (req as any).workspaceAccessResolved = true;
  }
  next();
});
app.get("/locations", getLocations);
app.get("/locations/:id", getLocationById);
app.use((error: any, _req, res, _next) => {
  res.status(error.statusCode || 500).json({ code: error.code });
});

describe("location controller authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access = null;
    mocks.list.mockResolvedValue({ locations: [], total: 0 });
    mocks.getById.mockResolvedValue({ id: ALLOWED_LOCATION_ID });
  });

  it("fails closed when no active workspace membership was resolved", async () => {
    const response = await request(app).get("/locations").expect(403);

    expect(response.body).toEqual({ code: "WORKSPACE_ACCESS_REQUIRED" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("passes the member's selected location scope to list queries", async () => {
    mocks.access = scopedAccess();

    await request(app).get("/locations").expect(200);

    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        allowedLocationIds: [ALLOWED_LOCATION_ID],
      }),
    );
  });

  it("returns not found before reading a location outside the member scope", async () => {
    mocks.access = scopedAccess();

    await request(app).get(`/locations/${OTHER_LOCATION_ID}`).expect(404);

    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it("requires management permission before exposing private access fields", async () => {
    mocks.access = scopedAccess();

    const denied = await request(app)
      .get(`/locations/${ALLOWED_LOCATION_ID}?includePrivateAccess=true`)
      .expect(403);

    expect(denied.body).toEqual({
      code: "FORBIDDEN",
    });
    expect(mocks.getById).not.toHaveBeenCalled();

    mocks.access = scopedAccess([
      WORKSPACE_PERMISSION.LOCATIONS_VIEW,
      WORKSPACE_PERMISSION.LOCATIONS_MANAGE,
    ]);

    await request(app)
      .get(`/locations/${ALLOWED_LOCATION_ID}?includePrivateAccess=true`)
      .expect(200);

    expect(mocks.getById).toHaveBeenLastCalledWith(
      TENANT_ID,
      ALLOWED_LOCATION_ID,
      true,
    );
  });
});
