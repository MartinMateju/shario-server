import { describe, expect, it, vi } from "vitest";

import { AUTH_CONTEXT } from "../../../src/modules/auth/auth.constants.js";
import {
  requireAnyPermission,
  requireLocationAccess,
  requirePermission,
  requireWorkspaceAccess,
} from "../../../src/modules/tenant-access/tenant-access.middleware.js";
import {
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
} from "../../../src/modules/tenant-access/tenant-access.constants.js";
import { WORKSPACE_PERMISSION } from "../../../src/modules/tenant-access/tenant-access.permissions.js";
import type {
  ResolvedWorkspaceAccess,
  WorkspaceAccessRequest,
} from "../../../src/modules/tenant-access/tenant-access.types.js";

const access = {
  membershipId: "507f1f77bcf86cd799439011",
  tenantId: "507f1f77bcf86cd799439012",
  userId: "507f1f77bcf86cd799439013",
  status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  role: WORKSPACE_ROLE.STAFF,
  customRoleId: null,
  customRoleName: null,
  permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
  locationAccess: { mode: "all", locationIds: [] },
  workspaceProfile: {
    jobTitle: "",
    displayName: "",
    calendarColor: "#74869a",
  },
  preferences: {
    language: null,
    displayTimezone: null,
    defaultLocation: null,
    defaultCalendarView: "week",
    weekStartsOn: 1,
    defaultLandingPage: "/app",
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
} satisfies ResolvedWorkspaceAccess;

const buildRequest = (
  workspaceAccess: ResolvedWorkspaceAccess | null,
): WorkspaceAccessRequest =>
  ({
    userInfo: {
      authContext: AUTH_CONTEXT.WORKSPACE,
    },
    workspaceAccess,
    workspaceAccessResolved: true,
  }) as WorkspaceAccessRequest;

const response = {} as never;

describe("tenant access middleware", () => {
  it("allows an active membership with the required permission", async () => {
    const next = vi.fn();

    await requirePermission(WORKSPACE_PERMISSION.BOOKINGS_VIEW)(
      buildRequest(access),
      response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it("fails closed when the required permission is absent", async () => {
    const next = vi.fn();

    await requirePermission(WORKSPACE_PERMISSION.PAYMENTS_REFUND)(
      buildRequest(access),
      response,
      next,
    );

    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: "WORKSPACE_PERMISSION_REQUIRED",
    });
  });

  it("supports any-of permission checks", async () => {
    const next = vi.fn();

    await requireAnyPermission(
      WORKSPACE_PERMISSION.PAYMENTS_VIEW,
      WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    )(buildRequest(access), response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("rejects suspended workspace memberships", async () => {
    const next = vi.fn();

    await requireWorkspaceAccess(
      buildRequest({
        ...access,
        status: TENANT_MEMBERSHIP_STATUS.SUSPENDED,
      }),
      response,
      next,
    );

    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: "WORKSPACE_ACCESS_INACTIVE",
    });
  });

  it("allows resources in an assigned location", async () => {
    const next = vi.fn();
    const request = buildRequest({
      ...access,
      locationAccess: {
        mode: "selected",
        locationIds: ["507f1f77bcf86cd799439099"],
      },
    });
    request.params = { locationId: "507f1f77bcf86cd799439099" };

    await requireLocationAccess((req) => req.params.locationId)(
      request,
      response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it("hides resources outside the assigned location scope", async () => {
    const next = vi.fn();
    const request = buildRequest({
      ...access,
      locationAccess: {
        mode: "selected",
        locationIds: ["507f1f77bcf86cd799439099"],
      },
    });
    request.params = { locationId: "507f1f77bcf86cd799439098" };

    await requireLocationAccess((req) => req.params.locationId)(
      request,
      response,
      next,
    );

    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 404,
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
  });

  it("rejects customer context before reusing resolved workspace access", async () => {
    const next = vi.fn();
    const request = buildRequest(access);
    request.userInfo = {
      authContext: AUTH_CONTEXT.CUSTOMER,
    } as never;

    await requirePermission(WORKSPACE_PERMISSION.BOOKINGS_VIEW)(
      request,
      response,
      next,
    );

    expect(next.mock.calls[0][0]).toMatchObject({
      statusCode: 403,
      code: "WORKSPACE_SESSION_REQUIRED",
    });
  });
});
