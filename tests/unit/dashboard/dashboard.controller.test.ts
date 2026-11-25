import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  management: vi.fn(),
  generate: vi.fn(),
  pdf: vi.fn(),
  access: { tenantId: "authenticated-tenant", userId: "authenticated-user" },
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: () => "authenticated-user",
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: () => "authenticated-tenant",
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  getResolvedWorkspaceAccess: () => mocks.access,
}));
vi.mock("@/modules/dashboard/dashboard.service.js", () => ({
  dashboardService: { overview: vi.fn() },
}));
vi.mock("@/modules/dashboard/dashboard-management.service.js", () => ({
  buildDashboardManagement: mocks.management,
}));
vi.mock("@/modules/dashboard/dashboard-report.service.js", () => ({
  generateDashboardReport: mocks.generate,
  exportDashboardReportPdf: mocks.pdf,
}));

import {
  createDashboardReport,
  downloadDashboardReportPdf,
  getDashboardManagement,
} from "@/modules/dashboard/dashboard.controller.js";

const app = express();
app.use(express.json());
app.get("/management", getDashboardManagement);
app.post("/reports", createDashboardReport);
app.get("/reports/:reportId/pdf", downloadDashboardReportPdf);
app.use(((error, _req, res, _next) => {
  res.status(error.statusCode || 500).json({ code: error.code });
}) as ErrorRequestHandler);

describe("management dashboard HTTP boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the authenticated tenant/user for management queries and prevents shared caching", async () => {
    mocks.management.mockResolvedValue({ metadata: { currency: "CZK" } });
    const response = await request(app).get("/management?date=2026-11-07");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.management).toHaveBeenCalledWith({
      context: {
        tenantId: "authenticated-tenant",
        userId: "authenticated-user",
        access: mocks.access,
      },
      query: { date: "2026-11-07" },
    });
  });

  it("rejects forged report data before invoking generation", async () => {
    const response = await request(app)
      .post("/reports")
      .send({ date: "2026-11-07", snapshot: { revenue: 99999 } });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("DASHBOARD_REPORT_FILTERS_INVALID");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("returns the generated snapshot in the standard data envelope", async () => {
    const saved = {
      id: "507f1f77bcf86cd799439011",
      snapshot: { metadata: { generatedAt: "2026-11-07T13:05:00Z" } },
    };
    mocks.generate.mockResolvedValue(saved);
    const response = await request(app)
      .post("/reports")
      .send({ date: "2026-11-07", locale: "cs" });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: saved });
    expect(mocks.generate).toHaveBeenCalledWith({
      context: {
        tenantId: "authenticated-tenant",
        userId: "authenticated-user",
        access: mocks.access,
      },
      query: { date: "2026-11-07" },
      locale: "cs",
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("downloads only a saved report identifier as a private PDF attachment", async () => {
    mocks.pdf.mockResolvedValue({
      bytes: Buffer.from("%PDF-example"),
      filename: "dashboard-report-2026-11-07.pdf",
    });
    const response = await request(app).get(
      "/reports/507f1f77bcf86cd799439011/pdf",
    );
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="dashboard-report-2026-11-07.pdf"',
    );
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(mocks.pdf).toHaveBeenCalledWith({
      context: {
        tenantId: "authenticated-tenant",
        userId: "authenticated-user",
        access: mocks.access,
      },
      reportId: "507f1f77bcf86cd799439011",
    });
  });
});
