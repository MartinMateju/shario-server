import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  find: vi.fn(),
  updateMany: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: { find: vi.fn() },
}));
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.model.js",
  () => ({
    CommunicationEmailLogModel: {
      findOneAndUpdate: mocks.findOneAndUpdate,
      find: mocks.find,
      updateMany: mocks.updateMany,
      updateOne: mocks.updateOne,
    },
  }),
);

import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const LOG_ID = "507f191e810c19729de860ea";
const NOW = new Date("2026-08-04T12:00:00.000Z");

const execResult = <T>(value: T) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const staleQuery = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["sort", "limit", "select"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.lean = vi.fn().mockResolvedValue(value);
  return chain;
};

const selectedQuery = <T>(value: T) => {
  const chain: Record<string, any> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.lean = vi.fn().mockResolvedValue(value);
  return chain;
};

describe("communication email durable claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOneAndUpdate.mockReturnValue(execResult(null));
    mocks.updateMany.mockReturnValue(execResult({ modifiedCount: 0 }));
    mocks.updateOne.mockReturnValue(execResult({ modifiedCount: 0 }));
  });

  it("claims only non-in-flight statuses with an owner token and lease", async () => {
    const leaseUntil = new Date(NOW.getTime() + 300_000);
    await communicationEmailLogRepository.claimForSending({
      tenantId: TENANT_ID,
      logId: LOG_ID,
      jobId: "email-job-1",
      claimToken: "claim-1",
      now: NOW,
      leaseUntil,
    });

    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter.$or).toEqual([
      {
        status: "scheduled",
        $or: [{ scheduledFor: null }, { scheduledFor: { $lte: NOW } }],
      },
      { status: { $in: ["queued", "pending", "failed"] } },
    ]);
    expect(update).toMatchObject({
      $set: {
        status: "sending",
        processingJobId: "email-job-1",
        processingClaimToken: "claim-1",
        processingLeaseExpiresAt: leaseUntil,
        providerAttemptStartedAt: null,
      },
    });
  });

  it("starts SMTP only while the exact claim owns a live lease", async () => {
    await communicationEmailLogRepository.beginProviderAttempt({
      tenantId: TENANT_ID,
      logId: LOG_ID,
      jobId: "email-job-1",
      claimToken: "claim-1",
      now: NOW,
    });

    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      status: "sending",
      processingJobId: "email-job-1",
      processingClaimToken: "claim-1",
      processingLeaseExpiresAt: { $gt: NOW },
      providerAttemptStartedAt: null,
    });
    expect(update).toEqual({
      $set: {
        providerAttemptStartedAt: NOW,
        processingLeaseExpiresAt: new Date(NOW.getTime() + 300000),
      },
      $inc: { attempts: 1 },
    });
  });

  it("persists a terminal known-not-sent failure and counts preflight attempts", async () => {
    await communicationEmailLogRepository.markFailed(
      TENANT_ID,
      LOG_ID,
      "Sender unavailable",
      "claim-1",
      true,
      { retryable: false, countAttempt: true },
    );
    const [filter, update] = mocks.updateOne.mock.calls[0];
    expect(filter).toMatchObject({
      status: "sending",
      processingClaimToken: "claim-1",
    });
    expect(update).toMatchObject({
      $set: {
        status: "failed",
        retryable: false,
        providerAttemptStartedAt: null,
      },
      $inc: { attempts: 1 },
    });
  });

  it("excludes permanent failures from direct claims and periodic recovery", async () => {
    await communicationEmailLogRepository.claimForSending({
      tenantId: TENANT_ID,
      logId: LOG_ID,
      jobId: "job",
      claimToken: "claim",
    });
    expect(mocks.findOneAndUpdate.mock.calls[0][0].retryable).toEqual({
      $ne: false,
    });
    const candidates = staleQuery([]);
    mocks.find.mockReturnValue(candidates);
    await communicationEmailLogRepository.listQueueReconciliationCandidates();
    expect(mocks.find.mock.calls[0][0].retryable).toEqual({ $ne: false });
    expect(candidates.select).toHaveBeenCalledWith(
      expect.stringMatching(/emailType purpose allowanceClass/),
    );
  });

  it("will not mark a provider-started or differently owned claim failed", async () => {
    await communicationEmailLogRepository.markFailed(
      TENANT_ID,
      LOG_ID,
      "pre-provider failure",
      "claim-1",
    );

    const [filter] = mocks.updateOne.mock.calls[0];
    expect(filter).toMatchObject({
      status: "sending",
      processingClaimToken: "claim-1",
      providerAttemptStartedAt: null,
    });
  });

  it("requeues expired pre-SMTP claims but requires review after SMTP may have started", async () => {
    const expired = new Date(NOW.getTime() - 1);
    const safe = {
      _id: "safe-log",
      tenant: TENANT_ID,
      automation: "automation-1",
      deduplicationKey: "safe-key",
      processingClaimToken: "claim-safe",
      processingLeaseExpiresAt: expired,
      providerAttemptStartedAt: null,
      processingStartedAt: expired,
    };
    const unknown = {
      ...safe,
      _id: "unknown-log",
      processingClaimToken: "claim-unknown",
      providerAttemptStartedAt: expired,
    };
    mocks.find
      .mockReturnValueOnce(staleQuery([safe, unknown]))
      .mockReturnValueOnce(selectedQuery([{ ...safe, status: "queued" }]));
    mocks.updateMany
      .mockReturnValueOnce(execResult({ modifiedCount: 1 }))
      .mockReturnValueOnce(execResult({ modifiedCount: 1 }));

    await expect(
      communicationEmailLogRepository.recoverStaleSending({ now: NOW }),
    ).resolves.toMatchObject({ requeued: [{ _id: "safe-log" }], ambiguous: 1 });

    const [safeFilter, safeUpdate] = mocks.updateMany.mock.calls[0];
    expect(safeFilter._id).toEqual({ $in: ["safe-log"] });
    expect(safeUpdate.$set.status).toBe("queued");
    const [unknownFilter, unknownUpdate] = mocks.updateMany.mock.calls[1];
    expect(unknownFilter._id).toEqual({ $in: ["unknown-log"] });
    expect(unknownUpdate.$set).toMatchObject({
      status: "ambiguous",
      manualReviewRequiredAt: NOW,
    });
  });

  it("does not touch live leases", async () => {
    mocks.find.mockReturnValue(staleQuery([]));

    await expect(
      communicationEmailLogRepository.recoverStaleSending({ now: NOW }),
    ).resolves.toEqual({ requeued: [], ambiguous: 0 });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("atomically claims only a still-due queue reconciliation candidate", async () => {
    const leaseUntil = new Date(NOW.getTime() + 300_000);
    await communicationEmailLogRepository.claimQueueReconciliation({
      tenantId: TENANT_ID,
      logId: LOG_ID,
      claimToken: "queue-claim-1",
      now: NOW,
      leaseUntil,
    });

    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      manualReviewRequiredAt: null,
      $and: expect.arrayContaining([
        {
          $or: [
            { nextQueueRecoveryAt: null },
            { nextQueueRecoveryAt: { $lte: NOW } },
          ],
        },
        {
          $or: [
            { status: { $in: ["queued", "failed"] } },
            {
              status: "scheduled",
              $or: [{ scheduledFor: null }, { scheduledFor: { $lte: NOW } }],
            },
          ],
        },
      ]),
    });
    expect(update).toEqual({
      $set: {
        queueRecoveryClaimToken: "queue-claim-1",
        queueRecoveryLeaseExpiresAt: leaseUntil,
      },
    });
  });

  it("lets a successful external enqueue supersede a stale reconciliation lease", async () => {
    mocks.updateOne.mockReturnValue(execResult({ matchedCount: 1 }));

    await expect(
      communicationEmailLogRepository.markQueued(TENANT_ID, LOG_ID),
    ).resolves.toBe(true);
    const [, update] = mocks.updateOne.mock.calls[0];
    expect(update.$set).toMatchObject({
      status: "queued",
      queueRecoveryClaimToken: "",
      queueRecoveryLeaseExpiresAt: null,
    });
  });
});
