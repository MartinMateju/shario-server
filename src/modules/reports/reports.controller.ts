import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import { buildReportCsv } from "./reports.csv.js";
import { reportService } from "./reports.service.js";
import type { ReportContext } from "./reports.types.js";
import {
  reportQuerySchema,
  type ParsedReportQuery,
} from "./reports.validators.js";

const parseQuery = (value: unknown): ParsedReportQuery => {
  const parsed = reportQuerySchema.safeParse(value);
  if (!parsed.success) {
    badRequest({
      message: "Invalid report filters.",
      code: "REPORT_FILTERS_INVALID",
      details: parsed.error.flatten(),
    });
  }
  return parsed.data;
};

const reportContext = (req: Request): ReportContext => ({
  tenantId: requireTenantId(req),
  userId: getAuthenticatedUserId(req),
  access: getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
});

export const getReportOverview = asyncHandler(async (req, res) => {
  const data = await reportService.overview({
    context: reportContext(req),
    query: parseQuery(req.query),
  });
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).json({ data });
});

export const exportReportCsv = asyncHandler(async (req, res: Response) => {
  const data = await reportService.overview({
    context: reportContext(req),
    query: parseQuery(req.query),
  });
  const filename = `shario-report-${data.metadata.period.from}-to-${data.metadata.period.to}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).send(buildReportCsv(data));
});
