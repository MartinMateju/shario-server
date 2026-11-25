import type {
  ReportCoverage,
  ReportKpi,
} from "@/modules/reports/reports.types.js";

export type DashboardManagementKpi = ReportKpi;
export type ManagementPeriod = { from: string; to: string };
export type ManagementClient = {
  id: string;
  name: string;
  visits: number;
  revenueMinor: number | null;
  memberNumber?: number | null;
  spentMonthMinor?: number | null;
  spentTotalMinor?: number | null;
  spentMonthComplete?: boolean;
};
export type ManagementProduct = {
  id: string;
  name: string;
  quantity: number;
  purchaseCount?: number;
  revenueMinor: number | null;
};

/** All monetary values are integer minor units, never formatted strings. */
export type DashboardManagementOverview = {
  metadata: {
    generatedAt: string;
    snapshotAsOf: string;
    timezone: string;
    currency: string;
    locationId: string | null;
    locationIds: string[];
    period: ManagementPeriod;
    comparisonPeriod: ManagementPeriod;
    arrivalPeriod: ManagementPeriod;
    activeCustomerPeriod: ManagementPeriod;
    activeCustomerComparisonPeriod: ManagementPeriod;
    activeCustomersBasis: "booking_created";
    registeredCustomersBasis: "customer_record_created";
    visitsBasis: "elapsed_scheduled_bookings";
    newCustomersBasis: "first_recorded_scheduled_booking";
    revenueBasis: "confirmed_delivery" | "recorded_net_payments";
    revenueScope?: "workspace" | "selected_locations";
  };
  customers: {
    available: boolean;
    total: ReportKpi;
    new: ReportKpi;
    activeLast30Days: ReportKpi;
    scope: "workspace";
    activeScope: "workspace" | "selected_locations";
  };
  summary: {
    recordedPaymentsMinor?: ReportKpi;
    recordedPaymentsComplete?: boolean;
    deliveredRevenueMinor: ReportKpi;
    visits: ReportKpi;
    uniqueCustomers: ReportKpi;
    newCustomers: ReportKpi;
    activeMemberships: ReportKpi;
  };
  revenueBreakdown: {
    available: boolean;
    complete: boolean;
    confirmedServicesMinor: ReportKpi;
    reason: string | null;
  };
  attendance: {
    available: boolean;
    source: "scheduled" | "recorded";
    sampleSize: number;
    hours: Array<{ hour: number; count: number }>;
    openStudio: ReportKpi;
    courses: ReportKpi;
  };
  topClients: {
    available: boolean;
    revenueAvailable: boolean;
    revenueComplete: boolean;
    spendingAvailable?: boolean;
    spendingScope?: "workspace";
    spendingBasis?: "recorded_net_payments";
    revenueBasis?: "recorded_net_payments";
    spendingRankingScope?: "workspace";
    byVisits: ManagementClient[];
    byRevenue: ManagementClient[];
  };
  topProducts: {
    available: boolean;
    complete: boolean;
    basis: "confirmed_completed_services" | "paid_purchases";
    period?: ManagementPeriod;
    scope?: "workspace" | "selected_locations";
    items: ManagementProduct[];
  };
  cash: {
    available: boolean;
    complete: boolean;
    receivedMinor: ReportKpi;
    refundsMinor: ReportKpi;
    refundCount: ReportKpi;
    netReceivedMinor: ReportKpi;
  };
  memberships: {
    available: boolean;
    scope: "workspace" | "selected_locations";
    new: ReportKpi;
    newSubscribers: ReportKpi;
    cancelled: ReportKpi;
  };
  orders: {
    available: boolean;
    activeCount: number | null;
    overdueCount: number | null;
    items: Array<{
      id: string;
      reference: string;
      title: string;
      deadline: string;
      status: string;
      pieceCount: number;
    }>;
  };
  vouchers: {
    available: boolean;
    sold: ReportKpi;
    soldValueMinor: ReportKpi;
    redeemed: ReportKpi;
    redeemedValueMinor: ReportKpi;
  };
  issues: Array<{
    key: string;
    count: number;
    amountMinor?: number;
    href: string;
  }>;
  coverage: ReportCoverage;
};
