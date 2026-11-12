export const BUSINESS_ADVISOR_SCHEMA_VERSION = "studio-business-advisor-v1";
export const BUSINESS_ADVISOR_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
export const BUSINESS_ADVISOR_ADVICE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1_000;
export const BUSINESS_ADVISOR_RETENTION_MS = 120 * 24 * 60 * 60 * 1_000;

export const BUSINESS_ADVISOR_CATEGORY = {
  REVENUE: "revenue",
  CAPACITY: "capacity",
  RETENTION: "retention",
  COURSES: "courses",
  INVENTORY: "inventory",
  OPERATIONS: "operations",
} as const;

export const BUSINESS_ADVISOR_KIND = {
  RISK: "risk",
  OPPORTUNITY: "opportunity",
} as const;

export const BUSINESS_ADVISOR_PRIORITY = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export const BUSINESS_ADVISOR_EFFORT = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;

export const BUSINESS_ADVISOR_CONFIDENCE = {
  HIGH: "high",
  MEDIUM: "medium",
} as const;

export const BUSINESS_ADVISOR_STATUS = {
  LEARNING: "learning",
  NO_SIGNAL: "no_signal",
  READY: "ready",
} as const;

export type BusinessAdvisorCategory =
  (typeof BUSINESS_ADVISOR_CATEGORY)[keyof typeof BUSINESS_ADVISOR_CATEGORY];
export type BusinessAdvisorKind =
  (typeof BUSINESS_ADVISOR_KIND)[keyof typeof BUSINESS_ADVISOR_KIND];
export type BusinessAdvisorPriority =
  (typeof BUSINESS_ADVISOR_PRIORITY)[keyof typeof BUSINESS_ADVISOR_PRIORITY];
export type BusinessAdvisorEffort =
  (typeof BUSINESS_ADVISOR_EFFORT)[keyof typeof BUSINESS_ADVISOR_EFFORT];
export type BusinessAdvisorConfidence =
  (typeof BUSINESS_ADVISOR_CONFIDENCE)[keyof typeof BUSINESS_ADVISOR_CONFIDENCE];
export type BusinessAdvisorStatus =
  (typeof BUSINESS_ADVISOR_STATUS)[keyof typeof BUSINESS_ADVISOR_STATUS];

export type BusinessAdvisorEvidence = {
  id: string;
  source: string;
  metric: string;
  label: string;
  value: number | null;
  previousValue: number | null;
  changePercent: number | null;
  unit: "count" | "percent" | "minor_currency" | "hours";
  currency: string | null;
  period: { from: string; to: string } | null;
};

export type BusinessAdvisorRecommendation = {
  id: string;
  key: string;
  category: BusinessAdvisorCategory;
  kind: BusinessAdvisorKind;
  priority: BusinessAdvisorPriority;
  impact: BusinessAdvisorPriority;
  effort: BusinessAdvisorEffort;
  confidence: BusinessAdvisorConfidence;
  title: string;
  rationale: string;
  nextStep: string;
  evidence: BusinessAdvisorEvidence[];
  href: string;
  assistantIntent: string;
};

export type BusinessAdvisorCoverage = {
  available: string[];
  unavailable: Array<{ source: string; reason: string }>;
  limitations: string[];
  complete: boolean;
};

export type BusinessAdvisorPeriod = {
  from: string;
  to: string;
  comparisonPeriod: { from: string; to: string } | null;
  timezone: string;
  currency: string;
  locationId: string | null;
};

export type BusinessAdvisorNarrative = {
  headline: string;
  summary: string;
  rankedRecommendationIds: string[];
};
