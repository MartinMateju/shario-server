import type { DashboardManagementOverview } from "./dashboard-management.types.js";

export type DashboardReportNarrative = {
  mode: "ai" | "deterministic";
  headline: string;
  summary: string;
  highlights: string[];
  attention: string[];
  recommendations: string[];
  dataLimitations: string[];
};

export type DashboardReportSection = {
  key: string;
  title: string;
  columns: [string, string, string];
  rows: Array<{ label: string; value: string; previous?: string }>;
  notes: string[];
};

/** A server-owned, immutable snapshot, shared by the screen and PDF. */
export type DashboardReport = {
  id: string;
  generatedAt: string;
  locale: string;
  sourceLocale: "cs" | "en";
  locationLabel: string;
  snapshot: DashboardManagementOverview;
  narrative: DashboardReportNarrative;
  sections: DashboardReportSection[];
};
