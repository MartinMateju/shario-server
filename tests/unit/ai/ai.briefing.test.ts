import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  locationExists: vi.fn(),
  canAccessLocation: vi.fn(),
  getAllowedLocations: vi.fn(),
  requireEntitlement: vi.fn(),
  buildOperations: vi.fn(),
  executeStructured: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: { exists: mocks.locationExists },
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  canAccessWorkspaceLocation: mocks.canAccessLocation,
  getAllowedWorkspaceLocationIds: mocks.getAllowedLocations,
}));
vi.mock("@/modules/ai/services/ai-access.service.js", () => ({
  requireAiEntitlement: mocks.requireEntitlement,
}));
vi.mock("@/modules/ai/services/studio-context.service.js", () => ({
  STUDIO_CONTEXT_VERSION: "studio-context-v1",
  buildStudioOperationalContextSnapshot: mocks.buildOperations,
}));
vi.mock("@/modules/ai/services/ai-orchestrator.service.js", () => ({
  executeStructuredAi: mocks.executeStructured,
}));
vi.mock("@/modules/ai/ai.models.js", () => ({
  AiBriefingModel: {
    findOne: mocks.findOne,
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));

import {
  generateBriefing,
  getLatestBriefing,
} from "@/modules/ai/services/briefing.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";

const context = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT_ID,
  userId: USER_ID,
  audience: "workspace" as const,
  allowedLocationIds: null,
  access: {
    tenantId: TENANT_ID,
    userId: USER_ID,
    status: "active",
    accessVersion: 2,
    permissions: [
      "ai.use",
      "bookings.view",
      "tasks.view",
      "inventory.view",
      "firings.view",
      "communications.view",
      "orders.view",
    ],
    locationAccess: { mode: "all", locationIds: [] },
    preferences: { language: "en" },
  },
  ...overrides,
});

const operationalFacts = () => ({
  contextVersion: "studio-context-v1",
  dateKey: "2026-08-03",
  generatedAt: "2026-08-03T07:30:00.000Z",
  coverage: {
    available: [
      "bookings",
      "tasks",
      "inventory",
      "firings",
      "communications",
      "orders",
    ],
    unavailable: [],
    complete: true,
  },
  bookings: { todayCount: 8, unpaidCount: 1 },
  tasks: { openCount: 3, overdueCount: 1, urgent: 0 },
  inventory: { lowStockCount: 2 },
  firings: {
    running: 1,
    pending: 0,
    completedAwaitingNotification: 1,
  },
  communications: { open: 2, urgent: 1, unread: 1 },
  orders: { paidToday: 4, totalsMinorByCurrency: { CZK: 25_000 } },
  privateCustomerMessage: "must never reach the provider",
});

const entitlement = () => ({
  tenant: {
    settings: { timezone: "Europe/Prague" },
    modules: {
      ai: true,
      bookings: true,
      staff_tasks: true,
      inventory: true,
      firing: true,
      communications: true,
    },
  },
  settings: {
    defaultLocale: "en",
    dailyBriefingEnabled: true,
    staffPlanningEnabled: true,
    updatedAt: new Date("2026-08-03T06:00:00.000Z"),
  },
});

describe("daily briefing service", () => {
  let stored: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T08:00:00.000Z"));
    vi.clearAllMocks();
    stored = null;
    mocks.canAccessLocation.mockReturnValue(true);
    mocks.getAllowedLocations.mockReturnValue(null);
    mocks.locationExists.mockResolvedValue(true);
    mocks.requireEntitlement.mockResolvedValue(entitlement());
    mocks.buildOperations.mockResolvedValue(operationalFacts());
    mocks.executeStructured.mockResolvedValue({
      value: {
        headline: "Three priorities for this morning",
        summary: "Review the verified priorities before the first session.",
        attentionIds: ["low-stock-items", "invented-priority"],
      },
      runId: "507f1f77bcf86cd799439099",
      provider: "openai",
      model: "test-model",
    });
    mocks.findOne.mockImplementation((query: Record<string, unknown>) => {
      const matches =
        stored &&
        Object.entries(query).every(([key, value]) => stored[key] === value);
      const result = matches ? stored : null;
      const promise: any = Promise.resolve(result);
      promise.sort = vi.fn().mockResolvedValue(result);
      return promise;
    });
    mocks.findOneAndUpdate.mockImplementation(
      async (
        query: Record<string, unknown>,
        update: Record<string, any>,
        options: Record<string, unknown>,
      ) => {
        if (
          stored &&
          !Object.entries(query).every(([key, value]) => stored[key] === value)
        ) {
          return null;
        }
        stored = {
          ...(stored || update.$setOnInsert || {}),
          _id: stored?._id || "507f1f77bcf86cd799439088",
          ...(update.$set || {}),
        };
        return options?.returnDocument === "after" ? stored : null;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides a requested location outside the actor's current scope", async () => {
    mocks.canAccessLocation.mockReturnValueOnce(false);

    await expect(
      getLatestBriefing(context() as any, { locationId: LOCATION_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.locationExists).not.toHaveBeenCalled();
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  it("validates that an allowed briefing location is active in the tenant", async () => {
    mocks.locationExists.mockResolvedValueOnce(false);

    await expect(
      getLatestBriefing(context() as any, { locationId: LOCATION_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.locationExists).toHaveBeenCalledWith({
      _id: LOCATION_ID,
      tenant: TENANT_ID,
      isActive: true,
    });
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  it("persists verified facts first and gives the provider only a bounded aggregate", async () => {
    const result = await generateBriefing(context() as any, {
      locale: "en",
      locationId: LOCATION_ID,
    });

    expect(mocks.buildOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: USER_ID,
        locationId: LOCATION_ID,
        modules: expect.objectContaining({
          bookings: true,
          inventory: true,
          firing: true,
        }),
      }),
    );
    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(2);
    const deterministicWrite = mocks.findOneAndUpdate.mock.calls[0][1].$set;
    expect(deterministicWrite.provenance.provider).toBe("deterministic");
    expect(deterministicWrite.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "urgent-conversations" }),
        expect.objectContaining({ id: "overdue-tasks" }),
        expect.objectContaining({ id: "low-stock-items" }),
      ]),
    );
    const providerInput = mocks.executeStructured.mock.calls[0][0].input;
    expect(providerInput).toContain("workspace_daily_briefing_facts");
    expect(providerInput).not.toContain("privateCustomerMessage");
    expect(providerInput).not.toContain("must never reach the provider");
    expect(result.provenance.provider).toBe("openai");
    expect(result.attention[0].id).toBe("low-stock-items");
    expect(
      result.attention.some(({ id }: any) => id === "invented-priority"),
    ).toBe(false);
  });

  it("returns the same verified snapshot without a second provider call", async () => {
    await generateBriefing(context() as any, { locale: "en" });
    await generateBriefing(context() as any, { locale: "en" });

    expect(mocks.executeStructured).toHaveBeenCalledTimes(1);
  });

  it("refreshes an unchanged snapshot after its freshness window elapses", async () => {
    await generateBriefing(context() as any, { locale: "en" });
    const firstRefreshAfter = stored.refreshAfter;

    vi.setSystemTime(new Date("2026-08-03T12:01:00.000Z"));
    const result = await generateBriefing(context() as any, { locale: "en" });

    expect(mocks.executeStructured).toHaveBeenCalledTimes(2);
    expect(stored.refreshAfter.getTime()).toBeGreaterThan(
      firstRefreshAfter.getTime(),
    );
    expect(result.freshness.state).toBe("fresh");
  });

  it("uses a stable provider idempotency key for explicit refreshes of unchanged facts", async () => {
    await generateBriefing(context() as any, { force: true, locale: "en" });
    await generateBriefing(context() as any, { force: true, locale: "en" });

    expect(mocks.executeStructured).toHaveBeenCalledTimes(2);
    expect(mocks.executeStructured.mock.calls[0][0].idempotencyKey).toBe(
      mocks.executeStructured.mock.calls[1][0].idempotencyKey,
    );
  });

  it("returns the persisted deterministic briefing when provider quota is exhausted", async () => {
    mocks.executeStructured.mockRejectedValueOnce(
      Object.assign(new Error("quota"), {
        code: "AI_CREDIT_LIMIT_EXCEEDED",
        statusCode: 429,
      }),
    );

    const result = await generateBriefing(context() as any, { locale: "en" });

    expect(result.provenance.provider).toBe("deterministic");
    expect(result.headline).toContain("attention");
    expect(stored.metrics.bookingsToday).toBe(8);
  });

  it("does not return an older or differently authorized cached briefing", async () => {
    await generateBriefing(context() as any, { locale: "en" });
    const original = stored;
    const latest = await getLatestBriefing(context() as any, { locale: "en" });
    const downgraded = context();
    downgraded.access = {
      ...downgraded.access,
      accessVersion: 3,
      permissions: ["ai.use"],
    };
    const afterDowngrade = await getLatestBriefing(downgraded as any, {
      locale: "en",
    });

    expect(latest?.id).toBe(String(original._id));
    expect(afterDowngrade).toBeNull();
    expect(mocks.findOne.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ accessFingerprint: expect.any(String) }),
    );
  });

  it("keeps locale authoritative for cached reads", async () => {
    await generateBriefing(context() as any, { locale: "en" });

    await expect(
      getLatestBriefing(context() as any, { locale: "cs" }),
    ).resolves.toBeNull();
  });

  it("normalizes an invalid tenant timezone before lookup and hashing", async () => {
    const invalidTimezoneEntitlement = entitlement();
    invalidTimezoneEntitlement.tenant.settings.timezone = "Not/A-Timezone";
    mocks.requireEntitlement.mockResolvedValue(invalidTimezoneEntitlement);

    const generated = await generateBriefing(context() as any, {
      locale: "en",
    });
    const latest = await getLatestBriefing(context() as any, { locale: "en" });

    expect(mocks.buildOperations).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "UTC" }),
    );
    expect(generated.timezone).toBe("UTC");
    expect(latest?.id).toBe(generated.id);
  });

  it("rejects a mismatched internal actor context before reading cache", async () => {
    const mismatched = context();
    mismatched.access = {
      ...mismatched.access,
      tenantId: "507f1f77bcf86cd799439099",
    };

    await expect(
      getLatestBriefing(mismatched as any, { locale: "en" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.requireEntitlement).not.toHaveBeenCalled();
    expect(mocks.findOne).not.toHaveBeenCalled();
  });
});
