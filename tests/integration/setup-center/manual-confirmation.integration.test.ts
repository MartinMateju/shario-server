import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Prerequisite reads must not contact external providers. The setup state,
// audit log, tenant, location and product reads/writes below use real MongoDB.
vi.mock("@/infrastructure/redis/cache.js", () => ({ deleteCache: vi.fn() }));
vi.mock("@/modules/tenants/settings/tenant-settings.service.js", () => ({
  publishTenantPublicSiteDraft: vi.fn(),
}));
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: vi.fn(),
  }),
);
vi.mock(
  "@/modules/registered-sender-email/services/managed-sender-resolver.service.js",
  () => ({
    ManagedSenderNotReadyError: class ManagedSenderNotReadyError extends Error {},
    resolveManagedSender: vi.fn().mockResolvedValue({ id: "test-sender" }),
  }),
);

import LocationModel from "@/modules/location/location.model.js";
import Product from "@/modules/product/product.model.js";
import {
  SETUP_PRACTICE_ACTION,
  SETUP_PRACTICE_STATUS,
  SETUP_PUBLICATION_STATUS,
} from "@/modules/setup-center/setup-center.constants.js";
import {
  SetupAuditEventModel,
  SetupCenterStateModel,
} from "@/modules/setup-center/setup-center.model.js";
import {
  buildSetupCenterSnapshot,
  clearSetupPracticeConfirmation,
  confirmSetupPractice,
} from "@/modules/setup-center/setup-center.service.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenantId = new mongoose.Types.ObjectId();
const otherTenantId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();
const secondActorId = new mongoose.Types.ObjectId();
const locationId = new mongoose.Types.ObjectId();
const otherLocationId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const otherProductId = new mongoose.Types.ObjectId();
const fixtureDate = new Date("2026-11-03T08:00:00.000Z");
const context = (tenant = tenantId, actor = actorId) => ({
  tenantId: String(tenant),
  actorUserId: String(actor),
});
const loadState = (tenant = tenantId) =>
  SetupCenterStateModel.findOne({ tenant }).lean();
const confirmationEvents = (tenant = tenantId) =>
  SetupAuditEventModel.find({
    tenant,
    event: "practice_manually_confirmed",
  }).lean();

async function seedWorkspace(
  tenant: mongoose.Types.ObjectId,
  location: mongoose.Types.ObjectId,
  product: mongoose.Types.ObjectId,
) {
  // Raw fixture inserts keep unrelated onboarding defaults out of this contract.
  // The new confirmation itself always goes through the real model and service.
  await TenantModel.collection.insertOne({
    _id: tenant,
    slug: `manual-${tenant}`,
    name: "Manual confirmation test studio",
    status: "active",
    settings: { currency: "CZK", timezone: "Europe/Prague" },
    modules: {
      bookings: true,
      payments: false,
      inventory: false,
      communications: false,
    },
    onboarding: {
      completed: true,
      businessType: "coworking_space",
      teamSize: "just_me",
      businessDetails: { country: "CZ", address: "Test street 1" },
    },
    publicSiteEditor: {
      draftRevision: 1,
      publishedRevision: 1,
      publishedAt: fixtureDate,
    },
  } as never);
  await LocationModel.collection.insertOne({
    _id: location,
    tenant,
    name: "Test location",
    slug: `location-${location}`,
    code: String(location),
    isPrimary: true,
    isActive: true,
    booking: { enabled: true },
    updatedAt: fixtureDate,
  } as never);
  await Product.collection.insertOne({
    _id: product,
    tenant,
    name: "Test studio booking",
    type: "workshop",
    kind: "open-studio",
    kindContractVersion: 2,
    bookingMode: "public",
    price: 0,
    currency: "CZK",
    maxNumberOfParticipants: 8,
    isActive: true,
    updatedAt: fixtureDate,
  } as never);
  await SetupCenterStateModel.create({
    tenant,
    publication: {
      status: SETUP_PUBLICATION_STATUS.LIVE,
      publishedAt: fixtureDate,
      publishedBy: actorId,
    },
    practice: {
      runId: `practice-${tenant}`,
      idempotencyKey: `practice-key-${tenant}`,
      actor: actorId,
      status: SETUP_PRACTICE_STATUS.IN_PROGRESS,
      locationId: location,
      productId: product,
      readinessFingerprint: "earlier-simulated-fingerprint",
      completedActions: [SETUP_PRACTICE_ACTION.CREATE_BOOKING],
      artifacts: [
        {
          kind: "booking",
          title: "Existing sample",
          summary: "Existing safe preview",
          createdAt: fixtureDate,
        },
      ],
      startedAt: fixtureDate,
      updatedAt: fixtureDate,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

async function fingerprint(tenant = tenantId) {
  const snapshot = await buildSetupCenterSnapshot(context(tenant));
  expect(snapshot.launchReview.testBooking.canStart).toBe(true);
  expect(snapshot.diagnostics.readinessFingerprint).toMatch(/^[a-f0-9]{64}$/);
  return snapshot.diagnostics.readinessFingerprint;
}

describe("manual booking confirmation persistence", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    await SetupCenterStateModel.init();
  });
  afterAll(disconnectTestDatabase);

  beforeEach(async () => {
    await clearTestDatabase();
    await seedWorkspace(tenantId, locationId, productId);
    await seedWorkspace(otherTenantId, otherLocationId, otherProductId);
  });

  it("persists actor/date/fingerprint separately, without changing either tenant's simulated run", async () => {
    const before = await loadState();
    const otherBefore = await loadState(otherTenantId);
    const expectedReadinessFingerprint = await fingerprint();
    const startedAt = Date.now();

    const result = await confirmSetupPractice({
      ...context(),
      expectedReadinessFingerprint,
    });
    const stored = await loadState();
    expect(stored.practiceConfirmation).toEqual({
      confirmedAt: expect.any(Date),
      confirmedBy: actorId,
      readinessFingerprint: expectedReadinessFingerprint,
    });
    expect(
      stored.practiceConfirmation.confirmedAt.getTime(),
    ).toBeGreaterThanOrEqual(startedAt);
    expect(
      stored.practiceConfirmation.confirmedAt.getTime(),
    ).toBeLessThanOrEqual(Date.now());
    expect(stored.practice).toEqual(before.practice);
    expect(await loadState(otherTenantId)).toEqual(otherBefore);
    expect(result.launchReview.testBooking).toMatchObject({
      complete: true,
      completionSource: "manual",
      retestRecommended: false,
    });
    expect(result.practice.status).toBe(SETUP_PRACTICE_STATUS.IN_PROGRESS);
    expect(result.practice.manualConfirmation).toMatchObject({
      current: true,
      confirmedBy: String(actorId),
    });
    const events = await confirmationEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: actorId,
      tenant: tenantId,
      metadata: { readinessFingerprint: expectedReadinessFingerprint },
    });
    expect(await confirmationEvents(otherTenantId)).toHaveLength(0);
  });

  it("keeps one winner and one audit event for concurrent same-fingerprint confirmations", async () => {
    const expectedReadinessFingerprint = await fingerprint();
    const outcomes = await Promise.all(
      [actorId, secondActorId, actorId, secondActorId].map((actor) =>
        confirmSetupPractice({
          ...context(tenantId, actor),
          expectedReadinessFingerprint,
        }),
      ),
    );
    expect(
      outcomes.every((result) => result.launchReview.testBooking.complete),
    ).toBe(true);
    const first = (await loadState()).practiceConfirmation;
    const events = await confirmationEvents();
    expect(events).toHaveLength(1);
    expect(String(events[0].actor)).toBe(String(first.confirmedBy));
    expect(events[0].metadata.readinessFingerprint).toBe(
      expectedReadinessFingerprint,
    );

    await confirmSetupPractice({
      ...context(tenantId, secondActorId),
      expectedReadinessFingerprint,
    });
    expect((await loadState()).practiceConfirmation).toEqual(first);
    expect(await confirmationEvents()).toHaveLength(1);
  });

  it("invalidates stale evidence and rejects the old fingerprint without erasing it", async () => {
    const originalFingerprint = await fingerprint();
    await confirmSetupPractice({
      ...context(),
      expectedReadinessFingerprint: originalFingerprint,
    });
    const before = await loadState();
    await Product.updateOne(
      { _id: productId, tenant: tenantId },
      { $set: { maxNumberOfParticipants: 9 } },
    );

    const stale = await buildSetupCenterSnapshot(context());
    expect(stale.practice.manualConfirmation.current).toBe(false);
    expect(stale.launchReview.testBooking).toMatchObject({
      complete: false,
      completionSource: null,
      retestRecommended: true,
    });
    await expect(
      confirmSetupPractice({
        ...context(),
        expectedReadinessFingerprint: originalFingerprint,
      }),
    ).rejects.toMatchObject({ code: "SETUP_PRACTICE_CONFIGURATION_CHANGED" });
    expect((await loadState()).practiceConfirmation).toEqual(
      before.practiceConfirmation,
    );
    expect(await confirmationEvents()).toHaveLength(1);

    const newFingerprint = await fingerprint();
    expect(newFingerprint).not.toBe(originalFingerprint);
    await confirmSetupPractice({
      ...context(tenantId, secondActorId),
      expectedReadinessFingerprint: newFingerprint,
    });
    const after = await loadState();
    expect(after.practiceConfirmation).toMatchObject({
      confirmedBy: secondActorId,
      readinessFingerprint: newFingerprint,
    });
    expect(after.practice).toEqual(before.practice);
    expect(await confirmationEvents()).toHaveLength(2);
  });

  it("clears only the requested tenant's confirmation and makes concurrent undo idempotent", async () => {
    await confirmSetupPractice({
      ...context(),
      expectedReadinessFingerprint: await fingerprint(),
    });
    await confirmSetupPractice({
      ...context(otherTenantId),
      expectedReadinessFingerprint: await fingerprint(otherTenantId),
    });
    const before = await loadState();
    const otherBefore = await loadState(otherTenantId);

    await Promise.all([
      clearSetupPracticeConfirmation(context()),
      clearSetupPracticeConfirmation(context()),
    ]);
    const result = await clearSetupPracticeConfirmation(context());
    const after = await loadState();
    expect(after.practiceConfirmation).toBeNull();
    expect(after.practice).toEqual(before.practice);
    expect(await loadState(otherTenantId)).toEqual(otherBefore);
    expect(result.launchReview.testBooking.complete).toBe(false);
    expect(
      await SetupAuditEventModel.countDocuments({
        tenant: tenantId,
        event: "practice_manual_confirmation_cleared",
      }),
    ).toBe(1);
    expect(
      await SetupAuditEventModel.countDocuments({
        tenant: otherTenantId,
        event: "practice_manual_confirmation_cleared",
      }),
    ).toBe(0);
  });

  it("persists only the strict confirmation evidence fields", async () => {
    await SetupCenterStateModel.findOneAndUpdate(
      { tenant: tenantId },
      {
        $set: {
          practiceConfirmation: {
            confirmedAt: fixtureDate,
            confirmedBy: actorId,
            readinessFingerprint: "a".repeat(64),
            completedActions: ["forged"],
            customerEmail: "private@example.test",
          },
        },
      },
      { runValidators: true },
    );
    expect((await loadState()).practiceConfirmation).toEqual({
      confirmedAt: fixtureDate,
      confirmedBy: actorId,
      readinessFingerprint: "a".repeat(64),
    });
  });

  it.each([
    { readinessFingerprint: "a".repeat(63) },
    { readinessFingerprint: "A".repeat(64) },
    { confirmedBy: null },
    { confirmedAt: null },
  ])(
    "rejects invalid evidence %j without persisting a partial confirmation",
    async (invalid) => {
      await expect(
        SetupCenterStateModel.findOneAndUpdate(
          { tenant: tenantId },
          {
            $set: {
              practiceConfirmation: {
                confirmedAt: fixtureDate,
                confirmedBy: actorId,
                readinessFingerprint: "a".repeat(64),
                ...invalid,
              },
            },
          },
          { runValidators: true },
        ),
      ).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
      expect((await loadState()).practiceConfirmation).toBeNull();
    },
  );
});
