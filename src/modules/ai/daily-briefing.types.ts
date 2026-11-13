export const DAILY_BRIEFING_SCHEMA_VERSION = "daily-studio-briefing-v3";
export const DAILY_BRIEFING_FRESHNESS_MS = 4 * 60 * 60 * 1_000;

export const DAILY_BRIEFING_SEVERITY = {
  CRITICAL: "critical",
  WARNING: "warning",
  INFO: "info",
} as const;

export type DailyBriefingSeverity =
  (typeof DAILY_BRIEFING_SEVERITY)[keyof typeof DAILY_BRIEFING_SEVERITY];

export type DailyBriefingCoverage = {
  available: string[];
  unavailable: string[];
  complete: boolean;
};

export type DailyBriefingMetrics = {
  bookingsToday: number | null;
  unpaidBookings: number | null;
  occupancyPercent: number | null;
  openTasks: number | null;
  overdueTasks: number | null;
  urgentTasks: number | null;
  missingStaffUpdates: number | null;
  blockedStaffUpdates: number | null;
  staffUpdatesNeedingOwnerAttention: number | null;
  lowStockItems: number | null;
  openConversations: number | null;
  urgentConversations: number | null;
  unreadConversations: number | null;
  paidOrdersToday: number | null;
  paidTotalsMinorByCurrency: Record<string, number> | null;
  coverage: DailyBriefingCoverage;
  sourceCount: number;
};

export type DailyBriefingAttention = {
  id: string;
  key: string;
  severity: DailyBriefingSeverity;
  metricKey:
    | keyof Omit<
        DailyBriefingMetrics,
        "coverage" | "sourceCount" | "paidTotalsMinorByCurrency"
      >
    | "coverage";
  value: number | null;
  title: string;
  description: string;
  href: string | null;
};

export type DailyBriefingSuggestedAction = {
  id: string;
  kind: "assistant_intent" | "navigate";
  label: string;
  intent: string | null;
  href: string | null;
  attentionId: string | null;
};

export type DailyBriefingOperationsInboxItem = {
  id: string;
  type: string;
  severity: DailyBriefingSeverity;
  title: string;
  description: string;
  prompt: string;
  href: string | null;
};

export type DailyBriefingNarrative = {
  headline: string;
  summary: string;
  attentionIds: string[];
};
