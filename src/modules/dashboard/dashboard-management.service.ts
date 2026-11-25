import dayjs from "dayjs";
import Booking from "@/modules/booking/booking.model.js";
import {
  CLASS_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
} from "@/modules/booking/booking.constants.js";
import Order from "@/modules/order/order.model.js";
import { CustomOrder } from "@/modules/custom-orders/custom-order.model.js";
import UserMembership from "@/modules/membership/user-membership.model.js";
import { buildMembershipReportingLocationFilter } from "@/modules/membership/membership-reporting.js";
import User from "@/modules/user/user.model.js";
import { PLATFORM_ROLE, TENANT_ROLE } from "@/modules/user/user.constants.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import { VoucherLedger } from "@/modules/coupon/voucher-ledger.model.js";
import CommunicationEmailLogModel from "@/modules/communication-email-logs/communication-email-log.model.js";
import { InvoiceModel } from "@/modules/invoice/invoice.schema.js";
import { isNativeInvoicingEnabled } from "@/modules/invoice/invoice.feature.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/index.js";
import {
  WORKSPACE_PERMISSION as P,
  type WorkspacePermission,
} from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  resolveReportLocationScope,
  orderLocationFilter,
} from "@/modules/reports/reports.scope.js";
import { getReportPlanEntitlement } from "@/modules/reports/report-plan-entitlements.js";
import type {
  ReportCoverage,
  ReportPeriod,
} from "@/modules/reports/reports.types.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import {
  isStudioCommerceCurrency,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";
import type { DashboardContext, DashboardQuery } from "./dashboard.types.js";
import type {
  DashboardManagementOverview,
  ManagementClient,
} from "./dashboard-management.types.js";
import { getManagementCustomerDetails, getManagementSpendingRanking } from "./dashboard-management.customers.js";
import { calculateManagementPurchases } from "./dashboard-management.purchases.js";
import {
  managementActiveCustomerIds,
  managementSubscriberCounts,
} from "./dashboard-management.audience.js";
import {
  calculateConfirmedServiceRevenue,
  hasConfirmedServiceCompletion,
  inManagementPeriod,
  managementBookingCustomers,
  managementDate,
  managementId,
  managementKpi as kpi,
  managementNumber,
  managementParticipantCount,
  resolveManagementPeriods,
  scheduledBookingEligible,
} from "./dashboard-management.calculations.js";

// Bounded reads fail closed rather than returning plausible, truncated totals.
const MAX_ROWS = 20_000;
const BOOKING_FIELDS =
  "_id start end tag status paymentStatus participants attendanceManaged numberOfGuests createdBy author bookingProduct location";
const nullKpi = () => kpi(null, null);
const nonnegativeMinor = (value: unknown) => {
  const amount = managementNumber(value);
  return amount !== null && Number.isSafeInteger(amount) && amount >= 0
    ? amount
    : null;
};

export const buildDashboardManagement = async ({
  context,
  query,
  now = new Date(),
}: {
  context: DashboardContext;
  query: DashboardQuery;
  now?: Date;
}): Promise<DashboardManagementOverview> => {
  if (String(context.access.tenantId) !== context.tenantId)
    forbidden("Workspace access does not match this tenant.");
  const tenant = await TenantModel.findById(context.tenantId)
    .select("modules settings plan planVersion")
    .lean();
  if (!tenant) notFound("Workspace not found.");
  const entitlement = getReportPlanEntitlement({
    plan: tenant.plan as TenantPlan,
    planVersion: Number(tenant.planVersion ?? 1),
  });
  const timezone = String(tenant.settings?.timezone || "UTC");
  const currency = String(tenant.settings?.currency || "CZK").toUpperCase();
  const periods = resolveManagementPeriods(query.date, timezone, now);
  const scope = await resolveReportLocationScope({
    context,
    locationId: query.locationId,
  });
  if (scope.locationIds.length > 1 && !entitlement.consolidatedLocations)
    forbidden({
      message: "Cross-location reporting is not included in the current plan.",
      code: "CONSOLIDATED_REPORTING_NOT_ENTITLED",
    });
  const wholeTenant = scope.unrestricted && !scope.requestedLocationId;
  const coverage: ReportCoverage = {
    available: [],
    unavailable: [],
    limitations: [],
    complete: false,
  };
  const unavailable = (source: string, reason: string) => {
    if (
      !coverage.unavailable.some(
        (row) => row.source === source && row.reason === reason,
      )
    )
      coverage.unavailable.push({ source, reason });
  };
  const limitation = (reason: string) => {
    if (!coverage.limitations.includes(reason))
      coverage.limitations.push(reason);
  };
  const permit = (
    source: string,
    module: string,
    permissions: WorkspacePermission[],
    entitled = true,
  ) => {
    const modules = tenant.modules as Record<string, boolean> | undefined;
    const reason = !entitled
      ? "plan_tier"
      : modules?.[module] !== true
        ? "module_disabled"
        : permissions.some(
              (permission) =>
                !hasWorkspacePermission(context.access, permission),
            )
          ? "permission_denied"
          : null;
    if (reason) {
      unavailable(source, reason);
      return false;
    }
    return true;
  };
  const read = async (
    source: string,
    enabled: boolean,
    model: any,
    filter: Record<string, unknown>,
    fields: string,
  ): Promise<any[] | null> => {
    if (!enabled) return null;
    // Never recover from a missing tenant/location predicate with a tenant-wide read.
    const rows = await model
      .find({ tenant: context.tenantId, ...filter })
      .select(fields)
      .limit(MAX_ROWS + 1)
      .lean();
    if (rows.length > MAX_ROWS) {
      unavailable(source, "query_limit_exceeded");
      return null;
    }
    coverage.available.push(source);
    return rows;
  };
  const location = { location: { $in: scope.locationIds } };
  const monthDates = { $gte: periods.comparison.start, $lt: periods.asOf };
  const permittedCourses = permit("courses", "courses", [
    P.COURSES_VIEW,
    P.PRODUCTS_VIEW,
  ]);
  const permittedBookings = permit("bookings", "bookings", [P.BOOKINGS_VIEW]);
  const permittedCustomers = permit("customers", "customers", [
    P.CUSTOMERS_VIEW,
  ]);
  const permittedProducts = hasWorkspacePermission(
    context.access,
    P.PRODUCTS_VIEW,
  );
  const permittedFinancials = permit(
    "sales",
    "payments",
    [P.ORDERS_VIEW, P.PAYMENTS_VIEW],
    entitlement.studioOperations,
  );
  const permittedMemberships = permit(
    "memberships",
    "memberships",
    [P.MEMBERSHIPS_VIEW],
    entitlement.studioOperations,
  );
  const permittedVouchers = permit(
    "vouchers",
    "vouchers",
    [P.VOUCHERS_VIEW],
    entitlement.studioOperations,
  );
  const permittedCustomOrders = permit(
    "customOrders",
    "payments",
    [P.ORDERS_VIEW],
    entitlement.studioOperations,
  );
  const permittedEmails = permit(
    "emailIssues",
    "communications",
    [P.COMMUNICATIONS_AUDIT_VIEW],
    entitlement.studioOperations,
  );
  const nativeInvoicesEnabled = isNativeInvoicingEnabled();
  const permittedInvoices =
    nativeInvoicesEnabled &&
    permit(
      "paymentIssues",
      "payments",
      [P.INVOICES_VIEW, P.PAYMENTS_VIEW],
      entitlement.studioOperations,
    );
  if (!nativeInvoicesEnabled) unavailable("paymentIssues", "module_disabled");
  const tags = [
    ...(entitlement.courseOnly ? [] : OPEN_STUDIO_BOOKING_TAGS),
    ...(permittedCourses ? CLASS_BOOKING_TAGS : []),
  ];
  const bookingStart = new Date(
    Math.min(
      periods.comparison.start.getTime(),
      periods.arrivals.start.getTime(),
    ),
  );
  if (permittedVouchers && !wholeTenant)
    unavailable("vouchers", "location_attribution_unavailable");
  const membershipScope = buildMembershipReportingLocationFilter(
    wholeTenant ? null : scope.locationIds,
  );
  const [
    bookings,
    customOrders,
    memberships,
    coupons,
    ledger,
    emails,
    invoices,
  ] = await Promise.all([
    read(
      "bookings",
      permittedBookings && tags.length > 0,
      Booking,
      {
        ...location,
        tag: { $in: tags },
        $or: [
          { start: { $gte: bookingStart, $lt: periods.asOf } },
          { end: monthDates },
        ],
        end: { $lte: periods.asOf },
      },
      BOOKING_FIELDS,
    ),
    read(
      "customOrders",
      permittedCustomOrders,
      CustomOrder,
      { ...location, status: "active" },
      "_id reference title deadline deadlineAt status pieceCount",
    ),
    read(
      "memberships",
      permittedMemberships,
      UserMembership,
      membershipScope,
      "_id user status startedAt currentPeriodStart currentPeriodEnd cancelledAt selectedLocation assignmentSource",
    ),
    read(
      "voucherSales",
      permittedVouchers && wholeTenant,
      CouponOrder,
      { paidAt: monthDates },
      "_id quantity currencySnapshot unitPriceSnapshot totalSnapshot expectedAmountMinor paidAt status",
    ),
    read(
      "voucherRedemptions",
      permittedVouchers && wholeTenant,
      VoucherLedger,
      { createdAt: monthDates, kind: "commit" },
      "_id coupon currency amountMinor quantity createdAt",
    ),
    read(
      "emailIssues",
      permittedEmails,
      CommunicationEmailLogModel,
      {
        ...(wholeTenant ? {} : location),
        status: { $in: ["failed", "bounced", "ambiguous"] },
      },
      "_id status",
    ),
    read(
      "paymentIssues",
      permittedInvoices,
      InvoiceModel,
      {
        ...(wholeTenant ? {} : { locationIds: { $in: scope.locationIds } }),
        documentType: "invoice",
        documentStatus: "issued",
        amountDueMinor: { $gt: 0 },
        dueDate: { $lt: now },
      },
      "_id currency locationIds amountDueMinor",
    ),
  ]);
  const eligibleBookings = (bookings || []).filter((booking) =>
    scheduledBookingEligible(booking, periods.asOf),
  );
  const completedBookings = (bookings || []).filter((booking) =>
    hasConfirmedServiceCompletion(booking, periods.asOf),
  );
  const bookingIds = completedBookings.map((booking) => booking._id);
  const [orders, refundCandidates] = await Promise.all([
    read(
      "sales",
      permittedFinancials,
      Order,
      {
        ...orderLocationFilter(scope),
        $or: [
          { "lineItems.booking": { $in: bookingIds } },
          { paidAt: monthDates },
        ],
      },
      "_id currency status createdBy customer paidAt paidAmountMinor grossAmountMinor appliedDiscount lineItems paymentAllocations membershipRedemption courseCancellations waitlistRefund pieceCheckout locationIds",
    ),
    read(
      "bookingRefunds",
      permittedFinancials && permittedBookings,
      BookingPaymentRefund,
      { status: "succeeded", completedAt: monthDates },
      "_id booking currency cardAmountMinor completedAt",
    ),
  ]);
  // Refunds may refer to cancelled, future or older bookings. Resolve their
  // branch independently of the elapsed-booking attendance window.
  const refundBookings = await read(
    "refundLocations",
    refundCandidates !== null,
    Booking,
    {
      ...location,
      _id: { $in: (refundCandidates || []).map((row) => row.booking) },
      tag: { $in: tags },
    },
    "_id",
  );
  const visibleRefundBookings = new Set(
    (refundBookings || []).map((row) => managementId(row._id)),
  );
  const refunds =
    refundCandidates === null || refundBookings === null
      ? null
      : refundCandidates.filter((row) =>
          visibleRefundBookings.has(managementId(row.booking)),
        );
  const activityDates = {
    $gte: periods.activeCustomerComparison.start,
    $lt: periods.asOf,
  };
  const canReadActivity = permittedCustomers && permittedBookings;
  const [createdBookings, courseReservationOrders] = await Promise.all([
    read(
      "customerBookingActivity",
      canReadActivity && !entitlement.courseOnly,
      Booking,
      {
        ...location,
        tag: { $in: OPEN_STUDIO_BOOKING_TAGS },
        createdAt: activityDates,
        status: { $in: ["processed", "delivered", "completed", "cancelled"] },
        paymentStatus: { $in: ["CONFIRMED", null, ""] },
      },
      "_id createdBy createdAt tag status paymentStatus paymentConfirmedAt",
    ),
    // Course reservation identity is non-financial booking information, as in
    // the customer directory. No order prices or payments are returned.
    read(
      "customerCourseActivity",
      canReadActivity && permittedCourses,
      Order,
      {
        ...orderLocationFilter(scope),
        createdAt: activityDates,
        isPaid: true,
        status: { $in: ["processed_order", "cancelled_order"] },
        "courseBookings.0": { $exists: true },
      },
      "_id createdBy createdAt paidAt isPaid status courseBookings.bookingId courseBookings.quantity",
    ),
  ]);
  const activityClasses = await read(
    "customerCourseActivityLocations",
    courseReservationOrders !== null,
    Booking,
    {
      ...location,
      tag: { $in: CLASS_BOOKING_TAGS },
      _id: { $in: [...new Set((courseReservationOrders || []).flatMap((order) =>
        (order.courseBookings || []).map((slot: any) => slot.bookingId)))] },
    },
    "_id tag",
  );
  const activityAvailable = canReadActivity && tags.length > 0 &&
    (entitlement.courseOnly || createdBookings !== null) &&
    (tenant.modules?.courses !== true ||
      (permittedCourses && courseReservationOrders !== null && activityClasses !== null));
  const activeIds = (period: ReportPeriod) => managementActiveCustomerIds({
    bookings: createdBookings || [],
    courseOrders: courseReservationOrders || [],
    courseBookings: activityClasses || [],
    period,
    asOf: periods.asOf,
  });
  const activeCurrent = activeIds(periods.arrivals);
  const activePrevious = activeIds(periods.activeCustomerComparison);
  const canReadWorkspaceCustomers = permittedCustomers && scope.allowedLocationIds === null;
  if (permittedCustomers && !canReadWorkspaceCustomers)
    unavailable("registeredCustomers", "location_attribution_unavailable");
  // Customer records have no studio allocation. Only unrestricted staff may
  // receive workspace totals; restricted staff may resolve scoped booking IDs.
  const customerRecords = await read(
    canReadWorkspaceCustomers ? "registeredCustomers" : "customerActivityIdentities",
    canReadWorkspaceCustomers || activityAvailable,
    User,
    {
      tenantRole: TENANT_ROLE.CUSTOMER,
      platformRole: { $in: [PLATFORM_ROLE.NONE, null] },
      createdAt: { $lt: periods.asOf },
      ...(canReadWorkspaceCustomers ? {} : {
        _id: { $in: [...new Set([...activeCurrent, ...activePrevious])] },
      }),
    },
    "_id createdAt",
  );
  const registeredAvailable = canReadWorkspaceCustomers && customerRecords !== null;
  const knownCustomerIds = new Set((customerRecords || []).map((row) => managementId(row._id)));
  const activeCount = (ids: Set<string>) => activityAvailable && customerRecords !== null
    ? [...ids].filter((id) => knownCustomerIds.has(id)).length : null;
  const registeredNew = (period: ReportPeriod) => registeredAvailable
    ? customerRecords!.filter((row) => inManagementPeriod(row.createdAt, period)).length : null;
  limitation(
    "Registered customer totals and new customers use customer record creation dates across the workspace; imported records use their recorded creation dates. Workspace totals are unavailable to location-restricted staff.",
  );
  limitation(
    "Active customers are distinct registered customers who created a confirmed reservation in the last 30 calendar days in the selected, authorized studios, regardless of visit date or subscription. Open-studio reservations use booking creation dates; courses use completed reservation order creation dates. Later cancellations still count. Drafts, expired holds, instructors and unnamed guests do not count; staff-added course participants without a dated reservation order cannot be included.",
  );
  limitation(
    "Legacy reservations without confirmation timestamps use recorded creation dates; their exact historical confirmation timing cannot be verified.",
  );
  const byPeriod = (period: ReportPeriod) =>
    eligibleBookings.filter((booking) =>
      inManagementPeriod(booking.start, period),
    );
  const currentBookings = byPeriod(periods.current);
  const previousBookings = byPeriod(periods.comparison);
  const customerIds = (rows: any[]) =>
    new Set(
      rows.flatMap(managementBookingCustomers).map((customer) => customer.id),
    );
  const currentCustomers = customerIds(currentBookings);
  const previousCustomers = customerIds(previousBookings);
  const candidates = [...new Set([...currentCustomers, ...previousCustomers])];
  const history = await read(
    "customerHistory",
    bookings !== null && permittedCustomers && candidates.length > 0,
    Booking,
    {
      ...location,
      tag: { $in: tags },
      start: { $lt: bookingStart },
      $or: [
        { createdBy: { $in: candidates } },
        { "participants.customer": { $in: candidates } },
      ],
    },
    BOOKING_FIELDS,
  );
  const earliest = new Map<string, Date>();
  for (const booking of [...(history || []), ...eligibleBookings]) {
    if (!scheduledBookingEligible(booking, periods.asOf)) continue;
    const start = managementDate(booking.start);
    if (!start) continue;
    for (const customer of managementBookingCustomers(booking))
      if (!earliest.has(customer.id) || start < earliest.get(customer.id)!)
        earliest.set(customer.id, start);
  }
  const countNew = (customers: Set<string>, period: ReportPeriod) =>
    [...customers].filter((id) => inManagementPeriod(earliest.get(id), period))
      .length;
  const canCountNew =
    bookings !== null &&
    permittedCustomers &&
    (!candidates.length || history !== null);
  const participantCount = (rows: any[], filter: readonly string[] = tags) =>
    rows
      .filter((row) => filter.includes(row.tag))
      .reduce((sum, row) => sum + managementParticipantCount(row), 0);
  const visits = (rows: any[], filter?: readonly string[]) =>
    bookings === null ? null : participantCount(rows, filter);
  limitation(
    "Visits and arrival times use elapsed, confirmed scheduled bookings; check-in attendance is not recorded. Removed participants are excluded.",
  );
  limitation(
    "New customers means the first recorded elapsed scheduled booking in the selected, authorized studios; unnamed guests cannot be deduplicated.",
  );
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const booking of eligibleBookings)
    if (inManagementPeriod(booking.start, periods.arrivals))
      hours[dayjs(booking.start).tz(timezone).hour()]!.count +=
        managementParticipantCount(booking);
  const clients = new Map<string, ManagementClient>();
  if (permittedCustomers)
    for (const booking of currentBookings)
      for (const customer of managementBookingCustomers(booking)) {
        const row = clients.get(customer.id) || {
          ...customer,
          visits: 0,
          revenueMinor: null,
        };
        row.visits++;
        clients.set(customer.id, row);
      }
  const services = calculateConfirmedServiceRevenue({
    orders: orders || [],
    bookings: completedBookings,
    ...periods,
    currency,
    locationIds: scope.locationIds,
  });
  const revenueAvailable = bookings !== null && orders !== null;
  for (const client of services.clients)
    client.visits = clients.get(client.id)?.visits || 0;
  const topByVisits = [...clients.values()]
    .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name))
    .slice(0, 5);
  const canViewWorkspacePayments = permittedFinancials && permittedVouchers &&
    permittedMemberships && scope.allowedLocationIds === null;
  const canViewCustomerSpending = permittedCustomers && canViewWorkspacePayments;
  const spendingRanking = await getManagementSpendingRanking({
    tenantId: context.tenantId,
    canRankCustomers: permittedCustomers,
    enabled: canViewWorkspacePayments,
    currency,
    monthStart: periods.current.start,
    comparisonStart: periods.comparison.start,
    comparisonEnd: periods.comparison.endExclusive,
    asOf: periods.asOf,
    now,
  });
  const topByRevenue = spendingRanking.rankingAvailable && canViewCustomerSpending
    ? spendingRanking.items.map(row => ({ ...row, visits: clients.get(row.id)?.visits ?? 0 })) : [];
  if (spendingRanking.queryLimitExceeded)
    unavailable("recordedPayments", "query_limit_exceeded");
  if (spendingRanking.rankingLimitExceeded)
    unavailable("customerSpending", "query_limit_exceeded");
  const workspaceProductScope = scope.allowedLocationIds === null;
  const purchaseDates = { $or: [
    { paidAt: { $gte: periods.arrivals.start, $lt: periods.asOf } }, { paidAt: null },
  ] };
  const [purchaseOrders, purchaseVouchers] = await Promise.all([
    read("productPurchases", permittedFinancials && permittedProducts, Order,
      { ...(workspaceProductScope ? {} : orderLocationFilter(scope)), isPaid: true,
        status: "processed_order", ...purchaseDates },
      "_id status isPaid paidAt lineItems creditPurchase courseCancellations pieceCheckout.state pieceCheckout.refundedAmountMinor waitlistRefund paidAmountMinor refund"),
    read("voucherPurchases", permittedFinancials && permittedProducts && permittedVouchers && workspaceProductScope,
      CouponOrder, { status: { $in: ["processed_coupon", "shipped_coupon"] }, ...purchaseDates },
      "_id status paidAt product productNameSnapshot quantity expectedAmountMinor refundedAmountMinor refundState refundFailureReviewRequired"),
  ]);
  const purchases = calculateManagementPurchases({ orders: purchaseOrders ?? [], vouchers: purchaseVouchers ?? [],
    period: periods.arrivals, asOf: periods.asOf, now, locationIds: scope.locationIds, wholeTenant: workspaceProductScope });
  const purchasesComplete = purchaseOrders !== null && purchaseVouchers !== null && purchases.complete;
  if (purchaseOrders !== null && !workspaceProductScope) {
    unavailable("voucherPurchases", "location_attribution_unavailable");
    limitation("Product rankings cover the selected studios only. Voucher purchases are omitted because they cannot be assigned to a studio.");
  } else if (purchaseOrders !== null && purchaseVouchers === null) {
    limitation("Product rankings exclude voucher purchases because that source is unavailable.");
  }
  const customerDetails = await getManagementCustomerDetails({
    tenantId: context.tenantId,
    customerIds: [...new Set([...topByVisits, ...topByRevenue].map((row) => row.id))],
    canViewSpending: canViewCustomerSpending,
    currency,
    monthStart: periods.current.start,
    asOf: periods.asOf,
    now,
  });
  const enrichCustomer = (row: ManagementClient): ManagementClient => ({
    ...row,
    memberNumber: null,
    spentMonthMinor: null,
    spentTotalMinor: null,
    ...customerDetails.details.get(row.id),
    ...(row.spentMonthMinor !== undefined ? {
      spentMonthMinor: row.spentMonthMinor, spentMonthComplete: row.spentMonthComplete,
    } : {}),
  });
  if (customerDetails.queryLimitExceeded)
    unavailable("customerSpending", "query_limit_exceeded");
  if (canViewCustomerSpending)
    limitation(
      "Customer spending is workspace-wide cash collected for payments dated in the selected period, net of recorded external refunds. Stored-value purchases count once; later redemption does not. Missing payment dates, mixed currencies and unreconstructable historical refunds are unavailable.",
    );
  const recordedPaymentsComplete = spendingRanking.currentPaymentsComplete &&
    spendingRanking.comparisonPaymentsComplete;
  const recordedPayments = kpi(spendingRanking.currentPaymentsMinor, spendingRanking.comparisonPaymentsMinor);
  if (!recordedPaymentsComplete) recordedPayments.changePercent = null;
  if (spendingRanking.available) {
    coverage.available.push("recordedPayments");
    limitation(
      "Recorded payments cover the whole workspace by original payment date, net of recorded external refunds. Order payments, voucher purchases and membership invoices count once; later stored-value redemptions do not. They are not proof of service or product delivery.",
    );
    if (!recordedPaymentsComplete)
      limitation("Payment totals and spending rankings include only verified dated amounts when payment history is incomplete. Unknown amounts and dates are excluded and no percentage comparison is shown.");
  } else if (!canViewWorkspacePayments) {
    unavailable("recordedPayments", "permission_denied");
  }
  if (purchaseOrders !== null && !purchasesComplete)
    limitation("Product rankings count purchases with verified product quantities and payment dates. Incomplete purchase records are excluded; each product counts once per settled order in the last 30 calendar days.");
  const membershipCount = (field: string, period: ReportPeriod) =>
    memberships === null
      ? null
      : memberships.filter((row) => inManagementPeriod(row[field], period))
          .length;
  // Current status is never projected backwards into a historical month.
  const isCurrentDate =
    periods.current.to === dayjs(now).tz(timezone).format("YYYY-MM-DD");
  const subscriberCurrent = memberships === null ? null : managementSubscriberCounts({
    memberships, period: periods.current, asOf: periods.asOf, currentSnapshot: isCurrentDate,
  });
  const subscriberPrevious = memberships === null ? null : managementSubscriberCounts({
    memberships, period: periods.comparison, asOf: periods.comparison.endExclusive, currentSnapshot: false,
  });
  const activeMemberships = subscriberCurrent?.active ?? null;
  if (memberships !== null)
    limitation(
      "Previous active membership counts are unavailable because historical pause/status snapshots are not recorded. New and cancelled memberships use their recorded event dates.",
    );
  if (memberships !== null)
    limitation(
      "Active subscribers count each customer once while their membership is active or cancellation is scheduled and the current entitlement has not expired. New subscribers use each customer's first recorded membership activation in the selected scope; renewals, plan changes and returning subscribers are not new. Historical active subscriber snapshots are unavailable.",
    );
  const cashFor = (period: ReportPeriod) => {
    if (orders === null) return null;
    let total = 0;
    for (const order of orders) {
      if (
        !inManagementPeriod(order.paidAt, period) ||
        String(order.currency).toUpperCase() !== currency
      )
        continue;
      const locations = [
        ...(order.locationIds || []),
        ...(order.lineItems || []).flatMap(
          (line: any) => line.locationIds || [],
        ),
      ].map(managementId);
      if (
        !wholeTenant &&
        (!locations.length ||
          locations.some((id: string) => !scope.locationIds.includes(id)))
      )
        continue;
      const allocations = (order.paymentAllocations || []).filter(
        (payment: any) => ["stripe", "manual"].includes(payment.method),
      );
      // Without a payment-method snapshot, paidAmountMinor could include credits.
      for (const allocation of allocations)
        total += nonnegativeMinor(allocation.amountMinor) ?? 0;
    }
    return total;
  };
  const refundFor = (period: ReportPeriod) =>
    refunds === null
      ? null
      : refunds
          .filter(
            (row) =>
              String(row.currency).toUpperCase() === currency &&
              inManagementPeriod(row.completedAt, period),
          )
          .reduce(
            (sum, row) => sum + (nonnegativeMinor(row.cardAmountMinor) ?? 0),
            0,
          );
  if (orders !== null)
    limitation(
      "Cash receipts include only order Stripe/manual payment allocations. Membership invoices, voucher purchases and legacy allocations are excluded. Refunds include recorded card refunds for bookings in this report scope; other refund channels are excluded. These are partial cash figures, separate from delivered revenue.",
    );
  const voucherFor = (period: ReportPeriod) => {
    if (coupons === null || ledger === null) return null;
    const sold = coupons.filter(
      (row) =>
        ["processed_coupon", "shipped_coupon"].includes(row.status) &&
        String(row.currencySnapshot).toUpperCase() === currency &&
        inManagementPeriod(row.paidAt, period),
    );
    const redeemed = ledger.filter(
      (row) =>
        String(row.currency).toUpperCase() === currency &&
        inManagementPeriod(row.createdAt, period),
    );
    return {
      sold: sold.reduce(
        (sum, row) => sum + (managementNumber(row.quantity) ?? 0),
        0,
      ),
      soldValue: isStudioCommerceCurrency(currency)
        ? sold.reduce(
            (sum, row) =>
              sum +
              toCurrencyMinorUnits(
                (managementNumber(row.unitPriceSnapshot) ?? 0) *
                  (managementNumber(row.quantity) ?? 0),
                currency,
              ),
            0,
          )
        : null,
      redeemed: redeemed.length,
      redeemedValue: redeemed.reduce(
        (sum, row) => sum + (nonnegativeMinor(row.amountMinor) ?? 0),
        0,
      ),
    };
  };
  const voucherCurrent = voucherFor(periods.current),
    voucherPrevious = voucherFor(periods.comparison);
  if (coupons !== null)
    limitation(
      "Voucher sales use payment date and exclude shipping. Redemptions count committed checkout transactions before later reversals; wallet conversions and legacy unrecorded redemptions are excluded. Sales are not delivered revenue.",
    );
  const issues: DashboardManagementOverview["issues"] = [];
  const overdueOrders = (customOrders || []).filter(
    (row) =>
      managementDate(row.deadlineAt) && managementDate(row.deadlineAt)! < now,
  );
  if (overdueOrders.length)
    issues.push({
      key: "overdue_custom_orders",
      count: overdueOrders.length,
      href: "/app/custom-orders",
    });
  if (emails?.length)
    issues.push({
      key: "failed_emails",
      count: emails.length,
      href: "/app/communications?section=history",
    });
  const visibleInvoices = (invoices || []).filter(
    (row) =>
      wholeTenant ||
      (row.locationIds?.length &&
        row.locationIds.every((id: unknown) =>
          scope.locationIds.includes(managementId(id)),
        )),
  );
  if (visibleInvoices.length)
    issues.push({
      key: "overdue_invoices",
      count: visibleInvoices.length,
      ...(visibleInvoices.every(
        (row) => String(row.currency).toUpperCase() === currency,
      )
        ? {
            amountMinor: visibleInvoices.reduce(
              (sum, row) => sum + (nonnegativeMinor(row.amountDueMinor) ?? 0),
              0,
            ),
          }
        : {}),
      href: "/app/finance/invoices",
    });
  limitation(
    "Active custom orders and attention issues show the current state at generation time, independently of the selected comparison periods.",
  );
  return {
    metadata: {
      generatedAt: now.toISOString(),
      snapshotAsOf: now.toISOString(),
      timezone,
      currency,
      locationId: scope.requestedLocationId,
      locationIds: scope.locationIds,
      period: { from: periods.current.from, to: periods.current.to },
      comparisonPeriod: {
        from: periods.comparison.from,
        to: periods.comparison.to,
      },
      arrivalPeriod: { from: periods.arrivals.from, to: periods.arrivals.to },
      activeCustomerPeriod: { from: periods.arrivals.from, to: periods.arrivals.to },
      activeCustomerComparisonPeriod: {
        from: periods.activeCustomerComparison.from, to: periods.activeCustomerComparison.to,
      },
      activeCustomersBasis: "booking_created",
      registeredCustomersBasis: "customer_record_created",
      visitsBasis: "elapsed_scheduled_bookings",
      newCustomersBasis: "first_recorded_scheduled_booking",
      revenueBasis: "recorded_net_payments",
      revenueScope: "workspace",
    },
    summary: {
      recordedPaymentsMinor: recordedPayments,
      recordedPaymentsComplete,
      deliveredRevenueMinor: nullKpi(),
      visits: kpi(visits(currentBookings), visits(previousBookings)),
      uniqueCustomers:
        bookings === null || !permittedCustomers
          ? nullKpi()
          : kpi(currentCustomers.size, previousCustomers.size),
      newCustomers: canCountNew
        ? kpi(
            countNew(currentCustomers, periods.current),
            countNew(previousCustomers, periods.comparison),
          )
        : nullKpi(),
      activeMemberships: kpi(activeMemberships, null),
    },
    customers: {
      available: registeredAvailable || (activityAvailable && customerRecords !== null),
      total: registeredAvailable ? kpi(
        customerRecords!.length,
        customerRecords!.filter((row) => managementDate(row.createdAt)! < periods.comparison.endExclusive).length,
      ) : nullKpi(),
      new: kpi(registeredNew(periods.current), registeredNew(periods.comparison)),
      activeLast30Days: kpi(activeCount(activeCurrent), activeCount(activePrevious)),
      scope: "workspace",
      activeScope: wholeTenant ? "workspace" : "selected_locations",
    },
    revenueBreakdown: {
      available: revenueAvailable,
      complete: false,
      confirmedServicesMinor: revenueAvailable
        ? kpi(services.totals.current, services.totals.comparison)
        : nullKpi(),
      reason: "missing_fulfillment_evidence",
    },
    attendance: {
      available: bookings !== null,
      source: "scheduled",
      sampleSize: hours.reduce((sum, row) => sum + row.count, 0),
      hours,
      openStudio: entitlement.courseOnly
        ? nullKpi()
        : kpi(
            visits(currentBookings, OPEN_STUDIO_BOOKING_TAGS),
            visits(previousBookings, OPEN_STUDIO_BOOKING_TAGS),
          ),
      courses: permittedCourses
        ? kpi(
            visits(currentBookings, CLASS_BOOKING_TAGS),
            visits(previousBookings, CLASS_BOOKING_TAGS),
          )
        : nullKpi(),
    },
    topClients: {
      available: permittedCustomers && (bookings !== null || spendingRanking.rankingAvailable),
      revenueAvailable: canViewCustomerSpending && spendingRanking.rankingAvailable,
      revenueComplete: spendingRanking.complete,
      revenueBasis: "recorded_net_payments",
      spendingRankingScope: "workspace",
      spendingAvailable: canViewCustomerSpending && !customerDetails.queryLimitExceeded,
      spendingScope: "workspace",
      spendingBasis: "recorded_net_payments",
      byVisits: topByVisits.map(enrichCustomer),
      byRevenue: topByRevenue.map(enrichCustomer),
    },
    topProducts: {
      available: purchaseOrders !== null,
      complete: purchasesComplete,
      basis: "paid_purchases",
      scope: workspaceProductScope ? "workspace" : "selected_locations",
      period: { from: periods.arrivals.from, to: periods.arrivals.to },
      items: purchaseOrders !== null ? purchases.items : [],
    },
    cash: {
      available: orders !== null,
      complete: false,
      receivedMinor: kpi(cashFor(periods.current), cashFor(periods.comparison)),
      refundsMinor: kpi(
        refundFor(periods.current),
        refundFor(periods.comparison),
      ),
      refundCount:
        refunds === null
          ? nullKpi()
          : kpi(
              refunds.filter((row) =>
                inManagementPeriod(row.completedAt, periods.current),
              ).length,
              refunds.filter((row) =>
                inManagementPeriod(row.completedAt, periods.comparison),
              ).length,
            ),
      netReceivedMinor: nullKpi(),
    },
    memberships: {
      available: memberships !== null,
      scope: wholeTenant ? "workspace" : "selected_locations",
      newSubscribers: kpi(subscriberCurrent?.newSubscribers ?? null, subscriberPrevious?.newSubscribers ?? null),
      new: kpi(
        membershipCount("startedAt", periods.current),
        membershipCount("startedAt", periods.comparison),
      ),
      cancelled: kpi(
        membershipCount("cancelledAt", periods.current),
        membershipCount("cancelledAt", periods.comparison),
      ),
    },
    orders: {
      available: customOrders !== null,
      activeCount: customOrders?.length ?? null,
      overdueCount: customOrders === null ? null : overdueOrders.length,
      items: (customOrders || [])
        .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))
        .slice(0, 10)
        .map((row) => ({
          id: managementId(row._id),
          reference: row.reference,
          title: row.title,
          deadline: row.deadline,
          status: row.status,
          pieceCount: row.pieceCount,
        })),
    },
    vouchers: {
      available: voucherCurrent !== null,
      sold: kpi(voucherCurrent?.sold ?? null, voucherPrevious?.sold ?? null),
      soldValueMinor: kpi(
        voucherCurrent?.soldValue ?? null,
        voucherPrevious?.soldValue ?? null,
      ),
      redeemed: kpi(
        voucherCurrent?.redeemed ?? null,
        voucherPrevious?.redeemed ?? null,
      ),
      redeemedValueMinor: kpi(
        voucherCurrent?.redeemedValue ?? null,
        voucherPrevious?.redeemedValue ?? null,
      ),
    },
    issues,
    coverage,
  };
};
