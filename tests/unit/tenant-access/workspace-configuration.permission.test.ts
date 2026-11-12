import { describe, expect, it } from "vitest";

import {
  OWNER_ONLY_PERMISSIONS,
  RESERVED_CUSTOM_ROLE_PERMISSIONS,
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/tenant-access.permissions.js";
import { getBuiltInRolePermissions } from "@/modules/tenant-access/tenant-access.roles.js";
import { WORKSPACE_ROLE } from "@/modules/tenant-access/tenant-access.constants.js";

describe("workspace configuration permission", () => {
  it("is available to owner and administrator but not lower built-in roles", () => {
    const permission = WORKSPACE_PERMISSION.WORKSPACE_CONFIGURATION_MANAGE;

    expect(OWNER_ONLY_PERMISSIONS).not.toContain(permission);
    expect(RESERVED_CUSTOM_ROLE_PERMISSIONS).not.toContain(permission);
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.OWNER)).toContain(permission);
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.ADMIN)).toContain(permission);
    expect(getBuiltInRolePermissions(WORKSPACE_ROLE.MANAGER)).not.toContain(
      permission,
    );
  });
});
