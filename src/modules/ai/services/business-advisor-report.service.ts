import type { ReportQuery } from "@/modules/reports/reports.types.js";
import { buildReportOverview } from "@/modules/reports/reports.service.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/index.js";

export const buildBusinessAdvisorReportOverview = (input: {
  context: {
    tenantId: string;
    userId: string;
    access: ResolvedWorkspaceAccess;
  };
  query: ReportQuery;
  now?: Date;
}) => buildReportOverview(input);

export const businessAdvisorReportService = {
  buildOverview: buildBusinessAdvisorReportOverview,
};
