import { aiProductText } from "../ai-product-copy.js";
import { createHash } from "node:crypto";

import { resolveAiLocale, type AiLocale } from "../ai-locale.js";
import {
  BUSINESS_ADVISOR_CATEGORY,
  BUSINESS_ADVISOR_CONFIDENCE,
  BUSINESS_ADVISOR_EFFORT,
  BUSINESS_ADVISOR_KIND,
  BUSINESS_ADVISOR_PRIORITY,
  BUSINESS_ADVISOR_SCHEMA_VERSION,
  BUSINESS_ADVISOR_STATUS,
  type BusinessAdvisorCoverage,
  type BusinessAdvisorEvidence,
  type BusinessAdvisorNarrative,
  type BusinessAdvisorRecommendation,
  type BusinessAdvisorStatus,
} from "../business-advisor.types.js";

type UnknownRecord = Record<string, any>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const text = (value: unknown, maxLength = 240): string =>
  String(value ?? "")
    .trim()
    .slice(0, maxLength);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");

export const normalizeBusinessAdvisorLocale = (value: unknown): AiLocale =>
  resolveAiLocale(value);

const sourceNames = (value: unknown): string[] =>
  [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((entry) =>
          text(typeof entry === "string" ? entry : entry?.source, 120),
        )
        .filter(Boolean),
    ),
  ].sort();

export const businessAdvisorCoverage = (
  value: unknown,
): BusinessAdvisorCoverage => {
  const coverage = asRecord(value);
  const available = sourceNames(coverage.available);
  const unavailable = (
    Array.isArray(coverage.unavailable) ? coverage.unavailable : []
  )
    .map((entry) => ({
      source: text(entry?.source, 120),
      reason: text(entry?.reason, 120) || "source_temporarily_unavailable",
    }))
    .filter(({ source }) => Boolean(source))
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.reason.localeCompare(right.reason),
    );
  const limitations = [
    ...new Set(
      (Array.isArray(coverage.limitations) ? coverage.limitations : [])
        .map((entry) => text(entry, 1_000))
        .filter(Boolean),
    ),
  ].sort();
  return {
    available,
    unavailable,
    limitations,
    complete: coverage.complete === true && unavailable.length === 0,
  };
};

const recommendationId = (key: string, overview: UnknownRecord): string =>
  `adv_${sha256({
    key,
    locationId: overview.metadata?.locationId || null,
  }).slice(0, 24)}`;

const evidenceId = (source: string, metric: string): string =>
  `ev_${sha256({ source, metric }).slice(0, 20)}`;

const reportPeriod = (overview: UnknownRecord) => {
  const period = asRecord(overview.metadata?.period);
  const from = text(period.from, 10);
  const to = text(period.to, 10);
  return from && to ? { from, to } : null;
};

const reportHref = (
  overview: UnknownRecord,
  tab: "sales" | "bookings" | "customers",
): string => {
  const period = reportPeriod(overview);
  const parameters = new URLSearchParams({
    section: "statistics",
    reportTab: tab,
    compare: "true",
  });
  if (period) {
    parameters.set("from", period.from);
    parameters.set("to", period.to);
  }
  const locationId = text(overview.metadata?.locationId, 100);
  if (locationId) parameters.set("locationId", locationId);
  return `/app/operations?${parameters.toString()}`;
};

const evidence = ({
  overview,
  source,
  metric,
  label,
  value,
  previousValue = null,
  changePercent = null,
  unit,
  currency = null,
  pointInTime = false,
}: {
  overview: UnknownRecord;
  source: string;
  metric: string;
  label: string;
  value: unknown;
  previousValue?: unknown;
  changePercent?: unknown;
  unit: BusinessAdvisorEvidence["unit"];
  currency?: string | null;
  pointInTime?: boolean;
}): BusinessAdvisorEvidence => ({
  id: evidenceId(source, metric),
  source,
  metric,
  label,
  value: finite(value),
  previousValue: finite(previousValue),
  changePercent: finite(changePercent),
  unit,
  currency: currency ? text(currency, 3).toUpperCase() : null,
  period: pointInTime ? null : reportPeriod(overview),
});

const recommendation = ({
  overview,
  key,
  category,
  kind,
  priority,
  impact,
  effort,
  confidence,
  title,
  rationale,
  nextStep,
  evidence: evidenceRows,
  href,
}: Omit<BusinessAdvisorRecommendation, "id" | "assistantIntent"> & {
  overview: UnknownRecord;
}): BusinessAdvisorRecommendation => {
  const id = recommendationId(key, overview);
  return {
    id,
    key,
    category,
    kind,
    priority,
    impact,
    effort,
    confidence,
    title,
    rationale,
    nextStep,
    evidence: evidenceRows,
    href,
    assistantIntent: `review-business-advisor:${id}`,
  };
};

const priorityRank = {
  [BUSINESS_ADVISOR_PRIORITY.HIGH]: 0,
  [BUSINESS_ADVISOR_PRIORITY.MEDIUM]: 1,
  [BUSINESS_ADVISOR_PRIORITY.LOW]: 2,
} as const;

const categoryRank = {
  [BUSINESS_ADVISOR_CATEGORY.REVENUE]: 0,
  [BUSINESS_ADVISOR_CATEGORY.CAPACITY]: 1,
  [BUSINESS_ADVISOR_CATEGORY.RETENTION]: 2,
  [BUSINESS_ADVISOR_CATEGORY.COURSES]: 3,
  [BUSINESS_ADVISOR_CATEGORY.INVENTORY]: 4,
  [BUSINESS_ADVISOR_CATEGORY.OPERATIONS]: 5,
} as const;

export const orderBusinessAdvisorRecommendations = (
  recommendations: BusinessAdvisorRecommendation[],
  rankedIds: readonly string[] = [],
): BusinessAdvisorRecommendation[] => {
  const requestedOrder = new Map<string, number>();
  rankedIds.forEach((id, index) => {
    if (!requestedOrder.has(id)) requestedOrder.set(id, index);
  });
  return [...recommendations].sort((left, right) => {
    const priorityDifference =
      priorityRank[left.priority] - priorityRank[right.priority];
    if (priorityDifference) return priorityDifference;
    const leftRequested = requestedOrder.get(left.id);
    const rightRequested = requestedOrder.get(right.id);
    if (leftRequested !== undefined || rightRequested !== undefined) {
      if (leftRequested === undefined) return 1;
      if (rightRequested === undefined) return -1;
      if (leftRequested !== rightRequested)
        return leftRequested - rightRequested;
    }
    return (
      categoryRank[left.category] - categoryRank[right.category] ||
      left.key.localeCompare(right.key)
    );
  });
};

/**
 * Converts verified report metrics into conservative, reversible advice.
 * The model can rank these cards but can never create or change one.
 */
export const buildBusinessAdvisorRecommendations = (
  overviewValue: unknown,
  localeValue: unknown,
): BusinessAdvisorRecommendation[] => {
  const overview = asRecord(overviewValue);
  const locale = normalizeBusinessAdvisorLocale(localeValue);
  const summary = asRecord(overview.summary);
  const salesKpi = asRecord(summary.netSales);
  const bookingKpi = asRecord(summary.bookings);
  const utilizationKpi = asRecord(summary.utilizationPercent);
  const returningKpi = asRecord(summary.returningCustomerPercent);
  const sales = asRecord(overview.sales);
  const bookings = asRecord(overview.bookings);
  const customers = asRecord(overview.customers);
  const operations = asRecord(overview.operations);
  const inventory = asRecord(operations.inventory);
  const staffTasks = asRecord(operations.staffTasks);
  const currency = text(overview.metadata?.currency, 3).toUpperCase() || null;
  const cards: BusinessAdvisorRecommendation[] = [];
  const salesOrders = finite(sales.orders);

  const salesValue = finite(salesKpi.value);
  const salesPrevious = finite(salesKpi.previous);
  const salesChange = finite(salesKpi.changePercent);
  if (
    salesValue !== null &&
    salesPrevious !== null &&
    salesPrevious > 0 &&
    salesOrders !== null &&
    salesOrders >= 10 &&
    salesChange !== null &&
    salesChange <= -20
  ) {
    cards.push(
      recommendation({
        overview,
        key: "revenue.net_sales_decline",
        category: BUSINESS_ADVISOR_CATEGORY.REVENUE,
        kind: BUSINESS_ADVISOR_KIND.RISK,
        priority:
          salesChange <= -35
            ? BUSINESS_ADVISOR_PRIORITY.HIGH
            : BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.HIGH,
        effort: BUSINESS_ADVISOR_EFFORT.MEDIUM,
        confidence:
          salesOrders >= 30
            ? BUSINESS_ADVISOR_CONFIDENCE.HIGH
            : BUSINESS_ADVISOR_CONFIDENCE.MEDIUM,
        title: aiProductText(localeValue, "advisor.message001"),
        rationale: aiProductText(localeValue, "advisor.message002", {
          value1: Math.abs(salesChange),
        }),
        nextStep: aiProductText(localeValue, "advisor.message003"),
        evidence: [
          evidence({
            overview,
            source: "sales",
            metric: "netSales",
            label: aiProductText(localeValue, "advisor.message004"),
            value: salesValue,
            previousValue: salesPrevious,
            changePercent: salesChange,
            unit: "minor_currency",
            currency,
          }),
        ],
        href: reportHref(overview, "sales"),
      }),
    );
  }

  const bookingsValue = finite(bookingKpi.value);
  const bookingsPrevious = finite(bookingKpi.previous);
  const bookingsChange = finite(bookingKpi.changePercent);
  if (
    bookingsValue !== null &&
    bookingsPrevious !== null &&
    bookingsPrevious >= 10 &&
    bookingsValue >= 10 &&
    bookingsChange !== null &&
    bookingsChange <= -20
  ) {
    cards.push(
      recommendation({
        overview,
        key: "capacity.booking_decline",
        category: BUSINESS_ADVISOR_CATEGORY.CAPACITY,
        kind: BUSINESS_ADVISOR_KIND.RISK,
        priority:
          bookingsChange <= -35
            ? BUSINESS_ADVISOR_PRIORITY.HIGH
            : BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.HIGH,
        effort: BUSINESS_ADVISOR_EFFORT.MEDIUM,
        confidence:
          Math.min(bookingsValue, bookingsPrevious) >= 30
            ? BUSINESS_ADVISOR_CONFIDENCE.HIGH
            : BUSINESS_ADVISOR_CONFIDENCE.MEDIUM,
        title: aiProductText(localeValue, "advisor.message005"),
        rationale: aiProductText(localeValue, "advisor.message006", {
          value1: Math.abs(bookingsChange),
        }),
        nextStep: aiProductText(localeValue, "advisor.message007"),
        evidence: [
          evidence({
            overview,
            source: "bookings",
            metric: "bookings",
            label: aiProductText(localeValue, "advisor.message008"),
            value: bookingsValue,
            previousValue: bookingsPrevious,
            changePercent: bookingsChange,
            unit: "count",
          }),
        ],
        href: reportHref(overview, "bookings"),
      }),
    );
  }

  const utilizationValue = finite(utilizationKpi.value);
  const utilizationPrevious = finite(utilizationKpi.previous);
  const utilizationDrop =
    utilizationValue !== null && utilizationPrevious !== null
      ? utilizationPrevious - utilizationValue
      : null;
  const bookingSample = finite(bookings.total);
  if (
    utilizationValue !== null &&
    bookingSample !== null &&
    bookingSample >= 10 &&
    utilizationValue < 30
  ) {
    cards.push(
      recommendation({
        overview,
        key: "capacity.low_utilization",
        category: BUSINESS_ADVISOR_CATEGORY.CAPACITY,
        kind: BUSINESS_ADVISOR_KIND.OPPORTUNITY,
        priority:
          utilizationValue < 15 ||
          (utilizationDrop !== null && utilizationDrop >= 15)
            ? BUSINESS_ADVISOR_PRIORITY.HIGH
            : BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.HIGH,
        effort: BUSINESS_ADVISOR_EFFORT.MEDIUM,
        confidence: BUSINESS_ADVISOR_CONFIDENCE.MEDIUM,
        title: aiProductText(localeValue, "advisor.message009"),
        rationale: aiProductText(localeValue, "advisor.message010", {
          value1: utilizationValue,
        }),
        nextStep: aiProductText(localeValue, "advisor.message011"),
        evidence: [
          evidence({
            overview,
            source: "bookings",
            metric: "utilizationPercent",
            label: aiProductText(localeValue, "advisor.message012"),
            value: utilizationValue,
            previousValue: utilizationPrevious,
            changePercent: utilizationKpi.changePercent,
            unit: "percent",
          }),
        ],
        href: reportHref(overview, "bookings"),
      }),
    );
  } else if (
    utilizationDrop !== null &&
    bookingSample !== null &&
    bookingSample >= 10 &&
    utilizationDrop >= 10
  ) {
    cards.push(
      recommendation({
        overview,
        key: "capacity.utilization_decline",
        category: BUSINESS_ADVISOR_CATEGORY.CAPACITY,
        kind: BUSINESS_ADVISOR_KIND.RISK,
        priority: BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        effort: BUSINESS_ADVISOR_EFFORT.MEDIUM,
        confidence: BUSINESS_ADVISOR_CONFIDENCE.MEDIUM,
        title: aiProductText(localeValue, "advisor.message013"),
        rationale: aiProductText(localeValue, "advisor.message014", {
          value1: utilizationDrop,
        }),
        nextStep: aiProductText(localeValue, "advisor.message015"),
        evidence: [
          evidence({
            overview,
            source: "bookings",
            metric: "utilizationPercent",
            label: aiProductText(localeValue, "advisor.message016"),
            value: utilizationValue,
            previousValue: utilizationPrevious,
            changePercent: utilizationKpi.changePercent,
            unit: "percent",
          }),
        ],
        href: reportHref(overview, "bookings"),
      }),
    );
  }

  const activeCustomers = finite(customers.active);
  const returningValue = finite(returningKpi.value);
  const returningPrevious = finite(returningKpi.previous);
  const returningDrop =
    returningValue !== null && returningPrevious !== null
      ? returningPrevious - returningValue
      : null;
  if (
    activeCustomers !== null &&
    activeCustomers >= 20 &&
    returningValue !== null &&
    returningValue < 30 &&
    returningPrevious !== null &&
    returningDrop !== null &&
    returningDrop >= 10
  ) {
    cards.push(
      recommendation({
        overview,
        key: "retention.returning_customers",
        category: BUSINESS_ADVISOR_CATEGORY.RETENTION,
        kind: BUSINESS_ADVISOR_KIND.OPPORTUNITY,
        priority:
          returningDrop >= 20
            ? BUSINESS_ADVISOR_PRIORITY.HIGH
            : BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.HIGH,
        effort: BUSINESS_ADVISOR_EFFORT.MEDIUM,
        // The Reports overview currently exposes the current cohort size but
        // not the comparison cohort size, so this trend must stay medium
        // confidence even when the current cohort is large.
        confidence: BUSINESS_ADVISOR_CONFIDENCE.MEDIUM,
        title: aiProductText(localeValue, "advisor.message017"),
        rationale: aiProductText(localeValue, "advisor.message018", {
          value1: returningValue,
          value2: activeCustomers,
        }),
        nextStep: aiProductText(localeValue, "advisor.message019"),
        evidence: [
          evidence({
            overview,
            source: "customers",
            metric: "returningCustomerPercent",
            label: aiProductText(localeValue, "advisor.message020"),
            value: returningValue,
            previousValue: returningPrevious,
            changePercent: returningKpi.changePercent,
            unit: "percent",
          }),
          evidence({
            overview,
            source: "customers",
            metric: "activeCustomers",
            label: aiProductText(localeValue, "advisor.message021"),
            value: activeCustomers,
            unit: "count",
          }),
        ],
        href: reportHref(overview, "customers"),
      }),
    );
  }

  const courseRows = Array.isArray(bookings.courseFill)
    ? bookings.courseFill
        .map((entry: unknown) => asRecord(entry))
        .filter((entry) => finite(entry.sessions) !== null)
    : [];
  const underfilled = [...courseRows]
    .filter(
      (entry) =>
        Number(entry.sessions) >= 3 &&
        Number(entry.capacity) >= 20 &&
        Number(entry.fillPercent) < 50,
    )
    .sort(
      (left, right) =>
        Number(left.fillPercent) - Number(right.fillPercent) ||
        text(left.name).localeCompare(text(right.name)),
    )[0];
  if (underfilled) {
    const name =
      text(underfilled.name, 160) ||
      aiProductText(localeValue, "advisor.message022");
    const fill = Number(underfilled.fillPercent);
    const key = `courses.underfilled:${text(underfilled.productId, 100) || name}`;
    cards.push(
      recommendation({
        overview,
        key,
        category: BUSINESS_ADVISOR_CATEGORY.COURSES,
        kind: BUSINESS_ADVISOR_KIND.OPPORTUNITY,
        priority:
          fill < 30
            ? BUSINESS_ADVISOR_PRIORITY.HIGH
            : BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        effort: BUSINESS_ADVISOR_EFFORT.MEDIUM,
        confidence:
          Number(underfilled.sessions) >= 5 &&
          Number(underfilled.capacity) >= 40
            ? BUSINESS_ADVISOR_CONFIDENCE.HIGH
            : BUSINESS_ADVISOR_CONFIDENCE.MEDIUM,
        title: aiProductText(localeValue, "advisor.message023", {
          value1: name,
        }),
        rationale: aiProductText(localeValue, "advisor.message024", {
          value1: fill,
          value2: Number(underfilled.sessions),
        }),
        nextStep: aiProductText(localeValue, "advisor.message025"),
        evidence: [
          evidence({
            overview,
            source: "courses",
            metric: `courseFill:${text(underfilled.productId, 100)}`,
            label: name,
            value: fill,
            unit: "percent",
          }),
        ],
        href: "/app/products",
      }),
    );
  }

  const highDemand = [...courseRows]
    .filter(
      (entry) =>
        Number(entry.sessions) >= 3 &&
        Number(entry.capacity) >= 20 &&
        Number(entry.fillPercent) >= 85,
    )
    .sort(
      (left, right) =>
        Number(right.fillPercent) - Number(left.fillPercent) ||
        text(left.name).localeCompare(text(right.name)),
    )[0];
  if (highDemand) {
    const name =
      text(highDemand.name, 160) ||
      aiProductText(localeValue, "advisor.message026");
    const fill = Number(highDemand.fillPercent);
    const key = `courses.high_demand:${text(highDemand.productId, 100) || name}`;
    cards.push(
      recommendation({
        overview,
        key,
        category: BUSINESS_ADVISOR_CATEGORY.COURSES,
        kind: BUSINESS_ADVISOR_KIND.OPPORTUNITY,
        priority: BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        effort: BUSINESS_ADVISOR_EFFORT.MEDIUM,
        confidence:
          Number(highDemand.sessions) >= 5 && Number(highDemand.capacity) >= 40
            ? BUSINESS_ADVISOR_CONFIDENCE.HIGH
            : BUSINESS_ADVISOR_CONFIDENCE.MEDIUM,
        title: aiProductText(localeValue, "advisor.message027", {
          value1: name,
        }),
        rationale: aiProductText(localeValue, "advisor.message028", {
          value1: fill,
          value2: Number(highDemand.sessions),
        }),
        nextStep: aiProductText(localeValue, "advisor.message029"),
        evidence: [
          evidence({
            overview,
            source: "courses",
            metric: `courseFill:${text(highDemand.productId, 100)}`,
            label: name,
            value: fill,
            unit: "percent",
          }),
        ],
        href: "/app/products",
      }),
    );
  }

  const lowStock = finite(inventory.lowStockItems);
  const openReorders = finite(inventory.openReorders);
  if (
    lowStock !== null &&
    lowStock > 0 &&
    openReorders !== null &&
    openReorders < lowStock
  ) {
    cards.push(
      recommendation({
        overview,
        key: "inventory.uncovered_low_stock",
        category: BUSINESS_ADVISOR_CATEGORY.INVENTORY,
        kind: BUSINESS_ADVISOR_KIND.RISK,
        priority:
          lowStock - openReorders >= 3
            ? BUSINESS_ADVISOR_PRIORITY.HIGH
            : BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        effort: BUSINESS_ADVISOR_EFFORT.LOW,
        confidence: BUSINESS_ADVISOR_CONFIDENCE.HIGH,
        title: aiProductText(localeValue, "advisor.message030"),
        rationale: aiProductText(localeValue, "advisor.message031", {
          value1: lowStock,
          value2: openReorders,
        }),
        nextStep: aiProductText(localeValue, "advisor.message032"),
        evidence: [
          evidence({
            overview,
            source: "inventory",
            metric: "lowStockItems",
            label: aiProductText(localeValue, "advisor.message033"),
            value: lowStock,
            unit: "count",
            pointInTime: true,
          }),
          evidence({
            overview,
            source: "inventory",
            metric: "openReorders",
            label: aiProductText(localeValue, "advisor.message034"),
            value: openReorders,
            unit: "count",
            pointInTime: true,
          }),
        ],
        href: "/app/operations?section=inventory",
      }),
    );
  }

  const overdueTasks = finite(staffTasks.overdue);
  const openTasks = finite(staffTasks.open);
  const completionRate = finite(staffTasks.completionRatePercent);
  const overdueRate =
    overdueTasks !== null && openTasks !== null && openTasks > 0
      ? (overdueTasks / openTasks) * 100
      : null;
  if (
    overdueTasks !== null &&
    overdueTasks >= 3 &&
    openTasks !== null &&
    openTasks >= 10 &&
    ((overdueRate !== null && overdueRate >= 25) ||
      (completionRate !== null && completionRate < 70))
  ) {
    cards.push(
      recommendation({
        overview,
        key: "operations.overdue_tasks",
        category: BUSINESS_ADVISOR_CATEGORY.OPERATIONS,
        kind: BUSINESS_ADVISOR_KIND.RISK,
        priority:
          overdueTasks >= 7
            ? BUSINESS_ADVISOR_PRIORITY.HIGH
            : BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        impact: BUSINESS_ADVISOR_PRIORITY.MEDIUM,
        effort: BUSINESS_ADVISOR_EFFORT.LOW,
        confidence: BUSINESS_ADVISOR_CONFIDENCE.HIGH,
        title: aiProductText(localeValue, "advisor.message035"),
        rationale: aiProductText(localeValue, "advisor.message036", {
          value1: overdueTasks,
        }),
        nextStep: aiProductText(localeValue, "advisor.message037"),
        evidence: [
          evidence({
            overview,
            source: "staffTasks",
            metric: "overdueTasks",
            label: aiProductText(localeValue, "advisor.message038"),
            value: overdueTasks,
            unit: "count",
            pointInTime: true,
          }),
        ],
        href: "/app/operations?section=tasks",
      }),
    );
  }

  return orderBusinessAdvisorRecommendations(cards).slice(0, 5);
};

export const resolveBusinessAdvisorStatus = (
  overviewValue: unknown,
  recommendations: BusinessAdvisorRecommendation[],
): BusinessAdvisorStatus => {
  if (recommendations.length) return BUSINESS_ADVISOR_STATUS.READY;
  const overview = asRecord(overviewValue);
  const bookings = asRecord(overview.bookings);
  const sales = asRecord(overview.sales);
  const customers = asRecord(overview.customers);
  const operations = asRecord(overview.operations);
  const courseRows = Array.isArray(bookings.courseFill)
    ? bookings.courseFill
    : [];
  const enoughHistory =
    Number(bookings.total || 0) >= 10 ||
    Number(sales.orders || 0) >= 10 ||
    Number(customers.active || 0) >= 20 ||
    courseRows.some(
      (entry: any) =>
        Number(entry?.sessions || 0) >= 3 && Number(entry?.capacity || 0) >= 20,
    );
  const hasOperationalSignal = [
    operations.inventory,
    operations.staffTasks,
  ].some((entry) => entry && typeof entry === "object");
  return enoughHistory || hasOperationalSignal
    ? BUSINESS_ADVISOR_STATUS.NO_SIGNAL
    : BUSINESS_ADVISOR_STATUS.LEARNING;
};

export const deterministicBusinessAdvisorNarrative = (
  recommendations: BusinessAdvisorRecommendation[],
  coverage: BusinessAdvisorCoverage,
  localeValue: unknown,
): BusinessAdvisorNarrative => {
  const high = recommendations.filter(
    ({ priority }) => priority === BUSINESS_ADVISOR_PRIORITY.HIGH,
  ).length;
  if (!recommendations.length) {
    return {
      headline: aiProductText(localeValue, "advisor.message039"),
      summary: coverage.complete
        ? aiProductText(localeValue, "advisor.message040")
        : aiProductText(localeValue, "advisor.message041"),
      rankedRecommendationIds: [],
    };
  }
  return {
    headline: high
      ? aiProductText(localeValue, "advisor.message042")
      : aiProductText(localeValue, "advisor.message043"),
    summary: aiProductText(localeValue, "advisor.message044", {
      value1: recommendations.length,
    }),
    rankedRecommendationIds: recommendations.map(({ id }) => id),
  };
};

const numericTokens = (value: string): string[] =>
  value.match(/-?\d+(?:[.,]\d+)?/g)?.map((token) => token.replace(",", ".")) ??
  [];

const collectNumbers = (value: unknown, target = new Set<string>()) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    target.add(String(value));
  } else if (typeof value === "string") {
    numericTokens(value).forEach((token) => target.add(token));
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectNumbers(entry, target));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => collectNumbers(entry, target));
  }
  return target;
};

export const isGroundedBusinessAdvisorNarrative = (
  value: BusinessAdvisorNarrative,
  recommendations: BusinessAdvisorRecommendation[],
  _facts: unknown,
): boolean => {
  const allowedIds = new Set(recommendations.map(({ id }) => id));
  if (
    value.rankedRecommendationIds.length !== recommendations.length ||
    value.rankedRecommendationIds.length !==
      new Set(value.rankedRecommendationIds).size ||
    value.rankedRecommendationIds.some((id) => !allowedIds.has(id))
  ) {
    return false;
  }
  const priorityById = new Map(
    recommendations.map(({ id, priority }) => [id, priorityRank[priority]]),
  );
  const rankedPriorities = value.rankedRecommendationIds.map(
    (id) => priorityById.get(id) ?? Number.POSITIVE_INFINITY,
  );
  if (
    rankedPriorities.some(
      (rank, index) => index > 0 && rank < rankedPriorities[index - 1]!,
    )
  ) {
    return false;
  }
  const narrative = `${value.headline}\n${value.summary}`;
  if (
    /\b(because|caused by|due to|will increase|will improve|guarantee|forecast|protože|způsoben[oa]?|kvůli|zaručí|povede k|předpovíd)\b/i.test(
      narrative,
    )
  ) {
    return false;
  }
  const allowedNumbers = collectNumbers(
    recommendations.flatMap(({ evidence }) =>
      evidence.map(({ value, previousValue, changePercent }) => ({
        value,
        previousValue,
        changePercent,
      })),
    ),
  );
  return numericTokens(narrative).every((token) => allowedNumbers.has(token));
};

export const createBusinessAdvisorScopeKey = ({
  locationId,
  allowedLocationIds,
}: {
  locationId?: string | null;
  allowedLocationIds: readonly string[] | null;
}): string => {
  if (locationId) return `location:${locationId}`;
  if (allowedLocationIds === null) return "all-locations";
  const normalized = [...new Set(allowedLocationIds.map(String))].sort();
  return `locations:${sha256(normalized).slice(0, 32)}`;
};

export const createBusinessAdvisorAccessFingerprint = ({
  access,
  locationId,
  allowedLocationIds,
  modules,
  settingsVersion,
}: {
  access: UnknownRecord;
  locationId?: string | null;
  allowedLocationIds: readonly string[] | null;
  modules: unknown;
  settingsVersion: unknown;
}): string =>
  sha256({
    schemaVersion: BUSINESS_ADVISOR_SCHEMA_VERSION,
    accessVersion: finite(access.accessVersion) || 0,
    role: text(access.role, 80),
    permissions: Array.isArray(access.permissions)
      ? [...new Set(access.permissions.map(String))].sort()
      : [],
    locationMode: text(access.locationAccess?.mode, 40),
    selectedLocationId: locationId || null,
    allowedLocationIds:
      allowedLocationIds === null
        ? null
        : [...new Set(allowedLocationIds.map(String))].sort(),
    modules: Object.entries(asRecord(modules))
      .map(([key, entry]) => [key, entry === true] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    settingsVersion: String(settingsVersion || ""),
  });

export const createBusinessAdvisorSnapshotHash = ({
  locale,
  accessFingerprint,
  period,
  coverage,
  recommendations,
}: {
  locale: string;
  accessFingerprint: string;
  period: unknown;
  coverage: BusinessAdvisorCoverage;
  recommendations: BusinessAdvisorRecommendation[];
}): string =>
  sha256({
    schemaVersion: BUSINESS_ADVISOR_SCHEMA_VERSION,
    locale,
    accessFingerprint,
    period,
    coverage,
    recommendations,
  });

export const businessAdvisorSnapshotService = {
  buildRecommendations: buildBusinessAdvisorRecommendations,
  deterministicNarrative: deterministicBusinessAdvisorNarrative,
  orderRecommendations: orderBusinessAdvisorRecommendations,
  isGroundedNarrative: isGroundedBusinessAdvisorNarrative,
  coverage: businessAdvisorCoverage,
  createScopeKey: createBusinessAdvisorScopeKey,
  createAccessFingerprint: createBusinessAdvisorAccessFingerprint,
  createSnapshotHash: createBusinessAdvisorSnapshotHash,
  resolveStatus: resolveBusinessAdvisorStatus,
};
