import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/index.js";

export const REPORT_GRANULARITY = {
  AUTO: "auto",
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
} as const;

export type ReportGranularity =
  (typeof REPORT_GRANULARITY)[keyof typeof REPORT_GRANULARITY];
export type ResolvedReportGranularity = Exclude<ReportGranularity, "auto">;

export type ReportQuery = {
  from?: string;
  to?: string;
  locationId?: string;
  locale?: string;
  compare: boolean;
  granularity: ReportGranularity;
};

export type ReportContext = {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
};

export type ReportPeriod = {
  from: string;
  to: string;
  start: Date;
  endExclusive: Date;
  days: number;
};

export type ResolvedReportPeriod = {
  current: ReportPeriod;
  comparison: ReportPeriod | null;
  queryStart: Date;
  queryEndExclusive: Date;
  granularity: ResolvedReportGranularity;
};

export type ReportKpi = {
  value: number | null;
  previous: number | null;
  changePercent: number | null;
};

export type ReportCoverage = {
  available: string[];
  unavailable: Array<{ source: string; reason: string }>;
  limitations: string[];
  complete: boolean;
};

export type ReportLocationScope = {
  requestedLocationId: string | null;
  locationIds: string[];
  allowedLocationIds: readonly string[] | null;
  unrestricted: boolean;
};
