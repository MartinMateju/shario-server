import mongoose, { type PipelineStage } from "mongoose";
import User from "../user.model.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import {
  customerDirectoryExportInput,
  customerDirectoryQuery,
  customerDirectoryScope,
  customerDirectorySummaryQuery,
  directoryDerivedStages,
  directoryFilterStages,
  directoryProjection,
  directoryRow,
  type DirectoryFilters,
} from "../user.directory-query.js";
import {
  directoryMembershipStages,
  getDirectoryMembershipOptions,
  resolveDirectoryMembership,
  type DirectoryMembership,
} from "../user.directory-membership.js";
import { getCustomerMembershipSummary } from "./user.membership-summary.service.js";
import {
  canReadCustomerSpending,
  getCustomerDirectoryCurrency,
  withCustomerDirectoryMetrics,
} from "./user.directory-metrics.service.js";
import {
  directoryAmountBounds,
  directoryCreditFilter,
  directoryCreditStages,
  directorySpendingPeriod,
  hasCreditBounds,
  hasSpendingBounds,
  matchesDirectorySpending,
} from "../user.directory-financial.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

type Context = {
  tenantId: string;
  access: ResolvedWorkspaceAccess;
  now?: Date;
};
const assertAccess = ({ tenantId, access }: Context) => {
  if (
    access?.tenantId !== tenantId ||
    access?.status !== "active" ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.CUSTOMERS_VIEW)
  ) {
    forbidden({
      code: "WORKSPACE_PERMISSION_REQUIRED",
      message: "Customer directory access is required.",
    });
  }
};
const hasFilters = (input: DirectoryFilters) =>
  Boolean(input.search || input.status || input.membership);
const matching = (
  tenantId: string,
  input: DirectoryFilters,
  membership: DirectoryMembership,
  currency: StudioCommerceCurrency | null,
  bounds: ReturnType<typeof directoryAmountBounds>,
): PipelineStage[] => [
  { $match: customerDirectoryScope(tenantId) },
  ...(hasFilters(input) || hasCreditBounds(input)
    ? [
        ...(input.membership ? directoryMembershipStages(membership) : []),
        ...directoryDerivedStages(),
        ...directoryCreditStages(currency),
        ...(input.membership
          ? [{ $match: { membershipAvailable: true } } as PipelineStage]
          : []),
        ...directoryFilterStages(input),
        ...directoryCreditFilter(bounds),
      ]
    : []),
];
const hydrate = (
  context: Context,
  rows: any[],
  input: DirectoryFilters,
  currency: StudioCommerceCurrency | null,
  includeBookings = true,
) =>
  withCustomerDirectoryMetrics({
    ...context,
    users: rows.map(directoryRow),
    spendingPeriod: directorySpendingPeriod(input),
    defaultCurrency: currency,
    includeBookings,
  });

/** Ordinary reads enrich only the requested page. Spending predicates require
 * scanning matching identities in bounded batches before counting/pagination. */
export const listCustomerDirectory = async (
  context: Context & { input: unknown },
) => {
  assertAccess(context);
  const input = customerDirectoryQuery.parse(context.input);
  context = { ...context, now: context.now ?? new Date() };
  if (
    hasSpendingBounds(input) &&
    !canReadCustomerSpending(context.tenantId, context.access)
  )
    forbidden("Spending filters require full workspace financial access.");
  const currency = await getCustomerDirectoryCurrency(context.tenantId);
  const bounds = directoryAmountBounds(input, currency);
  const membership = await resolveDirectoryMembership(context);
  if (input.membership && !membership.canRead)
    forbidden("Membership filters are unavailable.");
  const base = matching(context.tenantId, input, membership, currency, bounds);
  if (hasSpendingBounds(input)) {
    const cursor = User.aggregate([
      ...base,
      { $sort: { createdAt: -1, _id: -1 } },
      ...(!input.membership ? directoryMembershipStages(membership) : []),
      ...directoryDerivedStages(),
      ...directoryCreditStages(currency),
      { $project: directoryProjection },
    ]).cursor({ batchSize: CUSTOMER_DIRECTORY_EXPORT_BATCH_SIZE });
    let totalCount = 0;
    const page: any[] = [];
    let batch: any[] = [];
    const start = (input.page - 1) * input.limit;
    const consume = async () => {
      const rows = await hydrate(context, batch, input, currency, false);
      for (const row of rows) {
        if (!matchesDirectorySpending(row, input, bounds, currency)) continue;
        if (totalCount >= start && page.length < input.limit) page.push(row);
        totalCount += 1;
      }
      batch = [];
    };
    try {
      for await (const row of cursor) {
        batch.push(row);
        if (batch.length === CUSTOMER_DIRECTORY_EXPORT_BATCH_SIZE)
          await consume();
      }
      if (batch.length) await consume();
    } finally {
      await cursor.close();
    }
    const bookingRows = await withCustomerDirectoryMetrics({
      ...context,
      users: page,
      includeSpending: false,
    });
    return {
      // Keep the very spending evidence that qualified the row/count. A second
      // financial read could otherwise move a displayed row outside its filter.
      data: page.map((row, index) => ({
        ...row,
        lastBookingAt: bookingRows[index].lastBookingAt,
      })),
      totalCount,
      currentPage: input.page,
      pageSize: input.limit,
      totalPages: Math.ceil(totalCount / input.limit),
    };
  }
  const [rows, counts] = await Promise.all([
    User.aggregate([
      ...base,
      { $sort: { createdAt: -1, _id: -1 } },
      { $skip: (input.page - 1) * input.limit },
      { $limit: input.limit },
      ...(!input.membership
        ? [
            ...directoryMembershipStages(membership),
            ...directoryDerivedStages(),
          ]
        : []),
      ...directoryCreditStages(currency),
      { $project: directoryProjection },
    ]),
    User.aggregate([...base, { $count: "total" }]),
  ]);
  const totalCount = counts[0]?.total ?? 0;
  return {
    data: await hydrate(context, rows, input, currency),
    totalCount,
    currentPage: input.page,
    pageSize: input.limit,
    totalPages: Math.ceil(totalCount / input.limit),
  };
};

/** Global cards/facets use customer/current-membership fields, never lifetime commerce history. */
export const getCustomerDirectorySummary = async (
  context: Context & { input: unknown },
) => {
  assertAccess(context);
  const { timeZone } = customerDirectorySummaryQuery.parse(context.input);
  const now = context.now ?? new Date();
  context = { ...context, now };
  const currency = await getCustomerDirectoryCurrency(context.tenantId);
  const membership = await resolveDirectoryMembership(context);
  const membershipSummary = await getCustomerMembershipSummary(context);
  const membershipAvailable =
    membership.canRead && membershipSummary.activeMemberships !== null;
  const membershipOptions = membershipAvailable
    ? await getDirectoryMembershipOptions(membership)
    : [];
  const month = {
    $dateToString: { date: now, format: "%Y-%m", timezone: timeZone },
  };
  const [result] = await User.aggregate([
    { $match: customerDirectoryScope(context.tenantId) },
    ...directoryDerivedStages(),
    ...directoryCreditStages(currency),
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: null,
              totalCustomers: { $sum: 1 },
              credits: { $sum: "$_directoryCredits" },
              unknownCredits: {
                $sum: { $cond: [{ $eq: ["$_directoryCredits", null] }, 1, 0] },
              },
              needsAttention: {
                $sum: {
                  $cond: [{ $ne: ["$_directoryStatus", "active"] }, 1, 0],
                },
              },
              newThisMonth: {
                $sum: {
                  $cond: [
                    {
                      $eq: [
                        {
                          $dateToString: {
                            date: {
                              $convert: {
                                input: {
                                  $ifNull: ["$createdAt", "$registeredAt"],
                                },
                                to: "date",
                                onError: null,
                                onNull: null,
                              },
                            },
                            format: "%Y-%m",
                            timezone: timeZone,
                            onNull: "",
                          },
                        },
                        month,
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ]);
  const {
    _id: _group,
    unknownCredits = 0,
    ...summary
  } = result?.summary?.[0] ?? {
    totalCustomers: 0,
    credits: 0,
    activeMemberships: 0,
    needsAttention: 0,
    newThisMonth: 0,
  };
  return {
    summary: {
      ...summary,
      credits: unknownCredits ? null : summary.credits,
      activeMemberships: membershipSummary.activeMemberships,
    },
    membershipAvailable,
    membershipScope: membershipSummary.membershipScope,
    asOf: membershipSummary.asOf,
    membershipOptions,
    currency,
    spendingAvailable: Boolean(
      currency && canReadCustomerSpending(context.tenantId, context.access),
    ),
  };
};

export const CUSTOMER_DIRECTORY_EXPORT_BATCH_SIZE = 100;

/**
 * Explicit export only. Bounded cursor + bounded metric batches; never repairs
 * customer records. This is a live read ordered by creation time and identity,
 * not a point-in-time backup. Normal customers created after the request are
 * excluded. An interrupted/failed traversal must never yield a success suffix.
 */
export async function* exportCustomerDirectory(
  context: Context & { input: unknown },
) {
  assertAccess(context);
  const input = customerDirectoryExportInput.parse(context.input);
  context = { ...context, now: context.now ?? new Date() };
  if (
    hasSpendingBounds(input) &&
    !canReadCustomerSpending(context.tenantId, context.access)
  )
    forbidden("Spending filters require full workspace financial access.");
  const currency = await getCustomerDirectoryCurrency(context.tenantId);
  const bounds = directoryAmountBounds(input, currency);
  const membership = await resolveDirectoryMembership(context);
  if (input.membership && !membership.canRead)
    forbidden("Membership filters are unavailable.");
  const ids = input.ids
    ? [...new Set(input.ids.map((id) => id.toLowerCase()))]
    : null;
  if (ids) {
    const count = await User.countDocuments({
      ...customerDirectoryScope(context.tenantId),
      _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
    });
    if (count !== ids.length)
      notFound({
        code: "CUSTOMER_EXPORT_SELECTION_CHANGED",
        message:
          "Some selected customers are no longer available. Refresh the selection before exporting.",
      });
  }
  const cursor = User.aggregate([
    ...matching(context.tenantId, input, membership, currency, bounds),
    {
      $match: ids
        ? { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } }
        : {
            $or: [
              { createdAt: { $lte: context.now ?? new Date() } },
              { createdAt: null },
            ],
          },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    ...(!input.membership
      ? [...directoryMembershipStages(membership), ...directoryDerivedStages()]
      : []),
    ...directoryCreditStages(currency),
    { $project: directoryProjection },
  ]).cursor({ batchSize: CUSTOMER_DIRECTORY_EXPORT_BATCH_SIZE });
  let emitted = 0;
  let batch: any[] = [];
  try {
    for await (const row of cursor) {
      batch.push(row);
      if (batch.length === CUSTOMER_DIRECTORY_EXPORT_BATCH_SIZE) {
        const rows = (await hydrate(context, batch, input, currency)).filter(
          (row) => matchesDirectorySpending(row, input, bounds, currency),
        );
        emitted += rows.length;
        if (rows.length) yield rows;
        batch = [];
      }
    }
    if (batch.length) {
      const rows = (await hydrate(context, batch, input, currency)).filter(
        (row) => matchesDirectorySpending(row, input, bounds, currency),
      );
      emitted += rows.length;
      if (rows.length) yield rows;
    }
    if (ids && emitted !== ids.length)
      throw new Error("Customer export selection changed during delivery.");
  } finally {
    await cursor.close();
  }
}
