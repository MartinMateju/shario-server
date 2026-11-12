import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsFind: vi.fn(),
  membershipFind: vi.fn(),
  resolveEntitlement: vi.fn(),
  resolveAccess: vi.fn(),
  hasPermission: vi.fn(),
  getAllowedLocations: vi.fn(),
  getLatestBriefing: vi.fn(),
  generateBriefing: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/modules/ai/ai.models.js", () => ({
  AiSettingsModel: { find: mocks.settingsFind },
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { find: mocks.membershipFind },
}));
vi.mock("@/modules/tenant-access/index.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    resolveWorkspaceAccessForUser: mocks.resolveAccess,
    hasWorkspacePermission: mocks.hasPermission,
    getAllowedWorkspaceLocationIds: mocks.getAllowedLocations,
  };
});
vi.mock("@/modules/ai/services/ai-access.service.js", () => ({
  resolveAiEntitlement: mocks.resolveEntitlement,
}));
vi.mock("@/modules/ai/services/briefing.service.js", () => ({
  generateBriefing: mocks.generateBriefing,
  getLatestBriefing: mocks.getLatestBriefing,
}));
vi.mock("@/config/logger.js", () => ({
  logger: { warn: mocks.loggerWarn },
}));

import { generateDueAiBriefings } from "@/modules/ai/services/ai-scheduler.service.js";
import { AI_AUDIENCE } from "@/modules/ai/ai.constants.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";

const TENANT_A = "507f1f77bcf86cd799439011";
const TENANT_B = "507f1f77bcf86cd799439012";
const USER_ID = "507f1f77bcf86cd799439013";
const USER_ID_2 = "507f1f77bcf86cd799439015";
const LOCATION_ID = "507f1f77bcf86cd799439014";

const query = (value: unknown) => ({
  select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
});

const settingsRow = (
  tenant = TENANT_A,
  overrides: Record<string, unknown> = {},
) => ({
  tenant,
  defaultLocale: "en",
  briefingTime: "07:30",
  ...overrides,
});

const entitlement = (
  tenant = TENANT_A,
  overrides: Record<string, any> = {},
) => ({
  canUseAi: true,
  tenant: {
    _id: tenant,
    settings: { timezone: "Europe/Prague" },
  },
  settings: { dailyBriefingEnabled: true },
  ...overrides,
});

const access = (tenant = TENANT_A): ResolvedWorkspaceAccess => ({
  membershipId: "507f1f77bcf86cd799439020",
  tenantId: tenant,
  userId: USER_ID,
  status: "active",
  role: "staff",
  customRoleId: null,
  customRoleName: null,
  permissions: [WORKSPACE_PERMISSION.AI_USE],
  locationAccess: { mode: "selected", locationIds: [LOCATION_ID] },
  workspaceProfile: { jobTitle: "", displayName: "", calendarColor: "" },
  preferences: {
    language: "cs",
    displayTimezone: null,
    defaultLocation: LOCATION_ID,
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
});

describe("scheduled AI daily briefings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsFind.mockReturnValue(query([settingsRow()]));
    mocks.membershipFind.mockReturnValue(query([{ user: USER_ID }]));
    mocks.resolveEntitlement.mockResolvedValue(entitlement());
    mocks.resolveAccess.mockResolvedValue(access());
    mocks.hasPermission.mockReturnValue(true);
    mocks.getAllowedLocations.mockReturnValue([LOCATION_ID]);
    mocks.getLatestBriefing.mockResolvedValue(null);
    mocks.generateBriefing.mockResolvedValue({ id: "briefing-1" });
  });

  it("skips the tenant before its configured local briefing time", async () => {
    // 04:00 UTC is 06:00 in Europe/Prague in July, before 07:30.
    const result = await generateDueAiBriefings(
      new Date("2026-07-23T04:00:00.000Z"),
    );

    expect(result).toEqual({ generated: 0, skipped: 1 });
    expect(mocks.resolveEntitlement).toHaveBeenCalledWith(TENANT_A);
    expect(mocks.membershipFind).not.toHaveBeenCalled();
    expect(mocks.generateBriefing).not.toHaveBeenCalled();
  });

  it("generates for an entitled active AI_USE member using tenant time and location scope", async () => {
    // 06:00 UTC is 08:00 in Europe/Prague in July, after 07:30.
    const result = await generateDueAiBriefings(
      new Date("2026-07-23T06:00:00.000Z"),
    );

    expect(mocks.membershipFind).toHaveBeenCalledWith({
      tenant: TENANT_A,
      status: "active",
    });
    expect(mocks.resolveAccess).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      userId: USER_ID,
    });
    expect(mocks.hasPermission).toHaveBeenCalledWith(
      expect.any(Object),
      WORKSPACE_PERMISSION.AI_USE,
    );
    expect(mocks.getAllowedLocations).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, userId: USER_ID }),
    );
    expect(mocks.generateBriefing).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        userId: USER_ID,
        audience: AI_AUDIENCE.SYSTEM,
        allowedLocationIds: [LOCATION_ID],
        locale: "cs",
      }),
      { force: false, locale: "cs" },
    );
    expect(result).toEqual({ generated: 1, skipped: 0 });
  });

  it("skips an active member who lacks AI_USE", async () => {
    mocks.hasPermission.mockReturnValueOnce(false);

    const result = await generateDueAiBriefings(
      new Date("2026-07-23T06:00:00.000Z"),
    );

    expect(result).toEqual({ generated: 0, skipped: 1 });
    expect(mocks.generateBriefing).not.toHaveBeenCalled();
  });

  it("does not regenerate a current-day briefing on later scheduler polls", async () => {
    mocks.getLatestBriefing.mockResolvedValueOnce({ id: "briefing-1" });

    const result = await generateDueAiBriefings(
      new Date("2026-07-23T06:00:00.000Z"),
    );

    expect(mocks.getLatestBriefing).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, userId: USER_ID }),
      { locale: "cs" },
    );
    expect(mocks.generateBriefing).not.toHaveBeenCalled();
    expect(result).toEqual({ generated: 0, skipped: 1 });
  });

  it("isolates a member failure and continues generating for later members", async () => {
    mocks.membershipFind.mockReturnValueOnce(
      query([{ user: USER_ID }, { user: USER_ID_2 }]),
    );
    mocks.resolveAccess
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce({ ...access(), userId: USER_ID_2 });
    mocks.generateBriefing
      .mockRejectedValueOnce(new Error("member generation failed"))
      .mockResolvedValueOnce({ id: "briefing-2" });

    const result = await generateDueAiBriefings(
      new Date("2026-07-23T06:00:00.000Z"),
    );

    expect(mocks.generateBriefing).toHaveBeenCalledTimes(2);
    expect(mocks.generateBriefing).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, userId: USER_ID_2 }),
      { force: false, locale: "cs" },
    );
    expect(result).toEqual({ generated: 1, skipped: 1 });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tenantId: TENANT_A,
        userId: USER_ID,
      }),
      "Scheduled AI briefing generation failed for member.",
    );
  });

  it("isolates a tenant failure and continues scheduling later tenants", async () => {
    mocks.settingsFind.mockReturnValueOnce(
      query([settingsRow(TENANT_A), settingsRow(TENANT_B)]),
    );
    mocks.resolveEntitlement
      .mockRejectedValueOnce(new Error("tenant A database failure"))
      .mockResolvedValueOnce(entitlement(TENANT_B));
    mocks.membershipFind.mockReturnValueOnce(query([{ user: USER_ID }]));
    mocks.resolveAccess.mockResolvedValueOnce(access(TENANT_B));

    const result = await generateDueAiBriefings(
      new Date("2026-07-23T06:00:00.000Z"),
    );

    expect(mocks.resolveEntitlement).toHaveBeenNthCalledWith(1, TENANT_A);
    expect(mocks.resolveEntitlement).toHaveBeenNthCalledWith(2, TENANT_B);
    expect(mocks.generateBriefing).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_B }),
      expect.any(Object),
    );
    expect(result.generated).toBe(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tenantId: TENANT_A,
      }),
      "Scheduled AI briefing generation failed for tenant.",
    );
  });
});
