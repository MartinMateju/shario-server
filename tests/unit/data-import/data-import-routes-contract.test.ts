import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routes = fs.readFileSync(
  path.join(process.cwd(), "src/modules/data-import/data-import.routes.ts"),
  "utf8",
);
const compactRoutes = routes.replace(/\s+/g, " ");
const access = fs.readFileSync(
  path.join(
    process.cwd(),
    "src/modules/data-import/data-import-access.middleware.ts",
  ),
  "utf8",
);
const compactAccess = access.replace(/\s+/g, " ");
const appRoutes = fs.readFileSync(
  path.join(process.cwd(), "src/app/routes.ts"),
  "utf8",
);

describe("data import route contract", () => {
  it.each([
    ["customers", "CUSTOMERS"],
    ["products", "PRODUCTS"],
    ["bookings", "BOOKINGS"],
    ["membership-plans", "MEMBERSHIP_PLANS"],
    ["memberships", "MEMBERSHIPS"],
    ["credits", "CREDITS"],
    ["voucher-products", "VOUCHER_PRODUCTS"],
    ["vouchers", "VOUCHERS"],
  ])(
    "gates %s templates and uploads by their static entity",
    (pathName, entity) => {
      expect(compactRoutes).toContain(
        `"/templates/${pathName}.csv", requireStaticImportAccess(DATA_IMPORT_ENTITY.${entity})`,
      );
      expect(compactRoutes).toContain(
        `"/${pathName}/uploads", requireStaticImportAccess(DATA_IMPORT_ENTITY.${entity})`,
      );
    },
  );

  it("resolves permissions and module gates from the requested entity", () => {
    expect(compactAccess).toContain(
      "permission: WORKSPACE_PERMISSION.CUSTOMERS_IMPORT",
    );
    expect(compactAccess).toContain("modules: [TENANT_MODULE.CUSTOMERS]");
    expect(compactAccess).toContain(
      "permission: WORKSPACE_PERMISSION.PRODUCTS_IMPORT",
    );
    expect(compactAccess).toContain(
      "modules: [TENANT_MODULE.BOOKINGS, TENANT_MODULE.COURSES]",
    );
    expect(compactAccess).toContain(
      "permission: WORKSPACE_PERMISSION.BOOKINGS_IMPORT",
    );
    expect(compactAccess).toContain("modules: [TENANT_MODULE.BOOKINGS]");
    expect(compactAccess).toContain(
      "const entityType = asEntity(req.query.entity ?? req.query.entityType)",
    );
    expect(compactAccess).toContain(
      "await assertCommerceImportReady(entityType)",
    );
    expect(compactAccess).toContain(
      "runEntityAccess(entityType, req, res, next)",
    );
  });

  it("rechecks access against the stored entity for every session route", () => {
    for (const [method, route] of [
      ["post", "/:id/validate"],
      ["post", "/:id/execute"],
      ["get", "/:id/rows"],
      ["get", "/:id/report.csv"],
      ["get", "/:id"],
    ]) {
      expect(compactRoutes).toMatch(
        new RegExp(
          `router\\.${method}\\(\\s*"${route.replace(".", "\\.")}",\\s*requireImportSessionAccess`,
        ),
      );
    }
    expect(compactAccess).toContain("getTenantImportSession({");
    expect(compactAccess).toContain(
      "const entityType = asEntity(session.entityType)",
    );
    expect(compactAccess).toContain(
      "await assertCommerceImportReady(entityType)",
    );
    expect(compactAccess).toContain(
      "runEntityAccess(entityType, req, res, next)",
    );
  });

  it("mounts imports inside the authenticated workspace boundary", () => {
    const subscriptionBoundary = appRoutes.indexOf(
      "apiRouter.use(verifyJWT, requireTenantSubscriptionAccess)",
    );
    const importMount = appRoutes.indexOf('"/imports"');
    expect(subscriptionBoundary).toBeGreaterThan(-1);
    expect(importMount).toBeGreaterThan(subscriptionBoundary);
    expect(appRoutes.slice(importMount, importMount + 120)).toContain(
      "requireWorkspaceSession",
    );
  });
});
