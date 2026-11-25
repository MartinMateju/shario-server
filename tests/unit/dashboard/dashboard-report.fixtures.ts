import type { DashboardManagementOverview } from "@/modules/dashboard/dashboard-management.types.js";
import type { DashboardContext } from "@/modules/dashboard/dashboard.types.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

export const tenantId = "507f1f77bcf86cd799439011";
export const creatorId = "507f1f77bcf86cd799439012";
export const locationId = "507f1f77bcf86cd799439013";
export const reportId = "507f1f77bcf86cd799439014";
export const metric = (value: number | null = 0, previous: number | null = 0) => ({ value, previous, changePercent: previous && value !== null ? (value - previous) / previous * 100 : null });

export const reportContextFixture = (): DashboardContext => ({
  tenantId, userId: creatorId,
  access: {
    tenantId, userId: creatorId, status: "active", role: "manager", customRoleId: null,
    customRoleName: null, membershipId: "507f1f77bcf86cd799439015", isPlatformBypass: false,
    permissions: [WORKSPACE_PERMISSION.WORKSPACE_VIEW, WORKSPACE_PERMISSION.REPORTS_VIEW, WORKSPACE_PERMISSION.REPORTS_EXPORT, WORKSPACE_PERMISSION.AI_USE, WORKSPACE_PERMISSION.BOOKINGS_VIEW],
    locationAccess: { mode: "selected", locationIds: [locationId] },
    preferences: {
      language: "cs", displayTimezone: "Europe/Prague", defaultLocation: null,
      defaultCalendarView: "week", weekStartsOn: 1, defaultLandingPage: "/app", contextualGuides: {},
      notifications: { bookingCreated: false, bookingAssigned: false, bookingCancelled: false, taskAssigned: false, inventoryAlerts: false, email: false, inApp: true },
    },
    workspaceProfile: { displayName: "Manager", jobTitle: "", calendarColor: "" }, accessVersion: 1,
  },
});

export const reportSnapshotFixture = (): DashboardManagementOverview => ({
  metadata: {
    generatedAt: "2026-11-07T13:05:00.000Z", snapshotAsOf: "2026-11-07T13:05:00.000Z", timezone: "Europe/Prague", currency: "CZK",
    locationId, locationIds: [locationId], period: {from:"2026-11-01",to:"2026-11-07"}, comparisonPeriod:{from:"2026-10-01",to:"2026-10-07"}, arrivalPeriod:{from:"2026-10-09",to:"2026-11-07"},
    visitsBasis:"elapsed_scheduled_bookings",newCustomersBasis:"first_recorded_scheduled_booking",revenueBasis:"confirmed_delivery",
    activeCustomerPeriod:{from:"2026-10-09",to:"2026-11-07"},activeCustomerComparisonPeriod:{from:"2026-09-08",to:"2026-10-07"},activeCustomersBasis:"booking_created",registeredCustomersBasis:"customer_record_created",
  },
  summary:{deliveredRevenueMinor:metric(null,null),visits:metric(68,58),uniqueCustomers:metric(52,46),newCustomers:metric(12,9),activeMemberships:metric(32,null)},
  customers:{available:true,total:metric(null,null),new:metric(null,null),activeLast30Days:metric(83,72),scope:"workspace",activeScope:"selected_locations"},
  revenueBreakdown:{available:true,complete:false,confirmedServicesMinor:metric(120000,100000),reason:"missing_fulfillment_evidence"},
  attendance:{available:true,source:"scheduled",sampleSize:256,hours:[{hour:16,count:43}],openStudio:metric(40,34),courses:metric(28,24)},
  topClients:{available:true,revenueAvailable:false,revenueComplete:false,byVisits:[{id:"client",name:"Private Customer",visits:6,revenueMinor:null}],byRevenue:[]},
  topProducts:{available:false,complete:false,basis:"confirmed_completed_services",items:[]},
  cash:{available:true,complete:false,receivedMinor:metric(4436000,3906000),refundsMinor:metric(150000,80000),refundCount:metric(2,1),netReceivedMinor:metric(null,null)},
  memberships:{available:true,scope:"selected_locations",new:metric(4,3),newSubscribers:metric(3,2),cancelled:metric(2,1)},
  orders:{available:true,activeCount:7,overdueCount:1,items:[{id:"order",reference:"Z-104",title:"Firemní akce pro zákazníka - soukromé zadání",deadline:"2026-11-06",status:"active",pieceCount:12}]},
  vouchers:{available:true,sold:metric(4,3),soldValueMinor:metric(200000,150000),redeemed:metric(2,1),redeemedValueMinor:metric(100000,50000)},
  issues:[{key:"overdue_custom_orders",count:1,href:"/app/custom-orders"}],
  coverage:{available:["bookings","memberships"],unavailable:[{source:"deliveredRevenue",reason:"missing_fulfillment_evidence"}],limitations:["Visits and arrival times use elapsed, confirmed scheduled bookings; check-in attendance is not recorded. Removed participants are excluded."],complete:false},
});
