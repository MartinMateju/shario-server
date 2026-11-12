import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";
const BOOKING_ID = "507f1f77bcf86cd799439014";
const PRODUCT_ID = "507f1f77bcf86cd799439015";

const mocks = vi.hoisted(() => ({
  tenant: null as any,
  scheduleRows: [] as any[],
  tenantFindById: vi.fn(),
  resolveScope: vi.fn(),
  reportOverview: vi.fn(),
  bookingFind: vi.fn(),
  bookingAggregate: vi.fn(),
  bookingCount: vi.fn(),
  bookingExists: vi.fn(),
  potteryAggregate: vi.fn(),
  firingCount: vi.fn(),
  courseCapacityAdvisor: vi.fn(),
  dashboardSignals: vi.fn(),
}));

const queryChain = (value: unknown) => {
  const chain: Record<string, any> = {};
  for (const method of ["sort", "limit", "select", "populate"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.lean = vi.fn(() => Promise.resolve(value));
  return chain;
};

vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: {
    findById: mocks.tenantFindById,
  },
}));

vi.mock("@/modules/reports/reports.scope.js", () => ({
  resolveReportLocationScope: mocks.resolveScope,
}));

vi.mock("@/modules/reports/reports.service.js", () => ({
  reportService: {
    overview: mocks.reportOverview,
  },
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
    aggregate: mocks.bookingAggregate,
    countDocuments: mocks.bookingCount,
    exists: mocks.bookingExists,
  },
}));

vi.mock("@/modules/pottery-piece/pottery-piece.model.js", () => ({
  PotteryPiece: {
    aggregate: mocks.potteryAggregate,
  },
}));

vi.mock("@/modules/firing/firing.model.js", () => ({
  Firing: {
    countDocuments: mocks.firingCount,
  },
}));

vi.mock("@/modules/dashboard/course-capacity-advisor.service.js", () => ({
  loadCourseCapacityAdvisor: mocks.courseCapacityAdvisor,
}));

vi.mock("@/modules/dashboard/dashboard.signals.js", () => ({
  loadDashboardSignals: mocks.dashboardSignals,
}));

import { buildDashboardOverview } from "@/modules/dashboard/dashboard.service.js";
import {
  BOOKING_TAG,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import {
  WORKSPACE_PERMISSION,
  type ResolvedWorkspaceAccess,
  type WorkspacePermission,
} from "@/modules/tenant-access/index.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

const allDashboardPermissions: WorkspacePermission[] = [
  WORKSPACE_PERMISSION.WORKSPACE_VIEW,
  WORKSPACE_PERMISSION.BOOKINGS_VIEW,
  WORKSPACE_PERMISSION.ORDERS_VIEW,
  WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
  WORKSPACE_PERMISSION.INVENTORY_VIEW,

  WORKSPACE_PERMISSION.TASKS_VIEW,
];

const access = (
  permissions = allDashboardPermissions,
): ResolvedWorkspaceAccess => ({
  membershipId: "507f1f77bcf86cd799439016",
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: "active",
  role: "staff",
  customRoleId: null,
  customRoleName: null,
  permissions,
  locationAccess: {
    mode: "selected",
    locationIds: [LOCATION_ID],
  },
  workspaceProfile: {
    jobTitle: "",
    displayName: "",
    calendarColor: "",
  },
  preferences: {
    language: "en",
    displayTimezone: null,
    defaultLocation: LOCATION_ID,
    defaultCalendarView: "month",
    weekStartsOn: 1,
    defaultLandingPage: "",
    contextualGuides: {},
    productTour: {
      version: 0,
      status: null,
      lastStep: null,
      updatedAt: null,
    },
    firstBookingCelebrationSeen: false,
    notifications: {
      bookingAssigned: true,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: true,
      inApp: true,
    },
  },
  accessVersion: 1,
  isPlatformBypass: false,
});

const fullReport = () => ({
  coverage: {
    available: [
      "bookings",
      "customers",
      "firings",
      "inventory",
      "sales",
      "staffTasks",
    ],
    unavailable: [],
    limitations: ["Verified report limitation."],
    complete: true,
  },
  summary: {
    bookings: { value: 14 },
    utilizationPercent: { value: 35 },
    netSales: { value: 1_840_000 },
  },
  bookings: {
    heatmap: [
      {
        weekday: 3,
        hour: 8,
        utilizationPercent: 50,
      },
      {
        weekday: 3,
        hour: 9,
        utilizationPercent: 75,
      },
    ],
  },
  customers: { new: 3 },
  operations: {
    inventory: { lowStockItems: 1 },
    staffTasks: { overdue: 2 },
  },
});

describe("dashboard overview service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenant = {
      modules: {
        [TENANT_MODULE.BOOKINGS]: true,
        [TENANT_MODULE.PAYMENTS]: true,
        [TENANT_MODULE.CUSTOMERS]: true,
        [TENANT_MODULE.FIRING]: true,
        [TENANT_MODULE.INVENTORY]: true,
        [TENANT_MODULE.STAFF_TASKS]: true,
      },
      settings: {
        timezone: "Europe/Prague",
        currency: "CZK",
      },
    };
    mocks.tenantFindById.mockImplementation(() => ({
      select: vi.fn(() => ({
        lean: vi.fn(() => Promise.resolve(mocks.tenant)),
      })),
    }));
    mocks.resolveScope.mockResolvedValue({
      requestedLocationId: LOCATION_ID,
      locationIds: [LOCATION_ID],
      allowedLocationIds: [LOCATION_ID],
      unrestricted: false,
    });
    mocks.reportOverview.mockResolvedValue(fullReport());
    mocks.scheduleRows = [
      {
        _id: BOOKING_ID,
        start: new Date("2026-07-30T08:00:00.000Z"),
        end: new Date("2026-07-30T10:00:00.000Z"),
        bookingProduct: {
          _id: PRODUCT_ID,
          name: "Open studio",
          type: "STUDIO_TIME",
          maxNumberOfParticipants: 8,
        },
        location: {
          _id: LOCATION_ID,
          name: "Grohova",
          booking: { globalCapacity: 12 },
        },
        participants: [{ firstname: "A", lastname: "B" }],
        numberOfGuests: 6,
        tag: "workshop",
        status: "processed",
      },
    ];
    mocks.bookingFind.mockImplementation(() => queryChain(mocks.scheduleRows));
    mocks.bookingAggregate.mockImplementation((pipeline) => {
      const match = pipeline?.[0]?.$match;
      return Promise.resolve(
        match?.end
          ? [{ _id: null, inStudio: 5 }]
          : [
              {
                _id: null,
                booked: 7,
                unpaidBookings: 2,
                expectedVisitors: 11,
              },
            ],
      );
    });
    mocks.bookingExists.mockResolvedValue(false);
    mocks.bookingCount.mockImplementation((query) => {
      if (query.paymentStatus === PAYMENT_STATUS.PENDING_PAYMENT) {
        return Promise.resolve(2);
      }
      if (query.end) return Promise.resolve(5);
      return Promise.resolve(7);
    });
    mocks.potteryAggregate.mockResolvedValue([
      {
        _id: "WAITING_BISQUE",
        quantity: 8,
      },
      {
        _id: "WAITING_GLAZE_FIRING",
        quantity: 4,
      },
      {
        _id: "BISQUE_FIRING",
        quantity: 24,
      },
      {
        _id: "READY_FOR_PICKUP",
        quantity: 9,
      },
    ]);
    mocks.firingCount.mockResolvedValue(1);
    mocks.courseCapacityAdvisor.mockResolvedValue({
      period: {
        key: "recent_56_tenant_calendar_days",
        from: "2026-06-05",
        to: "2026-07-30",
        days: 56,
        timezone: "Europe/Prague",
        asOf: "2026-07-30T07:45:00.000Z",
      },
      analyzedSessions: 0,
      signal: null,
    });
    mocks.dashboardSignals.mockResolvedValue({
      messages: {
        available: true,
        reason: null,
        unreadCount: 1,
        items: [
          {
            id: "conversation-1",
            subject: "Glazing question",
            contactName: "Ada",
            preview: "Can I collect it tomorrow?",
            lastMessageAt: "2026-07-30T07:30:00.000Z",
            unreadCount: 1,
          },
        ],
      },
      tasks: {
        available: true,
        reason: null,
        openCount: 1,
        items: [
          {
            id: "task-1",
            title: "Unload kiln",
            assigneeName: "Martin",
            priority: "urgent",
            dueDate: "2026-07-30T08:00:00.000Z",
          },
        ],
      },
      kilns: {
        available: true,
        reason: null,
        totalCount: 2,
        attentionCount: 1,
        items: [
          {
            id: "kiln-1",
            name: "Main kiln",
            status: "firing",
            locationName: "Grohova",
          },
        ],
      },
    });
  });

  it("builds the live, location-scoped dashboard contract from verified sources", async () => {
    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: {
        date: "2026-07-30",
        locationId: LOCATION_ID,
      },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(result.metadata).toEqual({
      date: "2026-07-30",
      timezone: "Europe/Prague",
      generatedAt: "2026-07-30T07:45:00.000Z",
      locationId: LOCATION_ID,
      locationIds: [LOCATION_ID],
      currency: "CZK",
    });
    expect(result.today).toEqual({
      available: true,
      schedule: [
        expect.objectContaining({
          id: BOOKING_ID,
          title: "Open studio",
          locationId: LOCATION_ID,
          locationName: "Grohova",
          participantCount: 6,
          capacity: 8,
        }),
      ],
    });
    expect(result.flow).toEqual([
      expect.objectContaining({ key: "booked", value: 14, available: true }),
      expect.objectContaining({
        key: "arriving",
        value: 11,
        unit: "people",
        available: true,
      }),
      expect.objectContaining({
        key: "inStudio",
        value: 5,
        unit: "people",
        available: true,
      }),
    ]);
    expect(result.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "unpaidBookings",
          count: 2,
          available: true,
        }),
        expect.objectContaining({
          key: "lowStock",
          count: 1,
          available: true,
        }),
        expect.objectContaining({
          key: "overdueTasks",
          count: 2,
          available: true,
        }),
      ]),
    );
    expect(result.businessPulse).toMatchObject({
      occupancy: { available: true, value: 35, unit: "percent" },
      revenue: {
        available: true,
        valueMinor: 1_840_000,
        currency: "CZK",
      },
      bookings: { available: true, value: 14 },
      newCustomers: { available: true, value: 3 },
      series: {
        available: true,
        key: "utilization",
        points: [
          { label: "08:00", value: 50 },
          { label: "09:00", value: 75 },
        ],
      },
    });
    expect(mocks.dashboardSignals).toHaveBeenCalledWith({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      modules: mocks.tenant.modules,
      locationIds: [LOCATION_ID],
    });
    expect(result.signals).toMatchObject({
      messages: { available: true, unreadCount: 1 },
      tasks: { available: true, openCount: 1 },
    });
    expect(result.opportunity).toEqual({
      available: true,
      key: "lowOccupancy",
      value: 35,
      href: "/app/products?action=create",
      actionKey: "createOffer",
      source: "deterministic",
    });
    expect(result.coverage.available).toEqual(
      expect.arrayContaining(["bookings", "schedule"]),
    );
    expect(result.coverage.limitations).toContain(
      "In-studio attendance is inferred from active confirmed bookings, not verified check-ins.",
    );

    expect(mocks.bookingAggregate).toHaveBeenCalledTimes(2);
    const dailyMatch = mocks.bookingAggregate.mock.calls[0][0][0].$match;
    const liveMatch = mocks.bookingAggregate.mock.calls[1][0][0].$match;
    expect(dailyMatch).toMatchObject({
      tenant: expect.anything(),
      location: { $in: [expect.anything()] },
      start: {
        $gte: new Date("2026-07-29T22:00:00.000Z"),
        $lt: new Date("2026-07-30T22:00:00.000Z"),
      },
      status: { $ne: "cancelled" },
      paymentStatus: {
        $in: [PAYMENT_STATUS.CONFIRMED, PAYMENT_STATUS.PENDING_PAYMENT],
      },
      tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
    });
    expect(liveMatch).toMatchObject({
      tenant: expect.anything(),
      location: { $in: [expect.anything()] },
      start: { $lte: new Date("2026-07-30T07:45:00.000Z") },
      end: { $gt: new Date("2026-07-30T07:45:00.000Z") },
      paymentStatus: PAYMENT_STATUS.CONFIRMED,
      tag: { $ne: BOOKING_TAG.GUEST_INCREASE },
    });
  });

  it("counts active course attendees without counting retained payment snapshots twice", async () => {
    mocks.scheduleRows[0] = {
      ...mocks.scheduleRows[0],
      tag: "class",
      numberOfGuests: 1,
      participants: [
        { firstname: "Active", lastname: "Guest" },
        { firstname: "Removed", lastname: "Guest", attendanceStatus: "removed", order: "paid-order" },
        { firstname: "Removed too", lastname: "Guest", attendanceStatus: "removed", order: "paid-order" },
      ],
    };
    const result = await buildDashboardOverview({
      context: { tenantId: TENANT_ID, userId: USER_ID, access: access() },
      query: { date: "2026-07-30", locationId: LOCATION_ID },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });
    expect(result.today.schedule[0]).toMatchObject({ participantCount: 1 });
  });

  it("keeps selected-day visitors and live presence available for another date", async () => {
    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: {
        date: "2026-08-04",
        locationId: LOCATION_ID,
      },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(result.flow.find((stage) => stage.key === "arriving")).toMatchObject(
      {
        value: 11,
        unit: "people",
        available: true,
      },
    );
    expect(result.flow.find((stage) => stage.key === "inStudio")).toMatchObject(
      {
        value: 5,
        unit: "people",
        available: true,
      },
    );
  });

  it("treats empty attendance aggregates as available zeroes", async () => {
    mocks.bookingAggregate.mockResolvedValue([]);

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: { date: "2026-07-30" },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(result.flow.find((stage) => stage.key === "arriving")).toMatchObject(
      {
        value: 0,
        unit: "people",
        available: true,
      },
    );
    expect(result.flow.find((stage) => stage.key === "inStudio")).toMatchObject(
      {
        value: 0,
        unit: "people",
        available: true,
      },
    );
  });

  it("detects a real first customer booking across the full assigned scope", async () => {
    mocks.bookingExists.mockResolvedValueOnce({ _id: BOOKING_ID });

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: {
        date: "2026-07-30",
        locationId: LOCATION_ID,
      },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(mocks.bookingExists).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      location: { $in: [expect.anything()] },
      status: { $ne: "cancelled" },
      paymentStatus: PAYMENT_STATUS.CONFIRMED,
      "importMetadata.importId": { $exists: false },
      $or: [
        { tag: { $in: ["open-studio", "workshop"] } },
        {
          tag: { $in: ["class", "course"] },
          $or: [
            { "orders.0": { $exists: true } },
            { "participants.0": { $exists: true } },
            { numberOfGuests: { $gt: 0 } },
          ],
        },
      ],
    });
    expect(result.milestones.firstCustomerBooking).toEqual({
      applicable: true,
      available: true,
      achieved: true,
    });
    expect(result.coverage.available).toContain("firstCustomerBooking");
  });

  it("degrades the first-booking milestone without manufacturing a false value", async () => {
    mocks.bookingExists.mockRejectedValueOnce(
      new Error("booking milestone unavailable"),
    );

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: { date: "2026-07-30" },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(result.milestones.firstCustomerBooking).toEqual({
      applicable: true,
      available: false,
      achieved: null,
    });
    expect(result.coverage.unavailable).toContainEqual({
      source: "firstCustomerBooking",
      reason: "source_temporarily_unavailable",
    });
  });

  it("keeps permission-restricted sources null instead of reporting false zeros", async () => {
    mocks.reportOverview.mockResolvedValue({
      coverage: {
        available: [],
        unavailable: [
          { source: "bookings", reason: "permission_required" },
          { source: "firings", reason: "permission_required" },
          { source: "inventory", reason: "permission_required" },
        ],
        limitations: [],
        complete: false,
      },
      summary: {
        bookings: { value: null },
        utilizationPercent: { value: null },
        netSales: { value: null },
      },
      bookings: null,
      customers: null,
      operations: {
        inventory: null,
        staffTasks: null,
      },
    });

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access([WORKSPACE_PERMISSION.WORKSPACE_VIEW]),
      },
      query: { date: "2026-07-30" },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.bookingAggregate).not.toHaveBeenCalled();
    expect(mocks.bookingCount).not.toHaveBeenCalled();
    expect(mocks.potteryAggregate).not.toHaveBeenCalled();
    expect(mocks.firingCount).not.toHaveBeenCalled();
    expect(result.today).toEqual({ available: false, schedule: null });
    expect(result.flow.every((stage) => stage.value === null)).toBe(true);
    expect(result.flow.every((stage) => stage.available === false)).toBe(true);
    expect(
      result.attention.every(
        (item) => item.count === null && item.available === false,
      ),
    ).toBe(true);
    expect(result.businessPulse).toMatchObject({
      occupancy: { available: false, value: null },
      revenue: { available: false, valueMinor: null },
      bookings: { available: false, value: null },
      newCustomers: { available: false, value: null },
      series: { available: false, points: null },
    });
    expect(result.opportunity).toMatchObject({
      available: false,
      key: null,
      value: null,
    });
    expect(result.coverage.complete).toBe(false);
  });

  it("prioritizes deterministic repeated course saturation with evidence", async () => {
    const signal = {
      key: "repeatedCourseSaturation",
      value: 96.7,
      productId: PRODUCT_ID,
      courseName: "Saturday wheel",
      weekday: 5,
      weekdayKey: "saturday",
      localStartTime: "10:00",
      sessionCount: 3,
      highFillSessionCount: 3,
      averageFillPercent: 96.7,
      totalBookedSeats: 29,
      totalCapacity: 30,
      threshold: {
        minimumHighFillSessions: 3,
        minimumAverageFillPercent: 90,
      },
      period: {
        key: "recent_56_tenant_calendar_days",
        from: "2026-06-05",
        to: "2026-07-30",
        days: 56,
        timezone: "Europe/Prague",
        asOf: "2026-07-30T07:45:00.000Z",
      },
      capacityBasis: "current_product_capacity",
      recommendation: {
        kind: "review_or_increase_capacity",
        automaticChange: false,
      },
      evidence: {
        total: 3,
        truncated: false,
        items: [
          {
            sessionId: "session-3",
            start: "2026-07-25T08:00:00.000Z",
            end: "2026-07-25T10:00:00.000Z",
            bookedSeats: 10,
            capacity: 10,
            fillPercent: 100,
          },
        ],
      },
    };
    mocks.courseCapacityAdvisor.mockResolvedValue({
      period: signal.period,
      analyzedSessions: 3,
      signal,
    });

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access([
          ...allDashboardPermissions,
          WORKSPACE_PERMISSION.COURSES_VIEW,
        ]),
      },
      query: {
        date: "2026-07-30",
        locationId: LOCATION_ID,
      },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(mocks.courseCapacityAdvisor).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      locationIds: [LOCATION_ID],
      timezone: "Europe/Prague",
      now: new Date("2026-07-30T07:45:00.000Z"),
    });
    expect(result.opportunity).toEqual({
      available: true,
      key: "repeatedCourseSaturation",
      value: 96.7,
      href: "/app/products?category=classesEvents",
      actionKey: "reviewCourseCapacity",
      source: "deterministic",
      details: signal,
    });
    expect(result.coverage.available).toContain("courseCapacityAdvisor");
    expect(result.coverage.limitations).toContain(
      "Course-capacity advice uses the current product capacity for recent historical sessions.",
    );
  });

  it("treats legacy undefined module flags as enabled", async () => {
    mocks.tenant.modules = {};

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: { date: "2026-07-30" },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(mocks.bookingFind).toHaveBeenCalledOnce();
    expect(mocks.potteryAggregate).not.toHaveBeenCalled();
    expect(result.today.available).toBe(true);
    expect(result.businessPulse.revenue.available).toBe(true);
    expect(result.coverage.unavailable).not.toContainEqual({
      source: "schedule",
      reason: "module_disabled",
    });
    expect(result.coverage.unavailable).not.toContainEqual({
      source: "potteryPieces",
      reason: "module_disabled",
    });
  });

  it("does not coerce an available-but-uncomputable metric into zero", async () => {
    const report = fullReport();
    report.summary.utilizationPercent.value = null as never;
    mocks.reportOverview.mockResolvedValue(report);

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: { date: "2026-07-30" },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(result.businessPulse.occupancy).toEqual({
      available: false,
      value: null,
      unit: "percent",
    });
    expect(result.opportunity).not.toMatchObject({
      key: "lowOccupancy",
      value: 0,
    });
  });

  it("does not present an empty assigned-location scope as zero activity", async () => {
    mocks.resolveScope.mockResolvedValue({
      requestedLocationId: null,
      locationIds: [],
      allowedLocationIds: [],
      unrestricted: false,
    });

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: {
          ...access(),
          locationAccess: {
            mode: "selected",
            locationIds: [],
          },
        },
      },
      query: { date: "2026-07-30" },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(mocks.reportOverview).not.toHaveBeenCalled();
    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.potteryAggregate).not.toHaveBeenCalled();
    expect(result.today).toEqual({ available: false, schedule: null });
    expect(result.businessPulse.bookings).toEqual({
      available: false,
      value: null,
    });
    expect(result.coverage.unavailable).toContainEqual({
      source: "dashboard",
      reason: "location_scope_empty",
    });
    expect(result.coverage.complete).toBe(false);
  });

  it("degrades only a failed live schedule source and keeps independent business data", async () => {
    mocks.bookingFind.mockImplementation(() => {
      throw new Error("schedule database unavailable");
    });

    const result = await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: { date: "2026-07-30" },
      now: new Date("2026-07-30T07:45:00.000Z"),
    });

    expect(result.today).toEqual({ available: false, schedule: null });
    expect(result.flow.find((stage) => stage.key === "arriving")).toMatchObject(
      { available: false, value: null, unit: "people" },
    );
    expect(result.flow.find((stage) => stage.key === "inStudio")).toMatchObject(
      { available: false, value: null, unit: "people" },
    );
    expect(result.coverage.unavailable).toContainEqual({
      source: "schedule",
      reason: "source_temporarily_unavailable",
    });
  });

  it("uses tenant-local DST calendar boundaries instead of fixed 24-hour days", async () => {
    mocks.reportOverview.mockResolvedValue(fullReport());

    await buildDashboardOverview({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      query: {
        date: "2026-03-29",
        locationId: LOCATION_ID,
      },
      now: new Date("2026-03-29T10:00:00.000Z"),
    });

    const query = mocks.bookingFind.mock.calls[0][0];
    const start = query.start.$gte as Date;
    const end = query.start.$lt as Date;

    expect(start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(end.valueOf() - start.valueOf()).toBe(23 * 60 * 60 * 1_000);
  });
});
