import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALL_WORKSPACE_PERMISSIONS,
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/tenant-access.permissions.js";

const source = (relativeUrl: string) =>
  readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");

describe("access-code permissions", () => {
  it("publishes five dedicated permission keys", () => {
    expect([
      WORKSPACE_PERMISSION.ACCESS_CODES_VIEW,
      WORKSPACE_PERMISSION.ACCESS_CODES_MANAGE,
      WORKSPACE_PERMISSION.ACCESS_CODES_REVEAL,
      WORKSPACE_PERMISSION.ACCESS_CODES_IMPORT,
      WORKSPACE_PERMISSION.ACCESS_CODES_AUDIT_VIEW,
    ]).toEqual([
      "access_codes.view",
      "access_codes.manage",
      "access_codes.reveal",
      "access_codes.import",
      "access_codes.audit.view",
    ]);
    expect(ALL_WORKSPACE_PERMISSIONS).toEqual(
      expect.arrayContaining([
        "access_codes.view",
        "access_codes.manage",
        "access_codes.reveal",
        "access_codes.import",
        "access_codes.audit.view",
      ]),
    );
  });

  it("grants all five to manager and explicitly excludes viewer auto-view", () => {
    const roles = source(
      "../../../src/modules/tenant-access/tenant-access.roles.ts",
    );
    for (const key of [
      "ACCESS_CODES_VIEW",
      "ACCESS_CODES_MANAGE",
      "ACCESS_CODES_REVEAL",
      "ACCESS_CODES_IMPORT",
      "ACCESS_CODES_AUDIT_VIEW",
    ]) {
      expect(roles).toContain(`WORKSPACE_PERMISSION.${key}`);
    }
    expect(roles).toContain(
      "permission !== WORKSPACE_PERMISSION.ACCESS_CODES_VIEW",
    );
    expect(roles).toContain(
      "permission !== WORKSPACE_PERMISSION.ACCESS_CODES_AUDIT_VIEW",
    );
  });
});

describe("access-code route safety", () => {
  const routes = source(
    "../../../src/modules/access-codes/routes/access-code.routes.ts",
  );
  const controller = source(
    "../../../src/modules/access-codes/controllers/access-code.controller.ts",
  );
  const appRoutes = source("../../../src/app/routes.ts");

  it("gates reveal/import/audit with their dedicated permissions", () => {
    expect(routes).toContain(
      'accessCodeRouter.post("/:id/reveal", revealAccessCodes, revealAccessCode)',
    );
    expect(routes).toContain(
      'accessCodeRouter.post("/bulk", importAccessCodes, bulkCreateAccessCodes)',
    );
    expect(routes).toContain(
      'accessCodeRouter.get("/audit", viewAccessCodeAudit, listAccessCodeAudit)',
    );
  });

  it("sets reveal responses to no-store and never exposes legacy sending", () => {
    expect(controller).toContain(
      'res.set("Cache-Control", "private, no-store, max-age=0")',
    );
    expect(controller).toContain('res.set("Pragma", "no-cache")');
    expect(routes).not.toContain('"/jobs/send"');
  });

  it("uses the dedicated plan module instead of booking/course entitlement", () => {
    expect(appRoutes).toMatch(
      /apiRouter\.use\(\s*"\/access-codes"\s*,\s*requireWorkspaceSession\s*,\s*accessCodesModule/,
    );
    expect(routes).not.toContain("requireAnyTenantModule");
    expect(routes).not.toContain("TENANT_MODULE.BOOKINGS");
    expect(routes).not.toContain("TENANT_MODULE.COURSES");
  });
});
