import { aiProductText } from "../ai-product-copy.js";
import { createHash } from "node:crypto";

import {
  DAILY_BRIEFING_SCHEMA_VERSION,
  DAILY_BRIEFING_SEVERITY,
  type DailyBriefingAttention,
  type DailyBriefingCoverage,
  type DailyBriefingMetrics,
  type DailyBriefingNarrative,
  type DailyBriefingOperationsInboxItem,
  type DailyBriefingSuggestedAction,
} from "../daily-briefing.types.js";

type UnknownRecord = Record<string, any>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};

const finiteNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
};

const sourceName = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  const source = asRecord(value).source;
  return typeof source === "string" ? source.trim() : "";
};

const sourceList = (value: unknown): string[] =>
  [
    ...new Set(
      (Array.isArray(value) ? value : []).map(sourceName).filter(Boolean),
    ),
  ].sort();

const normalizeCoverage = (value: unknown): DailyBriefingCoverage => {
  const coverage = asRecord(value);
  const available = sourceList(coverage.available);
  const unavailable = sourceList([
    ...(Array.isArray(coverage.unavailable) ? coverage.unavailable : []),
    ...(Array.isArray(coverage.omitted) ? coverage.omitted : []),
  ]).filter((source) => !available.includes(source));
  return {
    available,
    unavailable,
    complete: coverage.complete === true && unavailable.length === 0,
  };
};

const moneyByCurrency = (value: unknown): Record<string, number> | null => {
  const entries = Object.entries(asRecord(value))
    .map(
      ([currency, amount]) =>
        [currency.trim().toUpperCase(), finiteNumber(amount)] as const,
    )
    .filter(
      (entry): entry is readonly [string, number] =>
        Boolean(entry[0]) && entry[1] !== null,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? Object.fromEntries(entries) : null;
};

export const extractDailyBriefingMetrics = (
  operationsValue: unknown,
): DailyBriefingMetrics => {
  const operations = asRecord(operationsValue);
  const coverage = normalizeCoverage(operations.coverage);
  const has = (source: string) => coverage.available.includes(source);
  const bookings = asRecord(operations.bookings);
  const tasks = asRecord(operations.tasks);
  const staffPlanning = asRecord(operations.staffPlanning);
  const staffCounts = asRecord(staffPlanning.counts);
  const staffToday = asRecord(staffPlanning.today);
  const boundedStaff = asRecord(staffToday.staff);
  const staffItems = Array.isArray(staffToday.staff)
    ? staffToday.staff
    : Array.isArray(boundedStaff.items)
      ? boundedStaff.items
      : [];
  const detailedBlockedStaff = staffItems.filter((member: unknown) => {
    const update = asRecord(asRecord(member).update);
    return String(update.blockers ?? "").trim().length > 0;
  });
  const detailedBlockedOwnerAttention = detailedBlockedStaff.filter(
    (member: unknown) =>
      asRecord(asRecord(member).update).needsOwnerAttention === true,
  ).length;
  const reportedBlockedStaff = finiteNumber(staffCounts.blocked);
  const reportedOwnerAttention = finiteNumber(staffCounts.needsOwnerAttention);
  const inventory = asRecord(operations.inventory);
  const communications = asRecord(operations.communications);
  const orders = asRecord(operations.orders);

  return {
    bookingsToday: has("bookings") ? finiteNumber(bookings.todayCount) : null,
    unpaidBookings: has("bookings")
      ? finiteNumber(
          bookings.unpaidCount,
          bookings.unpaid,
          bookings.unpaidFuture?.bookings?.total,
        )
      : null,
    occupancyPercent: has("bookings")
      ? finiteNumber(bookings.occupancyPercent, bookings.occupancy)
      : null,
    openTasks: has("tasks") ? finiteNumber(tasks.openCount) : null,
    overdueTasks: has("tasks")
      ? finiteNumber(tasks.overdueCount, tasks.overdue)
      : null,
    urgentTasks: has("tasks") ? finiteNumber(tasks.urgent) : null,
    missingStaffUpdates: has("staffPlanning")
      ? finiteNumber(staffCounts.missing)
      : null,
    blockedStaffUpdates: has("staffPlanning")
      ? reportedBlockedStaff === null && detailedBlockedStaff.length === 0
        ? null
        : Math.max(reportedBlockedStaff ?? 0, detailedBlockedStaff.length)
      : null,
    staffUpdatesNeedingOwnerAttention: has("staffPlanning")
      ? reportedOwnerAttention === null
        ? null
        : Math.max(reportedOwnerAttention - detailedBlockedOwnerAttention, 0)
      : null,
    lowStockItems: has("inventory")
      ? finiteNumber(inventory.lowStockCount)
      : null,
    openConversations: has("communications")
      ? finiteNumber(communications.open)
      : null,
    urgentConversations: has("communications")
      ? finiteNumber(communications.urgent)
      : null,
    unreadConversations: has("communications")
      ? finiteNumber(communications.unread)
      : null,
    paidOrdersToday: has("orders") ? finiteNumber(orders.paidToday) : null,
    paidTotalsMinorByCurrency: has("orders")
      ? moneyByCurrency(orders.totalsMinorByCurrency)
      : null,
    coverage,
    sourceCount: coverage.available.length,
  };
};

const attentionItem = ({
  id,
  key,
  severity,
  metricKey,
  value,
  title,
  description,
  href,
}: DailyBriefingAttention): DailyBriefingAttention => ({
  id,
  key,
  severity,
  metricKey,
  value,
  title,
  description,
  href,
});

export const buildDailyBriefingAttention = (
  metrics: DailyBriefingMetrics,
  locale: string,
): DailyBriefingAttention[] => {
  const items: DailyBriefingAttention[] = [];
  const positive = (value: number | null): value is number =>
    value !== null && value > 0;

  if (positive(metrics.urgentConversations)) {
    const count = aiProductText(locale, "briefing.message001", {
      count: metrics.urgentConversations,
    });
    items.push(
      attentionItem({
        id: "urgent-conversations",
        key: "urgent_conversations",
        severity: DAILY_BRIEFING_SEVERITY.CRITICAL,
        metricKey: "urgentConversations",
        value: metrics.urgentConversations,
        title: aiProductText(locale, "briefing.message002"),
        description: aiProductText(locale, "briefing.message003", {
          value1: count,
        }),
        href: "/app/communications?section=inbox",
      }),
    );
  }

  if (positive(metrics.overdueTasks)) {
    const count = aiProductText(locale, "briefing.message004", {
      count: metrics.overdueTasks,
    });
    items.push(
      attentionItem({
        id: "overdue-tasks",
        key: "overdue_tasks",
        severity: DAILY_BRIEFING_SEVERITY.CRITICAL,
        metricKey: "overdueTasks",
        value: metrics.overdueTasks,
        title: aiProductText(locale, "briefing.message005"),
        description: aiProductText(locale, "briefing.message006", {
          value1: count,
        }),
        href: "/app/operations?section=tasks",
      }),
    );
  }

  if (positive(metrics.blockedStaffUpdates)) {
    const count = aiProductText(locale, "briefing.message007", {
      count: metrics.blockedStaffUpdates,
    });
    items.push(
      attentionItem({
        id: "blocked-staff-updates",
        key: "blocked_staff_updates",
        severity: DAILY_BRIEFING_SEVERITY.CRITICAL,
        metricKey: "blockedStaffUpdates",
        value: metrics.blockedStaffUpdates,
        title: aiProductText(locale, "briefing.message008"),
        description: aiProductText(locale, "briefing.message009", {
          value1: count,
        }),
        href: "/app/operations?section=tasks",
      }),
    );
  }

  if (positive(metrics.urgentTasks)) {
    const count = aiProductText(locale, "briefing.message010", {
      count: metrics.urgentTasks,
    });
    items.push(
      attentionItem({
        id: "urgent-tasks",
        key: "urgent_tasks",
        severity: DAILY_BRIEFING_SEVERITY.WARNING,
        metricKey: "urgentTasks",
        value: metrics.urgentTasks,
        title: aiProductText(locale, "briefing.message011"),
        description: aiProductText(locale, "briefing.message012", {
          value1: count,
        }),
        href: "/app/operations?section=tasks",
      }),
    );
  }

  if (positive(metrics.unpaidBookings)) {
    const count = aiProductText(locale, "briefing.message013", {
      count: metrics.unpaidBookings,
    });
    items.push(
      attentionItem({
        id: "unpaid-bookings",
        key: "unpaid_bookings",
        severity: DAILY_BRIEFING_SEVERITY.WARNING,
        metricKey: "unpaidBookings",
        value: metrics.unpaidBookings,
        title: aiProductText(locale, "briefing.message014"),
        description: aiProductText(locale, "briefing.message015", {
          value1: count,
        }),
        href: "/app/bookings",
      }),
    );
  }

  if (positive(metrics.lowStockItems)) {
    const count = aiProductText(locale, "briefing.message016", {
      count: metrics.lowStockItems,
    });
    items.push(
      attentionItem({
        id: "low-stock-items",
        key: "low_stock_items",
        severity: DAILY_BRIEFING_SEVERITY.WARNING,
        metricKey: "lowStockItems",
        value: metrics.lowStockItems,
        title: aiProductText(locale, "briefing.message017"),
        description: aiProductText(locale, "briefing.message018", {
          value1: count,
        }),
        href: "/app/operations?section=inventory",
      }),
    );
  }

  if (positive(metrics.staffUpdatesNeedingOwnerAttention)) {
    const count = aiProductText(locale, "briefing.message019", {
      count: metrics.staffUpdatesNeedingOwnerAttention,
    });
    items.push(
      attentionItem({
        id: "staff-updates-owner-attention",
        key: "staff_updates_owner_attention",
        severity: DAILY_BRIEFING_SEVERITY.WARNING,
        metricKey: "staffUpdatesNeedingOwnerAttention",
        value: metrics.staffUpdatesNeedingOwnerAttention,
        title: aiProductText(locale, "briefing.message020"),
        description: aiProductText(locale, "briefing.message021", {
          value1: count,
        }),
        href: "/app/operations?section=tasks",
      }),
    );
  }

  if (!metrics.coverage.complete) {
    const count = metrics.coverage.unavailable.length;
    items.push(
      attentionItem({
        id: "partial-coverage",
        key: "partial_coverage",
        severity: DAILY_BRIEFING_SEVERITY.INFO,
        metricKey: "coverage",
        value: count || null,
        title: aiProductText(locale, "briefing.message022"),
        description: aiProductText(locale, "briefing.message023"),
        href: null,
      }),
    );
  }

  return items;
};

export const buildDeterministicBriefingNarrative = (
  metrics: DailyBriefingMetrics,
  attention: DailyBriefingAttention[],
  locale: string,
): DailyBriefingNarrative => {
  const actionable = attention.filter(({ key }) => key !== "partial_coverage");
  const facts: string[] = [];
  if (metrics.bookingsToday !== null) {
    facts.push(
      aiProductText(locale, "briefing.message024", {
        count: metrics.bookingsToday,
      }),
    );
  }
  if (metrics.openTasks !== null) {
    facts.push(
      aiProductText(locale, "briefing.message025", {
        count: metrics.openTasks,
      }),
    );
  }

  const headline = actionable.length
    ? aiProductText(locale, "briefing.message026")
    : aiProductText(locale, "briefing.message027");
  const factSentence = facts.length
    ? facts.join(", ")
    : aiProductText(locale, "briefing.message028");
  const coverageSentence = metrics.coverage.complete
    ? aiProductText(locale, "briefing.message029")
    : aiProductText(locale, "briefing.message030");

  return {
    headline,
    summary: `${factSentence}. ${coverageSentence}`,
    attentionIds: attention.map(({ id }) => id),
  };
};

export const orderDailyBriefingAttention = (
  attention: DailyBriefingAttention[],
  selectedIds: unknown,
): DailyBriefingAttention[] => {
  const byId = new Map(attention.map((item) => [item.id, item]));
  const ordered: DailyBriefingAttention[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(selectedIds) ? selectedIds : []) {
    if (typeof id !== "string" || seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    ordered.push(byId.get(id)!);
  }
  for (const item of attention) {
    if (seen.has(item.id)) continue;
    ordered.push(item);
  }
  return ordered;
};

export const buildDailyBriefingOperationsInbox = ({
  attention,
  suggestedActions,
  locale,
}: {
  attention: DailyBriefingAttention[];
  suggestedActions: DailyBriefingSuggestedAction[];
  locale: string;
}): DailyBriefingOperationsInboxItem[] => {
  const actionsByAttentionId = new Map(
    suggestedActions
      .filter((action) => action.attentionId)
      .map((action) => [action.attentionId!, action]),
  );
  const safeAppHref = (value: unknown): string | null => {
    const href = String(value || "").trim();
    return /^\/app(?:[/?#]|$)/.test(href) ? href.slice(0, 300) : null;
  };

  return attention.slice(0, 10).map((item) => {
    const action = actionsByAttentionId.get(item.id);
    const description = String(item.description || "")
      .trim()
      .slice(0, 1_000);
    const prompt = aiProductText(locale, "briefing.message031", {
      value1: description,
    }).slice(0, 500);
    return {
      id: String(item.id || "").slice(0, 100),
      type: String(item.key || "").slice(0, 100),
      severity: item.severity,
      title: String(item.title || "")
        .trim()
        .slice(0, 300),
      description,
      prompt,
      href: safeAppHref(item.href) || safeAppHref(action?.href),
    };
  });
};

export const buildDailyBriefingSuggestedActions = (
  attention: DailyBriefingAttention[],
  locale: string,
): DailyBriefingSuggestedAction[] => {
  const actions: DailyBriefingSuggestedAction[] = [
    {
      id: "review-daily-briefing",
      kind: "assistant_intent",
      label: aiProductText(locale, "briefing.message032"),
      intent: "review-daily-briefing",
      href: "/app/ai?intent=review-daily-briefing",
      attentionId: null,
    },
  ];
  for (const item of attention) {
    if (!item.href || actions.some(({ href }) => href === item.href)) continue;
    actions.push({
      id: `open-${item.id}`,
      kind: "navigate",
      label: item.title,
      intent: null,
      href: item.href,
      attentionId: item.id,
    });
  }
  return actions;
};

const sha256 = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const createDailyBriefingScopeKey = ({
  locationId,
  allowedLocationIds,
}: {
  locationId?: string | null;
  allowedLocationIds: readonly string[] | null;
}) => {
  if (locationId) return `location:${locationId}`;
  if (allowedLocationIds === null) return "all-locations";
  const locationIds = [...new Set(allowedLocationIds.map(String))].sort();
  return `locations:${sha256(locationIds).slice(0, 32)}`;
};

export const createDailyBriefingAccessFingerprint = ({
  access,
  locationId,
  allowedLocationIds,
  modules,
  settingsVersion,
  contextVersion,
}: {
  access: UnknownRecord;
  locationId?: string | null;
  allowedLocationIds: readonly string[] | null;
  modules?: unknown;
  settingsVersion?: unknown;
  contextVersion: string;
}) =>
  sha256({
    contextVersion,
    authorizationVersion: finiteNumber(access.accessVersion) || 0,
    permissions: Array.isArray(access.permissions)
      ? [...new Set(access.permissions.map(String))].sort()
      : [],
    locationMode: String(access.locationAccess?.mode || ""),
    selectedLocationId: locationId || null,
    allowedLocationIds:
      allowedLocationIds === null
        ? null
        : [...new Set(allowedLocationIds.map(String))].sort(),
    modules: Object.entries(asRecord(modules))
      .map(([key, value]) => [key, value === true] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    settingsVersion: String(settingsVersion || ""),
  });

export const createDailyBriefingSnapshotHash = ({
  dateKey,
  timezone,
  locale,
  accessFingerprint,
  metrics,
  attention,
}: {
  dateKey: string;
  timezone: string;
  locale: string;
  accessFingerprint: string;
  metrics: DailyBriefingMetrics;
  attention: DailyBriefingAttention[];
}) =>
  sha256({
    schemaVersion: DAILY_BRIEFING_SCHEMA_VERSION,
    dateKey,
    timezone,
    locale,
    accessFingerprint,
    metrics,
    attention: attention.map(({ id, key, severity, metricKey, value }) => ({
      id,
      key,
      severity,
      metricKey,
      value,
    })),
  });

export const normalizeDailyBriefingTimezone = (value: unknown): string => {
  const timezone = String(value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return "UTC";
  }
};

export const localDateKey = (date: Date, timezone: string): string => {
  const safeTimezone = normalizeDailyBriefingTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
};
