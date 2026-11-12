import { describe, expect, it } from "vitest";

import {
  ALL_WORKSPACE_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  RESERVED_CUSTOM_ROLE_PERMISSIONS,
  WORKSPACE_PERMISSION,
} from "../../../src/modules/tenant-access/tenant-access.permissions.js";
import {
  getBuiltInRoleName,
  getBuiltInRolePermissions,
  listBuiltInRoles,
} from "../../../src/modules/tenant-access/tenant-access.roles.js";
import { WORKSPACE_ROLE } from "../../../src/modules/tenant-access/tenant-access.constants.js";
import { assertCustomRolePermissionsCanBeAssigned } from "../../../src/modules/tenant-access/services/role.service.js";
import { serializeWorkspaceAccess } from "../../../src/modules/tenant-access/services/authorization.service.js";
import type { ResolvedWorkspaceAccess } from "../../../src/modules/tenant-access/tenant-access.types.js";

const ownerAccess = {
  status: "active",
  role: WORKSPACE_ROLE.OWNER,
  permissions: ALL_WORKSPACE_PERMISSIONS,
  isPlatformBypass: false,
} as ResolvedWorkspaceAccess;

describe("workspace role catalogue", () => {
  it("gives the immutable owner role every known permission", () => {
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.OWNER)).toEqual(
      ALL_WORKSPACE_PERMISSIONS,
    );
  });

  it("does not give administrator accounts owner-only capabilities", () => {
    const permissions = getBuiltInRolePermissions(WORKSPACE_ROLE.ADMIN);

    for (const permission of OWNER_ONLY_PERMISSIONS) {
      expect(permissions).not.toContain(permission);
    }

    expect(permissions).toContain(WORKSPACE_PERMISSION.TEAM_MANAGE);
    expect(permissions).toContain(WORKSPACE_PERMISSION.ROLES_MANAGE);
  });

  it("reserves workspace publication for owners and immutable permissions", () => {
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.OWNER)).toContain(
      WORKSPACE_PERMISSION.WORKSPACE_PUBLISH,
    );
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.ADMIN)).not.toContain(
      WORKSPACE_PERMISSION.WORKSPACE_PUBLISH,
    );
    expect(OWNER_ONLY_PERMISSIONS).toContain(
      WORKSPACE_PERMISSION.WORKSPACE_PUBLISH,
    );
    expect(RESERVED_CUSTOM_ROLE_PERMISSIONS).toContain(
      WORKSPACE_PERMISSION.WORKSPACE_PUBLISH,
    );
  });

  it("publishes stable role keys and display names", () => {
    expect(getBuiltInRoleName(WORKSPACE_ROLE.ACCOUNTANT)).toBe("Accountant");
    expect(listBuiltInRoles().map((role) => role.key)).toEqual([
      "owner",
      "admin",
      "manager",
      "staff",
      "accountant",
      "viewer",
    ]);
  });

  it("limits audited invoice payment management to financial roles", () => {
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.MANAGER)).toContain(
      WORKSPACE_PERMISSION.INVOICES_PAYMENTS_MANAGE,
    );
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.ACCOUNTANT)).toContain(
      WORKSPACE_PERMISSION.INVOICES_PAYMENTS_MANAGE,
    );
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.STAFF)).not.toContain(
      WORKSPACE_PERMISSION.INVOICES_PAYMENTS_MANAGE,
    );
  });

  it("limits Stripe Connect management to owner and built-in admin roles", () => {
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.OWNER)).toContain(
      WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE,
    );
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.ADMIN)).toContain(
      WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE,
    );
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.MANAGER)).not.toContain(
      WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE,
    );
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.ACCOUNTANT)).not.toContain(
      WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE,
    );
    expect(RESERVED_CUSTOM_ROLE_PERMISSIONS).toContain(
      WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE,
    );
  });

  it("rejects reserved capabilities even when an owner creates the role", () => {
    expect(() =>
      assertCustomRolePermissionsCanBeAssigned({
        actorAccess: ownerAccess,
        permissions: [RESERVED_CUSTOM_ROLE_PERMISSIONS[0]],
      }),
    ).toThrow("reserved");
  });

  it("rejects permissions the custom-role author does not possess", () => {
    const limitedAccess = {
      ...ownerAccess,
      role: WORKSPACE_ROLE.MANAGER,
      permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
    } as ResolvedWorkspaceAccess;

    expect(() =>
      assertCustomRolePermissionsCanBeAssigned({
        actorAccess: limitedAccess,
        permissions: [WORKSPACE_PERMISSION.PAYMENTS_REFUND],
      }),
    ).toThrow("cannot grant");
  });

  it("serializes the stable frontend authorization contract", () => {
    const serialized = serializeWorkspaceAccess({
      ...ownerAccess,
      membershipId: "507f1f77bcf86cd799439011",
      tenantId: "507f1f77bcf86cd799439012",
      userId: "507f1f77bcf86cd799439013",
      customRoleId: null,
      customRoleName: null,
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
      accessVersion: 3,
    });

    expect(serialized).toMatchObject({
      roleKey: "owner",
      roleName: "Owner",
      authorizationVersion: 3,
    });
    expect(serialized).not.toHaveProperty("role");
    expect(serialized).not.toHaveProperty("accessVersion");
  });
});
