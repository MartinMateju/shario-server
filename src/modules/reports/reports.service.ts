import dayjs from "dayjs";
import { activeBookingParticipants } from "@/modules/booking/booking.attendance-read.js";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

import Booking from "@/modules/booking/booking.model.js";
import {
  BOOKING_STATUS,
  BOOKING_TAG,
  CLASS_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import {
  InventoryAudit,
  InventoryItem,
  InventoryMovement,
  ReorderRequest,
} from "@/modules/inventory/inventory.model.js";
import {
  INVENTORY_AUDIT_STATUS,
  INVENTORY_MOVEMENT_REASON,
  INVENTORY_MOVEMENT_TYPE,
  REORDER_STATUS,
} from "@/modules/inventory/inventory.constants.js";
import LocationModel from "@/modules/location/location.model.js";
import Order from "@/modules/order/order.model.js";
import { ORDER_STATUS } from "@/modules/order/order.constants.js";
import Product from "@/modules/product/product.model.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";
import StaffTaskModel from "@/modules/staff/staff-task.model.js";
import { STAFF_TASK_STATUS } from "@/modules/staff/staff.constants.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/index.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import {
  isStudioCommerceCurrency,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";

import {
  addTenantCalendarDays,
  buildReportBuckets,
  isInReportPeriod,
  reportBucketFor,
  resolveReportPeriod,
} from "./reports.date.js";
import {
  matchesReportLocation,
  orderLocationFilter,
  resolveReportLocationScope,
} from "./reports.scope.js";
import {
  buildCourseUtilizationSeries,
  getReportPlanEntitlement,
} from "./report-plan-entitlements.js";
import type {
  ReportContext,
  ReportCoverage,
  ReportKpi,
  ReportLocationScope,
  ReportPeriod,
  ReportQuery,
  ResolvedReportGranularity,
  ResolvedReportPeriod,
} from "./reports.types.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const round = (value: number, digits = 2): number => {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

export const changePercent = (
  current: number | null,
  previous: number | null,
): number | null => {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return round(((current - previous) / Math.abs(previous)) * 100);
};

const kpi = (value: number | null, previous: number | null): ReportKpi => ({
  value,
  previous,
  changePercent: changePercent(value, previous),
});

const hasPermission = (
  context: ReportContext,
  permission: (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION],
) => hasWorkspacePermission(context.access, permission);

const asDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date;
};

const id = (value: unknown): string => String(value ?? "").trim();

const periodForDate = (
  value: Date | null,
  periods: ResolvedReportPeriod,
): "current" | "comparison" | null => {
  if (isInReportPeriod(value, periods.current)) return "current";
  if (isInReportPeriod(value, periods.comparison)) return "comparison";
  return null;
};

type CoverageBuilder = {
  available: Set<string>;
  unavailable: Array<{ source: string; reason: string }>;
  limitations: Set<string>;
};

const sourceAvailability = ({
  coverage,
  source,
  moduleEnabled,
  permissions,
}: {
  coverage: CoverageBuilder;
  source: string;
  moduleEnabled: boolean;
  permissions: boolean[];
}): boolean => {
  if (!moduleEnabled) {
    coverage.unavailable.push({ source, reason: "module_disabled" });
    return false;
  }
  if (permissions.some((allowed) => !allowed)) {
    coverage.unavailable.push({ source, reason: "permission_required" });
    return false;
  }
  coverage.available.add(source);
  return true;
};

const lineLocationIds = (line: any): string[] =>
  Array.isArray(line?.locationIds)
    ? line.locationIds.map(id).filter(Boolean)
    : [];

const eligibleOrderLines = (order: any, scope: ReportLocationScope): any[] => {
  const lines = Array.isArray(order.lineItems) ? order.lineItems : [];
  if (scope.unrestricted && !scope.requestedLocationId) return lines;
  return lines.filter((line: any) => {
    const locations = lineLocationIds(line);
    if (!locations.length) return false;
    if (scope.requestedLocationId) {
      return locations.includes(scope.requestedLocationId);
    }
    return locations.every((locationId) =>
      scope.locationIds.includes(locationId),
    );
  });
};

const isOrderEligibleForScopedFacts = (
  order: any,
  scope: ReportLocationScope,
): boolean => {
  if (scope.unrestricted && !scope.requestedLocationId) return true;
  return eligibleOrderLines(order, scope).length > 0;
};

type SalesAccumulator = {
  grossSalesMinor: number;
  discountsMinor: number;
  taxMinor: number;
  netSalesMinor: number;
  netSalesComplete: boolean;
  paidAmountMinor: number;
  orders: number;
};

type ReportTopProductAccumulator = {
  productId: string | null;
  name: string;
  quantity: number;
  netSalesMinor: number;
  grossSalesMinor: number;
  netSalesComplete: boolean;
};

export const finalizeTopProducts = (products: ReportTopProductAccumulator[]) =>
  products
    .map(({ netSalesComplete, ...product }) => ({
      ...product,
      netSalesMinor: netSalesComplete ? product.netSalesMinor : null,
    }))
    .sort((a, b) => {
      if (a.netSalesMinor === null && b.netSalesMinor !== null) return 1;
      if (a.netSalesMinor !== null && b.netSalesMinor === null) return -1;
      if (a.netSalesMinor !== null && b.netSalesMinor !== null) {
        const netDifference = b.netSalesMinor - a.netSalesMinor;
        if (netDifference) return netDifference;
      }
      return (
        b.grossSalesMinor - a.grossSalesMinor || a.name.localeCompare(b.name)
      );
    });

const emptySales = (): SalesAccumulator => ({
  grossSalesMinor: 0,
  discountsMinor: 0,
  taxMinor: 0,
  netSalesMinor: 0,
  netSalesComplete: true,
  paidAmountMinor: 0,
  orders: 0,
});

const hasTrustedTaxSnapshots = (lines: any[]): boolean =>
  lines.length > 0 &&
  lines.every((line) => {
    const gross = Number(line?.grossAmountMinor);
    const net = Number(line?.netAmountMinor);
    const tax = Number(line?.taxAmountMinor);
    return (
      Number.isSafeInteger(gross) &&
      Number.isSafeInteger(net) &&
      Number.isSafeInteger(tax) &&
      gross >= 0 &&
      net >= 0 &&
      tax >= 0 &&
      net + tax === gross
    );
  });

const UNALLOCATED_LOCATION = "\uffff-unallocated";

const minorUnits = (value: unknown): number => {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
};

const splitEvenly = (total: number, rawKeys: string[]): Map<string, number> => {
  const keys = [...new Set(rawKeys)].sort();
  const result = new Map(keys.map((key) => [key, 0]));
  if (!keys.length) return result;
  const base = Math.floor(total / keys.length);
  const remainder = total % keys.length;
  keys.forEach((key, index) => {
    result.set(key, base + (index < remainder ? 1 : 0));
  });
  return result;
};

export const allocateMinorUnitsByWeight = (
  totalValue: number,
  rawWeights: Map<string, number>,
): Map<string, number> => {
  const total = minorUnits(totalValue);
  const weights = [...rawWeights.entries()]
    .map(([key, value]) => [key, minorUnits(value)] as const)
    .filter(([, value]) => value > 0);
  const result = new Map([...rawWeights.keys()].map((key) => [key, 0]));
  if (total === 0 || !weights.length) return result;
  const totalWeight = weights.reduce(
    (sum, [, value]) => sum + BigInt(value),
    0n,
  );
  const shares = weights.map(([key, weight]) => {
    const product = BigInt(total) * BigInt(weight);
    return {
      key,
      amount: Number(product / totalWeight),
      remainder: product % totalWeight,
    };
  });
  let remainderUnits =
    total - shares.reduce((sum, share) => sum + share.amount, 0);
  shares.sort((a, b) => {
    if (a.remainder === b.remainder) return a.key.localeCompare(b.key);
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (const share of shares) {
    if (remainderUnits <= 0) break;
    share.amount += 1;
    remainderUnits -= 1;
  }
  for (const share of shares) result.set(share.key, share.amount);
  return result;
};

const roundMinorRatio = (
  value: number,
  numerator: number,
  denominator: number,
): number => {
  if (denominator <= 0 || value <= 0 || numerator <= 0) return 0;
  const product = BigInt(value) * BigInt(numerator);
  const divisor = BigInt(denominator);
  const base = product / divisor;
  const remainder = product % divisor;
  return Number(base + (remainder * 2n >= divisor ? 1n : 0n));
};

type ReportAllocationCell = {
  id: string;
  lineIndex: number;
  locationId: string;
  grossAmountMinor: number;
  taxAmountMinor: number;
};

const allocateCellsThroughLocations = (
  total: number,
  cells: ReportAllocationCell[],
  weight: "grossAmountMinor" | "taxAmountMinor",
): Map<string, number> => {
  const locationWeights = new Map<string, number>();
  for (const cell of cells) {
    locationWeights.set(
      cell.locationId,
      (locationWeights.get(cell.locationId) ?? 0) + cell[weight],
    );
  }
  const locationAmounts = allocateMinorUnitsByWeight(total, locationWeights);
  const result = new Map(cells.map((cell) => [cell.id, 0]));
  for (const [locationId, locationAmount] of locationAmounts) {
    const locationCells = cells.filter(
      (cell) => cell.locationId === locationId,
    );
    const cellWeights = new Map(
      locationCells.map((cell) => [cell.id, cell[weight]]),
    );
    const cellAmounts = allocateMinorUnitsByWeight(locationAmount, cellWeights);
    for (const [cellId, amount] of cellAmounts) result.set(cellId, amount);
  }
  return result;
};

export const allocateOrderForReport = (
  order: any,
  scope: ReportLocationScope,
  coverage: CoverageBuilder,
  linePredicate?: (line: any) => boolean,
) => {
  const allLines = Array.isArray(order.lineItems) ? order.lineItems : [];
  const fullyVisible = scope.unrestricted && !scope.requestedLocationId;
  const snapshotsTrusted = hasTrustedTaxSnapshots(allLines);
  const cells: ReportAllocationCell[] = [];
  const lineLocations = new Map<number, string[]>();
  allLines.forEach((line: any, lineIndex: number) => {
    const locations = [...new Set(lineLocationIds(line))].sort();
    lineLocations.set(lineIndex, locations);
    if (locations.length > 1) {
      coverage.limitations.add(
        "Line items assigned to multiple locations are split equally, with indivisible minor-unit remainders assigned by sorted location ID.",
      );
    }
    const allocationLocations = locations.length
      ? locations
      : [UNALLOCATED_LOCATION];
    const gross = splitEvenly(
      minorUnits(line.grossAmountMinor),
      allocationLocations,
    );
    const tax = snapshotsTrusted
      ? splitEvenly(minorUnits(line.taxAmountMinor), allocationLocations)
      : new Map(allocationLocations.map((locationId) => [locationId, 0]));
    for (const locationId of allocationLocations) {
      cells.push({
        id: `${locationId}:${String(lineIndex).padStart(8, "0")}`,
        lineIndex,
        locationId,
        grossAmountMinor: gross.get(locationId) ?? 0,
        taxAmountMinor: tax.get(locationId) ?? 0,
      });
    }
  });

  const eligibleLineIndexes = new Set<number>();
  allLines.forEach((line: any, lineIndex: number) => {
    if (linePredicate && !linePredicate(line)) return;
    const locations = lineLocations.get(lineIndex) ?? [];
    if (fullyVisible) {
      eligibleLineIndexes.add(lineIndex);
    } else if (scope.requestedLocationId) {
      if (locations.includes(scope.requestedLocationId)) {
        eligibleLineIndexes.add(lineIndex);
      }
    } else if (
      locations.length > 0 &&
      locations.every((locationId) => scope.locationIds.includes(locationId))
    ) {
      eligibleLineIndexes.add(lineIndex);
    }
  });
  const selectedCells = cells.filter(
    (cell) =>
      eligibleLineIndexes.has(cell.lineIndex) &&
      (fullyVisible ||
        !scope.requestedLocationId ||
        cell.locationId === scope.requestedLocationId),
  );
  const allLineGross = cells.reduce(
    (sum, cell) => sum + cell.grossAmountMinor,
    0,
  );
  if (allLineGross <= 0) {
    if (fullyVisible && !linePredicate) {
      coverage.limitations.add(
        "Tax-exclusive net sales are unavailable for legacy orders without allocatable line-item snapshots.",
      );
      const orderSaleValue = minorUnits(order.grossAmountMinor);
      const discount = minorUnits(order.appliedDiscount?.amountMinor);
      return {
        ratio: 1,
        lines: allLines.map((line: any) => ({
          ...line,
          _reportShare: 1,
          _reportGrossAmountMinor: minorUnits(line.grossAmountMinor),
          _reportTaxAmountMinor: null,
          _reportNetSalesMinor: null,
        })),
        grossSalesMinor: orderSaleValue + discount,
        discountsMinor: discount,
        taxMinor: null,
        netSalesMinor: null,
        paidAmountMinor: minorUnits(order.paidAmountMinor),
        allocateMinorUnits: (value: unknown) => minorUnits(value),
      };
    }
    coverage.limitations.add(
      linePredicate
        ? "Course sales exclude legacy orders without classifiable line-item amounts."
        : "Location-scoped sales exclude legacy orders without allocatable line-item locations.",
    );
    return null;
  }
  if (!selectedCells.length) return null;

  const sumSelected = (values: Map<string, number>) =>
    selectedCells.reduce((sum, cell) => sum + (values.get(cell.id) ?? 0), 0);
  const allocateSelectedMinorUnits = (value: unknown) =>
    sumSelected(
      allocateCellsThroughLocations(
        minorUnits(value),
        cells,
        "grossAmountMinor",
      ),
    );
  const orderSaleValue = minorUnits(order.grossAmountMinor);
  const discount = minorUnits(order.appliedDiscount?.amountMinor);
  const saleByCell = allocateCellsThroughLocations(
    orderSaleValue,
    cells,
    "grossAmountMinor",
  );
  const discountByCell = allocateCellsThroughLocations(
    discount,
    cells,
    "grossAmountMinor",
  );
  const paidByCell = allocateCellsThroughLocations(
    minorUnits(order.paidAmountMinor),
    cells,
    "grossAmountMinor",
  );
  const allLineTax = cells.reduce((sum, cell) => sum + cell.taxAmountMinor, 0);
  const fullTax = snapshotsTrusted
    ? roundMinorRatio(orderSaleValue, allLineTax, allLineGross)
    : null;
  const taxByCell =
    fullTax === null
      ? null
      : allocateCellsThroughLocations(fullTax, cells, "taxAmountMinor");
  if (taxByCell === null) {
    coverage.limitations.add(
      "Tax-exclusive net sales are unavailable for legacy orders without line-item tax snapshots.",
    );
  }
  const selectedLineGross = selectedCells.reduce(
    (sum, cell) => sum + cell.grossAmountMinor,
    0,
  );
  const selectedLines = [...eligibleLineIndexes]
    .sort((a, b) => a - b)
    .map((lineIndex) => {
      const line = allLines[lineIndex];
      const lineCells = selectedCells.filter(
        (cell) => cell.lineIndex === lineIndex,
      );
      const lineSale = lineCells.reduce(
        (sum, cell) => sum + (saleByCell.get(cell.id) ?? 0),
        0,
      );
      const lineTax =
        taxByCell === null
          ? null
          : lineCells.reduce(
              (sum, cell) => sum + (taxByCell.get(cell.id) ?? 0),
              0,
            );
      const locations = lineLocations.get(lineIndex) ?? [];
      return {
        ...line,
        _reportShare: fullyVisible
          ? 1
          : locations.length > 0
            ? lineCells.length / locations.length
            : 0,
        _reportGrossAmountMinor: lineCells.reduce(
          (sum, cell) => sum + cell.grossAmountMinor,
          0,
        ),
        _reportTaxAmountMinor: lineTax,
        _reportNetSalesMinor: lineTax === null ? null : lineSale - lineTax,
      };
    });
  const allocatedSaleValue = sumSelected(saleByCell);
  const allocatedDiscount = sumSelected(discountByCell);
  const allocatedTax = taxByCell === null ? null : sumSelected(taxByCell);

  return {
    ratio: selectedLineGross / allLineGross,
    lines: selectedLines,
    grossSalesMinor: allocatedSaleValue + allocatedDiscount,
    discountsMinor: allocatedDiscount,
    taxMinor: allocatedTax,
    netSalesMinor:
      allocatedTax === null ? null : allocatedSaleValue - allocatedTax,
    paidAmountMinor: sumSelected(paidByCell),
    allocateMinorUnits: allocateSelectedMinorUnits,
  };
};

const buildSales = async ({
  context,
  tenant,
  scope,
  periods,
  timezone,
  currency,
  coverage,
  productsAllowed,
  courseOnly,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  timezone: string;
  currency: string;
  coverage: CoverageBuilder;
  productsAllowed: boolean;
  courseOnly: boolean;
}) => {
  const available = sourceAvailability({
    coverage,
    source: "sales",
    moduleEnabled: tenant.modules?.[TENANT_MODULE.PAYMENTS] === true,
    permissions: [
      hasPermission(context, WORKSPACE_PERMISSION.ORDERS_VIEW),
      hasPermission(context, WORKSPACE_PERMISSION.PAYMENTS_VIEW),
    ],
  });
  if (!available) return { report: null, series: new Map(), orders: [] };

  coverage.limitations.add(
    "Refunds and payment-provider fees are unavailable because no authoritative report source is stored.",
  );
  coverage.limitations.add(
    "Credit-pack purchases are excluded from sales to avoid counting stored value twice.",
  );

  const orders = (await Order.find({
    tenant: context.tenantId,
    isPaid: true,
    status: ORDER_STATUS.PROCESSED,
    paidAt: {
      $gte: periods.queryStart,
      $lt: periods.queryEndExclusive,
    },
    ...orderLocationFilter(scope),
  })
    .select(
      "_id createdBy paidAt currency grossAmountMinor paidAmountMinor appliedDiscount appliedCoupons creditPurchase lineItems paymentAllocations locationIds",
    )
    .lean()) as any[];

  let courseLinePredicate: ((line: any) => boolean) | undefined;
  if (courseOnly) {
    const lines = orders.flatMap((order) =>
      Array.isArray(order.lineItems) ? order.lineItems : [],
    );
    const bookingIds = [
      ...new Set(lines.map((line) => id(line.booking)).filter(Boolean)),
    ];
    const courseBookings = bookingIds.length
      ? ((await Booking.find({
          tenant: context.tenantId,
          _id: { $in: bookingIds },
        })
          .select("_id tag bookingProduct")
          .lean()) as any[])
      : [];
    const productIds = [
      ...new Set(
        [
          ...lines.map((line) => id(line.product)),
          ...courseBookings.map((booking) => id(booking.bookingProduct)),
        ].filter(Boolean),
      ),
    ];
    const courseProductIds = new Set(
      productIds.length
        ? (
            (await Product.find({
              tenant: context.tenantId,
              _id: { $in: productIds },
              type: { $in: COURSE_PRODUCT_TYPES },
            })
              .select("_id")
              .lean()) as any[]
          ).map((product) => id(product._id))
        : [],
    );
    const bookingsById = new Map(
      courseBookings.map((booking) => [id(booking._id), booking]),
    );
    courseLinePredicate = (line: any): boolean => {
      const booking = bookingsById.get(id(line.booking));
      if (booking) {
        return (
          isClassBookingTag(booking.tag) ||
          courseProductIds.has(id(booking.bookingProduct))
        );
      }
      return courseProductIds.has(id(line.product));
    };
    coverage.limitations.add(
      "Limited-plan sales include only line items linked to course products or class bookings; unclassifiable legacy lines are excluded.",
    );
  }

  const byCurrency = new Map<
    string,
    { current: SalesAccumulator; comparison: SalesAccumulator }
  >();
  const methodTotals = new Map<string, number>();
  const topProducts = new Map<string, ReportTopProductAccumulator>();
  const series = new Map<string, number | null>();
  const eligibleOrders: any[] = [];
  let sawLegacyCoupon = false;

  for (const order of orders) {
    const paidAt = asDate(order.paidAt);
    const periodKey = periodForDate(paidAt, periods);
    if (!periodKey) continue;
    if (Number(order.creditPurchase?.amount ?? 0) > 0) continue;
    const allocation = allocateOrderForReport(
      order,
      scope,
      coverage,
      courseLinePredicate,
    );
    if (!allocation) continue;
    const denomination = String(order.currency || "").toUpperCase();
    if (!denomination) continue;
    const group = byCurrency.get(denomination) ?? {
      current: emptySales(),
      comparison: emptySales(),
    };
    const target = group[periodKey];
    target.grossSalesMinor += allocation.grossSalesMinor;
    target.discountsMinor += allocation.discountsMinor;
    if (allocation.taxMinor === null || allocation.netSalesMinor === null) {
      target.netSalesComplete = false;
    } else {
      target.taxMinor += allocation.taxMinor;
      target.netSalesMinor += allocation.netSalesMinor;
    }
    target.paidAmountMinor += allocation.paidAmountMinor;
    target.orders += 1;
    byCurrency.set(denomination, group);
    eligibleOrders.push({
      ...order,
      _reportPeriod: periodKey,
      _reportNetSalesMinor: allocation.netSalesMinor,
    });

    if (Array.isArray(order.appliedCoupons) && order.appliedCoupons.length) {
      sawLegacyCoupon = true;
    }

    if (periodKey === "current" && denomination === currency) {
      const bucket = reportBucketFor({
        value: paidAt!,
        timezone,
        granularity: periods.granularity,
      });
      const existingSeries = series.get(bucket);
      series.set(
        bucket,
        allocation.netSalesMinor === null || existingSeries === null
          ? null
          : (existingSeries ?? 0) + allocation.netSalesMinor,
      );
      for (const method of order.paymentAllocations ?? []) {
        const key = String(method.method || "unknown");
        methodTotals.set(
          key,
          (methodTotals.get(key) ?? 0) +
            allocation.allocateMinorUnits(method.amountMinor),
        );
      }
      if (productsAllowed) {
        for (const line of allocation.lines) {
          const key =
            id(line.product) || `description:${String(line.description || "")}`;
          const weightedGross = minorUnits(
            line._reportGrossAmountMinor ?? line.grossAmountMinor,
          );
          const recognized =
            line._reportNetSalesMinor === null
              ? null
              : minorUnits(line._reportNetSalesMinor);
          const existing = topProducts.get(key) ?? {
            productId: id(line.product) || null,
            name: String(line.description || "Unnamed product"),
            quantity: 0,
            netSalesMinor: 0,
            grossSalesMinor: 0,
            netSalesComplete: true,
          };
          existing.quantity +=
            Math.max(Number(line.quantity ?? 0), 0) *
            Math.max(Number(line._reportShare ?? 1), 0);
          if (recognized === null) {
            existing.netSalesComplete = false;
          } else {
            existing.netSalesMinor += recognized;
          }
          existing.grossSalesMinor += weightedGross;
          topProducts.set(key, existing);
        }
      }
    }
  }

  if (sawLegacyCoupon) {
    coverage.limitations.add(
      "Legacy coupon values are not added to discounts because their stored unit is not authoritative.",
    );
  }
  if (!productsAllowed) {
    coverage.limitations.add(
      "Top products are hidden because products.view permission is required.",
    );
  }

  const primary = byCurrency.get(currency) ?? {
    current: emptySales(),
    comparison: emptySales(),
  };
  const totalsByCurrency = [...byCurrency.entries()]
    .map(([entryCurrency, totals]) => ({
      currency: entryCurrency,
      grossSalesMinor: totals.current.grossSalesMinor,
      discountsMinor: totals.current.discountsMinor,
      taxMinor: totals.current.netSalesComplete
        ? totals.current.taxMinor
        : null,
      netSalesMinor: totals.current.netSalesComplete
        ? totals.current.netSalesMinor
        : null,
      paidAmountMinor: totals.current.paidAmountMinor,
      orders: totals.current.orders,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  if (totalsByCurrency.some((entry) => entry.currency !== currency)) {
    coverage.limitations.add(
      `Primary sales KPIs include ${currency} only; other currencies are separated in totalsByCurrency.`,
    );
  }

  return {
    report: {
      currency,
      grossSalesMinor: primary.current.grossSalesMinor,
      discountsMinor: primary.current.discountsMinor,
      taxMinor: primary.current.netSalesComplete
        ? primary.current.taxMinor
        : null,
      netSalesMinor: primary.current.netSalesComplete
        ? primary.current.netSalesMinor
        : null,
      orders: primary.current.orders,
      averageOrderValueMinor:
        primary.current.orders > 0 && primary.current.netSalesComplete
          ? Math.round(primary.current.netSalesMinor / primary.current.orders)
          : primary.current.orders > 0
            ? null
            : 0,
      refundsMinor: null,
      paymentMethods: [...methodTotals.entries()]
        .map(([method, amountMinor]) => ({ method, amountMinor }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      totalsByCurrency,
      topProducts: productsAllowed
        ? finalizeTopProducts([...topProducts.values()]).slice(0, 10)
        : null,
      limitations: [
        "Refunds and payment-provider fees are unavailable.",
        "Tax uses stored line-item snapshots and may precede legacy order-level discounts.",
      ],
    },
    primaryCurrent: primary.current,
    primaryComparison: periods.comparison ? primary.comparison : null,
    primaryCurrentNetSalesMinor: primary.current.netSalesComplete
      ? primary.current.netSalesMinor
      : null,
    primaryComparisonNetSalesMinor:
      periods.comparison && primary.comparison.netSalesComplete
        ? primary.comparison.netSalesMinor
        : null,
    series,
    orders: eligibleOrders,
  };
};

const isClassBookingTag = (tag: unknown): boolean =>
  (CLASS_BOOKING_TAGS as readonly string[]).includes(String(tag ?? ""));

const bookingSeats = (booking: any): number => {
  const participants = activeBookingParticipants(booking).length;
  const guests = Math.max(Number(booking.numberOfGuests ?? 0), 0);
  if (isClassBookingTag(booking.tag)) {
    return Math.max(participants, guests);
  }
  return Math.max(participants, guests, 1);
};

export const bookingReservations = (booking: any): number => {
  if (!isClassBookingTag(booking.tag)) return 1;
  const bookingOrders = new Set(
    (booking.orders ?? [])
      .map((orderId: unknown) => id(orderId))
      .filter(Boolean),
  );
  if (bookingOrders.size) return bookingOrders.size;
  // Attendance-managed rows retain refunded order references for webhook
  // idempotency. Only the current booking.orders list owns paid reservations.
  if (booking.attendanceManaged === true)
    return Number(booking.numberOfGuests ?? 0) > 0 ? 1 : 0;
  const orders = new Set(
    (booking.participants ?? [])
      .map((participant: any) => id(participant.order))
      .filter(Boolean),
  );
  if (orders.size) return orders.size;
  return Number(booking.numberOfGuests ?? 0) > 0 ? 1 : 0;
};

const bookingDurationHours = (booking: any): number => {
  const start = asDate(booking.start);
  const end = asDate(booking.end);
  if (!start || !end || end <= start) return 0;
  return (end.valueOf() - start.valueOf()) / 3_600_000;
};

export const openingHoursCapacity = ({
  locations,
  period,
  timezone,
  granularity,
}: {
  locations: any[];
  period: ReportPeriod;
  timezone: string;
  granularity: ResolvedReportGranularity;
}) => {
  const weekdayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const byBucket = new Map<string, number>();
  const heatmap = new Map<string, number>();
  let total = 0;
  let cursor = dayjs(period.start).tz(timezone).startOf("day");
  const end = dayjs(period.endExclusive).tz(timezone);
  while (cursor.isBefore(end)) {
    for (const location of locations) {
      if (location.booking?.enabled === false) continue;
      const hours = location.openingHours?.[weekdayNames[cursor.day()]];
      if (!hours?.isOpen) continue;
      const [openHour, openMinute] = String(hours.openTime || "00:00")
        .split(":")
        .map(Number);
      const [rawCloseHour, closeMinute] = String(hours.closeTime || "24:00")
        .split(":")
        .map(Number);
      const closeHour = rawCloseHour === 24 ? 24 : rawCloseHour;
      const open = openHour + openMinute / 60;
      const close = closeHour + closeMinute / 60;
      const capacity = Math.max(
        Number(location.booking?.globalCapacity ?? 0),
        0,
      );
      if (close <= open || capacity <= 0) continue;
      const capacityHours = (close - open) * capacity;
      total += capacityHours;
      const bucket = reportBucketFor({
        value: cursor.toDate(),
        timezone,
        granularity,
      });
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + capacityHours);
      for (let hour = Math.floor(open); hour < Math.ceil(close); hour += 1) {
        const overlap = Math.max(
          0,
          Math.min(close, hour + 1) - Math.max(open, hour),
        );
        const weekday = (cursor.day() + 6) % 7;
        const key = `${weekday}:${hour % 24}`;
        heatmap.set(key, (heatmap.get(key) ?? 0) + overlap * capacity);
      }
    }
    cursor = dayjs(addTenantCalendarDays(cursor.toDate(), 1, timezone)).tz(
      timezone,
    );
  }
  return { total, byBucket, heatmap };
};

const buildBookings = async ({
  context,
  tenant,
  scope,
  periods,
  timezone,
  locations,
  coverage,
  coursesAllowed,
  courseOnly,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  timezone: string;
  locations: any[];
  coverage: CoverageBuilder;
  coursesAllowed: boolean;
  courseOnly: boolean;
}) => {
  const available = sourceAvailability({
    coverage,
    source: "bookings",
    moduleEnabled: tenant.modules?.[TENANT_MODULE.BOOKINGS] === true,
    permissions: [hasPermission(context, WORKSPACE_PERMISSION.BOOKINGS_VIEW)],
  });
  if (!available) {
    return {
      report: null,
      current: null,
      comparison: null,
      series: new Map(),
      seriesUtilization: new Map(),
      records: [],
    };
  }
  coverage.limitations.add(
    "No-show and attendance data are unavailable because bookings do not store authoritative attendance.",
  );
  if (!courseOnly) {
    coverage.limitations.add(
      "Studio utilization uses booked participant-hours divided by configured opening capacity-hours; private blocking and activity-specific capacity can make this an estimate.",
    );
  }

  const bookingRows = (await Booking.find({
    tenant: context.tenantId,
    location: { $in: scope.locationIds },
    start: { $gte: periods.queryStart, $lt: periods.queryEndExclusive },
    tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
  })
    .select(
      "_id location participants orders start end bookingProduct bookingType status paymentStatus tag numberOfGuests isRoot attendanceManaged",
    )
    .lean()) as any[];

  const productIds =
    coursesAllowed || courseOnly
      ? [
          ...new Set(
            bookingRows
              .map((booking) => id(booking.bookingProduct))
              .filter(Boolean),
          ),
        ]
      : [];
  const products = productIds.length
    ? ((await Product.find({
        tenant: context.tenantId,
        _id: { $in: productIds },
      })
        .select("_id name type maxNumberOfParticipants")
        .lean()) as any[])
    : [];
  const productsById = new Map(
    products.map((product) => [id(product._id), product]),
  );
  const bookings = courseOnly
    ? bookingRows.filter((booking) => {
        const product = productsById.get(id(booking.bookingProduct));
        return (
          isClassBookingTag(booking.tag) ||
          COURSE_PRODUCT_TYPES.includes(product?.type as never)
        );
      })
    : bookingRows;
  if (courseOnly && bookings.length !== bookingRows.length) {
    coverage.limitations.add(
      "Limited-plan booking reports exclude open-studio and other non-course bookings.",
    );
  }

  const capacityLocations = locations.filter(
    (location) => location.isActive !== false,
  );
  if (!courseOnly) {
    if (capacityLocations.length !== locations.length) {
      coverage.limitations.add(
        "Utilization excludes inactive locations and uses current opening-hours and capacity settings for historical periods.",
      );
    } else {
      coverage.limitations.add(
        "Historical utilization uses current opening-hours and capacity settings.",
      );
    }
  } else {
    coverage.limitations.add(
      "Limited-plan utilization uses booked course seats divided by configured course capacity.",
    );
  }
  const capacities = courseOnly
    ? {
        current: { total: 0, byBucket: new Map(), heatmap: new Map() },
        comparison: periods.comparison
          ? { total: 0, byBucket: new Map(), heatmap: new Map() }
          : null,
      }
    : {
        current: openingHoursCapacity({
          locations: capacityLocations,
          period: periods.current,
          timezone,
          granularity: periods.granularity,
        }),
        comparison: periods.comparison
          ? openingHoursCapacity({
              locations: capacityLocations,
              period: periods.comparison,
              timezone,
              granularity: periods.granularity,
            })
          : null,
      };
  const stats = {
    current: {
      total: 0,
      participants: 0,
      cancellations: 0,
      bookedHours: 0,
      participantHours: 0,
    },
    comparison: {
      total: 0,
      participants: 0,
      cancellations: 0,
      bookedHours: 0,
      participantHours: 0,
    },
  };
  const typeTotals = new Map<string, { count: number; participants: number }>();
  const series = new Map<
    string,
    { bookings: number; participants: number; participantHours: number }
  >();
  const heat = new Map<
    string,
    { bookings: number; participants: number; bookedHours: number }
  >();
  const courseFill = new Map<
    string,
    {
      productId: string;
      name: string;
      sessions: number;
      bookedSeats: number;
      capacity: number;
    }
  >();
  let missingCourseCapacity = false;
  const courseCapacity = {
    current: { bookedSeats: 0, capacity: 0 },
    comparison: { bookedSeats: 0, capacity: 0 },
  };
  const courseCapacityByBucket = new Map<string, number>();
  const courseBookedSeatsByBucket = new Map<string, number>();

  for (const booking of bookings) {
    const periodKey = periodForDate(asDate(booking.start), periods);
    if (!periodKey) continue;
    const target = stats[periodKey];
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      if (!isClassBookingTag(booking.tag)) target.cancellations += 1;
      continue;
    }
    if (booking.paymentStatus !== PAYMENT_STATUS.CONFIRMED) continue;
    const seats = bookingSeats(booking);
    const reservations = bookingReservations(booking);
    const duration = bookingDurationHours(booking);
    const product = productsById.get(id(booking.bookingProduct));
    const courseBooking =
      isClassBookingTag(booking.tag) ||
      COURSE_PRODUCT_TYPES.includes(product?.type as never);
    const configuredCourseCapacity = courseBooking
      ? Math.max(Number(product?.maxNumberOfParticipants ?? 0), 0)
      : 0;
    if (courseBooking && coursesAllowed && configuredCourseCapacity > 0) {
      courseCapacity[periodKey].bookedSeats += seats;
      courseCapacity[periodKey].capacity += configuredCourseCapacity;
    }
    target.total += reservations;
    target.participants += seats;
    target.bookedHours += duration;
    target.participantHours += seats * duration;

    if (periodKey !== "current") continue;
    const type = String(booking.tag || booking.bookingType || "other");
    const typeEntry = typeTotals.get(type) ?? { count: 0, participants: 0 };
    typeEntry.count += reservations;
    typeEntry.participants += seats;
    typeTotals.set(type, typeEntry);
    const start = asDate(booking.start)!;
    const bucket = reportBucketFor({
      value: start,
      timezone,
      granularity: periods.granularity,
    });
    const point = series.get(bucket) ?? {
      bookings: 0,
      participants: 0,
      participantHours: 0,
    };
    point.bookings += reservations;
    point.participants += seats;
    point.participantHours += seats * duration;
    series.set(bucket, point);
    if (courseBooking && coursesAllowed && configuredCourseCapacity > 0) {
      courseCapacityByBucket.set(
        bucket,
        (courseCapacityByBucket.get(bucket) ?? 0) + configuredCourseCapacity,
      );
      courseBookedSeatsByBucket.set(
        bucket,
        (courseBookedSeatsByBucket.get(bucket) ?? 0) + seats,
      );
    }

    const end = asDate(booking.end);
    let segmentStart = start;
    while (end && segmentStart < end) {
      const local = dayjs(segmentStart).tz(timezone);
      const nextHour = local.startOf("hour").add(1, "hour").toDate();
      const segmentEnd =
        nextHour < end && nextHour > segmentStart ? nextHour : end;
      const occupiedHours =
        (segmentEnd.valueOf() - segmentStart.valueOf()) / 3_600_000;
      const heatKey = `${(local.day() + 6) % 7}:${local.hour()}`;
      const heatEntry = heat.get(heatKey) ?? {
        bookings: 0,
        participants: 0,
        bookedHours: 0,
      };
      heatEntry.bookings += reservations;
      heatEntry.participants += seats;
      heatEntry.bookedHours += seats * occupiedHours;
      heat.set(heatKey, heatEntry);
      segmentStart = segmentEnd;
    }

    if (coursesAllowed && courseBooking) {
      const capacity = Number(product?.maxNumberOfParticipants ?? 0);
      if (capacity <= 0) missingCourseCapacity = true;
      const productId = id(booking.bookingProduct);
      const entry = courseFill.get(productId) ?? {
        productId,
        name: String(product?.name || "Course"),
        sessions: 0,
        bookedSeats: 0,
        capacity: 0,
      };
      entry.sessions += 1;
      entry.bookedSeats += seats;
      if (capacity > 0) entry.capacity += capacity;
      courseFill.set(productId, entry);
    }
  }

  if (missingCourseCapacity) {
    coverage.limitations.add(
      "Course fill excludes sessions whose product has no configured capacity.",
    );
  }
  if (!coursesAllowed) {
    coverage.limitations.add(
      "Course fill is unavailable unless courses, bookings, and products can all be viewed.",
    );
  }
  coverage.limitations.add(
    "Course cancellation history is not authoritative; cancellations include non-course booking rows only.",
  );

  const currentUtilization = courseOnly
    ? courseCapacity.current.capacity > 0
      ? round(
          (courseCapacity.current.bookedSeats /
            courseCapacity.current.capacity) *
            100,
        )
      : null
    : capacities.current.total > 0
      ? round((stats.current.participantHours / capacities.current.total) * 100)
      : null;
  const comparisonUtilization = courseOnly
    ? periods.comparison && courseCapacity.comparison.capacity > 0
      ? round(
          (courseCapacity.comparison.bookedSeats /
            courseCapacity.comparison.capacity) *
            100,
        )
      : null
    : periods.comparison &&
        capacities.comparison &&
        capacities.comparison.total > 0
      ? round(
          (stats.comparison.participantHours / capacities.comparison.total) *
            100,
        )
      : null;
  const seriesUtilization = courseOnly
    ? buildCourseUtilizationSeries(
        courseCapacityByBucket,
        courseBookedSeatsByBucket,
      )
    : buildUtilizationSeries(capacities.current.byBucket, series);

  const heatKeys = new Set([
    ...capacities.current.heatmap.keys(),
    ...heat.keys(),
  ]);
  const heatmap = courseOnly
    ? []
    : [...heatKeys]
        .map((key) => {
          const entry = heat.get(key) ?? {
            bookings: 0,
            participants: 0,
            bookedHours: 0,
          };
          const [weekday, hour] = key.split(":").map(Number);
          const capacity = capacities.current.heatmap.get(key) ?? 0;
          return {
            weekday,
            hour,
            bookings: entry.bookings,
            participants: entry.participants,
            capacity: round(capacity),
            utilizationPercent:
              capacity > 0 ? round((entry.bookedHours / capacity) * 100) : null,
          };
        })
        .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);

  return {
    report: {
      total: stats.current.total,
      participants: stats.current.participants,
      cancellations: stats.current.cancellations,
      noShows: null,
      bookedHours: round(stats.current.bookedHours),
      utilizationPercent: currentUtilization,
      bookingTypes: [...typeTotals.entries()]
        .map(([type, values]) => ({ type, ...values }))
        .sort((a, b) => b.count - a.count),
      heatmap,
      courseFill: coursesAllowed
        ? [...courseFill.values()]
            .filter((entry) => entry.capacity > 0)
            .map((entry) => ({
              ...entry,
              fillPercent: round((entry.bookedSeats / entry.capacity) * 100),
            }))
            .sort((a, b) => b.fillPercent - a.fillPercent)
        : null,
      limitations: [
        "No-shows and attendance are unavailable.",
        courseOnly
          ? "Utilization is based on configured course capacity."
          : "Utilization is a deterministic capacity-hours estimate.",
      ],
    },
    current: {
      ...stats.current,
      utilizationPercent: currentUtilization,
    },
    comparison: periods.comparison
      ? {
          ...stats.comparison,
          utilizationPercent: comparisonUtilization,
        }
      : null,
    series,
    seriesUtilization,
    records: bookings,
  };
};

export const averageLinkedCustomerSpend = (
  orders: any[],
  currency: string,
): number | null => {
  const linkedOrders = orders.filter(
    (order) =>
      order._reportPeriod === "current" &&
      String(order.currency || "").toUpperCase() ===
        String(currency || "").toUpperCase() &&
      Boolean(id(order.createdBy)),
  );
  if (!linkedOrders.length) return null;
  if (
    linkedOrders.some(
      (order) =>
        order._reportNetSalesMinor === null ||
        !Number.isFinite(Number(order._reportNetSalesMinor)),
    )
  ) {
    return null;
  }
  const customers = new Set(
    linkedOrders.map((order) => id(order.createdBy)).filter(Boolean),
  );
  if (!customers.size) return null;
  const netSalesMinor = linkedOrders.reduce(
    (sum, order) => sum + Number(order._reportNetSalesMinor),
    0,
  );
  return Math.round(netSalesMinor / customers.size);
};

export const buildUtilizationSeries = (
  capacityByBucket: Map<string, number>,
  bookingSeries: Map<string, { participantHours: number }>,
): Map<string, number | null> => {
  const result = new Map<string, number | null>();
  for (const key of new Set([
    ...capacityByBucket.keys(),
    ...bookingSeries.keys(),
  ])) {
    const capacity = capacityByBucket.get(key) ?? 0;
    const participantHours = bookingSeries.get(key)?.participantHours ?? 0;
    result.set(
      key,
      capacity > 0 ? round((participantHours / capacity) * 100) : null,
    );
  }
  return result;
};

export const reportSeriesValue = (
  series: Map<string, number | null>,
  key: string,
): number | null => (series.has(key) ? series.get(key)! : 0);

const buildCustomers = async ({
  context,
  tenant,
  scope,
  periods,
  coverage,
  sales,
  courseOnly,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  coverage: CoverageBuilder;
  sales: any;
  courseOnly: boolean;
}) => {
  const moduleEnabled = tenant.modules?.[TENANT_MODULE.CUSTOMERS] === true;
  const permission = hasPermission(
    context,
    WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
  );
  if (
    !sourceAvailability({
      coverage,
      source: "customers",
      moduleEnabled,
      permissions: [permission],
    })
  )
    return { report: null, current: null, comparison: null };
  if (!sales.report) {
    coverage.available.delete("customers");
    coverage.unavailable.push({
      source: "customers",
      reason: "sales_source_required",
    });
    return { report: null, current: null, comparison: null };
  }

  const currentIds = new Set<string>();
  const comparisonIds = new Set<string>();
  for (const order of sales.orders) {
    const customerId = id(order.createdBy);
    if (!customerId) continue;
    if (order._reportPeriod === "current") currentIds.add(customerId);
    if (order._reportPeriod === "comparison") comparisonIds.add(customerId);
  }
  if (courseOnly) {
    const limitedOverview = (ids: Set<string>, period: ReportPeriod | null) =>
      period
        ? {
            active: ids.size,
            new: null,
            returning: null,
            returningRatePercent: null,
          }
        : null;
    const current = limitedOverview(currentIds, periods.current)!;
    const comparison = limitedOverview(comparisonIds, periods.comparison);
    coverage.limitations.add(
      "Limited-plan customer lifecycle is not classified because historical non-course orders are intentionally excluded.",
    );
    return {
      report: {
        ...current,
        averageSpendMinor: averageLinkedCustomerSpend(
          sales.orders,
          sales.report.currency,
        ),
        limitations: [
          "Active customers and average spend use course-linked orders only; new/returning classification is unavailable.",
        ],
      },
      current,
      comparison,
    };
  }

  coverage.limitations.add(
    "New and returning customers use the first paid order linked by createdBy; guest identity and merged accounts can affect counts.",
  );
  const allIds = [...new Set([...currentIds, ...comparisonIds])];
  const firstPaidAt = new Map<string, Date>();
  if (allIds.length) {
    const history = (await Order.find({
      tenant: context.tenantId,
      createdBy: { $in: allIds },
      isPaid: true,
      status: ORDER_STATUS.PROCESSED,
      paidAt: { $lt: periods.current.endExclusive },
      ...orderLocationFilter(scope),
    })
      .select("createdBy paidAt locationIds lineItems creditPurchase")
      .sort({ paidAt: 1 })
      .lean()) as any[];
    for (const order of history) {
      if (Number(order.creditPurchase?.amount ?? 0) > 0) continue;
      if (!isOrderEligibleForScopedFacts(order, scope)) continue;
      const customerId = id(order.createdBy);
      const paidAt = asDate(order.paidAt);
      if (customerId && paidAt && !firstPaidAt.has(customerId)) {
        firstPaidAt.set(customerId, paidAt);
      }
    }
  }

  const classify = (ids: Set<string>, period: ReportPeriod | null) => {
    if (!period) return null;
    let fresh = 0;
    let returning = 0;
    for (const customerId of ids) {
      const first = firstPaidAt.get(customerId);
      if (first && first >= period.start) fresh += 1;
      else returning += 1;
    }
    return {
      active: ids.size,
      new: fresh,
      returning,
      returningRatePercent:
        ids.size > 0 ? round((returning / ids.size) * 100) : 0,
    };
  };
  const current = classify(currentIds, periods.current)!;
  const comparison = classify(comparisonIds, periods.comparison);
  return {
    report: {
      ...current,
      averageSpendMinor: averageLinkedCustomerSpend(
        sales.orders,
        sales.report.currency,
      ),
      limitations: [
        "Customer lifecycle is based on non-credit-pack paid orders linked to user accounts.",
        "Average spend uses only net sales from linked customers with eligible orders in the workspace currency; guest sales are excluded.",
      ],
    },
    current,
    comparison,
  };
};

const locationPredicate = (scope: ReportLocationScope, field: string) => ({
  [field]: { $in: scope.locationIds },
});

const buildInventory = async ({
  context,
  tenant,
  scope,
  periods,
  currency,
  coverage,
  now,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  currency: string;
  coverage: CoverageBuilder;
  now: Date;
}) => {
  if (
    !sourceAvailability({
      coverage,
      source: "inventory",
      moduleEnabled: tenant.modules?.[TENANT_MODULE.INVENTORY] === true,
      permissions: [
        hasPermission(context, WORKSPACE_PERMISSION.INVENTORY_VIEW),
      ],
    })
  )
    return null;
  const [movements, items, openReorders, audits] = await Promise.all([
    InventoryMovement.find({
      tenant: context.tenantId,
      ...locationPredicate(scope, "location"),
      createdAt: {
        $gte: periods.current.start,
        $lt: periods.current.endExclusive,
      },
    })
      .select("item type reason quantity totalWithoutVat currency")
      .lean(),
    InventoryItem.find({
      tenant: context.tenantId,
    })
      .select("_id unit isActive stockLevels")
      .lean(),
    ReorderRequest.countDocuments({
      tenant: context.tenantId,
      ...locationPredicate(scope, "location"),
      status: { $in: [REORDER_STATUS.OPEN, REORDER_STATUS.ORDERED] },
    }),
    InventoryAudit.find({
      tenant: context.tenantId,
      ...locationPredicate(scope, "location"),
      status: INVENTORY_AUDIT_STATUS.COMPLETED,
      completedAt: {
        $gte: periods.current.start,
        $lt: periods.current.endExclusive,
      },
    })
      .select("items")
      .lean(),
  ]);
  const itemUnits = new Map(
    (items as any[]).map((item) => [
      id(item._id),
      String(item.unit || "unknown"),
    ]),
  );
  const consumedByUnit = new Map<string, number>();
  const purchasedByUnit = new Map<string, number>();
  const differenceByUnit = new Map<string, number>();
  let purchaseCostWithoutVatMinor = 0;
  let mixedPurchaseCurrency = false;
  let missingPurchaseCurrency = false;
  let unknownUnit = false;
  const addUnitQuantity = (
    map: Map<string, number>,
    itemId: unknown,
    quantity: number,
  ) => {
    const unit = itemUnits.get(id(itemId)) || "unknown";
    if (unit === "unknown") unknownUnit = true;
    map.set(unit, (map.get(unit) ?? 0) + quantity);
  };
  for (const movement of movements as any[]) {
    if (movement.type === INVENTORY_MOVEMENT_TYPE.OUT) {
      addUnitQuantity(
        consumedByUnit,
        movement.item,
        Math.max(Number(movement.quantity ?? 0), 0),
      );
    }
    if (
      movement.type === INVENTORY_MOVEMENT_TYPE.IN &&
      movement.reason === INVENTORY_MOVEMENT_REASON.PURCHASE
    ) {
      addUnitQuantity(
        purchasedByUnit,
        movement.item,
        Math.max(Number(movement.quantity ?? 0), 0),
      );
      if (String(movement.currency || "").toUpperCase() === currency) {
        const amount = Math.max(Number(movement.totalWithoutVat ?? 0), 0);
        if (isStudioCommerceCurrency(currency)) {
          try {
            purchaseCostWithoutVatMinor += toCurrencyMinorUnits(
              amount,
              currency,
            );
          } catch {
            coverage.limitations.add(
              "An inventory purchase cost with invalid currency precision was excluded.",
            );
          }
        }
      } else if (movement.currency) {
        mixedPurchaseCurrency = true;
      } else {
        missingPurchaseCurrency = true;
      }
    }
  }
  if (mixedPurchaseCurrency) {
    coverage.limitations.add(
      `Inventory purchase cost includes ${currency} only; other currencies are not summed.`,
    );
  }
  if (missingPurchaseCurrency) {
    coverage.limitations.add(
      "Inventory purchase cost is unavailable because at least one legacy purchase has no currency.",
    );
  }
  const locationSet = new Set(scope.locationIds);
  const lowStockItems = (items as any[]).filter(
    (item) =>
      item.isActive !== false &&
      (item.stockLevels ?? []).some(
        (level: any) =>
          locationSet.has(id(level.location)) &&
          Number(level.minimumQuantity ?? 0) > 0 &&
          Number(level.currentQuantity ?? 0) <=
            Number(level.minimumQuantity ?? 0),
      ),
  ).length;
  for (const audit of audits as any[]) {
    for (const item of audit.items ?? []) {
      addUnitQuantity(
        differenceByUnit,
        item.item,
        Number(item.difference ?? 0),
      );
    }
  }
  if (unknownUnit) {
    coverage.limitations.add(
      "Inventory quantities for deleted or legacy items are grouped under the unknown unit.",
    );
  }
  const unitRows = (map: Map<string, number>) =>
    [...map.entries()]
      .map(([unit, quantity]) => ({ unit, quantity: round(quantity, 4) }))
      .sort((a, b) => a.unit.localeCompare(b.unit));
  return {
    asOf: now.toISOString(),
    consumptionByUnit: unitRows(consumedByUnit),
    purchasesByUnit: unitRows(purchasedByUnit),
    purchaseCostWithoutVatMinor: missingPurchaseCurrency
      ? null
      : purchaseCostWithoutVatMinor,
    openReorders,
    lowStockItems,
    stocktakeDifferenceByUnit: unitRows(differenceByUnit),
    limitations: [
      "Consumption sums OUT movements and excludes transfers and audit movements.",
      "Purchase cost is a minor-unit amount without VAT in the workspace currency.",
      "Reorder cost is unavailable until a purchase receipt creates an inventory movement.",
      "Open reorders and low-stock items are point-in-time snapshots at asOf.",
    ],
  };
};

const buildStaffTasks = async ({
  context,
  tenant,
  scope,
  periods,
  coverage,
  now,
}: {
  context: ReportContext;
  tenant: any;
  scope: ReportLocationScope;
  periods: ResolvedReportPeriod;
  coverage: CoverageBuilder;
  now: Date;
}) => {
  if (
    !sourceAvailability({
      coverage,
      source: "staffTasks",
      moduleEnabled: tenant.modules?.[TENANT_MODULE.STAFF_TASKS] === true,
      permissions: [hasPermission(context, WORKSPACE_PERMISSION.TASKS_VIEW)],
    })
  )
    return null;
  const locationFilter = {
    $or: [
      { appliesToAllLocations: true },
      { appliesToAllLocations: false, locationId: null },
      { locationId: { $in: scope.locationIds } },
    ],
  };
  // open/overdue only ever need counts (see below), so they're counted in
  // MongoDB directly instead of fetching every still-open task into Node —
  // both correct (open/overdue task backlogs are unbounded over a tenant's
  // lifetime) and cheaper than the previous find()+filter()+.length.
  const openTaskFilter = {
    tenantId: context.tenantId,
    ...locationFilter,
    status: { $ne: STAFF_TASK_STATUS.DONE },
  } as any;
  const [completedRows, openCount, overdueCount, dueRows] = await Promise.all([
    StaffTaskModel.find({
      tenantId: context.tenantId,
      ...locationFilter,
      completedAt: { $gte: periods.queryStart, $lt: periods.queryEndExclusive },
      status: STAFF_TASK_STATUS.DONE,
    } as any)
      .select("completedAt")
      .lean(),
    StaffTaskModel.countDocuments(openTaskFilter),
    StaffTaskModel.countDocuments({ ...openTaskFilter, dueDate: { $lt: now } }),
    StaffTaskModel.find({
      tenantId: context.tenantId,
      ...locationFilter,
      dueDate: {
        $gte: periods.current.start,
        $lt: periods.current.endExclusive,
      },
    } as any)
      .select("status completedAt")
      .lean(),
  ]);
  let completed = 0;
  let previousCompleted = 0;
  for (const task of completedRows as any[]) {
    const period = periodForDate(asDate(task.completedAt), periods);
    if (period === "current") completed += 1;
    if (period === "comparison") previousCompleted += 1;
  }
  const due = (dueRows as any[]).length;
  const completedDue = (dueRows as any[]).filter(
    (task) => task.status === STAFF_TASK_STATUS.DONE,
  ).length;
  return {
    asOf: now.toISOString(),
    completed,
    previousCompleted: periods.comparison ? previousCompleted : null,
    changePercent: periods.comparison
      ? changePercent(completed, previousCompleted)
      : null,
    open: openCount,
    overdue: overdueCount,
    completionRatePercent: due > 0 ? round((completedDue / due) * 100) : null,
    limitations: scope.requestedLocationId
      ? [
          "Tasks applying to all locations are included in each location report and must not be summed across location exports.",
          "Open and overdue tasks are point-in-time snapshots at asOf.",
        ]
      : ["Open and overdue tasks are point-in-time snapshots at asOf."],
  };
};

export const resolveReportLocale = (
  requestedLocale?: string,
  preferredLocale?: string,
  defaultLocale?: string,
): string => {
  const locale = String(
    requestedLocale || preferredLocale || defaultLocale || "en",
  ).toLowerCase();
  return locale.startsWith("cz") ? "cs" : locale;
};

export const deterministicInsights = ({
  summary,
  coverage,
  locale,
}: {
  summary: Record<string, ReportKpi>;
  coverage: ReportCoverage;
  locale: string;
}) => {
  const cs = locale.toLowerCase().startsWith("cs");
  const highlights: string[] = [];
  const attention: string[] = [];
  const recommendations: string[] = [];
  const sales = summary.netSales;
  const bookings = summary.bookings;
  const utilization = summary.utilizationPercent;
  if (sales.value !== null && sales.changePercent !== null) {
    highlights.push(
      cs
        ? `Tržby se oproti předchozímu období změnily o ${sales.changePercent} %.`
        : `Net sales changed by ${sales.changePercent}% versus the previous period.`,
    );
  }
  if (bookings.value !== null && bookings.changePercent !== null) {
    highlights.push(
      cs
        ? `Počet rezervací se oproti předchozímu období změnil o ${bookings.changePercent} %.`
        : `Bookings changed by ${bookings.changePercent}% versus the previous period.`,
    );
  }
  if (utilization.value !== null && utilization.value < 30) {
    attention.push(
      cs
        ? `Využití kapacity je ${utilization.value} %.`
        : `Configured-capacity utilization is ${utilization.value}%.`,
    );
    recommendations.push(
      cs
        ? "Zkontrolujte časový přehled a zvažte propagaci méně využitých termínů."
        : "Review the time breakdown and consider promoting lower-utilization slots.",
    );
  }
  if (!coverage.complete || coverage.limitations.length) {
    attention.push(
      cs
        ? "Některé zdroje nebo ukazatele mají omezené pokrytí."
        : "Some sources or metrics have limited coverage.",
    );
  }
  if (!highlights.length) {
    highlights.push(
      cs
        ? "Přehled je založen pouze na dostupných ověřených datech."
        : "This overview uses only available verified data.",
    );
  }
  return { highlights, attention, recommendations };
};

export const buildReportOverview = async ({
  context,
  query,
  now = new Date(),
}: {
  context: ReportContext;
  query: ReportQuery;
  now?: Date;
}) => {
  const tenant = await TenantModel.findById(context.tenantId)
    .select("modules settings plan planVersion")
    .lean();
  if (!tenant) notFound("Workspace not found.");
  const reportEntitlement = getReportPlanEntitlement({
    plan: tenant.plan as TenantPlan,
    planVersion: Number(tenant.planVersion ?? 1),
  });
  const timezone = String(tenant.settings?.timezone || "UTC");
  const currency = String(tenant.settings?.currency || "CZK").toUpperCase();
  const periods = resolveReportPeriod({ query, timezone, now });
  const scope = await resolveReportLocationScope({
    context,
    locationId: query.locationId,
  });
  if (
    scope.locationIds.length > 1 &&
    !reportEntitlement.consolidatedLocations
  ) {
    forbidden({
      message: "Cross-location reporting is not included in the current plan.",
      code: "CONSOLIDATED_REPORTING_NOT_ENTITLED",
      details: {
        reportingTier: reportEntitlement.tier,
        currentPlan: tenant.plan,
      },
    });
  }
  const locations = (await LocationModel.find({
    tenant: context.tenantId,
    _id: { $in: scope.locationIds },
  })
    .select("_id isActive booking openingHours")
    .lean()) as any[];
  const coverageBuilder: CoverageBuilder = {
    available: new Set(),
    unavailable: [],
    limitations: new Set(),
  };
  const productsAllowed = hasPermission(
    context,
    WORKSPACE_PERMISSION.PRODUCTS_VIEW,
  );
  const coursesAllowed = sourceAvailability({
    coverage: coverageBuilder,
    source: "courses",
    moduleEnabled:
      tenant.modules?.[TENANT_MODULE.COURSES] === true &&
      tenant.modules?.[TENANT_MODULE.BOOKINGS] === true,
    permissions: [
      hasPermission(context, WORKSPACE_PERMISSION.COURSES_VIEW),
      hasPermission(context, WORKSPACE_PERMISSION.BOOKINGS_VIEW),
      productsAllowed,
    ],
  });

  const [sales, bookings] = await Promise.all([
    buildSales({
      context,
      tenant,
      scope,
      periods,
      timezone,
      currency,
      coverage: coverageBuilder,
      productsAllowed,
      courseOnly: reportEntitlement.courseOnly,
    }),
    buildBookings({
      context,
      tenant,
      scope,
      periods,
      timezone,
      locations,
      coverage: coverageBuilder,
      coursesAllowed,
      courseOnly: reportEntitlement.courseOnly,
    }),
  ]);
  const customers = await buildCustomers({
    context,
    tenant,
    scope,
    periods,
    coverage: coverageBuilder,
    sales,
    courseOnly: reportEntitlement.courseOnly,
  });
  let inventory = null;
  let staffTasks = null;
  if (reportEntitlement.studioOperations) {
    [inventory, staffTasks] = await Promise.all([
      buildInventory({
        context,
        tenant,
        scope,
        periods,
        currency,
        coverage: coverageBuilder,
        now,
      }),
      buildStaffTasks({
        context,
        tenant,
        scope,
        periods,
        coverage: coverageBuilder,
        now,
      }),
    ]);
  } else {
    for (const source of ["inventory", "staffTasks"]) {
      coverageBuilder.unavailable.push({ source, reason: "plan_tier" });
    }
  }

  const summary = {
    netSales: sales.report
      ? kpi(
          sales.primaryCurrentNetSalesMinor,
          sales.primaryComparisonNetSalesMinor,
        )
      : kpi(null, null),
    bookings: bookings.current
      ? kpi(bookings.current.total, bookings.comparison?.total ?? null)
      : kpi(null, null),
    participants: bookings.current
      ? kpi(
          bookings.current.participants,
          bookings.comparison?.participants ?? null,
        )
      : kpi(null, null),
    utilizationPercent: bookings.current
      ? kpi(
          bookings.current.utilizationPercent,
          bookings.comparison?.utilizationPercent ?? null,
        )
      : kpi(null, null),
    returningCustomerPercent: customers.current
      ? kpi(
          customers.current.returningRatePercent,
          customers.comparison?.returningRatePercent ?? null,
        )
      : kpi(null, null),
  };

  const timeSeries = buildReportBuckets({
    period: periods.current,
    timezone,
    granularity: periods.granularity,
  }).map((bucket) => ({
    periodStart: bucket.periodStart,
    periodEnd: bucket.periodEnd,
    netSalesMinor: sales.report
      ? reportSeriesValue(sales.series, bucket.key)
      : null,
    bookings: bookings.report
      ? (bookings.series.get(bucket.key)?.bookings ?? 0)
      : null,
    participants: bookings.report
      ? (bookings.series.get(bucket.key)?.participants ?? 0)
      : null,
    utilizationPercent: bookings.report
      ? (bookings.seriesUtilization.get(bucket.key) ?? null)
      : null,
  }));
  const meaningfulUnavailable = coverageBuilder.unavailable.filter(
    (entry) =>
      entry.reason !== "module_disabled" && entry.reason !== "plan_tier",
  );
  const coverage: ReportCoverage = {
    available: [...coverageBuilder.available].sort(),
    unavailable: [...coverageBuilder.unavailable].sort(
      (a, b) =>
        a.source.localeCompare(b.source) || a.reason.localeCompare(b.reason),
    ),
    limitations: [...coverageBuilder.limitations].sort(),
    complete: meaningfulUnavailable.length === 0,
  };
  const locale = resolveReportLocale(
    query.locale,
    context.access.preferences.language,
    tenant.settings?.defaultLanguage,
  );
  return {
    metadata: {
      timezone,
      currency,
      period: {
        from: periods.current.from,
        to: periods.current.to,
      },
      comparisonPeriod: periods.comparison
        ? {
            from: periods.comparison.from,
            to: periods.comparison.to,
          }
        : null,
      granularity: periods.granularity,
      generatedAt: now.toISOString(),
      locationId: scope.requestedLocationId,
      locale,
      reportingTier: reportEntitlement.tier,
      consolidatedLocations: reportEntitlement.consolidatedLocations,
    },
    coverage,
    summary,
    timeSeries,
    sales: sales.report,
    bookings: bookings.report,
    customers: customers.report,
    operations: {
      inventory,
      staffTasks,
    },
    insights: deterministicInsights({ summary, coverage, locale }),
  };
};

export const reportService = {
  overview: buildReportOverview,
};
