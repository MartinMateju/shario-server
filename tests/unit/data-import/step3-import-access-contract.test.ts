import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isReservedCustomRolePermission,
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/tenant-access.permissions.js";
import { getBuiltInRolePermissions } from "@/modules/tenant-access/tenant-access.roles.js";
import { WORKSPACE_ROLE } from "@/modules/tenant-access/tenant-access.constants.js";

const importPermissions = [
  WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
  WORKSPACE_PERMISSION.CREDITS_IMPORT,
  WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
];

describe("Step 3 import access contract", () => {
  it("grants built-in migration access only to owner and administrator", () => {
    for (const role of [WORKSPACE_ROLE.OWNER, WORKSPACE_ROLE.ADMIN]) {
      expect(getBuiltInRolePermissions(role)).toEqual(
        expect.arrayContaining(importPermissions),
      );
    }
    for (const role of [
      WORKSPACE_ROLE.MANAGER,
      WORKSPACE_ROLE.STAFF,
      WORKSPACE_ROLE.ACCOUNTANT,
      WORKSPACE_ROLE.VIEWER,
    ]) {
      for (const permission of importPermissions) {
        expect(getBuiltInRolePermissions(role)).not.toContain(permission);
      }
    }
  });

  it("allows tenant owners to assign the three permissions to custom roles", () => {
    for (const permission of importPermissions) {
      expect(isReservedCustomRolePermission(permission)).toBe(false);
    }
  });

  it("maps each entity to its domain permission and module gate", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/modules/data-import/data-import-access.middleware.ts",
      ),
      "utf8",
    );
    const compact = source.replace(/\s+/g, " ");

    expect(compact).toMatch(
      /DATA_IMPORT_ENTITY\.MEMBERSHIP_PLANS\]: \{ permission: WORKSPACE_PERMISSION\.MEMBERSHIPS_IMPORT,[^}]* modules: \[TENANT_MODULE\.MEMBERSHIPS\]/,
    );
    expect(compact).toMatch(
      /DATA_IMPORT_ENTITY\.MEMBERSHIPS\]: \{ permission: WORKSPACE_PERMISSION\.MEMBERSHIPS_IMPORT,[^}]* modules: \[TENANT_MODULE\.MEMBERSHIPS\]/,
    );
    expect(compact).toMatch(
      /DATA_IMPORT_ENTITY\.CREDITS\]: \{ permission: WORKSPACE_PERMISSION\.CREDITS_IMPORT,[^}]* modules: \[TENANT_MODULE\.CREDITS\]/,
    );
    expect(compact).toMatch(
      /DATA_IMPORT_ENTITY\.VOUCHER_PRODUCTS\]: \{ permission: WORKSPACE_PERMISSION\.VOUCHERS_IMPORT,[^}]* modules: \[TENANT_MODULE\.VOUCHERS\]/,
    );
    expect(compact).toMatch(
      /DATA_IMPORT_ENTITY\.VOUCHERS\]: \{ permission: WORKSPACE_PERMISSION\.VOUCHERS_IMPORT,[^}]* modules: \[TENANT_MODULE\.VOUCHERS\]/,
    );
  });

  it("rechecks stored-session access before validation, execution, rows, and reports", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/modules/data-import/data-import-access.middleware.ts",
      ),
      "utf8",
    );
    expect(source).toContain("getTenantImportSession({");
    expect(source).toContain("const entityType = asEntity(session.entityType)");
    expect(source).toContain("runEntityAccess(entityType");
  });
});
