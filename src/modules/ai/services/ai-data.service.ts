import { isNativeInvoicingEnabled } from "@/modules/invoice/invoice.feature.js";
import { activeBookingParticipants } from "@/modules/booking/booking.attendance-read.js";
import mongoose from "mongoose";
import dayjs from "dayjs";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import Booking from "@/modules/booking/booking.model.js";
import {
  BOOKING_STATUS,
  BOOKING_TAG,
  CLASS_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import { CommunicationConversationModel } from "@/modules/communications/communications.models.js";
import { buildConversationVisibilityFilter } from "@/modules/communications/communication.access.js";
import { CommunicationAutomation } from "@/modules/communication-automations/communication-automation.model.js";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import EventModel from "@/modules/event/event.model.js";
import {
  INVOICE_DOCUMENT_STATUS,
  INVOICE_DOCUMENT_TYPE,
} from "@/modules/invoice/invoice.constants.js";
import InvoiceModel from "@/modules/invoice/invoice.schema.js";
import { buildInvoiceLocationScopeFilter } from "@/modules/invoice/invoice.access.js";
import {
  InventoryItem,
  ReorderRequest,
} from "@/modules/inventory/inventory.model.js";
import {
  REORDER_PRIORITY,
  REORDER_STATUS,
} from "@/modules/inventory/inventory.constants.js";
import { getCanonicalStockLevels } from "@/modules/inventory/inventory-stock-levels.js";
import LocationModel from "@/modules/location/location.model.js";
import { resolveLocationActivitySelectionMode } from "@/modules/location/location.utils.js";
import membershipRepository from "@/modules/membership/membership.repository.js";
import UserMembership from "@/modules/membership/user-membership.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Order } from "@/modules/order/order.model.js";
import { ORDER_STATUS } from "@/modules/order/order.constants.js";
import {
  buildOrderLocationScopeFilter,
  buildOrderReadLocationFilter,
} from "@/modules/order/order.access.js";
import ProductModel from "@/modules/product/product.model.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";
import StaffMemberModel from "@/modules/staff/staff-member.model.js";
import StaffTaskModel from "@/modules/staff/staff-task.model.js";
import { getStaffPlanningOverview } from "@/modules/staff/staff-planning.service.js";
import {
  canAccessWorkspaceLocation,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_PERMISSION,
  hasWorkspacePermission,
  type ResolvedWorkspaceAccess,
} from "@/modules/tenant-access/index.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import UserModel from "@/modules/user/user.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import {
  getTenantPublicSiteEditorState,
  getTenantPublicSitePreview,
} from "@/modules/tenants/settings/tenant-settings.service.js";
import { buildReportOverview } from "@/modules/reports/reports.service.js";
import { CURRENCY_EXPONENT } from "@/shared/money/currency.js";
import {
  STUDIO_CONTEXT_PROFILE,
  STUDIO_CONTEXT_VERSION,
  type StudioContextBuildInput,
  type StudioContextSnapshot,
} from "../studio-context.types.js";
import { scopeOperationalAccessToEnabledModules } from "./operational-context-access.service.js";

export { STUDIO_CONTEXT_VERSION } from "../studio-context.types.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const ids = (values: readonly string[] | null | undefined) =>
  values?.map((value) => new mongoose.Types.ObjectId(value)) || [];

const locationFilter = (
  field: string,
  allowedLocationIds: readonly string[] | null,
) =>
  allowedLocationIds === null
    ? {}
    : { [field]: { $in: ids(allowedLocationIds) } };

const taskLocationFilter = (allowedLocationIds: readonly string[] | null) =>
  allowedLocationIds === null
    ? {}
    : allowedLocationIds.length === 0
      ? { _id: { $exists: false } }
      : {
          $or: [
            { appliesToAllLocations: true },
            { appliesToAllLocations: false, locationId: null },
            { locationId: { $in: ids(allowedLocationIds) } },
          ],
        };

const ASSISTANT_CONTEXT_LIMIT = {
  LOCATIONS: 20,
  PRODUCTS: 20,
  COURSE_CATALOG: 15,
  COURSE_SESSIONS: 10,
  COURSE_REVENUE: 10,
  EVENTS: 8,
  TEAM: 25,
  INVENTORY: 20,
  INVENTORY_LEVELS: 20,
  REORDER_REQUESTS: 15,
  MEMBERSHIP_PLANS: 10,
  INVOICES: 10,
  KILNS: 12,
  PIECES: 10,
  PLANNING_STAFF: 25,
  PLANNING_WEEKLY_PLANS: 25,
  PLANNING_OUTCOMES: 12,
  PLANNING_PRIORITY_SETS: 12,
  PLANNING_PRIORITIES: 12,
  PLANNING_BOARD_TASKS: 30,
  TOMORROW_BOOKINGS: 25,
  UNPAID_FUTURE_BOOKINGS: 25,
  UNPAID_FUTURE_CUSTOMERS: 25,
  CREDIT_CURRENCIES: 12,
  CREDIT_TRANSACTION_GROUPS: 24,
  VOUCHER_STATUS_GROUPS: 12,
  AUTOMATION_STATUS_GROUPS: 12,
  AUTOMATION_SCHEDULE_GROUPS: 16,
  DELIVERY_STATUS_GROUPS: 12,
  DELIVERY_TYPE_GROUPS: 16,
  AUTOMATIONS: 10,
  PIECE_PRICING_PROFILES: 8,
  PIECE_PRICING_PROFILE_PRICE_CELLS: 24,
  FIRING_PROFILES: 8,
  FIRING_PROFILE_SIZES: 10,
  FIRING_PROFILE_PRICE_CELLS: 24,
  FIRING_RUNS: 10,
} as const;

export const WORKSPACE_ASSISTANT_CONTEXT_MAX_SERIALIZED_CHARS = 75_000;

const compactText = (value: unknown, maxLength = 600): string =>
  String(value ?? "")
    .trim()
    .slice(0, maxLength);

const boundedList = <T>(
  items: T[],
  total: number,
): { total: number; items: T[]; truncated: boolean } => ({
  total: Math.max(Number(total || 0), 0),
  items,
  truncated: Math.max(Number(total || 0), 0) > items.length,
});

const safeTenantModules = (value: unknown): Record<string, boolean> => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.values(TENANT_MODULE).map((module) => [
      module,
      raw[module] === true,
    ]),
  );
};

const moduleIsEnabled = (
  modules: Record<string, boolean>,
  module: string,
): boolean => modules[module] === true;

type AssistantLocationScope = {
  actorAllowedLocationIds: readonly string[] | null;
  requestedLocationId: string | null;
  requestedLocationAccessible: boolean;
};

/**
 * All-location automations can act on locations outside a restricted actor's
 * assignment, so only all-location actors may inspect those rows. A selected
 * location narrows unrestricted access to global plus that exact location.
 */
export const visibleAllLocationDocumentFilter = (
  scope: AssistantLocationScope,
): Record<string, unknown> => {
  if (!scope.requestedLocationAccessible) {
    return { _id: { $exists: false } };
  }
  if (scope.actorAllowedLocationIds === null) {
    return scope.requestedLocationId
      ? {
          $or: [
            { appliesToAllLocations: true },
            {
              appliesToAllLocations: false,
              location: new mongoose.Types.ObjectId(scope.requestedLocationId),
            },
          ],
        }
      : {};
  }
  if (!scope.actorAllowedLocationIds.length) {
    return { _id: { $exists: false } };
  }
  return {
    appliesToAllLocations: false,
    location: scope.requestedLocationId
      ? new mongoose.Types.ObjectId(scope.requestedLocationId)
      : { $in: ids(scope.actorAllowedLocationIds) },
  };
};

/**
 * Empty profile location lists are global and safe to describe. Restricted
 * actors may otherwise see a profile only when every assigned location is in
 * their scope; an overlapping hidden assignment must not leak through `$in`.
 */
export const visibleProfileLocationFilter = (
  scope: AssistantLocationScope,
): Record<string, unknown> => {
  if (!scope.requestedLocationAccessible) {
    return { _id: { $exists: false } };
  }
  const globalProfile = { locationIds: { $size: 0 } };
  if (scope.actorAllowedLocationIds === null) {
    return scope.requestedLocationId
      ? {
          $or: [
            globalProfile,
            {
              locationIds: new mongoose.Types.ObjectId(
                scope.requestedLocationId,
              ),
            },
          ],
        }
      : {};
  }
  if (!scope.actorAllowedLocationIds.length) {
    return { _id: { $exists: false } };
  }
  const allowed = ids(scope.actorAllowedLocationIds);
  const fullyVisibleAssignedProfile = {
    "locationIds.0": { $exists: true },
    locationIds: { $not: { $elemMatch: { $nin: allowed } } },
  };
  const visibility = {
    $or: [globalProfile, fullyVisibleAssignedProfile],
  };
  if (!scope.requestedLocationId) return visibility;
  return {
    $and: [
      visibility,
      {
        $or: [
          globalProfile,
          {
            locationIds: new mongoose.Types.ObjectId(scope.requestedLocationId),
          },
        ],
      },
    ],
  };
};

const finiteNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const zeroDecimalStudioCurrencies = Object.entries(CURRENCY_EXPONENT)
  .filter(([, exponent]) => exponent === 0)
  .map(([currency]) => currency);

const legacyMajorAmountToMinorExpression = (
  amountField: string,
  currencyExpression: unknown,
) => ({
  $round: [
    {
      $multiply: [
        { $ifNull: [amountField, 0] },
        {
          $cond: [
            {
              $in: [
                { $toUpper: { $ifNull: [currencyExpression, ""] } },
                zeroDecimalStudioCurrencies,
              ],
            },
            1,
            100,
          ],
        },
      ],
    },
    0,
  ],
});

const communicationEmailClaimLeaseMs = (): number => {
  const configured = Number(process.env.COMMUNICATION_EMAIL_CLAIM_LEASE_MS);
  return Number.isFinite(configured)
    ? Math.max(60_000, configured)
    : 5 * 60_000;
};

const boundedTextItems = (values: unknown, maxItems = 10, maxLength = 120) => {
  const items = Array.isArray(values)
    ? values
        .map((value) => compactText(value, maxLength))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];
  return boundedList(items, Array.isArray(values) ? values.length : 0);
};

const boundedLocationIds = (
  values: unknown,
  visibleLocationSet: Set<string> | null,
) => {
  const locationIds = Array.isArray(values)
    ? values
        .map(String)
        .filter(
          (locationId) =>
            Boolean(locationId) &&
            (!visibleLocationSet || visibleLocationSet.has(locationId)),
        )
    : [];
  return boundedList(
    locationIds.slice(0, ASSISTANT_CONTEXT_LIMIT.LOCATIONS),
    locationIds.length,
  );
};

const minorAmountRange = (values: unknown) => {
  const amounts = Array.isArray(values)
    ? values
        .map((entry: any) => finiteNumberOrNull(entry?.amountMinor))
        .filter((value): value is number => value !== null)
    : [];
  return amounts.length
    ? { minimumMinor: Math.min(...amounts), maximumMinor: Math.max(...amounts) }
    : { minimumMinor: null, maximumMinor: null };
};

const resolveAssistantLocationScope = ({
  access,
  locationId,
}: {
  access: ResolvedWorkspaceAccess;
  locationId?: string | null;
}) => {
  const actorAllowedLocationIds =
    access.locationAccess.mode === "all"
      ? null
      : [...new Set(access.locationAccess.locationIds.map(String))];
  const requestedLocationId = compactText(locationId, 100) || null;
  const requestedLocationAccessible =
    !requestedLocationId ||
    canAccessWorkspaceLocation(access, requestedLocationId);
  const effectiveLocationIds = requestedLocationId
    ? requestedLocationAccessible
      ? [requestedLocationId]
      : []
    : actorAllowedLocationIds;

  return {
    actorAllowedLocationIds,
    effectiveLocationIds,
    requestedLocationId,
    requestedLocationAccessible,
  };
};

const scopedLocationQuery = (
  field: string,
  allowedLocationIds: readonly string[] | null,
): Record<string, unknown> =>
  allowedLocationIds === null
    ? {}
    : allowedLocationIds.length
      ? { [field]: { $in: ids(allowedLocationIds) } }
      : { _id: { $exists: false } };

const membershipLocationScopeFilter = ({
  actorAllowedLocationIds,
  requestedLocationId,
  requestedLocationAccessible,
}: {
  actorAllowedLocationIds: readonly string[] | null;
  requestedLocationId: string | null;
  requestedLocationAccessible: boolean;
}): Record<string, unknown> => {
  if (!requestedLocationAccessible) {
    return { _id: { $exists: false } };
  }

  if (actorAllowedLocationIds !== null) {
    if (!actorAllowedLocationIds.length) {
      return { _id: { $exists: false } };
    }
    const allowed = ids(actorAllowedLocationIds);
    const requestedLocationObjectId = requestedLocationId
      ? new mongoose.Types.ObjectId(requestedLocationId)
      : null;
    const selectedScope = {
      $or: [
        { selectedLocation: { $in: allowed } },
        {
          selectedLocation: null,
          "planSnapshot.locationScope.type": "selected",
          "planSnapshot.locationScope.locationIds.0": {
            $exists: true,
          },
          "planSnapshot.locationScope.locationIds": {
            $not: { $elemMatch: { $nin: allowed } },
          },
        },
      ],
    };
    return requestedLocationId
      ? {
          $and: [
            selectedScope,
            {
              $or: [
                { selectedLocation: requestedLocationObjectId },
                {
                  selectedLocation: null,
                  "planSnapshot.locationScope.type": "selected",
                  "planSnapshot.locationScope.locationIds.0": {
                    $exists: true,
                  },
                  "planSnapshot.locationScope.locationIds":
                    requestedLocationObjectId,
                },
              ],
            },
          ],
        }
      : selectedScope;
  }

  if (!requestedLocationId) return {};
  const requestedLocationObjectId = new mongoose.Types.ObjectId(
    requestedLocationId,
  );
  return {
    $or: [
      { selectedLocation: requestedLocationObjectId },
      { "planSnapshot.locationScope.type": "all" },
      {
        selectedLocation: null,
        "planSnapshot.locationScope.type": "selected",
        "planSnapshot.locationScope.locationIds.0": { $exists: true },
        "planSnapshot.locationScope.locationIds": requestedLocationObjectId,
      },
    ],
  };
};

const inventoryLocationScopeFilter = (
  allowedLocationIds: readonly string[] | null,
): Record<string, unknown> => {
  if (allowedLocationIds === null) return {};
  if (!allowedLocationIds.length) {
    return { _id: { $exists: false } };
  }
  const allowed = ids(allowedLocationIds);
  return {
    $or: [
      { "stockLevels.location": { $in: allowed } },
      {
        $and: [
          {
            $expr: {
              $eq: [{ $size: { $ifNull: ["$stockLevels", []] } }, 0],
            },
          },
          { locations: { $in: allowed } },
        ],
      },
    ],
  };
};

const serializedCharacters = (value: unknown): number =>
  JSON.stringify(value).length;

/**
 * Final defense-in-depth budget. Per-field limits do most of the work; this
 * trims whole serialized list entries if an unusual combination of maximum
 * values would still exceed the provider-context ceiling.
 */
export const enforceWorkspaceAssistantContextBudget = (
  context: Record<string, any>,
): Record<string, any> => {
  // Leave room for writing the final measured value into the budget metadata.
  const workingSerializedCharacterLimit =
    WORKSPACE_ASSISTANT_CONTEXT_MAX_SERIALIZED_CHARS - 32;
  const coverage =
    context.coverage && typeof context.coverage === "object"
      ? context.coverage
      : {
          available: ["actor", "studio"],
          omitted: [],
          unavailable: [],
          complete: true,
        };
  context.coverage = coverage;
  coverage.omitted = Array.isArray(coverage.omitted) ? coverage.omitted : [];
  coverage.available = Array.isArray(coverage.available)
    ? coverage.available
    : ["actor", "studio"];
  coverage.budget = {
    maxSerializedCharacters: WORKSPACE_ASSISTANT_CONTEXT_MAX_SERIALIZED_CHARS,
    serializedCharacters: 0,
    truncated: false,
  };

  const markBudgetOmission = (source: string) => {
    if (
      !coverage.omitted.some(
        (entry: any) =>
          entry?.source === source && entry?.reason === "context_budget",
      )
    ) {
      coverage.omitted.push({ source, reason: "context_budget" });
    }
  };

  const boundedTargets: Array<{
    source: string;
    value: any;
    minimum: number;
  }> = [
    { source: "memberships", value: context.memberships?.plans, minimum: 0 },
    {
      source: "credits.balances",
      value: context.credits?.balancesByCurrency,
      minimum: 0,
    },
    {
      source: "credits.transactions",
      value: context.credits?.transactionsLast30Days,
      minimum: 0,
    },
    {
      source: "vouchers.ordersByStatus",
      value: context.vouchers?.ordersLast30Days?.byStatus,
      minimum: 0,
    },
    {
      source: "vouchers.orderValue",
      value: context.vouchers?.ordersLast30Days?.valueByCurrency,
      minimum: 0,
    },
    {
      source: "communications.automations",
      value: context.communications?.automations?.recent,
      minimum: 0,
    },
    {
      source: "communications.automationsByStatus",
      value: context.communications?.automations?.byStatus,
      minimum: 0,
    },
    {
      source: "communications.automationsBySchedule",
      value: context.communications?.automations?.byScheduleType,
      minimum: 0,
    },
    {
      source: "communications.deliveriesByStatus",
      value: context.communications?.deliveryLast30Days?.byStatus,
      minimum: 0,
    },
    {
      source: "communications.deliveriesByType",
      value: context.communications?.deliveryLast30Days?.byType,
      minimum: 0,
    },
    {
      source: "communications.deliveryProblems",
      value: context.communications?.deliveryBacklog?.problems,
      minimum: 0,
    },
    { source: "products", value: context.products, minimum: 0 },
    { source: "inventory", value: context.inventory, minimum: 0 },
    {
      source: "inventory.reorderRequests",
      value: context.inventory?.reorderRequests?.active,
      minimum: 0,
    },
    {
      source: "courses.catalog",
      value: context.courses?.catalog,
      minimum: 0,
    },
    {
      source: "courses.events",
      value: context.courses?.upcomingEvents,
      minimum: 0,
    },
    {
      source: "courses.sessions",
      value: context.courses?.upcomingSessions,
      minimum: 0,
    },
    {
      source: "courses.revenueRecent",
      value: context.courses?.revenueRecent?.courses,
      minimum: 0,
    },
    { source: "team", value: context.team, minimum: 0 },
    {
      source: "invoices",
      value: context.invoices?.recent,
      minimum: 0,
    },
    {
      source: "invoices.overdue",
      value: context.invoices?.overdueItems,
      minimum: 0,
    },
    {
      source: "invoices",
      value: context.invoices?.outstandingByCurrency,
      minimum: 0,
    },
    {
      source: "operations.staffPlanning.today",
      value: context.operations?.staffPlanning?.today?.staff,
      minimum: 0,
    },
    {
      source: "operations.staffPlanning.week",
      value: context.operations?.staffPlanning?.week?.plans,
      minimum: 0,
    },
    {
      source: "operations.staffPlanning.month",
      value: context.operations?.staffPlanning?.month?.prioritySets,
      minimum: 0,
    },
    {
      source: "operations.staffPlanning.board",
      value: context.operations?.staffPlanning?.board?.tasks,
      minimum: 0,
    },
    ...(Array.isArray(context.inventory?.items)
      ? context.inventory.items.map((item: any) => ({
          source: "inventory.levels",
          value: item?.stock?.levels,
          minimum: 0,
        }))
      : []),
    ...(Array.isArray(context.operations?.staffPlanning?.week?.plans?.items)
      ? context.operations.staffPlanning.week.plans.items.map((plan: any) => ({
          source: "operations.staffPlanning.week.outcomes",
          value: plan?.outcomes,
          minimum: 0,
        }))
      : []),
    ...(Array.isArray(
      context.operations?.staffPlanning?.month?.prioritySets?.items,
    )
      ? context.operations.staffPlanning.month.prioritySets.items.map(
          (set: any) => ({
            source: "operations.staffPlanning.month.priorities",
            value: set?.priorities,
            minimum: 0,
          }),
        )
      : []),
    { source: "locations", value: context.locations, minimum: 1 },
  ].filter((target) => Array.isArray(target.value?.items));

  const operationListTargets: Array<{
    source: string;
    items: any[] | undefined;
    markTruncated?: () => void;
  }> = [
    {
      source: "operations.bookings",
      items: context.operations?.bookings?.upcoming,
    },
    {
      source: "operations.bookings.tomorrow",
      items: context.operations?.bookings?.tomorrow?.items,
      markTruncated: () => {
        context.operations.bookings.tomorrow.truncated = true;
      },
    },
    {
      source: "operations.bookings.unpaidFuture",
      items: context.operations?.bookings?.unpaidFuture?.bookings?.items,
      markTruncated: () => {
        context.operations.bookings.unpaidFuture.bookings.truncated = true;
      },
    },
    {
      source: "operations.bookings.unpaidFuture.customers",
      items: context.operations?.bookings?.unpaidFuture?.customers?.items,
      markTruncated: () => {
        context.operations.bookings.unpaidFuture.customers.truncated = true;
      },
    },
    {
      source: "operations.tasks",
      items: context.operations?.tasks?.due,
    },
    {
      source: "operations.inventory",
      items: context.operations?.inventory?.items,
    },
  ].filter((target) => Array.isArray(target.items));

  let wasTrimmed = false;
  let madeProgress = true;
  while (
    serializedCharacters(context) > workingSerializedCharacterLimit &&
    madeProgress
  ) {
    madeProgress = false;
    for (const target of boundedTargets) {
      if (target.value.items.length <= target.minimum) continue;
      target.value.items.pop();
      target.value.truncated = true;
      markBudgetOmission(target.source);
      wasTrimmed = true;
      madeProgress = true;
      if (serializedCharacters(context) <= workingSerializedCharacterLimit) {
        break;
      }
    }
    if (serializedCharacters(context) <= workingSerializedCharacterLimit) {
      break;
    }
    for (const target of operationListTargets) {
      if (!target.items?.length) continue;
      target.items.pop();
      target.markTruncated?.();
      context.operations.contextTruncated = true;
      markBudgetOmission(target.source);
      wasTrimmed = true;
      madeProgress = true;
      if (serializedCharacters(context) <= workingSerializedCharacterLimit) {
        break;
      }
    }
  }

  const optionalSections: Array<{
    source: string;
    drop: () => void;
  }> = [
    {
      source: "memberships",
      drop: () => {
        context.memberships = null;
      },
    },
    {
      source: "credits",
      drop: () => {
        context.credits = null;
      },
    },
    {
      source: "vouchers",
      drop: () => {
        context.vouchers = null;
      },
    },
    {
      source: "communications",
      drop: () => {
        context.communications = null;
      },
    },
    {
      source: "reports",
      drop: () => {
        context.reports = null;
      },
    },
    {
      source: "publicSite",
      drop: () => {
        context.publicSite = null;
      },
    },
    {
      source: "products",
      drop: () => {
        context.products = null;
      },
    },
    {
      source: "subscription",
      drop: () => {
        context.subscription = null;
      },
    },
    {
      source: "inventory",
      drop: () => {
        context.inventory = null;
      },
    },
    {
      source: "courses",
      drop: () => {
        context.courses = {
          catalog: null,
          upcomingSessions: null,
          upcomingEvents: null,
          revenueRecent: null,
        };
      },
    },
    {
      source: "team",
      drop: () => {
        context.team = null;
      },
    },
    {
      source: "customers",
      drop: () => {
        context.customers = null;
      },
    },
    {
      source: "invoices",
      drop: () => {
        context.invoices = null;
      },
    },
    {
      source: "operations",
      drop: () => {
        context.operations = {
          generatedAt: context.generatedAt,
          locationId: context.scope?.requestedLocationId ?? null,
          timezone: context.scope?.timezone ?? "UTC",
          dateKey: context.scope?.dateKey ?? null,
          coverage: {
            available: [],
            unavailable: [{ source: "details", reason: "context_budget" }],
            complete: false,
          },
        };
      },
    },
    {
      source: "locations",
      drop: () => {
        context.locations = null;
      },
    },
  ];

  for (const section of optionalSections) {
    if (serializedCharacters(context) <= workingSerializedCharacterLimit) {
      break;
    }
    section.drop();
    markBudgetOmission(section.source);
    coverage.available = coverage.available.filter(
      (source: string) =>
        source !== section.source && !source.startsWith(`${section.source}.`),
    );
    wasTrimmed = true;
  }

  coverage.budget.truncated = wasTrimmed;
  if (wasTrimmed) coverage.complete = false;
  coverage.omitted.sort(
    (left: any, right: any) =>
      String(left?.source || "").localeCompare(String(right?.source || "")) ||
      String(left?.reason || "").localeCompare(String(right?.reason || "")),
  );
  coverage.budget.serializedCharacters = serializedCharacters(context);
  // Updating the counter can add a few digits, so measure once more.
  coverage.budget.serializedCharacters = serializedCharacters(context);

  return context;
};

const normalizeTimezone = (value: unknown): string => {
  const timezone = String(value || "UTC").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return "UTC";
  }
};

const boundedIds = (values: unknown, limit = 12) => {
  const list = Array.isArray(values) ? values.map(String).filter(Boolean) : [];
  return {
    items: list.slice(0, limit),
    truncated: list.length > limit,
  };
};

const serializeStaffPlanningDetail = (overview: any, canViewTasks: boolean) => {
  const staffRows = Array.isArray(overview?.today?.staff)
    ? overview.today.staff
    : [];
  const displayNameByUserId = new Map<string, string>(
    staffRows
      .map(
        (member: any) =>
          [
            String(member.userId || ""),
            compactText(member.displayName, 160),
          ] as const,
      )
      .filter(([userId]) => Boolean(userId)),
  );
  const serializeUpdate = (update: any) =>
    update
      ? {
          date: compactText(update.date, 10) || null,
          locationId: update.locationId ? String(update.locationId) : null,
          focusToday: compactText(update.focusToday, 800),
          completedSinceLast: compactText(update.completedSinceLast, 800),
          blockers: compactText(update.blockers, 800),
          notWorkingToday: update.notWorkingToday === true,
          needsOwnerAttention: update.needsOwnerAttention === true,
          attentionStatus: compactText(update.attentionStatus, 40) || null,
          submittedAt: update.submittedAt || null,
          ...(canViewTasks
            ? {
                linkedTaskIds: boundedIds(update.linkedTaskIds),
              }
            : {}),
        }
      : null;
  const serializeOutcome = (outcome: any) => ({
    title: compactText(outcome.title, 240),
    completed: outcome.completed === true,
    ...(canViewTasks
      ? { linkedTaskIds: boundedIds(outcome.linkedTaskIds) }
      : {}),
  });

  const weeklyRows = Array.isArray(overview?.week?.plans)
    ? overview.week.plans
    : [];
  const prioritySets = Array.isArray(overview?.month?.prioritySets)
    ? overview.month.prioritySets
    : [];
  const boardRows =
    canViewTasks && Array.isArray(overview?.board?.tasks)
      ? overview.board.tasks
      : [];

  return {
    metadata: {
      date: compactText(overview?.metadata?.date, 10) || null,
      timezone: compactText(overview?.metadata?.timezone, 80) || "UTC",
      locationId: overview?.metadata?.locationId
        ? String(overview.metadata.locationId)
        : null,
      week: {
        from: compactText(overview?.metadata?.week?.from, 10) || null,
        to: compactText(overview?.metadata?.week?.to, 10) || null,
      },
      month: {
        key: compactText(overview?.metadata?.month?.key, 7) || null,
        from: compactText(overview?.metadata?.month?.from, 10) || null,
        to: compactText(overview?.metadata?.month?.to, 10) || null,
      },
    },
    settings: {
      expectedUpdateTime:
        compactText(overview?.settings?.expectedUpdateTime, 8) || null,
      dueAt: overview?.settings?.dueAt || null,
    },
    counts: overview?.today?.counts || {},
    today: {
      staff: boundedList(
        staffRows
          .slice(0, ASSISTANT_CONTEXT_LIMIT.PLANNING_STAFF)
          .map((member: any) => ({
            userId: member.userId ? String(member.userId) : null,
            displayName: compactText(member.displayName, 160),
            state: compactText(member.state, 40),
            isExpectedToday: member.isExpectedToday === true,
            update: serializeUpdate(member.update),
          })),
        staffRows.length,
      ),
    },
    week: {
      plans: boundedList(
        weeklyRows
          .slice(0, ASSISTANT_CONTEXT_LIMIT.PLANNING_WEEKLY_PLANS)
          .map((plan: any) => {
            const outcomes = Array.isArray(plan.outcomes) ? plan.outcomes : [];
            const planUserId = String(plan.userId || "");
            return {
              userId: planUserId || null,
              displayName: displayNameByUserId.get(planUserId) || null,
              weekStart: compactText(plan.weekStart, 10) || null,
              locationId: plan.locationId ? String(plan.locationId) : null,
              outcomes: boundedList(
                outcomes
                  .slice(0, ASSISTANT_CONTEXT_LIMIT.PLANNING_OUTCOMES)
                  .map(serializeOutcome),
                outcomes.length,
              ),
              submittedAt: plan.submittedAt || null,
              updatedAt: plan.updatedAt || null,
            };
          }),
        weeklyRows.length,
      ),
    },
    month: {
      prioritySets: boundedList(
        prioritySets
          .slice(0, ASSISTANT_CONTEXT_LIMIT.PLANNING_PRIORITY_SETS)
          .map((set: any) => {
            const priorities = Array.isArray(set.priorities)
              ? set.priorities
              : [];
            return {
              month: compactText(set.month, 7) || null,
              locationId: set.locationId ? String(set.locationId) : null,
              priorities: boundedList(
                priorities
                  .slice(0, ASSISTANT_CONTEXT_LIMIT.PLANNING_PRIORITIES)
                  .map((priority: any) => {
                    const ownerUserId = String(priority.ownerUserId || "");
                    return {
                      title: compactText(priority.title, 240),
                      ownerUserId: ownerUserId || null,
                      ownerName: displayNameByUserId.get(ownerUserId) || null,
                      completed: priority.completed === true,
                      ...(canViewTasks
                        ? {
                            linkedTaskIds: boundedIds(priority.linkedTaskIds),
                          }
                        : {}),
                    };
                  }),
                priorities.length,
              ),
              updatedAt: set.updatedAt || null,
            };
          }),
        prioritySets.length,
      ),
    },
    ...(canViewTasks
      ? {
          board: {
            tasks: boundedList(
              boardRows
                .slice(0, ASSISTANT_CONTEXT_LIMIT.PLANNING_BOARD_TASKS)
                .map((task: any) => ({
                  id: task.id ? String(task.id) : null,
                  title: compactText(task.title, 240),
                  description: compactText(task.description, 600),
                  locationId: task.locationId ? String(task.locationId) : null,
                  appliesToAllLocations: task.appliesToAllLocations === true,
                  assignee: task.assignedTo
                    ? {
                        userId: task.assignedTo.userId
                          ? String(task.assignedTo.userId)
                          : null,
                        displayName:
                          compactText(task.assignedTo.displayName, 160) || null,
                      }
                    : null,
                  dueDate: task.dueDate || null,
                  completedAt: task.completedAt || null,
                  status: compactText(task.status, 40),
                  column: compactText(task.column, 40),
                  priority: compactText(task.priority, 40),
                  blockerReason: compactText(task.blockerReason, 400),
                  category: compactText(task.category, 80) || null,
                })),
              boardRows.length,
            ),
          },
        }
      : {}),
  };
};

/** Tenant-local calendar boundaries; safe across 23/25-hour DST days. */
export const getTenantLocalDay = (timezone: string, now = new Date()) => {
  const safeTimezone = normalizeTimezone(timezone);
  const local = dayjs(now).tz(safeTimezone);
  // Reparse the calendar date in-zone instead of calling startOf("day") on a
  // timestamp whose current offset may differ from midnight across DST.
  const dateKey = local.format("YYYY-MM-DD");
  const start = dayjs.tz(dateKey, "YYYY-MM-DD", safeTimezone);
  const nextDateKey = start.add(1, "day").format("YYYY-MM-DD");
  const end = dayjs.tz(nextDateKey, "YYYY-MM-DD", safeTimezone);
  return {
    timezone: safeTimezone,
    dateKey,
    start: start.toDate(),
    end: end.toDate(),
  };
};

const tenantCalendarDayAfter = ({
  localDay,
  days,
}: {
  localDay: ReturnType<typeof getTenantLocalDay>;
  days: number;
}) => {
  const dateKey = dayjs(localDay.start)
    .tz(localDay.timezone)
    .add(days, "day")
    .format("YYYY-MM-DD");
  const nextDateKey = dayjs
    .tz(dateKey, "YYYY-MM-DD", localDay.timezone)
    .add(1, "day")
    .format("YYYY-MM-DD");

  return {
    dateKey,
    start: dayjs
      .tz(dateKey, "YYYY-MM-DD", localDay.timezone)
      .startOf("day")
      .toDate(),
    end: dayjs
      .tz(nextDateKey, "YYYY-MM-DD", localDay.timezone)
      .startOf("day")
      .toDate(),
  };
};

const operationalBookingCustomer = (booking: any, includeCustomer: boolean) => {
  if (!includeCustomer) return undefined;
  const name = compactText(booking?.author?.name, 160) || null;
  const customId = compactText(booking?.author?.customId, 120) || null;
  const customerId = booking?.createdBy ? String(booking.createdBy) : null;
  if (!customerId && !name && !customId) return null;

  return { customerId, name, customId };
};

const serializeOperationalBooking = (
  booking: any,
  {
    includeCustomer,
    includePaymentExpiry = false,
  }: {
    includeCustomer: boolean;
    includePaymentExpiry?: boolean;
  },
) => {
  const bookingProduct =
    booking.bookingProduct && typeof booking.bookingProduct === "object"
      ? booking.bookingProduct
      : null;
  const participants = activeBookingParticipants(booking).length;
  const customer = operationalBookingCustomer(booking, includeCustomer);

  return {
    id: String(booking._id),
    name: compactText(bookingProduct?.name, 160) || null,
    productType: compactText(bookingProduct?.type, 80) || null,
    start: booking.start,
    end: booking.end,
    locationId: booking.location ? String(booking.location) : null,
    tag: compactText(booking.tag, 40) || null,
    status: compactText(booking.status, 40) || null,
    participantCount: Math.max(
      participants,
      Number(booking.numberOfGuests || 0),
    ),
    ...(includePaymentExpiry
      ? { paymentExpiresAt: booking.paymentExpiresAt || null }
      : {}),
    ...(includeCustomer ? { customer } : {}),
  };
};

const safeMinorUnits = (value: unknown): number | null => {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
};

const allocateMinorUnitsByWeights = (
  total: number,
  rawWeights: Map<string, number>,
): Map<string, number> => {
  const weights = [...rawWeights.entries()]
    .filter(([, weight]) => weight > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const result = new Map([...rawWeights.keys()].map((key) => [key, 0]));
  const weightTotal = weights.reduce(
    (sum, [, weight]) => sum + BigInt(weight),
    0n,
  );
  if (total <= 0 || weightTotal <= 0n) return result;

  const shares = weights.map(([key, weight]) => {
    const product = BigInt(total) * BigInt(weight);
    return {
      key,
      amount: Number(product / weightTotal),
      remainder: product % weightTotal,
    };
  });
  let remainder = total - shares.reduce((sum, share) => sum + share.amount, 0);
  shares.sort((left, right) => {
    if (left.remainder === right.remainder) {
      return left.key.localeCompare(right.key);
    }
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const share of shares) {
    if (remainder <= 0) break;
    share.amount += 1;
    remainder -= 1;
  }
  for (const share of shares) result.set(share.key, share.amount);
  return result;
};

type CourseRevenueScope = {
  requestedLocationId: string | null;
  allowedLocationIds: readonly string[] | null;
};

const allocatePaidCourseLines = ({
  order,
  courseProductIds,
  scope,
}: {
  order: any;
  courseProductIds: Set<string>;
  scope: CourseRevenueScope;
}) => {
  const paidAmountMinor = safeMinorUnits(order?.paidAmountMinor);
  if (paidAmountMinor === null) return null;
  const lines = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const unrestricted =
    scope.allowedLocationIds === null && !scope.requestedLocationId;
  const allowed =
    scope.allowedLocationIds === null
      ? null
      : new Set(scope.allowedLocationIds.map(String));
  const cells: Array<{
    key: string;
    lineIndex: number;
    locationId: string | null;
    weight: number;
  }> = [];

  lines.forEach((line: any, lineIndex: number) => {
    const gross = safeMinorUnits(line?.grossAmountMinor) ?? 0;
    const rawLocationIds: unknown[] = Array.isArray(line?.locationIds)
      ? line.locationIds
      : [];
    const locations = [
      ...new Set<string>(
        rawLocationIds.map((value) => String(value)).filter(Boolean),
      ),
    ].sort();
    const cellLocations = locations.length ? locations : [null];
    const base = Math.floor(gross / cellLocations.length);
    const remainder = gross % cellLocations.length;
    cellLocations.forEach((locationId, locationIndex) => {
      cells.push({
        key: `${String(locationId ?? "unallocated")}:${String(
          lineIndex,
        ).padStart(8, "0")}`,
        lineIndex,
        locationId,
        weight: base + (locationIndex < remainder ? 1 : 0),
      });
    });
  });

  const paidByCell = allocateMinorUnitsByWeights(
    paidAmountMinor,
    new Map(cells.map((cell) => [cell.key, cell.weight])),
  );
  const result: Array<{
    productId: string;
    revenueMinor: number;
    quantity: number;
  }> = [];

  lines.forEach((line: any, lineIndex: number) => {
    const productId = String(line?.product || "").trim();
    if (!productId || !courseProductIds.has(productId)) return;
    const lineCells = cells.filter((cell) => cell.lineIndex === lineIndex);
    let visibleCells = lineCells;
    if (!unrestricted && scope.requestedLocationId) {
      visibleCells = lineCells.filter(
        (cell) => cell.locationId === scope.requestedLocationId,
      );
    } else if (
      !unrestricted &&
      lineCells.some(
        (cell) => !cell.locationId || !allowed?.has(cell.locationId),
      )
    ) {
      visibleCells = [];
    }
    if (!visibleCells.length) return;
    const quantity = Number(line?.quantity || 0);
    result.push({
      productId,
      revenueMinor: visibleCells.reduce(
        (sum, cell) => sum + (paidByCell.get(cell.key) || 0),
        0,
      ),
      quantity:
        lineCells.length > 0
          ? quantity * (visibleCells.length / lineCells.length)
          : 0,
    });
  });

  return result;
};

export const buildWorkspaceOperationalContext = async ({
  tenantId,
  userId,
  access,
  locationId,
  timezone,
  now: suppliedNow,
  includeStaffPlanning = false,
  includeStaffPlanningDetail = false,
}: {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
  locationId?: string | null;
  timezone?: string | null;
  now?: Date;
  includeStaffPlanning?: boolean;
  includeStaffPlanningDetail?: boolean;
}) => {
  const allowed = locationId
    ? [locationId]
    : access.locationAccess.mode === "all"
      ? null
      : access.locationAccess.locationIds;
  const now = suppliedNow || new Date();
  let tenantTimezone = timezone ? normalizeTimezone(timezone) : "";
  let timezoneFallback = false;
  if (!tenantTimezone) {
    try {
      const tenant = await TenantModel.findById(tenantId)
        .select("settings.timezone")
        .lean();
      tenantTimezone = normalizeTimezone((tenant as any)?.settings?.timezone);
    } catch {
      tenantTimezone = "UTC";
      timezoneFallback = true;
    }
  }
  const localDay = getTenantLocalDay(tenantTimezone, now);
  const today = localDay.start;
  const tomorrow = localDay.end;
  const tomorrowDay = tenantCalendarDayAfter({
    localDay,
    days: 1,
  });
  const context: Record<string, unknown> = {
    generatedAt: now,
    locationId: locationId || null,
    timezone: localDay.timezone,
    dateKey: localDay.dateKey,
  };

  const operations: Array<{ source: string; run: Promise<void> }> = [];
  if (hasWorkspacePermission(access, WORKSPACE_PERMISSION.BOOKINGS_VIEW)) {
    operations.push({
      source: "bookings",
      run: (async () => {
        const confirmedTodayQuery: any = {
          tenant: tenantId,
          start: { $gte: today, $lt: tomorrow },
          status: { $ne: BOOKING_STATUS.CANCELLED },
          paymentStatus: PAYMENT_STATUS.CONFIRMED,
          tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
          ...locationFilter("location", allowed),
        };
        const confirmedTomorrowQuery: any = {
          ...confirmedTodayQuery,
          start: {
            $gte: tomorrowDay.start,
            $lt: tomorrowDay.end,
          },
        };
        const confirmedFutureQuery: any = {
          tenant: tenantId,
          start: { $gte: now },
          status: { $ne: BOOKING_STATUS.CANCELLED },
          paymentStatus: PAYMENT_STATUS.CONFIRMED,
          tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
          ...locationFilter("location", allowed),
        };
        const confirmedAllTimeQuery: any = {
          tenant: tenantId,
          status: { $ne: BOOKING_STATUS.CANCELLED },
          paymentStatus: PAYMENT_STATUS.CONFIRMED,
          tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
          ...locationFilter("location", allowed),
        };
        const unpaidFutureQuery: any = {
          tenant: tenantId,
          start: { $gte: now },
          status: { $ne: BOOKING_STATUS.CANCELLED },
          paymentStatus: PAYMENT_STATUS.PENDING_PAYMENT,
          tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
          ...locationFilter("location", allowed),
        };
        const canViewCustomers = hasWorkspacePermission(
          access,
          WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
        );
        const aggregateBookingCountsByLocation = (query: any) =>
          Booking.aggregate([
            {
              $match: {
                ...query,
                tenant: new mongoose.Types.ObjectId(tenantId),
                location: {
                  ...((query.location as Record<string, unknown>) || {}),
                  $ne: null,
                },
              },
            },
            { $group: { _id: "$location", count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ]);
        const [
          todayCount,
          futureConfirmedCount,
          allTimeConfirmedCount,
          upcomingRows,
          tomorrowCount,
          tomorrowRows,
          unpaidFutureCount,
          unpaidFutureRows,
          unpaidCustomerFacet,
          todayLocationCounts,
          upcomingLocationCounts,
          allTimeLocationCounts,
        ] = await Promise.all([
          Booking.countDocuments(confirmedTodayQuery),
          Booking.countDocuments(confirmedFutureQuery),
          Booking.countDocuments(confirmedAllTimeQuery),
          Booking.find(confirmedFutureQuery)
            .sort({ start: 1 })
            .limit(5)
            .select("start end location tag status bookingProduct")
            .populate({
              path: "bookingProduct",
              select: "name type",
              match: { tenant: tenantId },
            })
            .lean(),
          Booking.countDocuments(confirmedTomorrowQuery),
          Booking.find(confirmedTomorrowQuery)
            .sort({ start: 1, _id: 1 })
            .limit(ASSISTANT_CONTEXT_LIMIT.TOMORROW_BOOKINGS)
            .select(
              "start end location tag status bookingProduct participants numberOfGuests createdBy author",
            )
            .populate({
              path: "bookingProduct",
              select: "name type",
              match: { tenant: tenantId },
            })
            .lean(),
          Booking.countDocuments(unpaidFutureQuery),
          Booking.find(unpaidFutureQuery)
            .sort({ start: 1, _id: 1 })
            .limit(ASSISTANT_CONTEXT_LIMIT.UNPAID_FUTURE_BOOKINGS)
            .select(
              "start end location tag status bookingProduct participants numberOfGuests createdBy author paymentExpiresAt",
            )
            .populate({
              path: "bookingProduct",
              select: "name type",
              match: { tenant: tenantId },
            })
            .lean(),
          canViewCustomers
            ? Booking.aggregate([
                {
                  $match: {
                    ...unpaidFutureQuery,
                    tenant: new mongoose.Types.ObjectId(tenantId),
                  },
                },
                {
                  $group: {
                    _id: "$createdBy",
                    name: { $first: "$author.name" },
                    customId: { $first: "$author.customId" },
                    unpaidBookings: { $sum: 1 },
                    nextBookingAt: { $min: "$start" },
                  },
                },
                { $sort: { nextBookingAt: 1, _id: 1 } },
                {
                  $facet: {
                    total: [{ $count: "count" }],
                    items: [
                      {
                        $limit: ASSISTANT_CONTEXT_LIMIT.UNPAID_FUTURE_CUSTOMERS,
                      },
                    ],
                  },
                },
              ])
            : Promise.resolve([]),
          aggregateBookingCountsByLocation(confirmedTodayQuery),
          aggregateBookingCountsByLocation(confirmedFutureQuery),
          aggregateBookingCountsByLocation(confirmedAllTimeQuery),
        ]);
        const rawLocationCountRows = [
          ...(todayLocationCounts as any[]),
          ...(upcomingLocationCounts as any[]),
          ...(allTimeLocationCounts as any[]),
        ];
        const locationCountIds = [
          ...new Set(
            rawLocationCountRows
              .map((entry) => String(entry?._id || ""))
              .filter(Boolean),
          ),
        ];
        const authorizedLocationCountIds =
          allowed === null
            ? locationCountIds
            : locationCountIds.filter((id) => allowed.includes(id));
        const locationRows = authorizedLocationCountIds.length
          ? await LocationModel.find({
              tenant: tenantId,
              _id: { $in: ids(authorizedLocationCountIds) },
            })
              .select("name")
              .lean()
          : [];
        const locationNames = new Map(
          (locationRows as any[]).map((location) => [
            String(location._id),
            compactText(location.name, 160),
          ]),
        );
        const serializeLocationCounts = (rows: any[]) => {
          const items = rows
            .map((entry) => {
              const locationId = String(entry?._id || "");
              const locationName = locationNames.get(locationId) || "";
              return locationId && locationName
                ? {
                    locationId,
                    locationName,
                    count: Number(entry?.count || 0),
                  }
                : null;
            })
            .filter(
              (
                entry,
              ): entry is {
                locationId: string;
                locationName: string;
                count: number;
              } => Boolean(entry && entry.count >= 0),
            )
            .sort(
              (left, right) =>
                right.count - left.count ||
                left.locationName.localeCompare(right.locationName),
            );
          return boundedList(
            items.slice(0, ASSISTANT_CONTEXT_LIMIT.LOCATIONS),
            rows.length,
          );
        };
        const upcoming = (upcomingRows as any[]).map((booking) =>
          serializeOperationalBooking(booking, {
            includeCustomer: false,
          }),
        );
        const tomorrowItems = (tomorrowRows as any[]).map((booking) =>
          serializeOperationalBooking(booking, {
            includeCustomer: canViewCustomers,
          }),
        );
        const unpaidBookingItems = (unpaidFutureRows as any[]).map((booking) =>
          serializeOperationalBooking(booking, {
            includeCustomer: canViewCustomers,
            includePaymentExpiry: true,
          }),
        );
        const customerFacet = (unpaidCustomerFacet as any[])?.[0] || {};
        const unpaidCustomers = canViewCustomers
          ? boundedList(
              (customerFacet.items || []).map((entry: any) => ({
                customerId: entry._id ? String(entry._id) : null,
                name: compactText(entry.name, 160) || null,
                customId: compactText(entry.customId, 120) || null,
                unpaidBookings: Number(entry.unpaidBookings || 0),
                nextBookingAt: entry.nextBookingAt || null,
              })),
              Number(customerFacet.total?.[0]?.count || 0),
            )
          : null;
        context.bookings = {
          todayCount: Number(todayCount || 0),
          futureConfirmedCount: Number(futureConfirmedCount || 0),
          allTimeConfirmedCount: Number(allTimeConfirmedCount || 0),
          byLocation: {
            today: serializeLocationCounts(todayLocationCounts as any[]),
            upcoming: serializeLocationCounts(upcomingLocationCounts as any[]),
            allTime: serializeLocationCounts(allTimeLocationCounts as any[]),
          },
          upcoming,
          tomorrow: {
            dateKey: tomorrowDay.dateKey,
            ...boundedList(tomorrowItems, Number(tomorrowCount || 0)),
          },
          unpaidFuture: {
            asOf: now.toISOString(),
            bookings: boundedList(
              unpaidBookingItems,
              Number(unpaidFutureCount || 0),
            ),
            customers: unpaidCustomers,
            customerDetailsAvailable: canViewCustomers,
          },
        };
      })(),
    });
  }
  if (hasWorkspacePermission(access, WORKSPACE_PERMISSION.TASKS_VIEW)) {
    operations.push({
      source: "tasks",
      run: (async () => {
        const query: any = {
          tenantId,
          status: { $nin: ["done"] },
          ...taskLocationFilter(allowed),
        };
        const [openCount, urgent, overdue, due] = await Promise.all([
          StaffTaskModel.countDocuments(query),
          StaffTaskModel.countDocuments({ ...query, priority: "urgent" }),
          StaffTaskModel.countDocuments({
            ...query,
            dueDate: { $ne: null, $lt: now },
          }),
          StaffTaskModel.find({
            ...query,
            dueDate: { $ne: null },
          })
            .sort({ dueDate: 1 })
            .limit(5)
            .select(
              "title priority status dueDate locationId appliesToAllLocations",
            )
            .lean(),
        ]);
        context.tasks = { openCount, urgent, overdue, due };
      })(),
    });
  }
  const canViewStaffPlanning =
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.PLANNING_TEAM_VIEW) ||
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.PLANNING_MANAGE);
  if (includeStaffPlanning && canViewStaffPlanning) {
    const enabled = await TenantModel.exists({
      _id: tenantId,
      [`modules.${TENANT_MODULE.STAFF_TASKS}`]: true,
    });
    if (enabled) {
      operations.push({
        source: "staffPlanning",
        run: (async () => {
          const overview = await getStaffPlanningOverview(
            { tenantId, userId, access, now },
            {
              date: localDay.dateKey,
              ...(locationId ? { locationId } : {}),
            },
          );
          context.staffPlanning = {
            counts: overview.today.counts,
            ...(includeStaffPlanningDetail
              ? serializeStaffPlanningDetail(
                  overview,
                  hasWorkspacePermission(
                    access,
                    WORKSPACE_PERMISSION.TASKS_VIEW,
                  ),
                )
              : {}),
          };
        })(),
      });
    }
  }
  if (hasWorkspacePermission(access, WORKSPACE_PERMISSION.INVENTORY_VIEW)) {
    operations.push({
      source: "inventory",
      run: (async () => {
        const allowedObjectIds = allowed === null ? null : ids(allowed);
        const query = {
          tenant: tenantId,
          isActive: true,
          $expr: {
            $or: [
              {
                $anyElementTrue: {
                  $map: {
                    input: { $ifNull: ["$stockLevels", []] },
                    as: "level",
                    in: {
                      $and: [
                        ...(allowedObjectIds === null
                          ? []
                          : [{ $in: ["$$level.location", allowedObjectIds] }]),
                        { $gt: ["$$level.minimumQuantity", 0] },
                        {
                          $lte: [
                            "$$level.currentQuantity",
                            "$$level.minimumQuantity",
                          ],
                        },
                      ],
                    },
                  },
                },
              },
              {
                $and: [
                  {
                    $eq: [{ $size: { $ifNull: ["$stockLevels", []] } }, 0],
                  },
                  { $gt: ["$minimumQuantity", 0] },
                  { $lte: ["$currentQuantity", "$minimumQuantity"] },
                  ...(allowedObjectIds === null
                    ? []
                    : [
                        {
                          $in: [
                            {
                              $arrayElemAt: [
                                { $ifNull: ["$locations", []] },
                                0,
                              ],
                            },
                            allowedObjectIds,
                          ],
                        },
                      ]),
                ],
              },
            ],
          },
        };
        const [lowStockCount, rawItems] = await Promise.all([
          InventoryItem.countDocuments(query),
          InventoryItem.find(query)
            .limit(25)
            .select(
              "name stockLevels locations currentQuantity minimumQuantity unit currency",
            )
            .lean(),
        ]);
        const allowedSet =
          allowed === null ? null : new Set(allowed.map(String));
        const items = (rawItems as any[])
          .map((item) => {
            const canonicalLevels = getCanonicalStockLevels(item);
            const levels = canonicalLevels.filter((level) => {
              const locationId = String(level.location || "");
              return (
                (!allowedSet || allowedSet.has(locationId)) &&
                Number(level.minimumQuantity || 0) > 0 &&
                Number(level.currentQuantity || 0) <=
                  Number(level.minimumQuantity || 0)
              );
            });

            if (levels.length) {
              const mostUrgent = [...levels].sort(
                (left, right) =>
                  Number(left.currentQuantity || 0) -
                  Number(right.currentQuantity || 0),
              )[0];
              return {
                id: String(item._id),
                name: compactText(item.name, 160),
                unit: compactText(item.unit, 40) || null,
                currency: compactText(item.currency, 3).toUpperCase() || null,
                stockLevels: levels.map((level) => ({
                  location: String(level.location),
                  currentQuantity: Number(level.currentQuantity || 0),
                  minimumQuantity: Number(level.minimumQuantity || 0),
                })),
                currentQuantity: Number(mostUrgent.currentQuantity || 0),
                minimumQuantity: Number(mostUrgent.minimumQuantity || 0),
              };
            }

            if (
              allowed === null &&
              canonicalLevels.length === 0 &&
              Number(item.minimumQuantity || 0) > 0 &&
              Number(item.currentQuantity || 0) <=
                Number(item.minimumQuantity || 0)
            ) {
              return {
                id: String(item._id),
                name: compactText(item.name, 160),
                unit: compactText(item.unit, 40) || null,
                currency: compactText(item.currency, 3).toUpperCase() || null,
                stockLevels: [],
                currentQuantity: Number(item.currentQuantity || 0),
                minimumQuantity: Number(item.minimumQuantity || 0),
                unscopedLegacy: true,
              };
            }

            return null;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
          .sort(
            (left, right) =>
              Number(left.currentQuantity || 0) -
              Number(right.currentQuantity || 0),
          )
          .slice(0, 5);
        context.inventory = { lowStockCount, items };
      })(),
    });
  }
  if (hasWorkspacePermission(access, WORKSPACE_PERMISSION.ORDERS_VIEW)) {
    operations.push({
      source: "orders",
      run: (async () => {
        const query = {
          tenant: tenantId,
          paidAt: { $gte: today, $lt: tomorrow },
          isPaid: true,
          ...buildOrderLocationScopeFilter(allowed),
        };
        const orders = await Order.find(query)
          .select("grossAmountMinor paidAmountMinor currency paidAt")
          .lean();
        const totalsByCurrency: Record<string, number> = {};
        for (const order of orders) {
          const currency = String(order.currency || "");
          totalsByCurrency[currency] =
            (totalsByCurrency[currency] || 0) +
            Number(order.paidAmountMinor ?? order.grossAmountMinor ?? 0);
        }
        context.orders = {
          paidToday: orders.length,
          totalsMinorByCurrency: totalsByCurrency,
        };
      })(),
    });
  }
  if (
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW)
  ) {
    operations.push({
      source: "communications",
      run: (async () => {
        const visibility = buildConversationVisibilityFilter({
          tenantId,
          userId,
          role: access.role,
          allowedLocationIds: allowed,
        });
        const [open, urgent, unread] = await Promise.all([
          CommunicationConversationModel.countDocuments({
            $and: [visibility, { status: { $ne: "closed" } }],
          }),
          CommunicationConversationModel.countDocuments({
            $and: [
              visibility,
              { status: { $ne: "closed" }, priority: "urgent" },
            ],
          }),
          CommunicationConversationModel.countDocuments({
            $and: [visibility, { unreadCount: { $gt: 0 } }],
          }),
        ]);
        context.communications = { open, urgent, unread };
      })(),
    });
  }

  const results = await Promise.allSettled(
    operations.map((operation) => operation.run),
  );
  const available: string[] = [];
  const unavailable: Array<{ source: string; reason: string }> = [];
  results.forEach((result, index) => {
    const source = operations[index]?.source || "unknown";
    if (result.status === "fulfilled") {
      available.push(source);
    } else {
      // Do not expose database/provider internals to the model or client.
      unavailable.push({ source, reason: "source_temporarily_unavailable" });
      delete context[source];
    }
  });
  if (timezoneFallback) {
    unavailable.push({
      source: "tenant_timezone",
      reason: "using_utc_fallback",
    });
  }
  context.coverage = {
    available,
    unavailable,
    complete: unavailable.length === 0,
  };
  return context;
};

/**
 * Builds a broad but deliberately bounded context for the interactive
 * workspace assistant. The daily briefing continues to use the lean
 * operational context above.
 *
 * Every query is tenant-pinned, respects the actor's effective permissions,
 * and applies the same location boundaries as the corresponding workspace
 * feature. Only fields that are safe to send to the configured AI provider
 * are selected and serialized.
 */
export const buildWorkspaceAssistantContext = async ({
  tenantId,
  userId,
  access,
  locationId,
  timezone,
  now: suppliedNow,
  profile = STUDIO_CONTEXT_PROFILE.FULL,
}: StudioContextBuildInput): Promise<StudioContextSnapshot> => {
  if (
    access.status !== "active" ||
    access.tenantId !== tenantId ||
    access.userId !== userId
  ) {
    throw new Error(
      "Active workspace access must match the requested workspace and user.",
    );
  }

  const now = suppliedNow || new Date();
  const [rawTenant, rawActor] = await Promise.all([
    TenantModel.findById(tenantId)
      .select(
        "name slug plan planVersion limits settings modules onboarding.businessType",
      )
      .lean(),
    UserModel.findOne({ _id: userId, tenant: tenantId })
      .select("firstname lastname")
      .lean(),
  ]);
  const tenant = rawTenant as any;
  const actor = rawActor as any;
  if (!tenant) {
    throw new Error("Workspace not found.");
  }

  const modules = safeTenantModules(tenant.modules);
  const tenantTimezone = normalizeTimezone(
    timezone || tenant.settings?.timezone,
  );
  const localDay = getTenantLocalDay(tenantTimezone, now);
  const locationScope = resolveAssistantLocationScope({
    access,
    locationId,
  });
  const has = (
    permission: (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION],
  ) => hasWorkspacePermission(access, permission);
  const effectiveLocationIds = locationScope.effectiveLocationIds;
  const hasUsableLocationScope =
    effectiveLocationIds === null || effectiveLocationIds.length > 0;
  const visibleLocationSet =
    effectiveLocationIds === null
      ? null
      : new Set(effectiveLocationIds.map(String));

  const available: string[] = ["actor", "studio"];
  const omitted: Array<{ source: string; reason: string }> = [];
  const unavailable: Array<{ source: string; reason: string }> = [];
  const sourceTasks: Promise<void>[] = [];

  const result: Record<string, any> = {
    contextVersion: STUDIO_CONTEXT_VERSION,
    profile,
    generatedAt: now.toISOString(),
    scope: {
      requestedLocationId: locationScope.requestedLocationId,
      requestedLocationAccessible: locationScope.requestedLocationAccessible,
      timezone: localDay.timezone,
      dateKey: localDay.dateKey,
    },
    studio: {
      name: compactText(tenant.name, 120),
      slug: compactText(tenant.slug, 80),
      businessType: compactText(tenant.onboarding?.businessType, 80) || null,
      settings: {
        defaultLanguage:
          compactText(tenant.settings?.defaultLanguage, 12) || null,
        currency:
          compactText(tenant.settings?.currency, 3).toUpperCase() || null,
        timezone: normalizeTimezone(tenant.settings?.timezone),
      },
      modules,
    },
    actor: {
      id: userId,
      firstName: compactText(actor?.firstname, 80) || null,
      lastName: compactText(actor?.lastname, 80) || null,
      displayName:
        compactText(access.workspaceProfile.displayName, 160) ||
        compactText(
          [actor?.firstname, actor?.lastname].filter(Boolean).join(" "),
          160,
        ) ||
        null,
      jobTitle: compactText(access.workspaceProfile.jobTitle, 120) || null,
      role: access.role,
      roleName: access.customRoleName || access.role,
      preferredLanguage: access.preferences.language,
      displayTimezone: access.preferences.displayTimezone,
      defaultLocationId:
        access.preferences.defaultLocation &&
        canAccessWorkspaceLocation(access, access.preferences.defaultLocation)
          ? access.preferences.defaultLocation
          : null,
    },
    subscription: null,
    locations: null,
    products: null,
    courses: {
      catalog: null,
      upcomingSessions: null,
      upcomingEvents: null,
      revenueRecent: null,
    },
    team: null,
    customers: null,
    inventory: null,
    memberships: null,
    invoices: null,
    credits: null,
    vouchers: null,
    communications: null,
    reports: null,
    publicSite: null,
    operations: null,
  };

  const scheduleSource = ({
    source,
    moduleEnabled = true,
    permitted = true,
    requiresLocationScope = false,
    run,
  }: {
    source: string;
    moduleEnabled?: boolean;
    permitted?: boolean;
    requiresLocationScope?: boolean;
    run: () => Promise<void>;
  }) => {
    if (profile === STUDIO_CONTEXT_PROFILE.CORE && source !== "locations") {
      omitted.push({ source, reason: "profile_excluded" });
      return;
    }
    if (!moduleEnabled) {
      omitted.push({ source, reason: "module_disabled" });
      return;
    }
    if (!permitted) {
      omitted.push({ source, reason: "permission_required" });
      return;
    }
    if (requiresLocationScope && !hasUsableLocationScope) {
      omitted.push({ source, reason: "location_scope_empty" });
      return;
    }
    sourceTasks.push(
      (async () => {
        try {
          await run();
          available.push(source);
        } catch {
          unavailable.push({
            source,
            reason: "source_temporarily_unavailable",
          });
        }
      })(),
    );
  };

  scheduleSource({
    source: "subscription",
    permitted: has(WORKSPACE_PERMISSION.SUBSCRIPTION_VIEW),
    run: async () => {
      result.subscription = {
        plan: compactText(tenant.plan, 40) || null,
        planVersion:
          tenant.planVersion == null ? null : Number(tenant.planVersion),
        limits: {
          locations: Number(tenant.limits?.locations || 0),
          admins: Number(tenant.limits?.admins || 0),
          staffMembers: Number(tenant.limits?.staffMembers || 0),
          inventoryItems: Number(tenant.limits?.inventoryItems || 0),
          monthlyEmails: Number(tenant.limits?.monthlyEmails || 0),
          monthlyAutomations: Number(tenant.limits?.monthlyAutomations || 0),
          aiCredits: Number(tenant.limits?.aiCredits || 0),
        },
      };
    },
  });

  scheduleSource({
    source: "locations",
    permitted: has(WORKSPACE_PERMISSION.LOCATIONS_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const query = {
        tenant: tenantId,
        isActive: true,
        ...scopedLocationQuery("_id", effectiveLocationIds),
      };
      const [total, rows] = await Promise.all([
        LocationModel.countDocuments(query),
        LocationModel.find(query)
          .sort({ isPrimary: -1, name: 1 })
          .limit(ASSISTANT_CONTEXT_LIMIT.LOCATIONS)
          .select(
            "name slug code isActive isPrimary address booking openingHours access.publicInstructions",
          )
          .lean(),
      ]);
      result.locations = boundedList(
        (rows as any[]).map((row) => ({
          id: String(row._id),
          name: compactText(row.name, 160),
          slug: compactText(row.slug, 160),
          code: compactText(row.code, 20),
          isPrimary: row.isPrimary === true,
          address: {
            line1: compactText(row.address?.line1, 200),
            line2: compactText(row.address?.line2, 200),
            city: compactText(row.address?.city, 120),
            postalCode: compactText(row.address?.postalCode, 32),
            country: compactText(row.address?.country, 80),
          },
          booking: {
            enabled: row.booking?.enabled === true,
            timezone: normalizeTimezone(row.booking?.timezone),
            slotStepMinutes: Number(row.booking?.slotStepMinutes || 0),
            minBookingMinutes: Number(row.booking?.minBookingMinutes || 0),
            maxBookingMinutes: Number(row.booking?.maxBookingMinutes || 0),
            globalCapacity: Number(row.booking?.globalCapacity || 0),
            activitySelectionMode: resolveLocationActivitySelectionMode(
              row.booking?.activitySelectionMode,
            ),
            allowPublicSoloOverlap:
              row.booking?.allowPublicSoloOverlap === true,
            maxPublicSoloOverlaps: Number(
              row.booking?.maxPublicSoloOverlaps || 0,
            ),
            privateSessionBlocksAll:
              row.booking?.privateSessionBlocksAll !== false,
            groupBookingBlocksAll: row.booking?.groupBookingBlocksAll !== false,
            doorCodeMinutesBefore: Number(
              row.booking?.doorCodeMinutesBefore || 0,
            ),
            activityCapacities: {
              items: (row.booking?.activityCapacities || [])
                .slice(0, 12)
                .map((entry: any) => ({
                  activity: compactText(entry.activity, 80),
                  capacity: Number(entry.capacity || 0),
                })),
              truncated: (row.booking?.activityCapacities || []).length > 12,
            },
          },
          openingHours: row.openingHours || {},
          publicAccessInstructions: compactText(
            row.access?.publicInstructions,
            1_000,
          ),
        })),
        total,
      );
    },
  });

  const serializeProduct = (row: any) => ({
    id: String(row._id),
    name: compactText(row.name, 160),
    description: compactText(row.description, 600),
    type: compactText(row.type, 80),
    price: Number(row.price || 0),
    extraCharge: Number(row.extraCharge || 0),
    currency: compactText(row.currency, 3).toUpperCase(),
    maxNumberOfParticipants:
      row.maxNumberOfParticipants == null
        ? null
        : Number(row.maxNumberOfParticipants),
  });

  scheduleSource({
    source: "products",
    permitted: has(WORKSPACE_PERMISSION.PRODUCTS_VIEW),
    run: async () => {
      const query = {
        tenant: tenantId,
        isActive: true,
        type: { $nin: [...COURSE_PRODUCT_TYPES] },
      };
      const [total, rows] = await Promise.all([
        ProductModel.countDocuments(query),
        ProductModel.find(query)
          .sort({ sortOrder: 1, name: 1 })
          .limit(ASSISTANT_CONTEXT_LIMIT.PRODUCTS)
          .select(
            "name description type price extraCharge currency maxNumberOfParticipants",
          )
          .lean(),
      ]);
      result.products = boundedList(
        (rows as any[]).map(serializeProduct),
        total,
      );
    },
  });

  scheduleSource({
    source: "courses.catalog",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.COURSES),
    permitted: has(WORKSPACE_PERMISSION.COURSES_VIEW),
    run: async () => {
      const query = {
        tenant: tenantId,
        isActive: true,
        type: { $in: [...COURSE_PRODUCT_TYPES] },
      };
      const [total, rows] = await Promise.all([
        ProductModel.countDocuments(query),
        ProductModel.find(query)
          .sort({ sortOrder: 1, name: 1 })
          .limit(ASSISTANT_CONTEXT_LIMIT.COURSE_CATALOG)
          .select(
            "name description type price extraCharge currency maxNumberOfParticipants",
          )
          .lean(),
      ]);
      result.courses.catalog = boundedList(
        (rows as any[]).map(serializeProduct),
        total,
      );
    },
  });

  scheduleSource({
    source: "courses.sessions",
    moduleEnabled:
      moduleIsEnabled(modules, TENANT_MODULE.COURSES) &&
      moduleIsEnabled(modules, TENANT_MODULE.BOOKINGS),
    permitted:
      has(WORKSPACE_PERMISSION.COURSES_VIEW) &&
      has(WORKSPACE_PERMISSION.BOOKINGS_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const query = {
        tenant: tenantId,
        tag: { $in: CLASS_BOOKING_TAGS },
        status: { $ne: BOOKING_STATUS.CANCELLED },
        paymentStatus: PAYMENT_STATUS.CONFIRMED,
        start: { $gte: now },
        ...scopedLocationQuery("location", effectiveLocationIds),
      };
      const [total, rows] = await Promise.all([
        Booking.countDocuments(query),
        Booking.find(query)
          .sort({ start: 1 })
          .limit(ASSISTANT_CONTEXT_LIMIT.COURSE_SESSIONS)
          .select(
            "start end location bookingProduct lecturer language status paymentStatus numberOfGuests",
          )
          .populate({
            path: "bookingProduct",
            select: "name type maxNumberOfParticipants",
            match: { tenant: tenantId },
          })
          .lean(),
      ]);
      result.courses.upcomingSessions = boundedList(
        (rows as any[]).map((row) => {
          const product =
            row.bookingProduct && typeof row.bookingProduct === "object"
              ? row.bookingProduct
              : null;
          return {
            id: String(row._id),
            productId: product?._id ? String(product._id) : null,
            name: compactText(product?.name, 160) || null,
            start: row.start,
            end: row.end,
            locationId: String(row.location || ""),
            lecturer: compactText(row.lecturer, 160) || null,
            language: compactText(row.language, 24) || null,
            status: compactText(row.status, 40),
            paymentStatus: compactText(row.paymentStatus, 40),
            participants: Number(row.numberOfGuests || 0),
            capacity:
              product?.maxNumberOfParticipants == null
                ? null
                : Number(product.maxNumberOfParticipants),
          };
        }),
        total,
      );
    },
  });

  scheduleSource({
    source: "courses.revenueRecent",
    moduleEnabled:
      moduleIsEnabled(modules, TENANT_MODULE.COURSES) &&
      moduleIsEnabled(modules, TENANT_MODULE.PAYMENTS),
    permitted:
      has(WORKSPACE_PERMISSION.COURSES_VIEW) &&
      has(WORKSPACE_PERMISSION.ORDERS_VIEW) &&
      has(WORKSPACE_PERMISSION.PAYMENTS_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const periodFrom = dayjs(localDay.start)
        .tz(localDay.timezone)
        .subtract(89, "day")
        .format("YYYY-MM-DD");
      const periodStart = dayjs
        .tz(periodFrom, "YYYY-MM-DD", localDay.timezone)
        .startOf("day")
        .toDate();
      const currency = compactText(tenant.settings?.currency, 3).toUpperCase();
      const courseProducts = (await ProductModel.find({
        tenant: tenantId,
        type: { $in: [...COURSE_PRODUCT_TYPES] },
      })
        .select("_id name type")
        .lean()) as any[];
      const productIds = courseProducts
        .map((product) => String(product._id || ""))
        .filter(Boolean);
      const productIdSet = new Set(productIds);
      const productNameById = new Map(
        courseProducts.map((product) => [
          String(product._id),
          compactText(product.name, 160) || "Course",
        ]),
      );
      const requestedLocationId = locationScope.requestedLocationAccessible
        ? locationScope.requestedLocationId
        : null;
      const orderQuery: Record<string, unknown> = {
        tenant: tenantId,
        isPaid: true,
        status: ORDER_STATUS.PROCESSED,
        currency,
        paidAt: {
          $gte: periodStart,
          $lt: localDay.end,
        },
        "lineItems.product": { $in: productIds },
        ...buildOrderReadLocationFilter(
          locationScope.actorAllowedLocationIds,
          requestedLocationId || undefined,
        ),
      };
      const orders = productIds.length
        ? ((await Order.find(orderQuery as any)
            .sort({ paidAt: 1, _id: 1 })
            .select(
              "_id paidAt paidAmountMinor currency creditPurchase lineItems locationIds",
            )
            .lean()) as any[])
        : [];
      const revenueByProduct = new Map<
        string,
        {
          productId: string;
          name: string;
          revenueMinor: number;
          quantity: number;
          orderIds: Set<string>;
        }
      >();
      let excludedOrdersWithoutPaidAmount = 0;
      let analyzedOrders = 0;

      for (const order of orders) {
        if (Number(order.creditPurchase?.amount || 0) > 0) continue;
        const allocated = allocatePaidCourseLines({
          order,
          courseProductIds: productIdSet,
          scope: {
            requestedLocationId,
            allowedLocationIds: locationScope.actorAllowedLocationIds,
          },
        });
        if (allocated === null) {
          excludedOrdersWithoutPaidAmount += 1;
          continue;
        }
        analyzedOrders += 1;
        for (const line of allocated) {
          const existing = revenueByProduct.get(line.productId) ?? {
            productId: line.productId,
            name: productNameById.get(line.productId) || "Course",
            revenueMinor: 0,
            quantity: 0,
            orderIds: new Set<string>(),
          };
          existing.revenueMinor += line.revenueMinor;
          existing.quantity += line.quantity;
          existing.orderIds.add(String(order._id));
          revenueByProduct.set(line.productId, existing);
        }
      }

      const ranked = [...revenueByProduct.values()]
        .map((entry) => ({
          productId: entry.productId,
          name: entry.name,
          revenueMinor: entry.revenueMinor,
          currency,
          orders: entry.orderIds.size,
          quantity: Number(entry.quantity.toFixed(2)),
        }))
        .sort(
          (left, right) =>
            right.revenueMinor - left.revenueMinor ||
            right.orders - left.orders ||
            left.name.localeCompare(right.name),
        );
      const highestRevenueCourse =
        ranked.find((entry) => entry.revenueMinor > 0) || null;

      result.courses.revenueRecent = {
        period: {
          key: "recent_90_tenant_calendar_days",
          label: "Recent 90 tenant-calendar days including today",
          from: periodFrom,
          to: localDay.dateKey,
          days: 90,
          timezone: localDay.timezone,
        },
        metric: "allocated_paid_revenue_minor",
        basis:
          "paid_processed_orders_allocated_by_stored_line_item_gross_amount",
        currency,
        profitAvailable: false,
        highestRevenueCourse,
        courses: boundedList(
          ranked.slice(0, ASSISTANT_CONTEXT_LIMIT.COURSE_REVENUE),
          ranked.length,
        ),
        analyzedOrders,
        excludedOrdersWithoutPaidAmount,
        limitations: [
          "This is allocated paid revenue, not profit; course costs and margins are not stored.",
          "Revenue uses paid processed orders in the workspace currency and stored line-item location snapshots.",
        ],
      };
    },
  });

  scheduleSource({
    source: "courses.events",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.COURSES),
    permitted: has(WORKSPACE_PERMISSION.COURSES_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const EventContextModel = EventModel as any;
      const query = {
        tenant: tenantId,
        date: { $gte: localDay.start },
        ...scopedLocationQuery("location", effectiveLocationIds),
      };
      const [total, rows] = await Promise.all([
        EventContextModel.countDocuments(query),
        EventContextModel.find(query)
          .sort({ date: 1, startTime: 1 })
          .limit(ASSISTANT_CONTEXT_LIMIT.EVENTS)
          .select(
            "title type status location externalLocationName date startTime endTime numberOfGuests currency priceEstimate finalPrice depositPaid",
          )
          .lean(),
      ]);
      result.courses.upcomingEvents = boundedList(
        (rows as any[]).map((row) => ({
          id: String(row._id),
          title: compactText(row.title, 160),
          type: compactText(row.type, 60),
          status: compactText(row.status, 60),
          locationId: row.location ? String(row.location) : null,
          externalLocationName:
            compactText(row.externalLocationName, 200) || null,
          date: row.date,
          startTime: compactText(row.startTime, 8) || null,
          endTime: compactText(row.endTime, 8) || null,
          numberOfGuests: Number(row.numberOfGuests || 0),
          currency: compactText(row.currency, 3).toUpperCase() || null,
          priceEstimate: Number(row.priceEstimate || 0),
          finalPrice: Number(row.finalPrice || 0),
          depositPaid: Number(row.depositPaid || 0),
        })),
        total,
      );
    },
  });

  scheduleSource({
    source: "team",
    permitted: has(WORKSPACE_PERMISSION.TEAM_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const TeamContextModel = StaffMemberModel as any;
      const query = {
        tenantId,
        isActive: true,
        ...scopedLocationQuery("locationIds", effectiveLocationIds),
      };
      const membershipQuery = {
        tenant: tenantId,
        status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
        ...(effectiveLocationIds === null
          ? {}
          : {
              $or: [
                { "locationAccess.mode": "all" as const },
                {
                  "locationAccess.locationIds": {
                    $in: ids(effectiveLocationIds),
                  },
                },
              ],
            }),
      };
      const [total, activeWorkspaceMemberCount, rows] = await Promise.all([
        TeamContextModel.countDocuments(query),
        TenantMembershipModel.countDocuments(membershipQuery),
        TeamContextModel.find(query)
          .sort({ lastName: 1, firstName: 1 })
          .limit(ASSISTANT_CONTEXT_LIMIT.TEAM)
          .select(
            "firstName lastName role employmentType locationIds skills isBookable visibleOnWebsite",
          )
          .lean(),
      ]);
      result.team = {
        ...boundedList(
          (rows as any[]).map((row) => ({
            id: String(row._id),
            firstName: compactText(row.firstName, 80),
            lastName: compactText(row.lastName, 80),
            role: compactText(row.role, 80),
            employmentType: compactText(row.employmentType, 80),
            locationIds: (row.locationIds || [])
              .map(String)
              .filter(
                (entry: string) =>
                  !visibleLocationSet || visibleLocationSet.has(entry),
              )
              .slice(0, ASSISTANT_CONTEXT_LIMIT.LOCATIONS),
            skills: {
              items: (row.skills || [])
                .slice(0, 12)
                .map((skill: unknown) => compactText(skill, 80)),
              truncated: (row.skills || []).length > 12,
            },
            isBookable: row.isBookable === true,
            visibleOnWebsite: row.visibleOnWebsite === true,
          })),
          total,
        ),
        activeWorkspaceMemberCount: Number(activeWorkspaceMemberCount || 0),
        workspaceMemberBasis: "active_tenant_memberships_in_visible_scope",
      };
    },
  });

  const customersCanBeScoped =
    locationScope.actorAllowedLocationIds === null ||
    (moduleIsEnabled(modules, TENANT_MODULE.BOOKINGS) &&
      has(WORKSPACE_PERMISSION.BOOKINGS_VIEW));
  scheduleSource({
    source: "customers",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.CUSTOMERS),
    permitted: has(WORKSPACE_PERMISSION.CUSTOMERS_VIEW) && customersCanBeScoped,
    requiresLocationScope:
      locationScope.actorAllowedLocationIds !== null ||
      Boolean(locationScope.requestedLocationId),
    run: async () => {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
      if (locationScope.actorAllowedLocationIds === null) {
        const [total, newLast30Days] = await Promise.all([
          UserModel.countDocuments({
            tenant: tenantId,
            tenantRole: "customer",
          }),
          UserModel.countDocuments({
            tenant: tenantId,
            tenantRole: "customer",
            createdAt: { $gte: thirtyDaysAgo },
          }),
        ]);
        result.customers = {
          total,
          newLast30Days,
          activeLast30Days: null,
          basis: "workspace_accounts",
        };
        return;
      }

      const bookingScope = {
        tenant: new mongoose.Types.ObjectId(tenantId),
        status: { $ne: BOOKING_STATUS.CANCELLED },
        paymentStatus: PAYMENT_STATUS.CONFIRMED,
        tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
        ...scopedLocationQuery("location", effectiveLocationIds),
      };
      const [aggregate] = await Booking.aggregate([
        { $match: bookingScope },
        {
          $group: {
            _id: "$createdBy",
            latestPastBookingAt: {
              $max: {
                $cond: [{ $lte: ["$start", now] }, "$start", null],
              },
            },
          },
        },
        {
          $lookup: {
            from: UserModel.collection.name,
            let: { customerId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$_id", "$$customerId"] },
                      {
                        $eq: ["$tenant", new mongoose.Types.ObjectId(tenantId)],
                      },
                      { $eq: ["$tenantRole", "customer"] },
                    ],
                  },
                },
              },
              { $project: { _id: 1 } },
            ],
            as: "customer",
          },
        },
        { $match: { "customer.0": { $exists: true } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            activeLast30Days: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$latestPastBookingAt", null] },
                      {
                        $gte: ["$latestPastBookingAt", thirtyDaysAgo],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);
      result.customers = {
        total: Number(aggregate?.total || 0),
        newLast30Days: null,
        activeLast30Days: Number(aggregate?.activeLast30Days || 0),
        basis: "customers_linked_to_visible_bookings",
      };
    },
  });

  scheduleSource({
    source: "inventory",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.INVENTORY),
    permitted: has(WORKSPACE_PERMISSION.INVENTORY_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const query = {
        tenant: tenantId,
        isActive: true,
        ...inventoryLocationScopeFilter(effectiveLocationIds),
      };
      const [total, rows] = await Promise.all([
        InventoryItem.countDocuments(query),
        InventoryItem.find(query)
          .sort({ name: 1, _id: 1 })
          .limit(ASSISTANT_CONTEXT_LIMIT.INVENTORY)
          .select(
            "name sku category unit currency stockLevels locations currentQuantity minimumQuantity averageUnitCostWithoutVat",
          )
          .lean(),
      ]);
      result.inventory = {
        ...(result.inventory || {}),
        ...boundedList(
          (rows as any[]).map((row) => {
            const canonicalLevels = getCanonicalStockLevels(row);
            const visibleLevels = canonicalLevels.filter((level) => {
              const stockLocationId = String(level.location || "");
              return (
                Boolean(stockLocationId) &&
                (!visibleLocationSet || visibleLocationSet.has(stockLocationId))
              );
            });
            const currentQuantity = visibleLevels.reduce(
              (sum, level) => sum + Number(level.currentQuantity || 0),
              0,
            );
            const minimumQuantity = visibleLevels.reduce(
              (sum, level) => sum + Number(level.minimumQuantity || 0),
              0,
            );
            const unscopedLegacyStock =
              effectiveLocationIds === null &&
              canonicalLevels.length === 0 &&
              (Number(row.currentQuantity || 0) > 0 ||
                Number(row.minimumQuantity || 0) > 0);
            const effectiveCurrentQuantity = unscopedLegacyStock
              ? Number(row.currentQuantity || 0)
              : currentQuantity;
            const effectiveMinimumQuantity = unscopedLegacyStock
              ? Number(row.minimumQuantity || 0)
              : minimumQuantity;

            return {
              id: String(row._id),
              name: compactText(row.name, 160),
              sku: compactText(row.sku, 80) || null,
              category: compactText(row.category, 60) || null,
              unit: compactText(row.unit, 40) || null,
              currency: compactText(row.currency, 3).toUpperCase() || null,
              averageUnitCostWithoutVat:
                row.averageUnitCostWithoutVat == null
                  ? null
                  : Number(row.averageUnitCostWithoutVat),
              stock: {
                currentQuantity: effectiveCurrentQuantity,
                minimumQuantity: effectiveMinimumQuantity,
                lowStock:
                  effectiveMinimumQuantity > 0 &&
                  effectiveCurrentQuantity <= effectiveMinimumQuantity,
                unscopedLegacy: unscopedLegacyStock,
                levels: boundedList(
                  visibleLevels
                    .slice(0, ASSISTANT_CONTEXT_LIMIT.INVENTORY_LEVELS)
                    .map((level) => ({
                      locationId: String(level.location),
                      currentQuantity: Number(level.currentQuantity || 0),
                      minimumQuantity: Number(level.minimumQuantity || 0),
                    })),
                  visibleLevels.length,
                ),
              },
            };
          }),
          total,
        ),
      };
    },
  });

  scheduleSource({
    source: "inventory.reorderRequests",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.INVENTORY),
    permitted: has(WORKSPACE_PERMISSION.INVENTORY_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const activeStatuses = [REORDER_STATUS.OPEN, REORDER_STATUS.ORDERED];
      const activeQuery = {
        tenant: tenantId,
        ...locationFilter("location", effectiveLocationIds),
        status: { $in: activeStatuses },
      };

      const [activeCount, openCount, orderedCount, highPriorityCount, rows] =
        await Promise.all([
          ReorderRequest.countDocuments(activeQuery),
          ReorderRequest.countDocuments({
            ...activeQuery,
            status: REORDER_STATUS.OPEN,
          }),
          ReorderRequest.countDocuments({
            ...activeQuery,
            status: REORDER_STATUS.ORDERED,
          }),
          ReorderRequest.countDocuments({
            ...activeQuery,
            priority: REORDER_PRIORITY.HIGH,
          }),
          ReorderRequest.find(activeQuery)
            .sort({ createdAt: -1, _id: 1 })
            .limit(ASSISTANT_CONTEXT_LIMIT.REORDER_REQUESTS)
            .select(
              "item location requestedQuantity priority status source createdAt",
            )
            .populate({
              path: "item",
              match: { tenant: tenantId },
              select: "name unit",
            })
            .lean(),
        ]);

      result.inventory = {
        ...(result.inventory || {}),
        reorderRequests: {
          active: {
            ...boundedList(
              (rows as any[]).map((row) => ({
                id: String(row._id),
                itemId:
                  row.item && typeof row.item === "object" && row.item._id
                    ? String(row.item._id)
                    : null,
                itemName:
                  row.item && typeof row.item === "object"
                    ? compactText(row.item.name, 160) || null
                    : null,
                locationId: row.location ? String(row.location) : null,
                unit:
                  row.item && typeof row.item === "object"
                    ? compactText(row.item.unit, 40) || null
                    : null,
                requestedQuantity: Number(row.requestedQuantity || 0),
                priority: compactText(row.priority, 20) || null,
                status: compactText(row.status, 20) || null,
                source: compactText(row.source, 20) || null,
                createdAt: row.createdAt || null,
              })),
              Number(activeCount || 0),
            ),
            openCount: Number(openCount || 0),
            orderedCount: Number(orderedCount || 0),
            highPriorityCount: Number(highPriorityCount || 0),
          },
        },
      };
    },
  });

  scheduleSource({
    source: "memberships",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.MEMBERSHIPS),
    permitted: has(WORKSPACE_PERMISSION.MEMBERSHIPS_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const [plansResult, membershipStats] = await Promise.all([
        membershipRepository.listPlansWithScope({
          tenantId,
          ...(locationScope.requestedLocationId &&
          locationScope.requestedLocationAccessible
            ? { locationId: locationScope.requestedLocationId }
            : {}),
          allowedLocationIds: locationScope.actorAllowedLocationIds,
          includeInactive: false,
          page: 1,
          limit: ASSISTANT_CONTEXT_LIMIT.MEMBERSHIP_PLANS,
        }),
        UserMembership.aggregate([
          {
            $match: {
              tenant: new mongoose.Types.ObjectId(tenantId),
              ...membershipLocationScopeFilter(locationScope),
            },
          },
          {
            $facet: {
              byStatus: [
                { $group: { _id: "$status", count: { $sum: 1 } } },
                { $sort: { _id: 1 } },
                { $limit: 20 },
              ],
              expiringSoon: [
                {
                  $match: {
                    currentPeriodEnd: {
                      $gte: now,
                      $lt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
                    },
                  },
                },
                { $count: "count" },
              ],
              total: [{ $count: "count" }],
            },
          },
        ]),
      ]);
      const stats = membershipStats[0] || {};
      const plans = (plansResult.plans as any[]).map((plan) => {
        const version =
          plan.relevantVersion ||
          plan.currentPublishedVersion ||
          plan.currentDraftVersion ||
          {};
        return {
          id: String(plan._id),
          status: compactText(plan.status, 40),
          name: compactText(version.name, 160),
          description: compactText(version.description, 600),
          prices: {
            items: (version.prices || []).slice(0, 10).map((price: any) => ({
              currency: compactText(price.currency, 3).toUpperCase(),
              amountMinor: Number(price.amountMinor || 0),
            })),
            truncated: (version.prices || []).length > 10,
          },
          billing: {
            type: compactText(version.billing?.type, 40) || null,
            interval: compactText(version.billing?.interval, 40) || null,
            intervalCount:
              version.billing?.intervalCount == null
                ? null
                : Number(version.billing.intervalCount),
            durationDays:
              version.billing?.durationDays == null
                ? null
                : Number(version.billing.durationDays),
          },
          locationScope: {
            type: compactText(version.locationScope?.type, 40) || null,
            locationIds: (version.locationScope?.locationIds || [])
              .map(String)
              .slice(0, ASSISTANT_CONTEXT_LIMIT.LOCATIONS),
            truncated:
              (version.locationScope?.locationIds || []).length >
              ASSISTANT_CONTEXT_LIMIT.LOCATIONS,
          },
          benefits: {
            items: (version.benefits || [])
              .slice(0, 10)
              .map((benefit: any) => ({
                key: compactText(benefit.key, 80),
                label: compactText(benefit.label, 120),
                type: compactText(benefit.type, 40),
                unit: compactText(benefit.unit, 40) || null,
                quantity:
                  benefit.quantity == null ? null : Number(benefit.quantity),
                currency:
                  compactText(benefit.currency, 3).toUpperCase() || null,
                expiresAfterDays:
                  benefit.expiresAfterDays == null
                    ? null
                    : Number(benefit.expiresAfterDays),
                percentageBps:
                  benefit.percentageBps == null
                    ? null
                    : Number(benefit.percentageBps),
                appliesTo: compactText(benefit.appliesTo, 40) || null,
                limit: benefit.limit == null ? null : Number(benefit.limit),
                enabled:
                  benefit.enabled == null ? null : benefit.enabled === true,
              })),
            truncated: (version.benefits || []).length > 10,
          },
        };
      });
      result.memberships = {
        plans: boundedList(plans, Number(plansResult.total || 0)),
        total: Number(stats.total?.[0]?.count || 0),
        byStatus: {
          items: (stats.byStatus || []).map((entry: any) => ({
            status: compactText(entry._id, 40),
            count: Number(entry.count || 0),
          })),
          truncated: (stats.byStatus || []).length >= 20,
        },
        expiringWithin30Days: Number(stats.expiringSoon?.[0]?.count || 0),
      };
    },
  });

  scheduleSource({
    source: "invoices",
    moduleEnabled:
      isNativeInvoicingEnabled() &&
      moduleIsEnabled(modules, TENANT_MODULE.PAYMENTS),
    permitted: has(WORKSPACE_PERMISSION.INVOICES_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const actorScope = buildInvoiceLocationScopeFilter(
        locationScope.actorAllowedLocationIds,
      );
      const locationClause =
        locationScope.requestedLocationId &&
        locationScope.requestedLocationAccessible
          ? {
              $and: [
                {
                  locationIds: new mongoose.Types.ObjectId(
                    locationScope.requestedLocationId,
                  ),
                },
              ],
            }
          : {};
      const query = {
        tenant: tenantId,
        ...actorScope,
        ...locationClause,
      };
      const aggregationMatch = {
        ...query,
        tenant: new mongoose.Types.ObjectId(tenantId),
      };
      const [total, requiresReview, overdue, overdueRows, rows, totals] =
        await Promise.all([
          InvoiceModel.countDocuments(query),
          InvoiceModel.countDocuments({
            ...query,
            requiresReview: true,
          }),
          InvoiceModel.countDocuments({
            ...query,
            documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
            documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
            amountDueMinor: { $gt: 0 },
            dueDate: { $lt: now },
          }),
          InvoiceModel.find({
            ...query,
            documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
            documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
            amountDueMinor: { $gt: 0 },
            dueDate: { $lt: now },
          })
            .sort({ dueDate: 1, _id: 1 })
            .limit(ASSISTANT_CONTEXT_LIMIT.INVOICES)
            .select(
              "number currency amountDueMinor dueDate paymentStatus locationIds",
            )
            .lean(),
          InvoiceModel.find(query)
            .sort({ issueDate: -1, createdAt: -1 })
            .limit(ASSISTANT_CONTEXT_LIMIT.INVOICES)
            .select(
              "number documentType documentStatus paymentStatus currency totalAmountMinor amountPaidMinor amountDueMinor issueDate dueDate requiresReview locationIds",
            )
            .lean(),
          InvoiceModel.aggregate([
            {
              $match: {
                ...aggregationMatch,
                documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
                documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
                amountDueMinor: { $gt: 0 },
              },
            },
            {
              $group: {
                _id: "$currency",
                amountDueMinor: { $sum: "$amountDueMinor" },
                invoices: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ]),
        ]);
      const outstandingRows = (totals as any[]).slice(0, 20).map((entry) => ({
        currency: compactText(entry._id, 3).toUpperCase(),
        amountDueMinor: Number(entry.amountDueMinor || 0),
        invoices: Number(entry.invoices || 0),
      }));
      result.invoices = {
        total,
        requiresReview,
        overdue,
        overdueItems: boundedList(
          (overdueRows as any[]).map((row) => ({
            id: String(row._id),
            number: compactText(row.number, 100) || null,
            currency: compactText(row.currency, 3).toUpperCase(),
            amountDueMinor: Number(row.amountDueMinor || 0),
            dueDate: row.dueDate || null,
            paymentStatus: compactText(row.paymentStatus, 40),
            locationIds: (row.locationIds || [])
              .map(String)
              .filter(
                (entry: string) =>
                  locationScope.actorAllowedLocationIds === null ||
                  locationScope.actorAllowedLocationIds.includes(entry),
              )
              .slice(0, ASSISTANT_CONTEXT_LIMIT.LOCATIONS),
          })),
          Number(overdue || 0),
        ),
        outstandingByCurrency: boundedList(
          outstandingRows,
          (totals as any[]).length,
        ),
        recent: boundedList(
          (rows as any[]).map((row) => ({
            id: String(row._id),
            number: compactText(row.number, 100) || null,
            documentType: compactText(row.documentType, 40),
            documentStatus: compactText(row.documentStatus, 40),
            paymentStatus: compactText(row.paymentStatus, 40),
            currency: compactText(row.currency, 3).toUpperCase(),
            totalAmountMinor: Number(row.totalAmountMinor || 0),
            amountPaidMinor: Number(row.amountPaidMinor || 0),
            amountDueMinor: Number(row.amountDueMinor || 0),
            issueDate: row.issueDate || null,
            dueDate: row.dueDate || null,
            requiresReview: row.requiresReview === true,
            locationIds: (row.locationIds || [])
              .map(String)
              .filter(
                (entry: string) =>
                  locationScope.actorAllowedLocationIds === null ||
                  locationScope.actorAllowedLocationIds.includes(entry),
              )
              .slice(0, ASSISTANT_CONTEXT_LIMIT.LOCATIONS),
          })),
          total,
        ),
      };
    },
  });

  scheduleSource({
    source: "credits",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.CREDITS),
    permitted: has(WORKSPACE_PERMISSION.CREDITS_VIEW),
    run: async () => {
      const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
      const legacyMinorBalance = legacyMajorAmountToMinorExpression(
        "$balance",
        "$currency",
      );
      const [summary] = (await MoneyCredit.aggregate([
        { $match: { tenant: tenantObjectId } },
        {
          $facet: {
            balances: [
              {
                $group: {
                  _id: { $toUpper: { $ifNull: ["$currency", ""] } },
                  accounts: { $sum: 1 },
                  accountsWithBalance: {
                    $sum: {
                      $cond: [
                        {
                          $gt: [
                            { $ifNull: ["$balanceMinor", legacyMinorBalance] },
                            0,
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  outstandingBalanceMinor: {
                    $sum: {
                      $ifNull: ["$balanceMinor", legacyMinorBalance],
                    },
                  },
                },
              },
              { $sort: { _id: 1 } },
              { $limit: ASSISTANT_CONTEXT_LIMIT.CREDIT_CURRENCIES },
            ],
            transactionsLast30Days: [
              {
                $project: {
                  currency: 1,
                  transactions: {
                    $filter: {
                      input: { $ifNull: ["$transactions", []] },
                      as: "transaction",
                      cond: {
                        $and: [
                          {
                            $gte: ["$$transaction.createdAt", thirtyDaysAgo],
                          },
                          { $lte: ["$$transaction.createdAt", now] },
                        ],
                      },
                    },
                  },
                },
              },
              { $unwind: "$transactions" },
              {
                $group: {
                  _id: {
                    currency: {
                      $toUpper: {
                        $ifNull: ["$transactions.currency", "$currency"],
                      },
                    },
                    type: "$transactions.type",
                  },
                  count: { $sum: 1 },
                  amountMinor: {
                    $sum: {
                      $ifNull: [
                        "$transactions.amountMinor",
                        legacyMajorAmountToMinorExpression(
                          "$transactions.amount",
                          {
                            $ifNull: ["$transactions.currency", "$currency"],
                          },
                        ),
                      ],
                    },
                  },
                },
              },
              { $sort: { "_id.currency": 1, "_id.type": 1 } },
              { $limit: ASSISTANT_CONTEXT_LIMIT.CREDIT_TRANSACTION_GROUPS },
            ],
          },
        },
      ])) as any[];
      const balances = Array.isArray(summary?.balances) ? summary.balances : [];
      const transactions = Array.isArray(summary?.transactionsLast30Days)
        ? summary.transactionsLast30Days
        : [];
      result.credits = {
        scope: "tenant_wide",
        amountBasis:
          "integer_minor_units_when_present_otherwise_iso_currency_exponent_conversion",
        balancesByCurrency: boundedList(
          balances.map((entry: any) => ({
            currency: compactText(entry._id, 3).toUpperCase(),
            accounts: Number(entry.accounts || 0),
            accountsWithBalance: Number(entry.accountsWithBalance || 0),
            outstandingBalanceMinor: Number(entry.outstandingBalanceMinor || 0),
          })),
          balances.length,
        ),
        transactionsLast30Days: boundedList(
          transactions.map((entry: any) => ({
            currency: compactText(entry._id?.currency, 3).toUpperCase(),
            type: compactText(entry._id?.type, 60),
            count: Number(entry.count || 0),
            amountMinor: Number(entry.amountMinor || 0),
          })),
          transactions.length,
        ),
        period: {
          from: thirtyDaysAgo.toISOString(),
          to: now.toISOString(),
          days: 30,
        },
      };
    },
  });

  scheduleSource({
    source: "vouchers",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.VOUCHERS),
    permitted: has(WORKSPACE_PERMISSION.VOUCHERS_VIEW),
    run: async () => {
      const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
      const thirtyDaysFromNow = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1_000,
      );
      const [[issued], [orders]] = (await Promise.all([
        Coupon.aggregate([
          { $match: { tenant: tenantObjectId } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$isActive", true] },
                        { $eq: ["$redeemedAt", null] },
                        {
                          $or: [
                            { $eq: ["$expiresAt", null] },
                            { $gt: ["$expiresAt", now] },
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              available: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$isActive", true] },
                        { $eq: ["$redeemedAt", null] },
                        {
                          $or: [
                            { $eq: ["$expiresAt", null] },
                            { $gt: ["$expiresAt", now] },
                          ],
                        },
                        {
                          $or: [
                            { $eq: ["$reservedUntil", null] },
                            { $lte: ["$reservedUntil", now] },
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              redeemed: {
                $sum: { $cond: [{ $ne: ["$redeemedAt", null] }, 1, 0] },
              },
              redeemedLast30Days: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: ["$redeemedAt", thirtyDaysAgo] },
                        { $lte: ["$redeemedAt", now] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              reserved: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$redeemedAt", null] },
                        { $gt: ["$reservedUntil", now] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              expired: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$redeemedAt", null] },
                        { $ne: ["$expiresAt", null] },
                        { $lte: ["$expiresAt", now] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              expiringWithin30Days: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$isActive", true] },
                        { $eq: ["$redeemedAt", null] },
                        { $gt: ["$expiresAt", now] },
                        { $lte: ["$expiresAt", thirtyDaysFromNow] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ]),
        CouponOrder.aggregate([
          {
            $match: {
              tenant: tenantObjectId,
              status: { $in: ["processed_coupon", "shipped_coupon"] },
              processedAt: { $gte: thirtyDaysAgo, $lte: now },
            },
          },
          {
            $facet: {
              total: [{ $count: "count" }],
              byStatus: [
                { $group: { _id: "$status", count: { $sum: 1 } } },
                { $sort: { _id: 1 } },
                { $limit: ASSISTANT_CONTEXT_LIMIT.VOUCHER_STATUS_GROUPS },
              ],
              valueByCurrency: [
                {
                  $group: {
                    _id: { $toUpper: "$currencySnapshot" },
                    orders: { $sum: 1 },
                    quantity: { $sum: "$quantity" },
                    processedValueMinor: {
                      $sum: { $ifNull: ["$expectedAmountMinor", 0] },
                    },
                  },
                },
                { $sort: { _id: 1 } },
                { $limit: ASSISTANT_CONTEXT_LIMIT.CREDIT_CURRENCIES },
              ],
            },
          },
        ]),
      ])) as [any[], any[]];
      const byStatus = Array.isArray(orders?.byStatus) ? orders.byStatus : [];
      const valueByCurrency = Array.isArray(orders?.valueByCurrency)
        ? orders.valueByCurrency
        : [];
      result.vouchers = {
        scope: "tenant_wide",
        issued: {
          total: Number(issued?.total || 0),
          active: Number(issued?.active || 0),
          available: Number(issued?.available || 0),
          redeemed: Number(issued?.redeemed || 0),
          redeemedLast30Days: Number(issued?.redeemedLast30Days || 0),
          reserved: Number(issued?.reserved || 0),
          expired: Number(issued?.expired || 0),
          expiringWithin30Days: Number(issued?.expiringWithin30Days || 0),
        },
        ordersLast30Days: {
          amountBasis: "authoritative_expected_amount_minor",
          period: {
            from: thirtyDaysAgo.toISOString(),
            to: now.toISOString(),
            days: 30,
          },
          total: Number(orders?.total?.[0]?.count || 0),
          byStatus: boundedList(
            byStatus.map((entry: any) => ({
              status: compactText(entry._id, 60),
              count: Number(entry.count || 0),
            })),
            byStatus.length,
          ),
          valueByCurrency: boundedList(
            valueByCurrency.map((entry: any) => ({
              currency: compactText(entry._id, 3).toUpperCase(),
              orders: Number(entry.orders || 0),
              quantity: Number(entry.quantity || 0),
              processedValueMinor: Number(entry.processedValueMinor || 0),
            })),
            valueByCurrency.length,
          ),
        },
      };
    },
  });

  scheduleSource({
    source: "communications.deliveryHealth",
    moduleEnabled: moduleIsEnabled(modules, TENANT_MODULE.COMMUNICATIONS),
    permitted: has(WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const tenantObjectId = new mongoose.Types.ObjectId(tenantId);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
      const staleSendingStartedBefore = new Date(
        now.getTime() - communicationEmailClaimLeaseMs(),
      );
      const visibility = visibleAllLocationDocumentFilter(locationScope);
      const automationsEnabled = moduleIsEnabled(
        modules,
        TENANT_MODULE.AUTOMATIONS,
      );
      const staleSendingMatch = {
        status: "sending",
        $or: [
          { processingLeaseExpiresAt: { $ne: null, $lte: now } },
          {
            processingLeaseExpiresAt: null,
            processingStartedAt: {
              $ne: null,
              $lte: staleSendingStartedBefore,
            },
          },
        ],
      };
      const deliveryProblemMatch = {
        $or: [
          {
            manualReviewRequiredAt: { $ne: null },
            status: { $nin: ["sent", "canceled", "suppressed"] },
          },
          staleSendingMatch,
          {
            status: { $in: ["pending", "scheduled"] },
            scheduledFor: { $ne: null, $lte: now },
          },
          {
            status: "failed",
            failedAt: { $gte: twentyFourHoursAgo, $lte: now },
          },
          {
            nextQueueRecoveryAt: { $ne: null, $lte: now },
            status: { $nin: ["sent", "canceled", "suppressed"] },
          },
        ],
      };
      let automationUnavailable = false;
      const automationPromise = automationsEnabled
        ? CommunicationAutomation.aggregate([
            { $match: { tenant: tenantObjectId, ...visibility } },
            {
              $facet: {
                total: [{ $count: "count" }],
                active: [{ $match: { isActive: true } }, { $count: "count" }],
                byStatus: [
                  {
                    $group: { _id: "$automationStatus", count: { $sum: 1 } },
                  },
                  { $sort: { _id: 1 } },
                  { $limit: ASSISTANT_CONTEXT_LIMIT.AUTOMATION_STATUS_GROUPS },
                ],
                byScheduleType: [
                  { $group: { _id: "$scheduleType", count: { $sum: 1 } } },
                  { $sort: { _id: 1 } },
                  {
                    $limit: ASSISTANT_CONTEXT_LIMIT.AUTOMATION_SCHEDULE_GROUPS,
                  },
                ],
                recent: [
                  { $sort: { updatedAt: -1, _id: 1 } },
                  { $limit: ASSISTANT_CONTEXT_LIMIT.AUTOMATIONS },
                  {
                    $project: {
                      _id: 0,
                      name: 1,
                      scheduleType: 1,
                      purpose: 1,
                      connectedProductType: 1,
                      automationStatus: 1,
                      isActive: 1,
                      appliesToAllLocations: 1,
                      location: 1,
                      lastRunAt: 1,
                      nextRunAt: 1,
                      failedAt: 1,
                      updatedAt: 1,
                    },
                  },
                ],
              },
            },
          ]).catch(() => {
            automationUnavailable = true;
            return [];
          })
        : Promise.resolve([]);
      const [[automationSummary], [deliverySummary], [deliveryBacklog]] =
        (await Promise.all([
          automationPromise,
          CommunicationEmailLogModel.aggregate([
            {
              $match: {
                tenant: tenantObjectId,
                createdAt: { $gte: thirtyDaysAgo, $lte: now },
                ...visibility,
              },
            },
            {
              $facet: {
                total: [{ $count: "count" }],
                byStatus: [
                  { $group: { _id: "$status", count: { $sum: 1 } } },
                  { $sort: { _id: 1 } },
                  { $limit: ASSISTANT_CONTEXT_LIMIT.DELIVERY_STATUS_GROUPS },
                ],
                byType: [
                  { $group: { _id: "$emailType", count: { $sum: 1 } } },
                  { $sort: { _id: 1 } },
                  { $limit: ASSISTANT_CONTEXT_LIMIT.DELIVERY_TYPE_GROUPS },
                ],
              },
            },
          ]),
          CommunicationEmailLogModel.aggregate([
            {
              $match: {
                tenant: tenantObjectId,
                $and: [visibility, deliveryProblemMatch],
              },
            },
            {
              $facet: {
                manualReviewRequired: [
                  {
                    $match: {
                      manualReviewRequiredAt: { $ne: null },
                      status: { $nin: ["sent", "canceled", "suppressed"] },
                    },
                  },
                  { $count: "count" },
                ],
                staleSending: [
                  { $match: staleSendingMatch },
                  { $count: "count" },
                ],
                dueScheduled: [
                  {
                    $match: {
                      status: { $in: ["pending", "scheduled"] },
                      scheduledFor: { $ne: null, $lte: now },
                    },
                  },
                  { $count: "count" },
                ],
                failedLast24Hours: [
                  {
                    $match: {
                      status: "failed",
                      failedAt: { $gte: twentyFourHoursAgo, $lte: now },
                    },
                  },
                  { $count: "count" },
                ],
                recoveryDue: [
                  {
                    $match: {
                      nextQueueRecoveryAt: { $ne: null, $lte: now },
                      status: { $nin: ["sent", "canceled", "suppressed"] },
                    },
                  },
                  { $count: "count" },
                ],
                problems: [
                  { $match: deliveryProblemMatch },
                  { $sort: { updatedAt: -1, _id: 1 } },
                  { $limit: 10 },
                  {
                    $project: {
                      _id: 0,
                      status: 1,
                      emailType: 1,
                      appliesToAllLocations: 1,
                      location: 1,
                      scheduledFor: 1,
                      failedAt: 1,
                      manualReviewRequiredAt: 1,
                      processingStartedAt: 1,
                      processingLeaseExpiresAt: 1,
                      nextQueueRecoveryAt: 1,
                      attempts: 1,
                      updatedAt: 1,
                    },
                  },
                ],
                problemCount: [
                  { $match: deliveryProblemMatch },
                  { $count: "count" },
                ],
              },
            },
          ]),
        ])) as [any[], any[], any[]];
      const automationByStatus = Array.isArray(automationSummary?.byStatus)
        ? automationSummary.byStatus
        : [];
      const automationBySchedule = Array.isArray(
        automationSummary?.byScheduleType,
      )
        ? automationSummary.byScheduleType
        : [];
      const recentAutomations = Array.isArray(automationSummary?.recent)
        ? automationSummary.recent
        : [];
      const deliveryByStatus = Array.isArray(deliverySummary?.byStatus)
        ? deliverySummary.byStatus
        : [];
      const deliveryByType = Array.isArray(deliverySummary?.byType)
        ? deliverySummary.byType
        : [];
      if (!automationsEnabled) {
        omitted.push({
          source: "communications.automations",
          reason: "module_disabled",
        });
      } else if (automationUnavailable) {
        unavailable.push({
          source: "communications.automations",
          reason: "source_temporarily_unavailable",
        });
      } else {
        available.push("communications.automations");
      }
      result.communications = {
        automations:
          automationsEnabled && !automationUnavailable
            ? {
                total: Number(automationSummary?.total?.[0]?.count || 0),
                active: Number(automationSummary?.active?.[0]?.count || 0),
                byStatus: boundedList(
                  automationByStatus.map((entry: any) => ({
                    status: compactText(entry._id, 60),
                    count: Number(entry.count || 0),
                  })),
                  automationByStatus.length,
                ),
                byScheduleType: boundedList(
                  automationBySchedule.map((entry: any) => ({
                    scheduleType: compactText(entry._id, 60),
                    count: Number(entry.count || 0),
                  })),
                  automationBySchedule.length,
                ),
                recent: boundedList(
                  recentAutomations.map((row: any) => ({
                    name: compactText(row.name, 160),
                    scheduleType: compactText(row.scheduleType, 60),
                    purpose: compactText(row.purpose, 40) || null,
                    connectedProductType:
                      compactText(row.connectedProductType, 60) || null,
                    status: compactText(row.automationStatus, 60),
                    isActive: row.isActive === true,
                    locationScope: row.appliesToAllLocations
                      ? "all"
                      : compactText(row.location, 100) || null,
                    lastRunAt: row.lastRunAt || null,
                    nextRunAt: row.nextRunAt || null,
                    failedAt: row.failedAt || null,
                    updatedAt: row.updatedAt || null,
                  })),
                  Number(automationSummary?.total?.[0]?.count || 0),
                ),
              }
            : null,
        deliveryLast30Days: {
          period: {
            from: thirtyDaysAgo.toISOString(),
            to: now.toISOString(),
            days: 30,
          },
          total: Number(deliverySummary?.total?.[0]?.count || 0),
          byStatus: boundedList(
            deliveryByStatus.map((entry: any) => ({
              status: compactText(entry._id, 60),
              count: Number(entry.count || 0),
            })),
            deliveryByStatus.length,
          ),
          byType: boundedList(
            deliveryByType.map((entry: any) => ({
              type: compactText(entry._id, 60),
              count: Number(entry.count || 0),
            })),
            deliveryByType.length,
          ),
        },
        deliveryBacklog: {
          asOf: now.toISOString(),
          manualReviewRequired: Number(
            deliveryBacklog?.manualReviewRequired?.[0]?.count || 0,
          ),
          staleSending: Number(deliveryBacklog?.staleSending?.[0]?.count || 0),
          dueScheduled: Number(deliveryBacklog?.dueScheduled?.[0]?.count || 0),
          failedLast24Hours: Number(
            deliveryBacklog?.failedLast24Hours?.[0]?.count || 0,
          ),
          recoveryDue: Number(deliveryBacklog?.recoveryDue?.[0]?.count || 0),
          problems: boundedList(
            (deliveryBacklog?.problems || []).map((row: any) => ({
              status: compactText(row.status, 60),
              type: compactText(row.emailType, 60),
              locationScope: row.appliesToAllLocations
                ? "all"
                : compactText(row.location, 100) || null,
              scheduledFor: row.scheduledFor || null,
              failedAt: row.failedAt || null,
              manualReviewRequiredAt: row.manualReviewRequiredAt || null,
              processingStartedAt: row.processingStartedAt || null,
              processingLeaseExpiresAt: row.processingLeaseExpiresAt || null,
              nextQueueRecoveryAt: row.nextQueueRecoveryAt || null,
              attempts: Number(row.attempts || 0),
              updatedAt: row.updatedAt || null,
            })),
            Number(
              deliveryBacklog?.problemCount?.[0]?.count ||
                (deliveryBacklog?.problems || []).length,
            ),
          ),
        },
      };
    },
  });

  scheduleSource({
    source: "reports.currentPeriod",
    permitted: has(WORKSPACE_PERMISSION.REPORTS_VIEW),
    requiresLocationScope: true,
    run: async () => {
      const report = await buildReportOverview({
        context: { tenantId, userId, access },
        query: {
          compare: true,
          granularity: "auto",
          ...(locationScope.requestedLocationId &&
          locationScope.requestedLocationAccessible
            ? { locationId: locationScope.requestedLocationId }
            : {}),
        },
        now,
      });
      const serializeKpi = (kpi: any) => ({
        value: finiteNumberOrNull(kpi?.value),
        previous: finiteNumberOrNull(kpi?.previous),
        changePercent: finiteNumberOrNull(kpi?.changePercent),
      });
      result.reports = {
        currentPeriod: {
          from: compactText(report.metadata?.period?.from, 10) || null,
          to: compactText(report.metadata?.period?.to, 10) || null,
          timezone: normalizeTimezone(report.metadata?.timezone),
          currency:
            compactText(report.metadata?.currency, 3).toUpperCase() || null,
          locationId: compactText(report.metadata?.locationId, 100) || null,
          generatedAt: report.metadata?.generatedAt || now.toISOString(),
        },
        comparisonPeriod: report.metadata?.comparisonPeriod
          ? {
              from:
                compactText(report.metadata.comparisonPeriod.from, 10) || null,
              to: compactText(report.metadata.comparisonPeriod.to, 10) || null,
            }
          : null,
        kpis: {
          netSalesMinor: serializeKpi(report.summary?.netSales),
          bookings: serializeKpi(report.summary?.bookings),
          participants: serializeKpi(report.summary?.participants),
          utilizationPercent: serializeKpi(report.summary?.utilizationPercent),
          returningCustomerPercent: serializeKpi(
            report.summary?.returningCustomerPercent,
          ),
        },
        coverage: {
          available: boundedTextItems(report.coverage?.available, 20, 80),
          unavailable: boundedList(
            (report.coverage?.unavailable || [])
              .slice(0, 20)
              .map((entry: any) => ({
                source: compactText(entry.source, 80),
                reason: compactText(entry.reason, 80),
              })),
            (report.coverage?.unavailable || []).length,
          ),
          limitations: boundedTextItems(report.coverage?.limitations, 12, 300),
          complete: report.coverage?.complete === true,
        },
      };
    },
  });

  scheduleSource({
    source: "publicSite",
    permitted: has(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
    run: async () => {
      const [preview, editorState] = await Promise.all([
        getTenantPublicSitePreview(tenantId),
        getTenantPublicSiteEditorState(tenantId),
      ]);
      result.publicSite = {
        publicationStatus:
          compactText(preview.preview?.publicationStatus, 60) || null,
        publiclyAvailable: preview.preview?.publiclyAvailable === true,
        hasExplicitPublicationState:
          preview.preview?.hasExplicitPublicationState === true,
        draftRevision: Number(editorState.editor?.draftRevision || 0),
        publishedRevision: Number(editorState.editor?.publishedRevision || 0),
        hasUnpublishedChanges:
          editorState.editor?.hasUnpublishedChanges === true,
        draftUpdatedAt: editorState.editor?.draftUpdatedAt || null,
        publishedAt: editorState.editor?.publishedAt || null,
      };
    },
  });

  const moduleScopedAccess = scopeOperationalAccessToEnabledModules(
    access,
    modules,
  );
  const operationalAccess: ResolvedWorkspaceAccess = {
    ...moduleScopedAccess,
    ...(locationScope.requestedLocationAccessible
      ? {}
      : {
          locationAccess: {
            mode: "selected" as const,
            locationIds: [],
          },
        }),
  };
  const operationsPromise =
    profile === STUDIO_CONTEXT_PROFILE.CORE
      ? Promise.resolve().then(() => {
          omitted.push({ source: "operations", reason: "profile_excluded" });
        })
      : (async () => {
          try {
            result.operations = await buildWorkspaceOperationalContext({
              tenantId,
              userId,
              access: operationalAccess,
              locationId: locationScope.requestedLocationAccessible
                ? locationScope.requestedLocationId
                : null,
              timezone: tenantTimezone,
              now,
              includeStaffPlanning: true,
              includeStaffPlanningDetail: true,
            });
            available.push("operations");
          } catch {
            result.operations = {
              generatedAt: now.toISOString(),
              locationId: locationScope.requestedLocationAccessible
                ? locationScope.requestedLocationId
                : null,
              timezone: tenantTimezone,
              dateKey: localDay.dateKey,
              coverage: {
                available: [],
                unavailable: [
                  {
                    source: "operations",
                    reason: "source_temporarily_unavailable",
                  },
                ],
                complete: false,
              },
            };
            unavailable.push({
              source: "operations",
              reason: "source_temporarily_unavailable",
            });
          }
        })();

  await Promise.all([...sourceTasks, operationsPromise]);
  if (
    result.operations?.coverage?.complete === false &&
    Array.isArray(result.operations.coverage.unavailable)
  ) {
    for (const entry of result.operations.coverage.unavailable) {
      const nestedSource = compactText(entry?.source, 120) || "unknown";
      const nestedReason =
        compactText(entry?.reason, 120) || "source_temporarily_unavailable";
      unavailable.push({
        source: `operations.${nestedSource}`,
        reason: nestedReason,
      });
    }
  }
  result.coverage = {
    available: [...new Set(available)].sort(),
    omitted: omitted.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.reason.localeCompare(right.reason),
    ),
    unavailable: unavailable.sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.reason.localeCompare(right.reason),
    ),
    complete: unavailable.length === 0,
  };

  return enforceWorkspaceAssistantContextBudget(
    result,
  ) as StudioContextSnapshot;
};

export const aiDataService = {
  workspaceContext: buildWorkspaceOperationalContext,
  workspaceAssistantContext: buildWorkspaceAssistantContext,
};
