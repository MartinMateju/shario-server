import mongoose from "mongoose";
import User from "@/modules/user/user.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import Booking from "@/modules/booking/booking.model.js";
import Order from "@/modules/order/order.model.js";
import { BookingCancellationEvent } from "@/modules/booking/booking-cancellation-event.model.js";
import {
  OPEN_STUDIO_BOOKING_TAGS,
  CLASS_BOOKING_TAGS,
} from "@/modules/booking/booking.constants.js";
import {
  customerDirectoryScope,
  directoryDerivedStages,
  directoryFilterStages,
} from "@/modules/user/user.directory-query.js";
import {
  directoryAmountBounds,
  directoryCreditStages,
  directoryCreditFilter,
} from "@/modules/user/user.directory-financial.js";
import { withCustomerDirectoryMetrics } from "@/modules/user/services/user.directory-metrics.service.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION as P } from "@/modules/tenant-access/tenant-access.permissions.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import {
  isStudioCommerceCurrency,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { resolveReportPeriod } from "./reports.date.js";
import { resolveReportLocationScope } from "./reports.scope.js";
import { getReportPlanEntitlement } from "./report-plan-entitlements.js";
import {
  iterateReportCashReceipts,
  allocateReportReceiptCash,
  resolveReportCashSources,
} from "./reports.cash.js";
import {
  parseReportCustomerQuery,
  type ReportCustomerQuery,
} from "./reports.customer-query.js";
import type { ReportContext } from "./reports.types.js";

const objectId = (value: string) => new mongoose.Types.ObjectId(value);
const hasBounds = (minimum?: number, maximum?: number) =>
  minimum !== undefined || maximum !== undefined;
const matches = (value: number | null, minimum?: number, maximum?: number) =>
  !hasBounds(minimum, maximum) ||
  (value !== null &&
    (minimum === undefined || value >= minimum) &&
    (maximum === undefined || value <= maximum));
const validDate = (value: unknown): Date | null =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value : null;
const BATCH_SIZE = 100;

export const prepareReportCustomers = async ({
  context,
  input,
  now = new Date(),
}: {
  context: ReportContext;
  input: unknown;
  now?: Date;
}) => {
  const query = parseReportCustomerQuery(input);
  if (
    context.access.tenantId !== context.tenantId ||
    context.access.status !== "active" ||
    !hasWorkspacePermission(context.access, P.REPORTS_VIEW) ||
    !hasWorkspacePermission(context.access, P.CUSTOMERS_VIEW)
  )
    forbidden("Customer reports access is required.");
  const tenant = await Tenant.findById(context.tenantId)
    .select("settings modules plan planVersion")
    .lean();
  if (!tenant) notFound("Workspace not found.");
  if (tenant.modules?.customers !== true)
    forbidden("Customer reports are unavailable.");
  const timezone = String(tenant.settings?.timezone || "UTC");
  const candidateCurrency = String(
    tenant.settings?.currency || "",
  ).toUpperCase();
  const currency = isStudioCommerceCurrency(candidateCurrency)
    ? (candidateCurrency as StudioCommerceCurrency)
    : null;
  const defaultPeriod = resolveReportPeriod({
    query: {
      from: query.from,
      to: query.to,
      compare: false,
      granularity: "auto",
    },
    timezone,
    now,
  }).current;
  const period = (from: string | undefined, to: string | undefined) =>
    resolveReportPeriod({
      query: {
        from: from ?? defaultPeriod.from,
        to: to ?? defaultPeriod.to,
        compare: false,
        granularity: "auto",
      },
      timezone,
      now,
    }).current;
  const spendPeriod = period(query.spendFrom, query.spendTo);
  const cancellationPeriod = period(
    query.cancellationFrom,
    query.cancellationTo,
  );
  const scope = await resolveReportLocationScope({
    context,
    locationId: query.locationId,
  });
  const entitlement = getReportPlanEntitlement({
    plan: tenant.plan as any,
    planVersion: Number(tenant.planVersion ?? 1),
  });
  if (scope.locationIds.length > 1 && !entitlement.consolidatedLocations)
    forbidden("Cross-location reporting is unavailable.");
  // Limited course-only reports cannot truthfully expose all-customer financial
  // segmentation. Keep the existing entitlement boundary rather than broaden it.
  if (entitlement.courseOnly || entitlement.tier === "none")
    forbidden("Customer segmentation requires full reporting.");
  const sources = resolveReportCashSources({ context, scope, tenant });
  if (tenant.modules?.payments !== true)
    sources.orders = sources.vouchers = sources.memberships = false;
  const spendingAvailable = Boolean(
    currency && sources.orders && sources.complete,
  );
  const creditsAvailable = Boolean(
    currency &&
    tenant.modules?.credits === true &&
    scope.allowedLocationIds === null &&
    hasWorkspacePermission(context.access, P.CREDITS_VIEW),
  );
  const cancellationsAvailable =
    tenant.modules?.bookings === true &&
    hasWorkspacePermission(context.access, P.BOOKINGS_VIEW);
  const activityAvailable = cancellationsAvailable;
  const bounds = directoryAmountBounds(
    { ...query, status: "", membership: "", timeZone: timezone },
    currency,
  );
  if (hasBounds(query.spendMin, query.spendMax) && !spendingAvailable)
    forbidden("Spending filters are unavailable.");
  if (hasBounds(query.creditMin, query.creditMax) && !creditsAvailable)
    forbidden("Credit filters are unavailable.");
  if (
    (hasBounds(query.cancelledMin, query.cancelledMax) ||
      query.cancellationActor !== "all") &&
    !cancellationsAvailable
  )
    forbidden("Cancellation filters are unavailable.");
  if (query.inactiveDays && !activityAvailable)
    forbidden("Activity filters are unavailable.");
  return {
    context,
    query,
    now,
    timezone,
    currency,
    spendPeriod,
    cancellationPeriod,
    scope,
    sources,
    bounds,
    spendingAvailable,
    creditsAvailable,
    cancellationsAvailable,
    activityAvailable,
    metadata: {
      currency,
      timeZone: timezone,
      asOf: now.toISOString(),
      spendPeriod: { from: spendPeriod.from, to: spendPeriod.to },
      cancellationPeriod: {
        from: cancellationPeriod.from,
        to: cancellationPeriod.to,
      },
      spendingAvailable,
      creditsAvailable,
      cancellationsAvailable,
      activityAvailable,
      locationId: scope.requestedLocationId,
      spendingScope:
        scope.unrestricted && !scope.requestedLocationId
          ? "workspace"
          : "location",
      spendingSources: {
        orders: sources.orders,
        vouchers: sources.vouchers,
        memberships: sources.memberships,
      },
      spendingDefinition:
        "Cash paid in the payment-date period, less successful external refunds recorded as of calculation time.",
      creditDefinition:
        "Current workspace wallet balance, independent of the selected date periods.",
      activityDefinition:
        "Days since the last started confirmed visit in the selected studio scope; account creation is used when no visit is recorded.",
      cancellationCoverage: {
        complete: false,
        since: null,
        limitation:
          "Only recorded cancellation operations are dated. Missing legacy history is unknown: recorded counts can prove a minimum, but maximum filters require complete history. Course cancellation snapshots use their recorded operation date.",
      },
      limitations: sources.limitations,
    },
  };
};
export type PreparedReportCustomers = Awaited<
  ReturnType<typeof prepareReportCustomers>
>;
export type ReportCustomerRow = {
  id: string;
  name: string;
  email: string;
  memberNumber: number | string | null;
  isGuest: boolean;
  paidSpendMinor: number | null;
  currentCreditMinor: number | null;
  cancelledBookings: number | null;
  recordedCancelledBookings: number | null;
  cancellationHistoryComplete: boolean;
  lastActivityAt: string | null;
  inactiveDays: number | null;
};

const cancellationCounts = async (
  prepared: PreparedReportCustomers,
  ids: string[],
) => {
  const { context, scope, cancellationPeriod, query, now } = prepared;
  const tenant = objectId(context.tenantId),
    customers = ids.map(objectId);
  const locations = scope.locationIds.map(objectId);
  const period = {
    $gte: cancellationPeriod.start,
    $lt: cancellationPeriod.endExclusive,
    $lte: now,
  };
  const unrecordedCourseOperationStages: any[] = [
    {
      $set: {
        _cancellationEventId: {
          $concat: [
            String(tenant),
            ":course:",
            { $toString: "$_id" },
            ":",
            {
              $convert: {
                input: "$courseCancellations.bookingId",
                to: "string",
                onError: "",
                onNull: "",
              },
            },
            ":",
            { $toString: "$_cancellationIndex" },
          ],
        },
      },
    },
    {
      $lookup: {
        from: BookingCancellationEvent.collection.name,
        localField: "_cancellationEventId",
        foreignField: "_id",
        pipeline: [{ $match: { tenant } }, { $project: { _id: 1 } }],
        as: "_operationEvent",
      },
    },
    { $match: { "_operationEvent.0": { $exists: false } } },
  ];
  const pipeline: any[] = [
    {
      $match: {
        tenant,
        customer: { $in: customers },
        location: { $in: locations },
        occurredAt: period,
        ...(query.cancellationActor === "all"
          ? {}
          : { actorType: query.cancellationActor }),
      },
    },
    { $project: { customer: 1, booking: 1 } },
  ];
  if (query.cancellationActor !== "customer")
    pipeline.push({
      $unionWith: {
        coll: Order.collection.name,
        pipeline: [
          {
            $match: {
              tenant,
              createdBy: { $in: customers },
              "courseCancellations.0": { $exists: true },
            },
          },
          {
            $unwind: {
              path: "$courseCancellations",
              includeArrayIndex: "_cancellationIndex",
            },
          },
          {
            $match: {
              "courseCancellations.refundedAt": period,
              "courseCancellations.actor": { $type: "objectId" },
            },
          },
          // The writer's order/session/ordinal identity selects the operation,
          // regardless of the requested period, actor or current studio. A
          // newer event must not hide older, unmatched partial cancellations.
          ...unrecordedCourseOperationStages,
          {
            $lookup: {
              from: Booking.collection.name,
              localField: "courseCancellations.bookingId",
              foreignField: "_id",
              pipeline: [
                {
                  $match: {
                    tenant,
                    location: { $in: locations },
                    tag: { $in: [...CLASS_BOOKING_TAGS] },
                  },
                },
                { $project: { _id: 1 } },
              ],
              as: "_booking",
            },
          },
          { $match: { "_booking.0": { $exists: true } } },
          {
            $project: {
              customer: "$createdBy",
              booking: "$courseCancellations.bookingId",
            },
          },
        ],
      },
    });
  // Count reservations rather than seats/events: retries and repeated partial
  // operations for one customer's booking never inflate the period count.
  pipeline.push(
    { $group: { _id: { customer: "$customer", booking: "$booking" } } },
    { $group: { _id: "$_id.customer", count: { $sum: 1 } } },
  );
  const counts = await BookingCancellationEvent.aggregate(pipeline).option({
    maxTimeMS: 60_000,
  });
  const counted = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const row of counts) counted.set(String(row._id), row.count);
  // An event outside the chosen period still proves the historical date is
  // known. No updatedAt/start-date heuristic is used for an absent event.
  const unknownRows = await Booking.aggregate([
    {
      $match: {
        tenant,
        createdBy: { $in: customers },
        location: { $in: locations },
        status: "cancelled",
        tag: { $in: [...OPEN_STUDIO_BOOKING_TAGS] },
      },
    },
    {
      $lookup: {
        from: BookingCancellationEvent.collection.name,
        let: { booking: "$_id", customer: "$createdBy" },
        pipeline: [
          {
            $match: {
              tenant,
              $expr: {
                $and: [
                  { $eq: ["$booking", "$$booking"] },
                  { $eq: ["$customer", "$$customer"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "_event",
      },
    },
    { $match: { "_event.0": { $exists: false } } },
    { $group: { _id: "$createdBy" } },
  ]).option({ maxTimeMS: 60_000 });
  const malformedCourseHistory = await Order.aggregate([
    {
      $match: {
        tenant,
        createdBy: { $in: customers },
        "courseCancellations.0": { $exists: true },
      },
    },
    {
      $unwind: {
        path: "$courseCancellations",
        includeArrayIndex: "_cancellationIndex",
      },
    },
    {
      $match: {
        $or: [
          { "courseCancellations.refundedAt": { $not: { $type: "date" } } },
          { "courseCancellations.actor": { $not: { $type: "objectId" } } },
        ],
      },
    },
    ...unrecordedCourseOperationStages,
    {
      $lookup: {
        from: Booking.collection.name,
        localField: "courseCancellations.bookingId",
        foreignField: "_id",
        pipeline: [
          {
            $match: {
              tenant,
              location: { $in: locations },
              tag: { $in: [...CLASS_BOOKING_TAGS] },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: "_booking",
      },
    },
    { $match: { "_booking.0": { $exists: true } } },
    { $group: { _id: "$createdBy" } },
  ]).option({ maxTimeMS: 60_000 });
  return {
    counted,
    unknown: new Set<string>(
      [...unknownRows, ...malformedCourseHistory].map((row) => String(row._id)),
    ),
  };
};

const customerMatchingStages = (prepared: PreparedReportCustomers): any[] => {
  const { context, query, now, currency, bounds } = prepared;
  return [
    {
      $match: {
        ...customerDirectoryScope(context.tenantId),
        $or: [{ createdAt: { $lte: now } }, { createdAt: null }],
      },
    },
    ...(query.search
      ? [
          ...directoryDerivedStages(),
          ...directoryFilterStages({
            search: query.search,
            status: "",
            membership: "",
            timeZone: prepared.timezone,
          }),
        ]
      : []),
    ...(hasBounds(query.creditMin, query.creditMax)
      ? [...directoryCreditStages(currency), ...directoryCreditFilter(bounds)]
      : []),
  ];
};
const customerProjectionStages = (prepared: PreparedReportCustomers): any[] => [
  ...directoryDerivedStages(),
  ...directoryCreditStages(prepared.currency),
  {
    $project: {
      _id: 1,
      firstname: 1,
      lastname: 1,
      name: 1,
      memberNumber: 1,
      customId: 1,
      isAccessGranted: 1,
      email: "$_directoryEmail",
      creditMinor: "$_directoryCreditMinor",
      createdAt: 1,
    },
  },
];
const hydrateReportCustomerBatch = async (
  prepared: PreparedReportCustomers,
  batch: any[],
) => {
  const { context, now, currency, scope } = prepared;
  const ids = batch.map((row) => String(row._id));
  const money = new Map<string, number | null>(
    ids.map((id) => [id, prepared.spendingAvailable ? 0 : null]),
  );
  if (prepared.spendingAvailable)
    for await (const receipt of iterateReportCashReceipts({
      context,
      scope,
      period: prepared.spendPeriod,
      now,
      customerIds: ids,
      sources: prepared.sources,
    })) {
      if (!receipt.customerId || !money.has(receipt.customerId)) continue;
      const amount = allocateReportReceiptCash(receipt, scope).cashMinor;
      const previous = money.get(receipt.customerId)!;
      const sum =
        amount === null || previous === null ? null : amount + previous;
      money.set(
        receipt.customerId,
        receipt.currency !== currency ||
          sum === null ||
          !Number.isSafeInteger(sum)
          ? null
          : sum,
      );
    }
  const cancellations = prepared.cancellationsAvailable
    ? await cancellationCounts(prepared, ids)
    : null;
  const activity = prepared.activityAvailable
    ? await withCustomerDirectoryMetrics({
        tenantId: context.tenantId,
        users: batch.map((row) => ({ _id: row._id })),
        now,
        includeSpending: false,
        access: {
          ...context.access,
          locationAccess: { mode: "selected", locationIds: scope.locationIds },
        },
      })
    : [];
  return batch.map((row, index): ReportCustomerRow => {
    const id = String(row._id);
    const lastActivityAt = activity[index]?.lastBookingAt ?? null;
    const base = lastActivityAt
      ? new Date(lastActivityAt)
      : validDate(row.createdAt);
    const inactiveDays =
      prepared.activityAvailable && base
        ? Math.max(0, Math.floor((now.valueOf() - base.valueOf()) / 86_400_000))
        : null;
    const cancellationHistoryComplete = Boolean(
      cancellations && !cancellations.unknown.has(id),
    );
    return {
      id,
      name:
        [row.firstname, row.lastname].filter(Boolean).join(" ") ||
        String(row.name || ""),
      email: String(row.email || ""),
      memberNumber: row.memberNumber ?? null,
      isGuest:
        row.isAccessGranted === false &&
        /^G-[a-f0-9]{20}$/i.test(String(row.customId || "")),
      paidSpendMinor: money.get(id)!,
      currentCreditMinor: prepared.creditsAvailable
        ? (row.creditMinor ?? null)
        : null,
      cancelledBookings: cancellationHistoryComplete
        ? cancellations!.counted.get(id)!
        : null,
      recordedCancelledBookings: cancellations
        ? cancellations.counted.get(id)!
        : null,
      cancellationHistoryComplete,
      lastActivityAt,
      inactiveDays,
    };
  });
};
export async function* iterateReportCustomerRows(
  prepared: PreparedReportCustomers,
): AsyncGenerator<ReportCustomerRow[]> {
  const cursor = User.aggregate([
    ...customerMatchingStages(prepared),
    { $sort: { createdAt: -1, _id: -1 } },
    ...customerProjectionStages(prepared),
  ])
    .option({ maxTimeMS: 60_000 })
    .cursor({ batchSize: BATCH_SIZE });
  try {
    let batch: any[] = [];
    for await (const row of cursor) {
      batch.push(row);
      if (batch.length === BATCH_SIZE) {
        yield await hydrateReportCustomerBatch(prepared, batch);
        batch = [];
      }
    }
    if (batch.length) yield await hydrateReportCustomerBatch(prepared, batch);
  } finally {
    await cursor.close();
  }
}
// The suggestion never needs financial history or cancellation joins. Only
// positive-wallet identities need the grouped visit-date query, in bounded batches.
const inactiveCreditSuggestion = async (
  prepared: PreparedReportCustomers,
): Promise<number | null> => {
  if (!prepared.creditsAvailable || !prepared.activityAvailable) return null;
  const base: any[] = [
    { $match: customerDirectoryScope(prepared.context.tenantId) },
    ...directoryCreditStages(prepared.currency),
  ];
  const unknown = await User.aggregate([
    ...base,
    { $match: { _directoryCreditMinor: null } },
    { $limit: 1 },
    { $project: { _id: 1 } },
  ]).option({ maxTimeMS: 60_000 });
  if (unknown.length) return null;
  const cursor = User.aggregate([
    ...base,
    { $match: { _directoryCreditMinor: { $gt: 0 } } },
    { $project: { _id: 1, createdAt: 1 } },
  ])
    .option({ maxTimeMS: 60_000 })
    .cursor({ batchSize: BATCH_SIZE });
  let count = 0,
    complete = true;
  const consume = async (batch: any[]) => {
    const rows = await withCustomerDirectoryMetrics({
      tenantId: prepared.context.tenantId,
      users: batch,
      now: prepared.now,
      includeSpending: false,
      access: {
        ...prepared.context.access,
        locationAccess: {
          mode: "selected",
          locationIds: prepared.scope.locationIds,
        },
      },
    });
    for (const row of rows) {
      const date = row.lastBookingAt
        ? new Date(row.lastBookingAt)
        : validDate(row.createdAt);
      if (!date) {
        complete = false;
        continue;
      }
      if (prepared.now.valueOf() - date.valueOf() >= 90 * 86_400_000)
        count += 1;
    }
  };
  try {
    let batch: any[] = [];
    for await (const row of cursor) {
      batch.push(row);
      if (batch.length === BATCH_SIZE) {
        await consume(batch);
        batch = [];
      }
    }
    if (batch.length) await consume(batch);
  } finally {
    await cursor.close();
  }
  return complete ? count : null;
};

export const matchesReportCustomer = (
  row: ReportCustomerRow,
  prepared: PreparedReportCustomers,
) => {
  const { query, bounds } = prepared;
  return (
    matches(row.paidSpendMinor, bounds.spendMin, bounds.spendMax) &&
    matches(row.currentCreditMinor, bounds.creditMin, bounds.creditMax) &&
    // A known lower bound proves a minimum, but cannot prove a maximum.
    matches(
      query.cancelledMax === undefined
        ? row.recordedCancelledBookings
        : row.cancelledBookings,
      query.cancelledMin,
      query.cancelledMax,
    ) &&
    (query.inactiveDays === undefined ||
      (row.inactiveDays !== null && row.inactiveDays >= query.inactiveDays))
  );
};
export const listReportCustomers = async (
  input: Parameters<typeof prepareReportCustomers>[0],
) => {
  const prepared = await prepareReportCustomers(input);
  const { query } = prepared;
  let data: ReportCustomerRow[] = [];
  let totalCount = 0;
  const start = (query.page - 1) * query.limit;
  const requiresMetricFilter =
    hasBounds(query.spendMin, query.spendMax) ||
    hasBounds(query.cancelledMin, query.cancelledMax) ||
    query.inactiveDays !== undefined;
  if (!requiresMetricFilter) {
    const base = customerMatchingStages(prepared);
    const [rows, count] = await Promise.all([
      User.aggregate([
        ...base,
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: start },
        { $limit: query.limit },
        ...customerProjectionStages(prepared),
      ]).option({ maxTimeMS: 60_000 }),
      User.aggregate([...base, { $count: "total" }]).option({
        maxTimeMS: 60_000,
      }),
    ]);
    totalCount = count[0]?.total ?? 0;
    if (rows.length) data = await hydrateReportCustomerBatch(prepared, rows);
  } else {
    for await (const rows of iterateReportCustomerRows(prepared))
      for (const row of rows) {
        if (!matchesReportCustomer(row, prepared)) continue;
        if (totalCount >= start && data.length < query.limit) data.push(row);
        totalCount += 1;
      }
  }
  const inactive90DaysWithCredits = await inactiveCreditSuggestion(prepared);
  return {
    data,
    totalCount,
    currentPage: query.page,
    pageSize: query.limit,
    totalPages: Math.ceil(totalCount / query.limit),
    metadata: prepared.metadata,
    suggested: { inactive90DaysWithCredits },
  };
};
