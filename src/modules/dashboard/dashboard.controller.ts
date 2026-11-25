import type { Request } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import { dashboardService } from "./dashboard.service.js";
import { buildDashboardManagement } from "./dashboard-management.service.js";
import {
  generateDashboardReport,
  exportDashboardReportPdf,
} from "./dashboard-report.service.js";
import {
  dashboardOverviewQuerySchema,
  dashboardReportBodySchema,
  dashboardReportIdSchema,
  type ParsedDashboardOverviewQuery,
} from "./dashboard.validators.js";

const parseQuery = (value: unknown): ParsedDashboardOverviewQuery => {
  const parsed = dashboardOverviewQuerySchema.safeParse(value);

  if (!parsed.success) {
    badRequest({
      message: "Invalid dashboard filters.",
      code: "DASHBOARD_FILTERS_INVALID",
      details: parsed.error.flatten(),
    });
  }

  return parsed.data;
};

export const getDashboardOverview = asyncHandler(async (req: Request, res) => {
  const workspaceRequest = req as WorkspaceAccessRequest;
  const data = await dashboardService.overview({
    context: {
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      access: getResolvedWorkspaceAccess(workspaceRequest),
    },
    query: parseQuery(req.query),
  });

  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).json({ data });
});

const dashboardContext = (req: Request) => ({
  tenantId: requireTenantId(req),
  userId: getAuthenticatedUserId(req),
  access: getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
});

export const getDashboardManagement = asyncHandler(async (req, res) => {
  const data = await buildDashboardManagement({
    context: dashboardContext(req),
    query: parseQuery(req.query),
  });
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).json({ data });
});

export const createDashboardReport = asyncHandler(async (req, res) => {
  const parsed = dashboardReportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest({
      message: "Invalid studio report filters.",
      code: "DASHBOARD_REPORT_FILTERS_INVALID",
      details: parsed.error.flatten(),
    });
  }
  const { locale, ...query } = parsed.data;
  const data = await generateDashboardReport({
    context: dashboardContext(req),
    query,
    locale,
  });
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(201).json({ data });
});

export const downloadDashboardReportPdf = asyncHandler(async (req, res) => {
  const parsed = dashboardReportIdSchema.safeParse(req.params.reportId);
  if (!parsed.success) {
    badRequest({
      message: "Invalid studio report id.",
      code: "DASHBOARD_REPORT_ID_INVALID",
    });
  }
  const { bytes, filename } = await exportDashboardReportPdf({
    context: dashboardContext(req),
    reportId: parsed.data,
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).send(Buffer.from(bytes));
});
