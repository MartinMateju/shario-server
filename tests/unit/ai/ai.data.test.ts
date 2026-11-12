import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  bookingCount: vi.fn(),
  bookingFind: vi.fn(),
  bookingAggregate: vi.fn(),
  locationCount: vi.fn(),
  locationFind: vi.fn(),
  taskCount: vi.fn(),
  taskFind: vi.fn(),
  inventoryCount: vi.fn(),
  inventoryFind: vi.fn(),
  reorderCount: vi.fn(),
  reorderFind: vi.fn(),
  productCount: vi.fn(),
  productFind: vi.fn(),
  eventCount: vi.fn(),
  eventFind: vi.fn(),
  firingCount: vi.fn(),
  firingAggregate: vi.fn(),
  firingFind: vi.fn(),
  moneyCreditAggregate: vi.fn(),
  couponAggregate: vi.fn(),
  couponOrderAggregate: vi.fn(),
  automationAggregate: vi.fn(),
  emailLogAggregate: vi.fn(),
  piecePricingCount: vi.fn(),
  piecePricingFind: vi.fn(),
  firingProfileCount: vi.fn(),
  firingProfileFind: vi.fn(),
  reportOverview: vi.fn(),
  publicSitePreview: vi.fn(),
  publicSiteEditorState: vi.fn(),
  orderFind: vi.fn(),
  communicationCount: vi.fn(),
  userFindOne: vi.fn(),
  userCount: vi.fn(),
  invoiceCount: vi.fn(),
  invoiceFind: vi.fn(),
  invoiceAggregate: vi.fn(),
  membershipAggregate: vi.fn(),
  membershipPlans: vi.fn(),
  kilnCount: vi.fn(),
  kilnFind: vi.fn(),
  pieceCount: vi.fn(),
  pieceAggregate: vi.fn(),
  pieceFind: vi.fn(),
  tenantFindById: vi.fn(),
  tenantExists: vi.fn(),
  staffPlanningOverview: vi.fn(),
  staffMemberCount: vi.fn(),
  staffMemberFind: vi.fn(),
  tenantMembershipCount: vi.fn(),
  conversationVisibility: vi.fn(),
  orderLocationScope: vi.fn(),
  orderReadLocationScope: vi.fn(),
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    countDocuments: mocks.bookingCount,
    find: mocks.bookingFind,
    aggregate: mocks.bookingAggregate,
  },
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: {
    countDocuments: mocks.locationCount,
    find: mocks.locationFind,
  },
}));
vi.mock("@/modules/staff/staff-task.model.js", () => ({
  default: { countDocuments: mocks.taskCount, find: mocks.taskFind },
}));
vi.mock("@/modules/inventory/inventory.model.js", () => ({
  InventoryItem: {
    countDocuments: mocks.inventoryCount,
    find: mocks.inventoryFind,
  },
  ReorderRequest: {
    countDocuments: mocks.reorderCount,
    find: mocks.reorderFind,
  },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: {
    countDocuments: mocks.productCount,
    find: mocks.productFind,
  },
}));
vi.mock("@/modules/event/event.model.js", () => ({
  default: {
    countDocuments: mocks.eventCount,
    find: mocks.eventFind,
  },
}));
vi.mock("@/modules/firing/firing.model.js", () => ({
  Firing: {
    countDocuments: mocks.firingCount,
    aggregate: mocks.firingAggregate,
    find: mocks.firingFind,
  },
}));
vi.mock("@/modules/money-credit/money-credit.model.js", () => ({
  MoneyCredit: { aggregate: mocks.moneyCreditAggregate },
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: { aggregate: mocks.couponAggregate },
  CouponOrder: { aggregate: mocks.couponOrderAggregate },
}));
vi.mock(
  "@/modules/communication-automations/communication-automation.model.js",
  () => ({
    CommunicationAutomation: { aggregate: mocks.automationAggregate },
  }),
);
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.model.js",
  () => ({
    CommunicationEmailLogModel: { aggregate: mocks.emailLogAggregate },
  }),
);
vi.mock("@/modules/piece-pricing/piece-pricing-profile.model.js", () => ({
  PiecePricingProfileModel: {
    countDocuments: mocks.piecePricingCount,
    find: mocks.piecePricingFind,
  },
}));
vi.mock("@/modules/firing-profile/firing-profile.model.js", () => ({
  FiringProfileModel: {
    countDocuments: mocks.firingProfileCount,
    find: mocks.firingProfileFind,
  },
}));
vi.mock("@/modules/reports/reports.service.js", () => ({
  buildReportOverview: mocks.reportOverview,
}));
vi.mock("@/modules/tenants/settings/tenant-settings.service.js", () => ({
  getTenantPublicSitePreview: mocks.publicSitePreview,
  getTenantPublicSiteEditorState: mocks.publicSiteEditorState,
}));
vi.mock("@/modules/order/order.model.js", () => ({
  Order: { find: mocks.orderFind },
}));
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationConversationModel: { countDocuments: mocks.communicationCount },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: mocks.userFindOne,
    countDocuments: mocks.userCount,
    collection: { name: "users" },
  },
}));
vi.mock("@/modules/invoice/invoice.schema.js", () => ({
  default: {
    countDocuments: mocks.invoiceCount,
    find: mocks.invoiceFind,
    aggregate: mocks.invoiceAggregate,
  },
}));
vi.mock("@/modules/membership/user-membership.model.js", () => ({
  default: {
    aggregate: mocks.membershipAggregate,
  },
}));
vi.mock("@/modules/membership/membership.repository.js", () => ({
  default: { listPlansWithScope: mocks.membershipPlans },
}));
vi.mock("@/modules/pottery-piece/pottery-piece.model.js", () => ({
  PotteryPiece: {
    countDocuments: mocks.pieceCount,
    aggregate: mocks.pieceAggregate,
    find: mocks.pieceFind,
  },
}));
vi.mock("@/modules/kiln/kiln.model.js", () => ({
  default: {
    countDocuments: mocks.kilnCount,
    find: mocks.kilnFind,
  },
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: {
    findById: mocks.tenantFindById,
    exists: mocks.tenantExists,
  },
}));
vi.mock("@/modules/staff/staff-planning.service.js", () => ({
  getStaffPlanningOverview: mocks.staffPlanningOverview,
}));
vi.mock("@/modules/staff/staff-member.model.js", () => ({
  default: {
    countDocuments: mocks.staffMemberCount,
    find: mocks.staffMemberFind,
  },
}));

vi.mock("@/modules/tenant-access/index.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, hasWorkspacePermission: mocks.hasPermission };
});

vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { countDocuments: mocks.tenantMembershipCount },
  TenantMembershipModel: { countDocuments: mocks.tenantMembershipCount },
}));

vi.mock("@/modules/communications/communication.access.js", () => ({
  buildConversationVisibilityFilter: mocks.conversationVisibility,
}));

vi.mock("@/modules/order/order.access.js", () => ({
  buildOrderLocationScopeFilter: mocks.orderLocationScope,
  buildOrderReadLocationFilter: mocks.orderReadLocationScope,
}));

import {
  buildWorkspaceAssistantContext,
  buildWorkspaceOperationalContext,
  enforceWorkspaceAssistantContextBudget,
  getTenantLocalDay,
  STUDIO_CONTEXT_VERSION,
  WORKSPACE_ASSISTANT_CONTEXT_MAX_SERIALIZED_CHARS,
  visibleAllLocationDocumentFilter,
  visibleProfileLocationFilter,
} from "@/modules/ai/services/ai-data.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";

const access: ResolvedWorkspaceAccess = {
  membershipId: "507f1f77bcf86cd799439014",
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: "active",
  role: "staff",
  customRoleId: null,
  customRoleName: null,
  permissions: [],
  locationAccess: { mode: "selected", locationIds: [LOCATION_ID] },
  workspaceProfile: { jobTitle: "", displayName: "", calendarColor: "" },
  preferences: {
    language: null,
    displayTimezone: null,
    defaultLocation: null,
    defaultCalendarView: "month",
    weekStartsOn: 1,
    defaultLandingPage: "",
    contextualGuides: {},
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
};

const queryResult = (value: unknown) => {
  const query: Record<string, any> = {};
  for (const method of ["sort", "skip", "limit", "select", "populate"]) {
    query[method] = vi.fn(() => query);
  }
  query.lean = vi.fn().mockResolvedValue(value);
  query.exec = vi.fn().mockResolvedValue(value);
  return query;
};
const selectLean = queryResult;
const limitSelectLean = queryResult;
const sortLimitSelectLean = queryResult;

const tenantRow = (modules: Record<string, boolean> = {}) => ({
  _id: TENANT_ID,
  name: "Studio Grohova",
  slug: "studio-grohova",
  settings: {
    timezone: "Europe/Prague",
    currency: "CZK",
    defaultLanguage: "CZ",
  },
  modules,
  plan: "professional",
  planVersion: 2,
  limits: {
    locations: 5,
    admins: 3,
    staffMembers: 20,
    inventoryItems: 500,
    monthlyEmails: 10_000,
    monthlyAutomations: 1_000,
    aiCredits: 2_000,
  },
  onboarding: { businessType: "coworking_space" },
});

const prepareAssistantIdentity = (modules: Record<string, boolean> = {}) => {
  mocks.tenantFindById.mockReturnValue(queryResult(tenantRow(modules)));
  mocks.userFindOne.mockReturnValue(
    queryResult({
      _id: USER_ID,
      firstname: "Martin",
      lastname: "Owner",
    }),
  );
};

describe("AI data context boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasPermission.mockReturnValue(false);
    mocks.tenantExists.mockResolvedValue(false);
    mocks.bookingFind.mockReturnValue(queryResult([]));
    mocks.bookingAggregate.mockResolvedValue([]);
    mocks.locationCount.mockResolvedValue(0);
    mocks.locationFind.mockReturnValue(queryResult([]));
    mocks.firingFind.mockReturnValue(queryResult([]));
    mocks.firingAggregate.mockResolvedValue([]);
    mocks.firingCount.mockResolvedValue(0);
    mocks.kilnCount.mockResolvedValue(0);
    mocks.kilnFind.mockReturnValue(queryResult([]));
    mocks.pieceCount.mockResolvedValue(0);
    mocks.pieceAggregate.mockResolvedValue([]);
    mocks.pieceFind.mockReturnValue(queryResult([]));
    mocks.reorderCount.mockResolvedValue(0);
    mocks.reorderFind.mockReturnValue(queryResult([]));
    mocks.moneyCreditAggregate.mockResolvedValue([
      {
        balances: [],
        transactionsLast30Days: [],
      },
    ]);
    mocks.couponAggregate.mockResolvedValue([]);
    mocks.couponOrderAggregate.mockResolvedValue([
      { total: [], byStatus: [], valueByCurrency: [] },
    ]);
    mocks.automationAggregate.mockResolvedValue([
      {
        total: [],
        active: [],
        byStatus: [],
        byScheduleType: [],
        recent: [],
      },
    ]);
    mocks.emailLogAggregate.mockResolvedValue([
      { total: [], byStatus: [], byType: [] },
    ]);
    mocks.piecePricingCount.mockResolvedValue(0);
    mocks.piecePricingFind.mockReturnValue(queryResult([]));
    mocks.firingProfileCount.mockResolvedValue(0);
    mocks.firingProfileFind.mockReturnValue(queryResult([]));
    mocks.orderReadLocationScope.mockReturnValue({});
    mocks.staffMemberCount.mockResolvedValue(0);
    mocks.staffMemberFind.mockReturnValue(queryResult([]));
    mocks.tenantMembershipCount.mockResolvedValue(0);
  });

  it("uses tenant-local DST-safe day boundaries", () => {
    const day = getTenantLocalDay(
      "Europe/Prague",
      new Date("2026-03-29T12:00:00.000Z"),
    );

    expect(day.dateKey).toBe("2026-03-29");
    expect(day.start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(day.end.getTime() - day.start.getTime()).toBe(23 * 60 * 60 * 1_000);
  });

  it("fails closed and uses exact automation location visibility", () => {
    const restricted = visibleAllLocationDocumentFilter({
      actorAllowedLocationIds: [LOCATION_ID],
      requestedLocationId: null,
      requestedLocationAccessible: true,
    });
    expect(restricted).toEqual({
      appliesToAllLocations: false,
      location: {
        $in: [new mongoose.Types.ObjectId(LOCATION_ID)],
      },
    });
    expect(JSON.stringify(restricted)).not.toContain(
      '"appliesToAllLocations":true',
    );

    const unrestrictedAtLocation = visibleAllLocationDocumentFilter({
      actorAllowedLocationIds: null,
      requestedLocationId: LOCATION_ID,
      requestedLocationAccessible: true,
    });
    expect(unrestrictedAtLocation).toEqual({
      $or: [
        { appliesToAllLocations: true },
        {
          appliesToAllLocations: false,
          location: new mongoose.Types.ObjectId(LOCATION_ID),
        },
      ],
    });

    expect(
      visibleAllLocationDocumentFilter({
        actorAllowedLocationIds: [],
        requestedLocationId: null,
        requestedLocationAccessible: true,
      }),
    ).toEqual({ _id: { $exists: false } });
  });

  it("includes only global or completely visible pricing profiles", () => {
    const restricted = visibleProfileLocationFilter({
      actorAllowedLocationIds: [LOCATION_ID],
      requestedLocationId: null,
      requestedLocationAccessible: true,
    }) as any;
    expect(restricted.$or[0]).toEqual({ locationIds: { $size: 0 } });
    expect(restricted.$or[1]).toEqual({
      "locationIds.0": { $exists: true },
      locationIds: {
        $not: {
          $elemMatch: {
            $nin: [new mongoose.Types.ObjectId(LOCATION_ID)],
          },
        },
      },
    });
    expect(restricted.$or[1].locationIds).not.toHaveProperty("$in");

    const selected = visibleProfileLocationFilter({
      actorAllowedLocationIds: [LOCATION_ID],
      requestedLocationId: LOCATION_ID,
      requestedLocationAccessible: true,
    }) as any;
    expect(selected.$and[0]).toEqual(restricted);
    expect(selected.$and[1].$or[1]).toEqual({
      locationIds: new mongoose.Types.ObjectId(LOCATION_ID),
    });

    expect(
      visibleProfileLocationFilter({
        actorAllowedLocationIds: [],
        requestedLocationId: null,
        requestedLocationAccessible: true,
      }),
    ).toEqual({ _id: { $exists: false } });
  });

  it("does not query newly added tenant sources when their modules are disabled", async () => {
    const enabledPermissions: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.CREDITS_VIEW,
        WORKSPACE_PERMISSION.VOUCHERS_VIEW,
        WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,

      ],
    };
    prepareAssistantIdentity({
      credits: false,
      vouchers: false,
      communications: false,
      automations: false,
      firing: false,
    });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: enabledPermissions,
      now: new Date("2026-08-05T08:00:00.000Z"),
    });

    expect(mocks.moneyCreditAggregate).not.toHaveBeenCalled();
    expect(mocks.couponAggregate).not.toHaveBeenCalled();
    expect(mocks.couponOrderAggregate).not.toHaveBeenCalled();
    expect(mocks.automationAggregate).not.toHaveBeenCalled();
    expect(mocks.emailLogAggregate).not.toHaveBeenCalled();
    expect(mocks.piecePricingFind).not.toHaveBeenCalled();
    expect(mocks.firingProfileFind).not.toHaveBeenCalled();
    expect(mocks.firingFind).not.toHaveBeenCalled();
    expect(result.coverage.omitted).toEqual(
      expect.arrayContaining([
        { source: "credits", reason: "module_disabled" },
        { source: "vouchers", reason: "module_disabled" },
        {
          source: "communications.deliveryHealth",
          reason: "module_disabled",
        },
      ]),
    );
  });

  it("does not query tenant summaries without their explicit workspace permissions", async () => {
    prepareAssistantIdentity({
      credits: true,
      vouchers: true,
      communications: true,
      automations: true,
      firing: true,
    });

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access,
      now: new Date("2026-08-05T08:00:00.000Z"),
    });

    expect(mocks.moneyCreditAggregate).not.toHaveBeenCalled();
    expect(mocks.couponAggregate).not.toHaveBeenCalled();
    expect(mocks.couponOrderAggregate).not.toHaveBeenCalled();
    expect(mocks.automationAggregate).not.toHaveBeenCalled();
    expect(mocks.emailLogAggregate).not.toHaveBeenCalled();
    expect(mocks.piecePricingFind).not.toHaveBeenCalled();
    expect(mocks.firingProfileFind).not.toHaveBeenCalled();
    expect(mocks.firingFind).not.toHaveBeenCalled();
    expect(mocks.reportOverview).not.toHaveBeenCalled();
    expect(mocks.publicSitePreview).not.toHaveBeenCalled();
    expect(mocks.publicSiteEditorState).not.toHaveBeenCalled();
    expect(result.coverage.omitted).toEqual(
      expect.arrayContaining([
        { source: "credits", reason: "permission_required" },
        { source: "vouchers", reason: "permission_required" },
        {
          source: "communications.deliveryHealth",
          reason: "permission_required",
        },
        { source: "reports.currentPeriod", reason: "permission_required" },
        { source: "publicSite", reason: "permission_required" },
      ]),
    );
  });

  it("queries only permitted sources and pins tenant plus selected locations", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) =>
        permission === WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    );
    mocks.bookingCount.mockResolvedValueOnce(2);
    const bookingQuery = sortLimitSelectLean([]);
    mocks.bookingFind.mockReturnValueOnce(bookingQuery);

    const result = await buildWorkspaceOperationalContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access,
      timezone: "Europe/Prague",
      now: new Date("2026-07-23T10:00:00.000Z"),
    });

    const location = new mongoose.Types.ObjectId(LOCATION_ID);
    expect(mocks.bookingCount).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        location: { $in: [location] },
        paymentStatus: "CONFIRMED",
        tag: { $ne: "guest-increase" },
      }),
    );
    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        location: { $in: [location] },
        paymentStatus: "CONFIRMED",
        tag: { $ne: "guest-increase" },
      }),
    );
    expect(bookingQuery.populate).toHaveBeenCalledWith({
      path: "bookingProduct",
      select: "name type",
      match: { tenant: TENANT_ID },
    });
    expect(mocks.taskCount).not.toHaveBeenCalled();
    expect(mocks.inventoryCount).not.toHaveBeenCalled();
    expect(mocks.firingCount).not.toHaveBeenCalled();
    expect(mocks.orderFind).not.toHaveBeenCalled();
    expect(mocks.communicationCount).not.toHaveBeenCalled();
    expect(mocks.moneyCreditAggregate).not.toHaveBeenCalled();
    expect(mocks.couponAggregate).not.toHaveBeenCalled();
    expect(mocks.automationAggregate).not.toHaveBeenCalled();
    expect(mocks.emailLogAggregate).not.toHaveBeenCalled();
    expect(mocks.piecePricingFind).not.toHaveBeenCalled();
    expect(mocks.firingProfileFind).not.toHaveBeenCalled();
    expect(mocks.reportOverview).not.toHaveBeenCalled();
    expect(mocks.publicSitePreview).not.toHaveBeenCalled();
    expect(result.coverage).toEqual({
      available: ["bookings"],
      unavailable: [],
      complete: true,
    });
  });

  it("counts overdue open tasks against the supplied operational clock", async () => {
    const now = new Date("2026-07-23T10:00:00.000Z");
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === WORKSPACE_PERMISSION.TASKS_VIEW,
    );
    mocks.taskCount.mockImplementation((query) => {
      if (query.dueDate?.$lt) return Promise.resolve(2);
      if (query.priority === "urgent") return Promise.resolve(1);
      return Promise.resolve(4);
    });
    mocks.taskFind.mockReturnValueOnce(sortLimitSelectLean([]));

    const result = await buildWorkspaceOperationalContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access,
      timezone: "Europe/Prague",
      now,
    });

    expect(result.tasks).toMatchObject({
      openCount: 4,
      urgent: 1,
      overdue: 2,
      due: [],
    });
    expect(mocks.taskCount).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        status: { $nin: ["done"] },
        dueDate: { $ne: null, $lt: now },
      }),
    );
  });

  it("provides exact tenant-local tomorrow and unpaid-future booking facts", async () => {
    const bookingAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.BOOKINGS_VIEW,
        WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
      ],
    };
    const now = new Date("2026-07-30T08:00:00.000Z");
    const confirmedBooking = {
      _id: "507f1f77bcf86cd799439061",
      bookingProduct: {
        _id: "507f1f77bcf86cd799439062",
        name: "Open studio",
        type: "service",
      },
      start: new Date("2026-07-31T08:00:00.000Z"),
      end: new Date("2026-07-31T10:00:00.000Z"),
      location: LOCATION_ID,
      tag: "private-session",
      status: "processed",
      participants: [{ firstname: "A", lastname: "B" }],
      numberOfGuests: 2,
      createdBy: "507f1f77bcf86cd799439063",
      author: { name: "Ada Clay", customId: "C-42" },
    };
    const unpaidBooking = {
      ...confirmedBooking,
      _id: "507f1f77bcf86cd799439064",
      start: new Date("2026-08-02T08:00:00.000Z"),
      end: new Date("2026-08-02T10:00:00.000Z"),
      paymentExpiresAt: new Date("2026-07-30T09:00:00.000Z"),
    };
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.bookingCount.mockImplementation((query) => {
      if (query.paymentStatus === "PENDING_PAYMENT") return 1;
      if (query.start?.$lt) return 1;
      return 2;
    });
    mocks.bookingFind.mockImplementation((query) => {
      if (query.paymentStatus === "PENDING_PAYMENT") {
        return queryResult([unpaidBooking]);
      }
      if (query.start?.$lt) {
        return queryResult([confirmedBooking]);
      }
      return queryResult([confirmedBooking, unpaidBooking]);
    });
    mocks.bookingAggregate.mockResolvedValue([
      {
        total: [{ count: 1 }],
        items: [
          {
            _id: unpaidBooking.createdBy,
            name: "Ada Clay",
            customId: "C-42",
            unpaidBookings: 1,
            nextBookingAt: unpaidBooking.start,
          },
        ],
      },
    ]);

    const result = await buildWorkspaceOperationalContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: bookingAccess,
      timezone: "Europe/Prague",
      now,
    });

    expect(result.bookings).toMatchObject({
      futureConfirmedCount: 2,
      allTimeConfirmedCount: 2,
      tomorrow: {
        dateKey: "2026-07-31",
        total: 1,
        truncated: false,
        items: [
          {
            name: "Open studio",
            participantCount: 2,
            customer: {
              customerId: unpaidBooking.createdBy,
              name: "Ada Clay",
              customId: "C-42",
            },
          },
        ],
      },
      unpaidFuture: {
        bookings: {
          total: 1,
          truncated: false,
          items: [
            {
              id: unpaidBooking._id,
              paymentExpiresAt: unpaidBooking.paymentExpiresAt,
            },
          ],
        },
        customers: {
          total: 1,
          truncated: false,
          items: [
            {
              customerId: unpaidBooking.createdBy,
              unpaidBookings: 1,
            },
          ],
        },
        customerDetailsAvailable: true,
      },
    });
    const tomorrowQuery = mocks.bookingFind.mock.calls
      .map(([query]) => query)
      .find((query) => query.paymentStatus === "CONFIRMED" && query.start?.$lt);
    expect(tomorrowQuery.start.$gte.toISOString()).toBe(
      "2026-07-30T22:00:00.000Z",
    );
    expect(tomorrowQuery.start.$lt.toISOString()).toBe(
      "2026-07-31T22:00:00.000Z",
    );
    const futureCountQuery = mocks.bookingCount.mock.calls
      .map(([query]) => query)
      .find(
        (query) =>
          query.paymentStatus === "CONFIRMED" &&
          query.start?.$gte?.toISOString?.() === now.toISOString() &&
          !query.start?.$lt,
      );
    expect(futureCountQuery).toEqual(
      expect.objectContaining({
        tenant: TENANT_ID,
        location: {
          $in: [new mongoose.Types.ObjectId(LOCATION_ID)],
        },
        status: { $ne: "cancelled" },
        paymentStatus: "CONFIRMED",
        tag: { $ne: "guest-increase" },
      }),
    );
    const allTimeCountQuery = mocks.bookingCount.mock.calls
      .map(([query]) => query)
      .find(
        (query) =>
          query.paymentStatus === "CONFIRMED" &&
          !Object.prototype.hasOwnProperty.call(query, "start"),
      );
    expect(allTimeCountQuery).toEqual(
      expect.objectContaining({
        tenant: TENANT_ID,
        location: {
          $in: [new mongoose.Types.ObjectId(LOCATION_ID)],
        },
        status: { $ne: "cancelled" },
        paymentStatus: "CONFIRMED",
        tag: { $ne: "guest-increase" },
      }),
    );
    expect(
      mocks.bookingAggregate.mock.calls[0][0][0].$match.tenant,
    ).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it("does not expose booking customer identities when the customers module is disabled", async () => {
    const bookingAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.BOOKINGS_VIEW,
        WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
      ],
    };
    const booking = {
      _id: "507f1f77bcf86cd799439064",
      bookingProduct: {
        _id: "507f1f77bcf86cd799439062",
        name: "Open studio",
        type: "service",
      },
      start: new Date("2026-07-31T08:00:00.000Z"),
      end: new Date("2026-07-31T10:00:00.000Z"),
      location: LOCATION_ID,
      tag: "private-session",
      status: "processed",
      numberOfGuests: 1,
      createdBy: "507f1f77bcf86cd799439063",
      author: { name: "Ada Clay", customId: "C-42" },
      paymentExpiresAt: new Date("2026-07-30T09:00:00.000Z"),
    };
    prepareAssistantIdentity({ bookings: true, customers: false });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.bookingCount.mockResolvedValue(1);
    mocks.bookingFind.mockReturnValue(queryResult([booking]));
    mocks.bookingAggregate.mockResolvedValue([
      {
        total: [{ count: 1 }],
        items: [
          {
            _id: booking.createdBy,
            name: booking.author.name,
            customId: booking.author.customId,
            unpaidBookings: 1,
            nextBookingAt: booking.start,
          },
        ],
      },
    ]);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: bookingAccess,
      now: new Date("2026-07-30T08:00:00.000Z"),
    });

    expect(result.customers).toBeNull();
    expect(result.operations.bookings.tomorrow.items[0]).not.toHaveProperty(
      "customer",
    );
    expect(
      result.operations.bookings.unpaidFuture.bookings.items[0],
    ).not.toHaveProperty("customer");
    expect(result.operations.bookings.unpaidFuture).toMatchObject({
      customers: null,
      customerDetailsAvailable: false,
    });
    expect(mocks.bookingAggregate).toHaveBeenCalledTimes(3);
    for (const [pipeline] of mocks.bookingAggregate.mock.calls) {
      expect(JSON.stringify(pipeline)).not.toContain("author.name");
      expect(pipeline[1]).toEqual({
        $group: { _id: "$location", count: { $sum: 1 } },
      });
    }
    expect(JSON.stringify(result.operations.bookings)).not.toContain(
      "Ada Clay",
    );
    expect(JSON.stringify(result.operations.bookings)).not.toContain("C-42");
  });

  it("degrades a failed source without leaking database internals", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) =>
        permission === WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    );
    mocks.bookingCount.mockRejectedValueOnce(
      new Error("mongo host and query secret"),
    );
    mocks.bookingFind.mockReturnValueOnce(sortLimitSelectLean([]));

    const result = await buildWorkspaceOperationalContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access,
      timezone: "UTC",
    });

    expect(result).not.toHaveProperty("bookings");
    expect(result.coverage).toEqual({
      available: [],
      unavailable: [
        { source: "bookings", reason: "source_temporarily_unavailable" },
      ],
      complete: false,
    });
    expect(JSON.stringify(result)).not.toContain("mongo host");
    expect(JSON.stringify(result)).not.toContain("query secret");
  });

  it("propagates partial operational failures to assistant coverage", async () => {
    const bookingAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
    };
    prepareAssistantIdentity({ bookings: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.bookingCount.mockRejectedValueOnce(
      new Error("hidden database error"),
    );
    mocks.bookingFind.mockReturnValueOnce(queryResult([]));

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: bookingAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.unavailable).toContainEqual({
      source: "operations.bookings",
      reason: "source_temporarily_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("hidden database error");
  });

  it("builds low-stock context from permitted location stock levels only", async () => {
    const hiddenLocation = new mongoose.Types.ObjectId().toString();
    mocks.hasPermission.mockImplementation(
      (_access, permission) =>
        permission === WORKSPACE_PERMISSION.INVENTORY_VIEW,
    );
    mocks.inventoryCount.mockResolvedValueOnce(1);
    mocks.inventoryFind.mockReturnValueOnce(
      limitSelectLean([
        {
          _id: "inventory-a",
          name: "Clay",
          unit: "kg",
          stockLevels: [
            {
              location: new mongoose.Types.ObjectId(LOCATION_ID),
              currentQuantity: 1,
              minimumQuantity: 2,
            },
            {
              location: new mongoose.Types.ObjectId(hiddenLocation),
              currentQuantity: 0,
              minimumQuantity: 4,
            },
          ],
        },
      ]),
    );

    const result = await buildWorkspaceOperationalContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access,
      timezone: "UTC",
    });

    const query = mocks.inventoryCount.mock.calls[0]?.[0];
    expect(JSON.stringify(query)).toContain("stockLevels");
    expect(JSON.stringify(query)).toContain(LOCATION_ID);
    expect(result.inventory).toMatchObject({
      lowStockCount: 1,
      items: [
        {
          currentQuantity: 1,
          minimumQuantity: 2,
          stockLevels: [
            {
              currentQuantity: 1,
              minimumQuantity: 2,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result.inventory)).not.toContain(hiddenLocation);
  });

  it("always includes safe workspace and actor identity", async () => {
    prepareAssistantIdentity({ ai: true });
    mocks.tenantFindById.mockReturnValueOnce(
      queryResult({
        ...tenantRow({ ai: true }),
        privateNotes: "tenant-secret",
        stripeSecret: "provider-secret",
      }),
    );
    mocks.userFindOne.mockReturnValueOnce(
      queryResult({
        _id: USER_ID,
        firstname: "Martin",
        lastname: "Owner",
        email: "private@example.test",
        phone: "+420-secret",
      }),
    );

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(result.studio).toMatchObject({
      name: "Studio Grohova",
      slug: "studio-grohova",
      businessType: "coworking_space",
      settings: {
        timezone: "Europe/Prague",
        currency: "CZK",
        defaultLanguage: "CZ",
      },
    });
    expect(result.actor).toMatchObject({
      id: USER_ID,
      firstName: "Martin",
      lastName: "Owner",
      displayName: "Martin Owner",
    });
    expect(result.contextVersion).toBe(STUDIO_CONTEXT_VERSION);
    expect(result.profile).toBe("full");
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining([
        "contextVersion",
        "profile",
        "scope",
        "studio",
        "actor",
        "subscription",
        "locations",
        "products",
        "courses",
        "team",
        "customers",
        "inventory",
        "memberships",
        "invoices",
        "credits",
        "vouchers",
        "communications",
        "reports",
        "publicSite",
        "operations",
        "coverage",
      ]),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("tenant-secret");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("+420-secret");
  });

  it("builds a core profile without querying broad domain or operational sources", async () => {
    prepareAssistantIdentity({
      ai: true,
      bookings: true,
      payments: true,
      communications: true,
      firing: true,
      inventory: true,
      staff_tasks: true,
    });

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access,
      profile: "core",
      now: new Date("2026-08-02T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      contextVersion: STUDIO_CONTEXT_VERSION,
      profile: "core",
      studio: { name: "Studio Grohova" },
      actor: { id: USER_ID },
      operations: null,
    });
    expect(result.coverage.omitted).toEqual(
      expect.arrayContaining([
        { source: "products", reason: "profile_excluded" },
        { source: "operations", reason: "profile_excluded" },
      ]),
    );
    expect(mocks.productCount).not.toHaveBeenCalled();
    expect(mocks.bookingCount).not.toHaveBeenCalled();
    expect(mocks.inventoryCount).not.toHaveBeenCalled();
    expect(mocks.firingCount).not.toHaveBeenCalled();
    expect(mocks.orderFind).not.toHaveBeenCalled();
    expect(mocks.communicationCount).not.toHaveBeenCalled();
    expect(mocks.moneyCreditAggregate).not.toHaveBeenCalled();
    expect(mocks.couponAggregate).not.toHaveBeenCalled();
    expect(mocks.automationAggregate).not.toHaveBeenCalled();
    expect(mocks.emailLogAggregate).not.toHaveBeenCalled();
    expect(mocks.piecePricingFind).not.toHaveBeenCalled();
    expect(mocks.firingProfileFind).not.toHaveBeenCalled();
    expect(mocks.reportOverview).not.toHaveBeenCalled();
    expect(mocks.publicSitePreview).not.toHaveBeenCalled();
  });

  it("exposes only configured subscription plan data with subscription permission", async () => {
    const subscriptionAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.SUBSCRIPTION_VIEW],
    };
    prepareAssistantIdentity({ ai: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: subscriptionAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(result.subscription).toEqual({
      plan: "professional",
      planVersion: 2,
      limits: {
        locations: 5,
        admins: 3,
        staffMembers: 20,
        inventoryItems: 500,
        monthlyEmails: 10_000,
        monthlyAutomations: 1_000,
        aiCredits: 2_000,
      },
    });
    expect(result.coverage.available).toContain("subscription");
  });

  it("adds tenant-wide credit and voucher aggregates without customer or code data", async () => {
    const commerceAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.CREDITS_VIEW,
        WORKSPACE_PERMISSION.VOUCHERS_VIEW,
      ],
    };
    prepareAssistantIdentity({ credits: true, vouchers: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.moneyCreditAggregate.mockResolvedValue([
      {
        balances: [
          {
            _id: "CZK",
            accounts: 4,
            accountsWithBalance: 3,
            outstandingBalanceMinor: 125_000,
          },
        ],
        transactionsLast30Days: [
          {
            _id: { currency: "CZK", type: "added" },
            count: 2,
            amountMinor: 50_000,
          },
        ],
      },
    ]);
    mocks.couponAggregate.mockResolvedValue([
      {
        total: 12,
        active: 8,
        available: 6,
        redeemed: 3,
        redeemedLast30Days: 2,
        reserved: 2,
        expired: 1,
        expiringWithin30Days: 2,
      },
    ]);
    mocks.couponOrderAggregate.mockResolvedValue([
      {
        total: [{ count: 2 }],
        byStatus: [{ _id: "processed_coupon", count: 2 }],
        valueByCurrency: [
          {
            _id: "CZK",
            orders: 2,
            quantity: 3,
            processedValueMinor: 150_000,
          },
        ],
      },
    ]);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: commerceAccess,
      now: new Date("2026-08-05T08:00:00.000Z"),
    });

    expect(result.credits).toMatchObject({
      scope: "tenant_wide",
      amountBasis:
        "integer_minor_units_when_present_otherwise_iso_currency_exponent_conversion",
      balancesByCurrency: {
        items: [
          {
            currency: "CZK",
            accounts: 4,
            accountsWithBalance: 3,
            outstandingBalanceMinor: 125_000,
          },
        ],
      },
    });
    expect(result.vouchers).toMatchObject({
      scope: "tenant_wide",
      issued: {
        total: 12,
        active: 8,
        available: 6,
        redeemedLast30Days: 2,
      },
      ordersLast30Days: {
        amountBasis: "authoritative_expected_amount_minor",
        valueByCurrency: {
          items: [
            {
              currency: "CZK",
              processedValueMinor: 150_000,
            },
          ],
        },
      },
    });
    const creditPipeline = mocks.moneyCreditAggregate.mock.calls[0][0];
    expect(creditPipeline[0].$match.tenant).toEqual(
      new mongoose.Types.ObjectId(TENANT_ID),
    );
    expect(JSON.stringify(creditPipeline)).toContain("balanceMinor");
    expect(JSON.stringify(creditPipeline)).toContain("$balance");
    expect(JSON.stringify(creditPipeline)).toContain("JPY");
    expect(JSON.stringify(creditPipeline)).toContain("CLP");
    const voucherOrderPipeline = mocks.couponOrderAggregate.mock.calls[0][0];
    expect(voucherOrderPipeline[0].$match).toMatchObject({
      tenant: new mongoose.Types.ObjectId(TENANT_ID),
      status: { $in: ["processed_coupon", "shipped_coupon"] },
      processedAt: expect.any(Object),
    });
    expect(JSON.stringify(voucherOrderPipeline)).toContain(
      "$expectedAmountMinor",
    );
    expect(JSON.stringify(voucherOrderPipeline)).not.toContain(
      "$totalSnapshot",
    );
    const serialized = JSON.stringify({
      credits: result.credits,
      vouchers: result.vouchers,
    });
    expect(serialized).not.toContain("promoCode");
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("stripe");
  });

  it("summarizes automation delivery health without message or provider data", async () => {
    const communicationAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW],
    };
    prepareAssistantIdentity({ communications: true, automations: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.automationAggregate.mockResolvedValue([
      {
        total: [{ count: 1 }],
        active: [{ count: 1 }],
        byStatus: [{ _id: "active", count: 1 }],
        byScheduleType: [{ _id: "beforeBooking", count: 1 }],
        recent: [
          {
            name: "Booking reminder",
            scheduleType: "beforeBooking",
            purpose: "transactional",
            connectedProductType: "booking",
            automationStatus: "active",
            isActive: true,
            appliesToAllLocations: false,
            location: LOCATION_ID,
            nextRunAt: new Date("2026-08-05T09:00:00.000Z"),
            recipients: [{ email: "hidden@example.test" }],
            body: "PRIVATE_BODY",
            errorMessage: "PRIVATE_ERROR",
          },
        ],
      },
    ]);
    mocks.emailLogAggregate
      .mockResolvedValueOnce([
        {
          total: [{ count: 20 }],
          byStatus: [{ _id: "sent", count: 18 }],
          byType: [{ _id: "beforeBooking", count: 20 }],
        },
      ])
      .mockResolvedValueOnce([
        {
          manualReviewRequired: [{ count: 1 }],
          staleSending: [{ count: 2 }],
          dueScheduled: [{ count: 2 }],
          failedLast24Hours: [{ count: 1 }],
          recoveryDue: [{ count: 1 }],
          problems: [
            {
              status: "sending",
              emailType: "beforeBooking",
              appliesToAllLocations: false,
              location: LOCATION_ID,
              processingStartedAt: new Date("2026-08-05T07:00:00.000Z"),
              processingLeaseExpiresAt: new Date("2026-08-05T07:00:00.000Z"),
              attempts: 3,
              recipientEmail: "private@example.test",
              subject: "PRIVATE_SUBJECT",
              body: "PRIVATE_BODY",
              providerMessageId: "provider-secret",
              errorMessage: "database-secret",
            },
          ],
        },
      ]);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: communicationAccess,
      now: new Date("2026-08-05T08:00:00.000Z"),
    });

    expect(result.communications).toMatchObject({
      automations: {
        total: 1,
        active: 1,
        recent: {
          items: [
            {
              name: "Booking reminder",
              purpose: "transactional",
              connectedProductType: "booking",
              locationScope: LOCATION_ID,
            },
          ],
        },
      },
      deliveryLast30Days: { total: 20 },
      deliveryBacklog: {
        manualReviewRequired: 1,
        staleSending: 2,
        dueScheduled: 2,
        failedLast24Hours: 1,
        recoveryDue: 1,
      },
    });
    const automationMatch =
      mocks.automationAggregate.mock.calls[0][0][0].$match;
    expect(automationMatch).toMatchObject({
      tenant: new mongoose.Types.ObjectId(TENANT_ID),
      appliesToAllLocations: false,
    });
    expect(automationMatch.location.$in).toEqual([
      new mongoose.Types.ObjectId(LOCATION_ID),
    ]);
    const [recentPipeline, backlogPipeline] =
      mocks.emailLogAggregate.mock.calls.map(([pipeline]) => pipeline);
    expect(recentPipeline[0].$match.createdAt).toEqual({
      $gte: expect.any(Date),
      $lte: expect.any(Date),
    });
    expect(backlogPipeline[0].$match).not.toHaveProperty("createdAt");
    expect(backlogPipeline[0].$match.$and[0]).toMatchObject({
      appliesToAllLocations: false,
    });
    expect(JSON.stringify(backlogPipeline[0].$match.$and[1])).toContain(
      "nextQueueRecoveryAt",
    );
    expect(
      JSON.stringify(backlogPipeline[1].$facet.problems[0].$match),
    ).toContain("nextQueueRecoveryAt");
    const staleSendingMatch = backlogPipeline[1].$facet.staleSending[0].$match;
    expect(staleSendingMatch).toMatchObject({
      status: "sending",
      $or: [
        { processingLeaseExpiresAt: { $ne: null, $lte: expect.any(Date) } },
        {
          processingLeaseExpiresAt: null,
          processingStartedAt: { $ne: null, $lte: expect.any(Date) },
        },
      ],
    });
    const serialized = JSON.stringify(result.communications);
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("PRIVATE_SUBJECT");
    expect(serialized).not.toContain("PRIVATE_BODY");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("database-secret");
  });

  it("keeps delivery health when automations are disabled", async () => {
    const communicationAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW],
    };
    prepareAssistantIdentity({ communications: true, automations: false });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.emailLogAggregate
      .mockResolvedValueOnce([
        {
          total: [{ count: 4 }],
          byStatus: [{ _id: "sent", count: 4 }],
          byType: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          manualReviewRequired: [],
          staleSending: [],
          dueScheduled: [],
          failedLast24Hours: [],
          recoveryDue: [],
          problems: [],
          problemCount: [],
        },
      ]);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: communicationAccess,
      now: new Date("2026-08-05T08:00:00.000Z"),
    });

    expect(mocks.automationAggregate).not.toHaveBeenCalled();
    expect(result.communications).toMatchObject({
      automations: null,
      deliveryLast30Days: { total: 4 },
      deliveryBacklog: { recoveryDue: 0 },
    });
    expect(result.coverage.available).toContain(
      "communications.deliveryHealth",
    );
    expect(result.coverage.omitted).toContainEqual({
      source: "communications.automations",
      reason: "module_disabled",
    });
  });

  it("isolates an automation query failure from delivery health", async () => {
    const communicationAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW],
    };
    prepareAssistantIdentity({ communications: true, automations: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.automationAggregate.mockRejectedValueOnce(new Error("unavailable"));
    mocks.emailLogAggregate
      .mockResolvedValueOnce([
        { total: [{ count: 2 }], byStatus: [], byType: [] },
      ])
      .mockResolvedValueOnce([
        {
          manualReviewRequired: [],
          staleSending: [],
          dueScheduled: [],
          failedLast24Hours: [],
          recoveryDue: [{ count: 1 }],
          problems: [
            {
              status: "failed",
              nextQueueRecoveryAt: new Date("2026-08-05T07:00:00.000Z"),
            },
          ],
          problemCount: [{ count: 1 }],
        },
      ]);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: communicationAccess,
      now: new Date("2026-08-05T08:00:00.000Z"),
    });

    expect(result.communications).toMatchObject({
      automations: null,
      deliveryLast30Days: { total: 2 },
      deliveryBacklog: { recoveryDue: 1, problems: { total: 1 } },
    });
    expect(result.coverage.available).toContain(
      "communications.deliveryHealth",
    );
    expect(result.coverage.unavailable).toContainEqual({
      source: "communications.automations",
      reason: "source_temporarily_unavailable",
    });
    expect(result.coverage.complete).toBe(false);
  });

  it("adds current report KPIs and sanitized public-site publication state", async () => {
    const insightAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.REPORTS_VIEW,
        WORKSPACE_PERMISSION.WORKSPACE_VIEW,
      ],
    };
    const now = new Date("2026-08-05T08:00:00.000Z");
    prepareAssistantIdentity({ ai: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.reportOverview.mockResolvedValue({
      metadata: {
        timezone: "Europe/Prague",
        currency: "CZK",
        period: { from: "2026-07-07", to: "2026-08-05" },
        comparisonPeriod: { from: "2026-06-07", to: "2026-07-06" },
        generatedAt: now.toISOString(),
        locationId: LOCATION_ID,
      },
      summary: {
        netSales: { value: 180_000, previous: 150_000, changePercent: 20 },
        bookings: { value: 42, previous: 40, changePercent: 5 },
        participants: { value: 80, previous: 70, changePercent: 14.29 },
        utilizationPercent: { value: 64, previous: 57, changePercent: 12.28 },
        returningCustomerPercent: {
          value: 45,
          previous: 40,
          changePercent: 12.5,
        },
      },
      coverage: {
        available: ["bookings", "sales"],
        unavailable: [{ source: "inventory", reason: "module_disabled" }],
        limitations: ["Verified KPI limitation."],
        complete: true,
      },
      customerRecords: "PRIVATE_REPORT_RECORDS",
    });
    mocks.publicSitePreview.mockResolvedValue({
      tenant: { privateDraft: "PRIVATE_SITE_DRAFT" },
      preview: {
        publicationStatus: "live",
        publiclyAvailable: true,
        hasExplicitPublicationState: true,
      },
    });
    mocks.publicSiteEditorState.mockResolvedValue({
      draft: { secret: "PRIVATE_SITE_DRAFT" },
      published: { secret: "PRIVATE_SITE_PUBLISHED" },
      editor: {
        draftRevision: 8,
        publishedRevision: 7,
        hasUnpublishedChanges: true,
        draftUpdatedAt: "2026-08-05T07:00:00.000Z",
        publishedAt: "2026-08-04T07:00:00.000Z",
      },
    });

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: insightAccess,
      locationId: LOCATION_ID,
      now,
    });

    expect(result.reports).toMatchObject({
      currentPeriod: {
        from: "2026-07-07",
        to: "2026-08-05",
        currency: "CZK",
        locationId: LOCATION_ID,
      },
      kpis: {
        netSalesMinor: {
          value: 180_000,
          previous: 150_000,
          changePercent: 20,
        },
        bookings: { value: 42 },
        utilizationPercent: { value: 64 },
      },
      coverage: {
        available: { items: ["bookings", "sales"] },
        complete: true,
      },
    });
    expect(result.publicSite).toEqual({
      publicationStatus: "live",
      publiclyAvailable: true,
      hasExplicitPublicationState: true,
      draftRevision: 8,
      publishedRevision: 7,
      hasUnpublishedChanges: true,
      draftUpdatedAt: "2026-08-05T07:00:00.000Z",
      publishedAt: "2026-08-04T07:00:00.000Z",
    });
    expect(mocks.reportOverview).toHaveBeenCalledWith({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: insightAccess,
      },
      query: {
        compare: true,
        granularity: "auto",
        locationId: LOCATION_ID,
      },
      now,
    });
    expect(mocks.publicSitePreview).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.publicSiteEditorState).toHaveBeenCalledWith(TENANT_ID);
    const serialized = JSON.stringify({
      reports: result.reports,
      publicSite: result.publicSite,
    });
    expect(serialized).not.toContain("PRIVATE_REPORT_RECORDS");
    expect(serialized).not.toContain("PRIVATE_SITE_DRAFT");
    expect(serialized).not.toContain("PRIVATE_SITE_PUBLISHED");
  });

  it("keeps the non-course product catalog available when payments are disabled", async () => {
    const productAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.PRODUCTS_VIEW],
    };
    prepareAssistantIdentity({ payments: false });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.productCount.mockResolvedValue(1);
    mocks.productFind.mockReturnValue(
      queryResult([
        {
          _id: "product-a",
          name: "Open studio",
          description: "Two-hour studio access",
          type: "time_slot",
          price: 490,
          currency: "CZK",
        },
      ]),
    );

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: productAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(mocks.productCount).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        isActive: true,
      }),
    );
    expect(result.products.items[0]).toMatchObject({
      name: "Open studio",
      price: 490,
      currency: "CZK",
    });
    expect(result.coverage.available).toContain("products");
  });

  it("ranks recent courses by allocated paid revenue and labels it as non-profit", async () => {
    const courseA = "507f1f77bcf86cd799439071";
    const courseB = "507f1f77bcf86cd799439072";
    const revenueAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.COURSES_VIEW,
        WORKSPACE_PERMISSION.ORDERS_VIEW,
        WORKSPACE_PERMISSION.PAYMENTS_VIEW,
      ],
    };
    prepareAssistantIdentity({ courses: true, payments: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.productCount.mockResolvedValue(0);
    mocks.productFind.mockImplementation((query) =>
      queryResult(
        query.isActive
          ? []
          : [
              { _id: courseA, name: "Wheel basics", type: "course" },
              { _id: courseB, name: "Glaze lab", type: "course" },
            ],
      ),
    );
    mocks.eventCount.mockResolvedValue(0);
    mocks.eventFind.mockReturnValue(queryResult([]));
    mocks.orderReadLocationScope.mockReturnValue({
      locationIds: { $not: { $elemMatch: { $nin: [LOCATION_ID] } } },
    });
    mocks.orderFind.mockImplementation((query) =>
      queryResult(
        query["lineItems.product"]
          ? [
              {
                _id: "507f1f77bcf86cd799439073",
                paidAmountMinor: 10_000,
                currency: "CZK",
                creditPurchase: { amount: 0 },
                lineItems: [
                  {
                    product: courseA,
                    quantity: 1,
                    grossAmountMinor: 6_000,
                    locationIds: [LOCATION_ID],
                  },
                  {
                    product: courseB,
                    quantity: 1,
                    grossAmountMinor: 4_000,
                    locationIds: [LOCATION_ID],
                  },
                ],
              },
              {
                _id: "507f1f77bcf86cd799439074",
                paidAmountMinor: 5_000,
                currency: "CZK",
                creditPurchase: { amount: 0 },
                lineItems: [
                  {
                    product: courseB,
                    quantity: 1,
                    grossAmountMinor: 5_000,
                    locationIds: [LOCATION_ID],
                  },
                ],
              },
            ]
          : [],
      ),
    );

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: revenueAccess,
      now: new Date("2026-07-30T08:00:00.000Z"),
    });

    expect(result.courses.revenueRecent).toMatchObject({
      period: {
        key: "recent_90_tenant_calendar_days",
        to: "2026-07-30",
        days: 90,
        timezone: "Europe/Prague",
      },
      metric: "allocated_paid_revenue_minor",
      currency: "CZK",
      profitAvailable: false,
      highestRevenueCourse: {
        productId: courseB,
        name: "Glaze lab",
        revenueMinor: 9_000,
        orders: 2,
      },
      courses: {
        total: 2,
        truncated: false,
      },
      analyzedOrders: 2,
      excludedOrdersWithoutPaidAmount: 0,
    });
    expect(result.courses.revenueRecent.limitations.join(" ")).toContain(
      "not profit",
    );
    expect(mocks.orderReadLocationScope).toHaveBeenCalledWith(
      [LOCATION_ID],
      undefined,
    );
    const revenueQuery = mocks.orderFind.mock.calls
      .map(([query]) => query)
      .find((query) => query["lineItems.product"]);
    expect(revenueQuery).toEqual(
      expect.objectContaining({
        tenant: TENANT_ID,
        isPaid: true,
        status: "processed_order",
        currency: "CZK",
      }),
    );
  });

  it("tenant-pins booking product population and omits unmatched raw product IDs", async () => {
    const rawBookingProductId = "507f1f77bcf86cd799439097";
    const courseAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.COURSES_VIEW,
        WORKSPACE_PERMISSION.BOOKINGS_VIEW,
      ],
    };
    prepareAssistantIdentity({
      courses: true,
      bookings: true,
    });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.productCount.mockResolvedValue(0);
    mocks.productFind.mockReturnValue(queryResult([]));
    mocks.eventCount.mockResolvedValue(0);
    mocks.eventFind.mockReturnValue(queryResult([]));
    mocks.bookingCount.mockResolvedValue(1);
    let courseQuery: Record<string, any> | null = null;
    let operationalQuery: Record<string, any> | null = null;
    const isClassBookingQuery = (query: Record<string, any>) =>
      Array.isArray(query.tag?.$in) &&
      query.tag.$in.includes("class") &&
      query.tag.$in.includes("course");
    mocks.bookingFind.mockImplementation((query) => {
      if (isClassBookingQuery(query)) {
        courseQuery = queryResult([
          {
            _id: "course-booking-a",
            bookingProduct: rawBookingProductId,
            start: new Date("2026-08-01T08:00:00.000Z"),
            end: new Date("2026-08-01T10:00:00.000Z"),
            location: LOCATION_ID,
            status: "confirmed",
            paymentStatus: "paid",
            numberOfGuests: 1,
          },
        ]);
        return courseQuery;
      }
      operationalQuery = queryResult([
        {
          _id: "booking-a",
          bookingProduct: rawBookingProductId,
          start: new Date("2026-08-01T08:00:00.000Z"),
          end: new Date("2026-08-01T10:00:00.000Z"),
          location: LOCATION_ID,
          tag: "solo",
          status: "confirmed",
        },
      ]);
      return operationalQuery;
    });

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: courseAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(courseQuery?.populate).toHaveBeenCalledWith({
      path: "bookingProduct",
      select: "name type maxNumberOfParticipants",
      match: { tenant: TENANT_ID },
    });
    const courseFindFilter = mocks.bookingFind.mock.calls
      .map(([query]) => query)
      .find(isClassBookingQuery);
    expect(courseFindFilter).toEqual(
      expect.objectContaining({
        tag: { $in: ["class", "course"] },
        paymentStatus: "CONFIRMED",
      }),
    );
    expect(operationalQuery?.populate).toHaveBeenCalledWith({
      path: "bookingProduct",
      select: "name type",
      match: { tenant: TENANT_ID },
    });
    expect(result.courses.upcomingSessions.items[0].productId).toBeNull();
    expect(result.courses.upcomingSessions.items[0].name).toBeNull();
    expect(result.operations.bookings.upcoming[0].name).toBeNull();
    expect(JSON.stringify(result)).not.toContain(rawBookingProductId);
  });

  it("counts customers linked to future bookings but only past bookings as recent activity", async () => {
    const customerAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
        WORKSPACE_PERMISSION.BOOKINGS_VIEW,
      ],
    };
    const now = new Date("2026-07-28T08:00:00.000Z");
    prepareAssistantIdentity({
      customers: true,
      bookings: true,
    });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.bookingCount.mockResolvedValue(0);
    mocks.bookingFind.mockReturnValue(queryResult([]));
    mocks.bookingAggregate.mockResolvedValue([
      { total: 3, activeLast30Days: 2 },
    ]);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: customerAccess,
      now,
    });

    const pipeline = mocks.bookingAggregate.mock.calls[0]?.[0];
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({
        paymentStatus: "CONFIRMED",
        tag: { $ne: "guest-increase" },
      }),
    );
    expect(pipeline[0].$match).not.toHaveProperty("start");
    expect(pipeline[1].$group.latestPastBookingAt.$max.$cond[0]).toEqual({
      $lte: ["$start", now],
    });
    expect(JSON.stringify(pipeline[4].$group.activeLast30Days)).toContain(
      "latestPastBookingAt",
    );
    expect(result.customers).toMatchObject({
      total: 3,
      activeLast30Days: 2,
    });
  });

  it("keeps the authoritative workspace customer count when an all-location actor pins the conversation", async () => {
    const allLocationAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.CUSTOMERS_VIEW],
      locationAccess: { mode: "all", locationIds: [] },
    };
    prepareAssistantIdentity({ customers: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.userCount.mockResolvedValueOnce(148).mockResolvedValueOnce(5);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: allLocationAccess,
      locationId: LOCATION_ID,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(mocks.userCount).toHaveBeenNthCalledWith(1, {
      tenant: TENANT_ID,
      tenantRole: "customer",
    });
    expect(result.customers).toMatchObject({
      total: 148,
      newLast30Days: 5,
      activeLast30Days: null,
      basis: "workspace_accounts",
    });
    expect(mocks.bookingAggregate).not.toHaveBeenCalled();
  });

  it("counts active workspace member accounts within the authorized location scope", async () => {
    const teamAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.TEAM_VIEW],
    };
    prepareAssistantIdentity();
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.staffMemberCount.mockResolvedValueOnce(2);
    mocks.staffMemberFind.mockReturnValueOnce(queryResult([]));
    mocks.tenantMembershipCount.mockResolvedValueOnce(3);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: teamAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    const membershipQuery = mocks.tenantMembershipCount.mock.calls[0]?.[0];
    expect(membershipQuery).toEqual({
      tenant: TENANT_ID,
      status: "active",
      $or: [
        { "locationAccess.mode": "all" },
        {
          "locationAccess.locationIds": {
            $in: [new mongoose.Types.ObjectId(LOCATION_ID)],
          },
        },
      ],
    });
    expect(result.team).toMatchObject({
      total: 2,
      activeWorkspaceMemberCount: 3,
      workspaceMemberBasis: "active_tenant_memberships_in_visible_scope",
    });
    expect(result.coverage.available).toContain("team");
  });

  it("counts only issued invoices as overdue or outstanding", async () => {
    vi.stubEnv("NATIVE_INVOICES_ENABLED", "true");
    const invoiceAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.INVOICES_VIEW],
    };
    prepareAssistantIdentity({ payments: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.invoiceCount.mockImplementation((query) =>
      Promise.resolve(query?.dueDate ? 1 : 0),
    );
    mocks.invoiceFind.mockImplementation((query) =>
      queryResult(
        query?.dueDate
          ? [
              {
                _id: "507f1f77bcf86cd799439099",
                number: "INV-2026-0042",
                currency: "CZK",
                amountDueMinor: 12_500,
                dueDate: new Date("2026-07-20T00:00:00.000Z"),
                paymentStatus: "unpaid",
                locationIds: [new mongoose.Types.ObjectId(LOCATION_ID)],
              },
            ]
          : [],
      ),
    );
    mocks.invoiceAggregate.mockResolvedValue([]);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: invoiceAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    const overdueQuery = mocks.invoiceCount.mock.calls.find(
      ([query]) => query?.dueDate,
    )?.[0];
    expect(overdueQuery).toEqual(
      expect.objectContaining({
        documentType: "invoice",
        documentStatus: "issued",
        amountDueMinor: { $gt: 0 },
      }),
    );
    const overdueListQuery = mocks.invoiceFind.mock.calls.find(
      ([query]) => query?.dueDate,
    )?.[0];
    expect(overdueListQuery).toEqual(
      expect.objectContaining({
        documentType: "invoice",
        documentStatus: "issued",
        amountDueMinor: { $gt: 0 },
      }),
    );
    expect(result.invoices.overdueItems).toMatchObject({
      total: 1,
      truncated: false,
      items: [
        expect.objectContaining({
          number: "INV-2026-0042",
          amountDueMinor: 12_500,
        }),
      ],
    });
    const outstandingPipeline = mocks.invoiceAggregate.mock.calls[0]?.[0];
    expect(outstandingPipeline[0].$match).toEqual(
      expect.objectContaining({
        documentType: "invoice",
        documentStatus: "issued",
        amountDueMinor: { $gt: 0 },
      }),
    );
  });

  it("does not query native invoices while disabled even when the actor has permission", async () => {
    vi.stubEnv("NATIVE_INVOICES_ENABLED", "false");
    prepareAssistantIdentity({ payments: true });
    mocks.hasPermission.mockReturnValue(true);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: { ...access, permissions: [WORKSPACE_PERMISSION.INVOICES_VIEW] },
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(result.invoices).toBeNull();
    expect(mocks.invoiceCount).not.toHaveBeenCalled();
    expect(mocks.invoiceFind).not.toHaveBeenCalled();
    expect(mocks.invoiceAggregate).not.toHaveBeenCalled();
    expect(result.coverage.available).not.toContain("invoices");
  });

  it.each([
    {
      name: "tenant mismatch",
      invalidAccess: { ...access, tenantId: "507f1f77bcf86cd799439099" },
    },
    {
      name: "user mismatch",
      invalidAccess: { ...access, userId: "507f1f77bcf86cd799439098" },
    },
    {
      name: "inactive membership",
      invalidAccess: { ...access, status: "suspended" as const },
    },
  ])("rejects $name before any database read", async ({ invalidAccess }) => {
    await expect(
      buildWorkspaceAssistantContext({
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: invalidAccess,
      }),
    ).rejects.toThrow("Active workspace access");

    expect(mocks.tenantFindById).not.toHaveBeenCalled();
    expect(mocks.userFindOne).not.toHaveBeenCalled();
  });

  it("returns only inventory stock visible in the selected location", async () => {
    const hiddenLocationId = "507f1f77bcf86cd799439099";
    const inventoryAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.INVENTORY_VIEW],
    };
    prepareAssistantIdentity({ inventory: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.inventoryCount.mockResolvedValue(1);
    mocks.inventoryFind.mockImplementation(() =>
      queryResult([
        {
          _id: "inventory-a",
          name: "Stoneware clay",
          sku: "CLAY-01",
          category: "clay",
          unit: "kg",
          currency: "CZK",
          averageUnitCostWithoutVat: 22,
          supplier: "hidden-supplier",
          note: "hidden-internal-note",
          stockLevels: [
            {
              location: new mongoose.Types.ObjectId(LOCATION_ID),
              currentQuantity: 8,
              minimumQuantity: 5,
            },
            {
              location: new mongoose.Types.ObjectId(hiddenLocationId),
              currentQuantity: 200,
              minimumQuantity: 50,
            },
          ],
        },
      ]),
    );

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: inventoryAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    const catalogQuery = mocks.inventoryCount.mock.calls
      .map(([query]) => query)
      .find((query) => Array.isArray(query?.$or));
    expect(JSON.stringify(catalogQuery)).toContain(LOCATION_ID);
    expect(result.inventory).toMatchObject({
      total: 1,
      truncated: false,
      items: [
        {
          name: "Stoneware clay",
          sku: "CLAY-01",
          stock: {
            currentQuantity: 8,
            minimumQuantity: 5,
            lowStock: false,
            levels: {
              total: 1,
              truncated: false,
              items: [
                {
                  locationId: LOCATION_ID,
                  currentQuantity: 8,
                  minimumQuantity: 5,
                },
              ],
            },
          },
        },
      ],
    });
    const serialized = JSON.stringify(result.inventory);
    expect(serialized).not.toContain(hiddenLocationId);
    expect(serialized).not.toContain("hidden-supplier");
    expect(serialized).not.toContain("hidden-internal-note");
  });

  it("adds only active, location-scoped reorder requests to authorized inventory context", async () => {
    const inventoryAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.INVENTORY_VIEW],
    };
    prepareAssistantIdentity({ inventory: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.inventoryCount.mockResolvedValue(0);
    mocks.inventoryFind.mockReturnValue(queryResult([]));
    mocks.reorderCount
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    const reorderQuery = queryResult([
      {
        _id: "reorder-a",
        item: {
          _id: "item-a",
          name: "Porcelain clay",
          unit: "kg",
          supplier: "private-supplier",
        },
        location: new mongoose.Types.ObjectId(LOCATION_ID),
        requestedQuantity: 12,
        priority: "high",
        status: "open",
        source: "manual",
        note: "PRIVATE_REORDER_NOTE",
        createdBy: "PRIVATE_CREATOR_ID",
        createdAt: new Date("2026-08-12T07:00:00.000Z"),
      },
    ]);
    mocks.reorderFind.mockReturnValue(reorderQuery);

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: inventoryAccess,
      now: new Date("2026-08-12T08:00:00.000Z"),
    });

    expect(mocks.reorderCount.mock.calls[0]?.[0]).toEqual({
      tenant: TENANT_ID,
      location: {
        $in: [new mongoose.Types.ObjectId(LOCATION_ID)],
      },
      status: { $in: ["open", "ordered"] },
    });
    expect(reorderQuery.select).toHaveBeenCalledWith(
      "item location requestedQuantity priority status source createdAt",
    );
    expect(reorderQuery.populate).toHaveBeenCalledWith({
      path: "item",
      match: { tenant: TENANT_ID },
      select: "name unit",
    });
    expect(result.coverage.available).toContain("inventory.reorderRequests");
    expect(result.inventory.reorderRequests.active).toMatchObject({
      total: 2,
      openCount: 1,
      orderedCount: 1,
      highPriorityCount: 1,
      truncated: true,
      items: [
        {
          id: "reorder-a",
          itemId: "item-a",
          itemName: "Porcelain clay",
          locationId: LOCATION_ID,
          unit: "kg",
          requestedQuantity: 12,
          priority: "high",
          status: "open",
          source: "manual",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REORDER_NOTE");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CREATOR_ID");
    expect(JSON.stringify(result)).not.toContain("private-supplier");
  });

  it("does not query reorder requests without inventory view access", async () => {
    prepareAssistantIdentity({ inventory: true });

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access,
      now: new Date("2026-08-12T08:00:00.000Z"),
    });

    expect(mocks.reorderCount).not.toHaveBeenCalled();
    expect(mocks.reorderFind).not.toHaveBeenCalled();
    expect(result.coverage.omitted).toContainEqual({
      source: "inventory.reorderRequests",
      reason: "permission_required",
    });
  });

  it("never exposes a legacy global quantity when its canonical first location is hidden", async () => {
    const hiddenFirstLocationId = "507f1f77bcf86cd799439099";
    const inventoryAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.INVENTORY_VIEW],
    };
    const legacyItem = {
      _id: "legacy-inventory-a",
      name: "Legacy clay",
      unit: "kg",
      currency: "CZK",
      stockLevels: [],
      locations: [
        new mongoose.Types.ObjectId(hiddenFirstLocationId),
        new mongoose.Types.ObjectId(LOCATION_ID),
      ],
      currentQuantity: 2,
      minimumQuantity: 5,
    };
    prepareAssistantIdentity({ inventory: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.inventoryCount.mockImplementation((query) =>
      Promise.resolve(Array.isArray(query?.$or) ? 1 : 0),
    );
    mocks.inventoryFind.mockImplementation(() => queryResult([legacyItem]));

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: inventoryAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(result.inventory.items[0].stock).toMatchObject({
      currentQuantity: 0,
      minimumQuantity: 0,
      lowStock: false,
      levels: {
        total: 1,
        items: [
          {
            locationId: LOCATION_ID,
            currentQuantity: 0,
            minimumQuantity: 0,
          },
        ],
      },
    });
    expect(result.operations.inventory).toEqual({
      lowStockCount: 0,
      items: [],
    });
    const operationalQuery = mocks.inventoryCount.mock.calls
      .map(([query]) => query)
      .find((query) => query?.$expr);
    expect(JSON.stringify(operationalQuery)).toContain("$arrayElemAt");
    expect(JSON.stringify(operationalQuery)).toContain(LOCATION_ID);
    expect(JSON.stringify(result)).not.toContain(`"currentQuantity":2`);
    expect(JSON.stringify(result)).not.toContain(`"minimumQuantity":5`);
  });

  it("fails closed for an explicitly empty selected-location scope", async () => {
    const emptyLocationAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.TASKS_VIEW,
        WORKSPACE_PERMISSION.INVENTORY_VIEW,
      ],
      locationAccess: { mode: "selected", locationIds: [] },
    };
    prepareAssistantIdentity({
      staff_tasks: true,
      inventory: true,
    });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.taskCount.mockResolvedValue(0);
    mocks.taskFind.mockReturnValue(queryResult([]));
    mocks.inventoryCount.mockResolvedValue(0);
    mocks.inventoryFind.mockReturnValue(queryResult([]));

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: emptyLocationAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(result.inventory).toBeNull();
    expect(result.coverage.omitted).toContainEqual({
      source: "inventory",
      reason: "location_scope_empty",
    });
    expect(mocks.taskCount).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $exists: false },
      }),
    );
    expect(
      mocks.inventoryCount.mock.calls.some(([query]) =>
        Array.isArray(query?.$or),
      ),
    ).toBe(false);
  });

  it("uses ObjectIds and excludes empty legacy selected scopes for memberships", async () => {
    const membershipAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.MEMBERSHIPS_VIEW],
    };
    prepareAssistantIdentity({ memberships: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.membershipPlans.mockResolvedValue({ plans: [], total: 0 });
    mocks.membershipAggregate.mockResolvedValue([
      { byStatus: [], expiringSoon: [], total: [] },
    ]);

    await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: membershipAccess,
      locationId: LOCATION_ID,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    const pipeline = mocks.membershipAggregate.mock.calls[0]?.[0];
    const match = pipeline[0].$match;
    expect(match.tenant).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(
      match.$and[0].$or[1]["planSnapshot.locationScope.locationIds.0"],
    ).toEqual({ $exists: true });
    expect(
      match.$and[1].$or[1]["planSnapshot.locationScope.locationIds.0"],
    ).toEqual({ $exists: true });
    expect(match.$and[1].$or[0].selectedLocation).toBeInstanceOf(
      mongoose.Types.ObjectId,
    );
  });

  it("adds bounded daily, weekly, monthly, and board planning detail for the assistant", async () => {
    const planningAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [
        WORKSPACE_PERMISSION.PLANNING_TEAM_VIEW,
        WORKSPACE_PERMISSION.TASKS_VIEW,
      ],
    };
    prepareAssistantIdentity({ staff_tasks: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.tenantExists.mockResolvedValue(true);
    mocks.taskCount.mockResolvedValue(0);
    mocks.taskFind.mockReturnValue(queryResult([]));
    mocks.staffPlanningOverview.mockResolvedValue({
      metadata: {
        date: "2026-07-28",
        timezone: "Europe/Prague",
        locationId: LOCATION_ID,
        week: { from: "2026-07-27", to: "2026-08-02" },
        month: {
          key: "2026-07",
          from: "2026-07-01",
          to: "2026-07-31",
        },
      },
      settings: {
        expectedUpdateTime: "09:00",
        dueAt: "2026-07-28T07:00:00.000Z",
      },
      today: {
        counts: { submitted: 1, blocked: 1 },
        staff: [
          {
            userId: USER_ID,
            displayName: "Martin Owner",
            state: "blocked",
            isExpectedToday: true,
            update: {
              date: "2026-07-28",
              locationId: LOCATION_ID,
              focusToday: "F".repeat(1_200),
              completedSinceLast: "Loaded kiln",
              blockers: "Waiting for elements",
              needsOwnerAttention: true,
              attentionStatus: "none",
              linkedTaskIds: ["task-1"],
            },
          },
        ],
      },
      week: {
        plans: [
          {
            userId: USER_ID,
            weekStart: "2026-07-27",
            locationId: LOCATION_ID,
            outcomes: [
              {
                title: "Finish glaze firing",
                completed: false,
                linkedTaskIds: ["task-1"],
              },
            ],
          },
        ],
      },
      month: {
        prioritySets: [
          {
            month: "2026-07",
            locationId: LOCATION_ID,
            priorities: [
              {
                title: "Reduce firing backlog",
                ownerUserId: USER_ID,
                completed: false,
                linkedTaskIds: ["task-1"],
              },
            ],
          },
        ],
      },
      board: {
        tasks: [
          {
            id: "task-1",
            title: "Load kiln",
            description: "Prepare shelves",
            locationId: LOCATION_ID,
            status: "in-progress",
            column: "in-progress",
            priority: "urgent",
            blockerReason: "",
            category: "firing",
          },
        ],
      },
    });

    const result = await buildWorkspaceAssistantContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: planningAccess,
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    const planning = result.operations.staffPlanning;
    expect(planning.today.staff.items[0]).toMatchObject({
      displayName: "Martin Owner",
      state: "blocked",
    });
    expect(planning.today.staff.items[0].update.focusToday).toHaveLength(800);
    expect(planning.week.plans.items[0].outcomes.items[0].title).toBe(
      "Finish glaze firing",
    );
    expect(
      planning.month.prioritySets.items[0].priorities.items[0],
    ).toMatchObject({
      title: "Reduce firing backlog",
      ownerName: "Martin Owner",
    });
    expect(planning.board.tasks.items[0].title).toBe("Load kiln");
    expect(mocks.taskFind).toHaveBeenCalledWith(
      expect.objectContaining({
        dueDate: { $ne: null },
      }),
    );
  });

  it("enforces the final serialized context ceiling after budget metadata is written", () => {
    const largeText = "x".repeat(2_500);
    const largeItems = Array.from({ length: 80 }, (_, index) => ({
      id: String(index),
      name: largeText,
      description: largeText,
    }));
    const context: Record<string, any> = {
      generatedAt: "2026-07-28T08:00:00.000Z",
      scope: { timezone: "Europe/Prague" },
      studio: { name: "Studio Grohova" },
      actor: { id: USER_ID, displayName: "Martin Owner" },
      locations: {
        total: largeItems.length,
        items: [...largeItems],
        truncated: false,
      },
      products: {
        total: largeItems.length,
        items: [...largeItems],
        truncated: false,
      },
      inventory: {
        total: largeItems.length,
        items: [...largeItems],
        truncated: false,
      },
      courses: {
        catalog: null,
        upcomingSessions: null,
        upcomingEvents: null,
      },
      team: null,
      customers: null,
      memberships: null,
      invoices: null,
      pottery: { kilns: null, pieces: null },
      operations: null,
      coverage: {
        available: ["actor", "studio", "locations", "products", "inventory"],
        omitted: [],
        unavailable: [],
        complete: true,
      },
    };

    const result = enforceWorkspaceAssistantContextBudget(context);
    const length = JSON.stringify(result).length;

    expect(length).toBeLessThanOrEqual(
      WORKSPACE_ASSISTANT_CONTEXT_MAX_SERIALIZED_CHARS,
    );
    expect(result.coverage.budget.serializedCharacters).toBe(length);
    expect(result.coverage.budget.truncated).toBe(true);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.omitted).toContainEqual(
      expect.objectContaining({ reason: "context_budget" }),
    );
    expect(result.studio.name).toBe("Studio Grohova");
    expect(result.actor.id).toBe(USER_ID);
    expect(result.scope.timezone).toBe("Europe/Prague");
  });

  it("tenant-pins authoritative booking-location aggregates and preserves location access", async () => {
    const bookingAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
    };
    prepareAssistantIdentity({ bookings: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.bookingCount.mockResolvedValue(0);
    mocks.bookingFind.mockReturnValue(queryResult([]));
    const leaderLocationId = new mongoose.Types.ObjectId(LOCATION_ID);
    mocks.bookingAggregate
      .mockResolvedValueOnce([{ _id: leaderLocationId, count: 2 }])
      .mockResolvedValueOnce([{ _id: leaderLocationId, count: 3 }])
      .mockResolvedValueOnce([{ _id: leaderLocationId, count: 7 }]);
    mocks.locationFind.mockReturnValue(
      queryResult([{ _id: leaderLocationId, name: "Grohova" }]),
    );

    const result = await buildWorkspaceOperationalContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: bookingAccess,
      timezone: "Europe/Prague",
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(mocks.bookingAggregate).toHaveBeenCalledTimes(3);
    const matches = mocks.bookingAggregate.mock.calls.map(
      ([pipeline]) => pipeline[0].$match,
    );
    for (const match of matches) {
      expect(match).toEqual(
        expect.objectContaining({
          tenant: new mongoose.Types.ObjectId(TENANT_ID),
          location: {
            $in: [new mongoose.Types.ObjectId(LOCATION_ID)],
            $ne: null,
          },
          status: { $ne: "cancelled" },
          paymentStatus: "CONFIRMED",
          tag: { $ne: "guest-increase" },
        }),
      );
    }
    expect(matches[0].start).toEqual({
      $gte: new Date("2026-07-27T22:00:00.000Z"),
      $lt: new Date("2026-07-28T22:00:00.000Z"),
    });
    expect(matches[1].start).toEqual({
      $gte: new Date("2026-07-28T08:00:00.000Z"),
    });
    expect(matches[2]).not.toHaveProperty("start");
    expect(mocks.locationFind).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      _id: { $in: [new mongoose.Types.ObjectId(LOCATION_ID)] },
    });
    expect(result.bookings).toHaveProperty("byLocation", {
      today: {
        total: 1,
        truncated: false,
        items: [
          {
            locationId: LOCATION_ID,
            locationName: "Grohova",
            count: 2,
          },
        ],
      },
      upcoming: {
        total: 1,
        truncated: false,
        items: [
          {
            locationId: LOCATION_ID,
            locationName: "Grohova",
            count: 3,
          },
        ],
      },
      allTime: {
        total: 1,
        truncated: false,
        items: [
          {
            locationId: LOCATION_ID,
            locationName: "Grohova",
            count: 7,
          },
        ],
      },
    });
  });

  it("keeps inactive historical booking locations and marks unresolved rows incomplete", async () => {
    const bookingAccess: ResolvedWorkspaceAccess = {
      ...access,
      permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
      locationAccess: { mode: "all", locationIds: [] },
    };
    prepareAssistantIdentity({ bookings: true });
    mocks.hasPermission.mockImplementation(
      (candidate: ResolvedWorkspaceAccess, permission: string) =>
        candidate.permissions.includes(permission as any),
    );
    mocks.bookingCount.mockResolvedValue(0);
    mocks.bookingFind.mockReturnValue(queryResult([]));

    const unresolvedLocationId = new mongoose.Types.ObjectId(
      "507f1f77bcf86cd799439015",
    );
    const inactiveLocationId = new mongoose.Types.ObjectId(
      "507f1f77bcf86cd799439016",
    );
    const activeLocationId = new mongoose.Types.ObjectId(LOCATION_ID);
    mocks.bookingAggregate
      .mockResolvedValueOnce([
        { _id: unresolvedLocationId, count: 12 },
        { _id: inactiveLocationId, count: 9 },
        { _id: activeLocationId, count: 4 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.locationFind.mockReturnValue(
      queryResult([
        {
          _id: inactiveLocationId,
          name: "Archived Annex",
          isActive: false,
        },
        { _id: activeLocationId, name: "Grohova", isActive: true },
      ]),
    );

    const result = await buildWorkspaceOperationalContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: bookingAccess,
      timezone: "Europe/Prague",
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(mocks.locationFind).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      _id: {
        $in: [unresolvedLocationId, inactiveLocationId, activeLocationId],
      },
    });
    expect(result.bookings).toHaveProperty("byLocation.today", {
      total: 3,
      truncated: true,
      items: [
        {
          locationId: String(inactiveLocationId),
          locationName: "Archived Annex",
          count: 9,
        },
        {
          locationId: LOCATION_ID,
          locationName: "Grohova",
          count: 4,
        },
      ],
    });
    expect(result.bookings).toHaveProperty(
      "byLocation.today.items",
      expect.not.arrayContaining([
        expect.objectContaining({ locationId: String(unresolvedLocationId) }),
      ]),
    );
  });
});
