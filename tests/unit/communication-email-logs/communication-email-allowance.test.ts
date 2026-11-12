import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantSubscriptionAccess: vi.fn(),
  ledgerFind: vi.fn(),
  ledgerFindOne: vi.fn(),
  ledgerFindOneAndUpdate: vi.fn(),
  ledgerFindById: vi.fn(),
  ledgerCreate: vi.fn(),
  periodFindOneAndUpdate: vi.fn(),
  periodUpdateOne: vi.fn(),
  logFind: vi.fn(),
}));

vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);

vi.mock(
  "@/modules/communication-email-logs/communication-email-allowance.model.js",
  () => ({
    COMMUNICATION_EMAIL_ALLOWANCE_STATUS: {
      RESERVED: "reserved",
      CONSUMED: "consumed",
      RELEASED: "released",
    },
    CommunicationEmailAllowanceLedgerModel: {
      find: mocks.ledgerFind,
      findOne: mocks.ledgerFindOne,
      findOneAndUpdate: mocks.ledgerFindOneAndUpdate,
      findById: mocks.ledgerFindById,
      create: mocks.ledgerCreate,
    },
    CommunicationEmailAllowancePeriodModel: {
      findOneAndUpdate: mocks.periodFindOneAndUpdate,
      updateOne: mocks.periodUpdateOne,
    },
  }),
);

vi.mock(
  "@/modules/communication-email-logs/communication-email-log.model.js",
  () => ({
    default: { find: mocks.logFind },
    CommunicationEmailLogModel: { find: mocks.logFind },
  }),
);

import { COMMUNICATION_EMAIL_ALLOWANCE_CLASS } from "@/modules/communication-email-logs/communication-email-log.constants.js";
import { communicationEmailLogSchema } from "@/modules/communication-email-logs/communication-email-log.schema.js";
import {
  consumeCommunicationEmailAllowance,
  releaseCommunicationEmailAllowance,
  reconcileCommunicationEmailAllowanceReservations,
  reserveCommunicationEmailAllowance,
  resolveCommunicationEmailAllowancePeriod,
} from "@/modules/communication-email-logs/communication-email-allowance.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const LOG_ID = "507f1f77bcf86cd799439012";
const RESERVATION_ID = "507f1f77bcf86cd799439013";
const PERIOD_KEY = "2026-07-01T00:00:00.000Z_2026-08-01T00:00:00.000Z";

const subscriptionResult = (overrides: Record<string, any> = {}) => ({
  tenant: {
    _id: TENANT_ID,
    planVersion: 3,
    limits: { monthlyEmails: 2 },
    ...(overrides.tenant ?? {}),
  },
  subscription: {
    billingInterval: "monthly",
    currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
    ...(overrides.subscription ?? {}),
  },
});

const period = (overrides: Record<string, unknown> = {}) => ({
  tenant: TENANT_ID,
  periodKey: PERIOD_KEY,
  limit: 2,
  reserved: 0,
  consumed: 0,
  ...overrides,
});

const reservation = (overrides: Record<string, unknown> = {}) => ({
  _id: RESERVATION_ID,
  tenant: TENANT_ID,
  periodKey: PERIOD_KEY,
  idempotencyKey: "communication-email:delivery-1",
  emailLog: LOG_ID,
  status: "reserved",
  ...overrides,
});

const reservationListQuery = (value: unknown) => ({
  sort: vi.fn(() => ({
    limit: vi.fn(() => ({
      select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
    })),
  })),
});

const logListQuery = (value: unknown) => ({
  select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
  vi.resetAllMocks();
  mocks.getTenantSubscriptionAccess.mockResolvedValue(subscriptionResult());
  mocks.ledgerFindOne.mockResolvedValue(null);
  mocks.ledgerFind.mockReturnValue(reservationListQuery([]));
  mocks.logFind.mockReturnValue(logListQuery([]));
  mocks.periodFindOneAndUpdate
    .mockResolvedValueOnce(period())
    .mockResolvedValueOnce(period({ reserved: 1 }));
  mocks.periodUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.ledgerCreate.mockResolvedValue(reservation());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("communication email allowance periods", () => {
  it("classifies automation logs as metered by default", () => {
    expect(
      (communicationEmailLogSchema.path("allowanceClass") as any).defaultValue,
    ).toBe(COMMUNICATION_EMAIL_ALLOWANCE_CLASS.METERED);
  });

  it("uses the active monthly subscription period and tenant email limit", async () => {
    await expect(
      resolveCommunicationEmailAllowancePeriod(TENANT_ID),
    ).resolves.toEqual({
      key: PERIOD_KEY,
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-08-01T00:00:00.000Z"),
      limit: 2,
      planVersion: 3,
    });
  });

  it("uses a UTC calendar month for annual subscriptions", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({
        subscription: {
          billingInterval: "yearly",
          currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
        },
      }),
    );

    await expect(
      resolveCommunicationEmailAllowancePeriod(TENANT_ID),
    ).resolves.toMatchObject({
      key: PERIOD_KEY,
      limit: 2,
      planVersion: 3,
    });
  });
});

describe("communication email allowance reservation", () => {
  it("keeps manual multi-year grants on a monthly email allowance", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({
        subscription: {
          status: "active",
          currentPeriodStart: null,
          currentPeriodEnd: null,
          trialStartedAt: new Date("2026-06-13T12:16:48.473Z"),
          trialEndsAt: new Date("2028-06-27T12:16:48.473Z"),
        },
      }),
    );
    expect(
      await resolveCommunicationEmailAllowancePeriod(TENANT_ID),
    ).toMatchObject({ key: PERIOD_KEY, limit: 2 });
  });

  it("never loads or meters essential system email", async () => {
    await expect(
      reserveCommunicationEmailAllowance({
        tenantId: TENANT_ID,
        idempotencyKey: "system:password-reset:1",
        allowanceClass: COMMUNICATION_EMAIL_ALLOWANCE_CLASS.ESSENTIAL_SYSTEM,
      }),
    ).resolves.toEqual({ kind: "exempt", reason: "essential_system" });

    expect(mocks.getTenantSubscriptionAccess).not.toHaveBeenCalled();
    expect(mocks.periodFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "preserves plan V%d behavior without metering",
    async (planVersion) => {
      await expect(
        reserveCommunicationEmailAllowance({
          tenantId: TENANT_ID,
          emailLogId: LOG_ID,
          idempotencyKey: "legacy:delivery-1",
          planVersion,
        }),
      ).resolves.toEqual({ kind: "exempt", reason: "legacy_plan" });

      expect(mocks.periodFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mocks.ledgerFindOne).not.toHaveBeenCalled();
      expect(mocks.getTenantSubscriptionAccess).not.toHaveBeenCalled();
    },
  );

  it("returns an existing reservation without consuming another unit", async () => {
    mocks.ledgerFindOne.mockResolvedValueOnce(
      reservation({ status: "consumed" }),
    );

    await expect(
      reserveCommunicationEmailAllowance({
        tenantId: TENANT_ID,
        emailLogId: LOG_ID,
        idempotencyKey: "communication-email:delivery-1",
      }),
    ).resolves.toEqual({
      kind: "reserved",
      reservationId: RESERVATION_ID,
      status: "consumed",
    });

    expect(mocks.periodFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("atomically reserves one unit before creating the idempotency ledger", async () => {
    await expect(
      reserveCommunicationEmailAllowance({
        tenantId: TENANT_ID,
        emailLogId: LOG_ID,
        idempotencyKey: "communication-email:delivery-1",
      }),
    ).resolves.toEqual({
      kind: "reserved",
      reservationId: RESERVATION_ID,
      status: "reserved",
    });

    expect(mocks.periodFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        tenant: TENANT_ID,
        periodKey: PERIOD_KEY,
        $expr: {
          $lt: [{ $add: ["$reserved", "$consumed"] }, "$limit"],
        },
      },
      { $inc: { reserved: 1 } },
      { returnDocument: "after" },
    );
    expect(mocks.ledgerCreate).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      periodKey: PERIOD_KEY,
      idempotencyKey: "communication-email:delivery-1",
      emailLog: LOG_ID,
      status: "reserved",
    });
  });

  it("reports exhaustion without creating a ledger", async () => {
    mocks.periodFindOneAndUpdate
      .mockReset()
      .mockResolvedValueOnce(period({ consumed: 2 }))
      .mockResolvedValueOnce(null);
    mocks.ledgerFindOne.mockResolvedValue(null);

    await expect(
      reserveCommunicationEmailAllowance({
        tenantId: TENANT_ID,
        emailLogId: LOG_ID,
        idempotencyKey: "communication-email:delivery-3",
      }),
    ).resolves.toEqual({
      kind: "exhausted",
      periodEnd: new Date("2026-08-01T00:00:00.000Z"),
      limit: 2,
    });
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("returns a canonical concurrent reservation instead of false exhaustion", async () => {
    const canonical = reservation({ _id: "canonical", status: "reserved" });
    mocks.periodFindOneAndUpdate
      .mockReset()
      .mockResolvedValueOnce(period({ consumed: 1 }))
      .mockResolvedValueOnce(null);
    mocks.ledgerFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(canonical);

    await expect(
      reserveCommunicationEmailAllowance({
        tenantId: TENANT_ID,
        emailLogId: LOG_ID,
        idempotencyKey: "communication-email:delivery-1",
      }),
    ).resolves.toEqual({
      kind: "reserved",
      reservationId: "canonical",
      status: "reserved",
    });
  });

  it("rolls back a losing duplicate ledger insertion", async () => {
    const canonical = reservation({ _id: "canonical" });
    mocks.ledgerCreate.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), { code: 11000 }),
    );
    mocks.ledgerFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(canonical);

    await expect(
      reserveCommunicationEmailAllowance({
        tenantId: TENANT_ID,
        emailLogId: LOG_ID,
        idempotencyKey: "communication-email:delivery-1",
      }),
    ).resolves.toMatchObject({ reservationId: "canonical" });
    expect(mocks.periodUpdateOne).toHaveBeenCalledWith(
      { tenant: TENANT_ID, periodKey: PERIOD_KEY },
      { $inc: { reserved: -1 } },
    );
  });

  it("re-reserves instead of returning a concurrently released duplicate ledger", async () => {
    const released = reservation({ status: "released" });
    const reclaimed = reservation({ status: "reserved" });
    mocks.ledgerCreate.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), { code: 11000 }),
    );
    mocks.ledgerFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(released);
    mocks.periodFindOneAndUpdate
      .mockResolvedValueOnce(period())
      .mockResolvedValueOnce(period({ reserved: 1 }))
      .mockResolvedValueOnce(period({ reserved: 1 }));
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(reclaimed);

    await expect(
      reserveCommunicationEmailAllowance({
        tenantId: TENANT_ID,
        emailLogId: LOG_ID,
        idempotencyKey: "communication-email:delivery-1",
      }),
    ).resolves.toEqual({
      kind: "reserved",
      reservationId: RESERVATION_ID,
      status: "reserved",
    });

    expect(mocks.periodUpdateOne).toHaveBeenCalledWith(
      { tenant: TENANT_ID, periodKey: PERIOD_KEY },
      { $inc: { reserved: -1 } },
    );
    expect(mocks.ledgerFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: RESERVATION_ID, status: "released" },
      {
        $set: {
          periodKey: PERIOD_KEY,
          emailLog: LOG_ID,
          status: "reserved",
        },
        $unset: { consumedAt: 1, releasedAt: 1 },
      },
      { returnDocument: "after" },
    );
  });
});

describe("communication email allowance settlement", () => {
  it("consumes a reservation once", async () => {
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(
      reservation({ status: "consumed" }),
    );

    await consumeCommunicationEmailAllowance(RESERVATION_ID);

    expect(mocks.periodUpdateOne).toHaveBeenCalledWith(
      { tenant: TENANT_ID, periodKey: PERIOD_KEY },
      { $inc: { reserved: -1, consumed: 1 } },
    );
  });

  it("releases a known-not-sent reservation once", async () => {
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(
      reservation({ status: "released" }),
    );

    await releaseCommunicationEmailAllowance(RESERVATION_ID);

    expect(mocks.periodUpdateOne).toHaveBeenCalledWith(
      { tenant: TENANT_ID, periodKey: PERIOD_KEY },
      { $inc: { reserved: -1 } },
    );
  });

  it("does not change counters after an idempotent settlement retry", async () => {
    const settled = reservation({ status: "consumed" });
    mocks.ledgerFindOneAndUpdate.mockResolvedValueOnce(null);
    mocks.ledgerFindById.mockResolvedValueOnce(settled);

    await expect(
      consumeCommunicationEmailAllowance(RESERVATION_ID),
    ).resolves.toBe(settled);
    expect(mocks.periodUpdateOne).not.toHaveBeenCalled();
  });

  it("reconciles only durable terminal email-log states", async () => {
    const sentReservation = reservation({
      _id: "sent-reservation",
      emailLog: "sent-log",
    });
    const failedReservation = reservation({
      _id: "failed-reservation",
      emailLog: "failed-log",
    });
    const queuedReservation = reservation({
      _id: "queued-reservation",
      emailLog: "queued-log",
    });
    mocks.ledgerFind.mockReturnValueOnce(
      reservationListQuery([
        sentReservation,
        failedReservation,
        queuedReservation,
      ]),
    );
    mocks.logFind.mockReturnValueOnce(
      logListQuery([
        { _id: "sent-log", status: "sent" },
        { _id: "failed-log", status: "failed" },
        { _id: "queued-log", status: "queued" },
      ]),
    );
    mocks.ledgerFindOneAndUpdate
      .mockResolvedValueOnce({ ...sentReservation, status: "consumed" })
      .mockResolvedValueOnce({ ...failedReservation, status: "released" });

    await expect(
      reconcileCommunicationEmailAllowanceReservations(),
    ).resolves.toEqual({ consumed: 1, released: 1 });

    expect(mocks.ledgerFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.periodUpdateOne).toHaveBeenCalledTimes(2);
  });
});

describe("communication email worker allowance contract", () => {
  it("reserves before provider start, releases known rejection, and consumes accepted or ambiguous delivery", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../src/workers/communication-email.worker.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const reserveAt = source.indexOf("reserveCommunicationEmailAllowance({");
    const providerAt = source.indexOf(
      "communicationEmailLogRepository.beginProviderAttempt({",
    );
    const knownNotSentAt = source.indexOf("if (providerOutcomeKnownNotSent)");
    const releaseAt = source.indexOf(
      "releaseCommunicationEmailAllowance(allowanceReservationId)",
    );
    const ambiguousAt = source.indexOf(
      "communicationEmailLogRepository.markAmbiguous(",
      knownNotSentAt,
    );
    const consumeAt = source.indexOf(
      "consumeCommunicationEmailAllowance(allowanceReservationId)",
      knownNotSentAt,
    );

    expect(reserveAt).toBeGreaterThan(-1);
    expect(reserveAt).toBeLessThan(providerAt);
    expect(releaseAt).toBeGreaterThan(knownNotSentAt);
    expect(releaseAt).toBeLessThan(ambiguousAt);
    expect(consumeAt).toBeGreaterThan(releaseAt);
    expect(source).toContain("monthly_email_allowance_exhausted");
    expect(source).toContain(
      "reconcileCommunicationEmailAllowanceIfConnected({ limit })",
    );
    expect(source).toContain("mongoose.connection.readyState !== 1");
    expect(source.match(/emailLogIds: \[emailLogId\]/g)).toHaveLength(2);
  });
});
