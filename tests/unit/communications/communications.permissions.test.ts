import { describe, expect, it } from "vitest";

import {
  WORKSPACE_ROLE,
} from "@/modules/tenant-access/tenant-access.constants.js";
import {
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  BUILT_IN_ROLE_CATALOG,
} from "@/modules/tenant-access/tenant-access.roles.js";

describe("communications workspace permissions", () => {
  it.each([
    WORKSPACE_ROLE.OWNER,
    WORKSPACE_ROLE.ADMIN,
    WORKSPACE_ROLE.MANAGER,
  ] as const)("allows %s to view and manage communications", (role) => {
    expect(BUILT_IN_ROLE_CATALOG[role].permissions).toEqual(
      expect.arrayContaining([
        WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
        WORKSPACE_PERMISSION.COMMUNICATIONS_SEND,
        WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN,
        WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
        WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
        WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW,
      ]),
    );
  });

  it("lets staff reply and assign from the inbox without settings or audit access", () => {
    const permissions = BUILT_IN_ROLE_CATALOG[WORKSPACE_ROLE.STAFF].permissions;

    expect(permissions).toEqual(
      expect.arrayContaining([
        WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
        WORKSPACE_PERMISSION.COMMUNICATIONS_SEND,
        WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN,
      ]),
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW,
    );
  });

  it("keeps the viewer role read-only", () => {
    const permissions = BUILT_IN_ROLE_CATALOG[WORKSPACE_ROLE.VIEWER].permissions;

    expect(permissions).toContain(WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW);
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_SEND,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW,
    );
  });

  it("does not expose customer conversations to the accountant role by default", () => {
    const permissions =
      BUILT_IN_ROLE_CATALOG[WORKSPACE_ROLE.ACCOUNTANT].permissions;

    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_SEND,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
    );
    expect(permissions).not.toContain(
      WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW,
    );
  });
});
