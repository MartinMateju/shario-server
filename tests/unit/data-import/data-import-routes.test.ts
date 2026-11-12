import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAccess: vi.fn((_req, _res, next) => next()),
  rollbackAccess: vi.fn((_req, _res, next) => next()),
  sessionAccess: vi.fn((_req, _res, next) => next()),
  staticAccess: vi.fn(() => vi.fn((_req, _res, next) => next())),
  upload: vi.fn((_req, _res, next) => next()),
  limiter: vi.fn((_req, _res, next) => next()),
  controller: vi.fn((_req, res) => res.end()),
}));

vi.mock("express-rate-limit", () => ({
  default: vi.fn(() => mocks.limiter),
}));
vi.mock(
  "../../../src/modules/data-import/data-import-access.middleware.js",
  () => ({
    requireImportListAccess: mocks.listAccess,
    requireImportRollbackAccess: mocks.rollbackAccess,
    requireImportSessionAccess: mocks.sessionAccess,
    requireStaticImportAccess: mocks.staticAccess,
  }),
);
vi.mock(
  "../../../src/modules/data-import/data-import-upload.middleware.js",
  () => ({
    dataImportUpload: mocks.upload,
  }),
);
vi.mock("../../../src/modules/data-import/data-import.controller.js", () => ({
  downloadImportReport: mocks.controller,
  downloadImportRollbackReport: mocks.controller,
  downloadBookingImportTemplate: mocks.controller,
  downloadCreditImportTemplate: mocks.controller,
  downloadCustomerImportTemplate: mocks.controller,
  downloadMembershipImportTemplate: mocks.controller,
  downloadMembershipPlanImportTemplate: mocks.controller,
  downloadProductImportTemplate: mocks.controller,
  downloadVoucherImportTemplate: mocks.controller,
  downloadVoucherProductImportTemplate: mocks.controller,
  executeImport: mocks.controller,
  getImport: mocks.controller,
  getImportRows: mocks.controller,
  getImportRollbackPreview: mocks.controller,
  listImports: mocks.controller,
  rollbackImport: mocks.controller,
  uploadBookingImport: mocks.controller,
  uploadCreditImport: mocks.controller,
  uploadCustomerImport: mocks.controller,
  uploadMembershipImport: mocks.controller,
  uploadMembershipPlanImport: mocks.controller,
  uploadProductImport: mocks.controller,
  uploadVoucherImport: mocks.controller,
  uploadVoucherProductImport: mocks.controller,
  validateImport: mocks.controller,
}));

import router from "../../../src/modules/data-import/data-import.routes.js";

const handlesFor = (method: string, path: string): any[] => {
  const layer = (router as any).stack.find(
    (candidate: any) =>
      candidate.route?.path === path && candidate.route?.methods?.[method],
  );
  expect(
    layer,
    `${method.toUpperCase()} ${path} must be registered`,
  ).toBeTruthy();
  return layer.route.stack.map((routeLayer: any) => routeLayer.handle);
};

describe("data import endpoint access wiring", () => {
  it.each([
    ["get", "/:id/rollback-preview"],
    ["post", "/:id/rollback"],
    ["get", "/:id/rollback-report.csv"],
  ])("uses destructive rollback access for %s %s", (method, path) => {
    const handles = handlesFor(method, path);
    expect(handles).toContain(mocks.rollbackAccess);
    expect(handles).not.toContain(mocks.sessionAccess);
  });

  it.each([
    ["get", "/:id"],
    ["get", "/:id/rows"],
    ["get", "/:id/report.csv"],
    ["post", "/:id/validate"],
    ["post", "/:id/execute"],
  ])("uses ordinary entity import access for %s %s", (method, path) => {
    const handles = handlesFor(method, path);
    expect(handles).toContain(mocks.sessionAccess);
    expect(handles).not.toContain(mocks.rollbackAccess);
  });

  it("uses tenant/entity-aware list access for import history", () => {
    const handles = handlesFor("get", "/");
    expect(handles).toContain(mocks.listAccess);
    expect(handles).not.toContain(mocks.rollbackAccess);
  });
});
