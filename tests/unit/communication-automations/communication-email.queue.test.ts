import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
  on: vi.fn(),
}));

vi.mock("@/infrastructure/redis/redis.js", () => ({
  bullMqPrefix: "shario",
  bullMqProducerConnection: {},
}));
vi.mock("@/infrastructure/queues/e2e-disabled.queue.js", () => ({
  createE2EDisabledQueue: vi.fn(),
}));
vi.mock("@/config/e2e-mode.js", () => ({
  isE2ETestMode: () => false,
}));
vi.mock("@/config/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue() {
    return { add: mocks.add, getJob: mocks.getJob, on: mocks.on };
  }),
}));

import { enqueueCommunicationEmail } from "@/infrastructure/queues/communication-email.queue.js";

const data = {
  tenantId: "507f1f77bcf86cd799439011",
  emailLogId: "507f191e810c19729de860ea",
  automationId: "507f191e810c19729de860eb",
};

const job = (...states: string[]) => ({
  id: "email-dedupe-1",
  getState: vi
    .fn()
    .mockImplementation(() => Promise.resolve(states.shift() || "unknown")),
  retry: vi.fn().mockResolvedValue(undefined),
});

describe("communication email queue reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getJob.mockResolvedValue(null);
  });

  it("submits a new stable job and verifies that BullMQ accepted it", async () => {
    const created = job("waiting");
    mocks.add.mockResolvedValue(created);

    await expect(
      enqueueCommunicationEmail(data, "dedupe-1"),
    ).resolves.toMatchObject({
      jobId: "email-dedupe-1",
      state: "waiting",
      action: "submitted",
      queueAccepted: true,
      newlyQueued: true,
    });
    expect(mocks.add).toHaveBeenCalledWith(
      "send",
      data,
      expect.objectContaining({ jobId: "email-dedupe-1" }),
    );
  });

  it("reactivates an exhausted failed job and resets both attempt counters", async () => {
    const existing = job("failed", "waiting");
    mocks.getJob.mockResolvedValue(existing);

    await expect(
      enqueueCommunicationEmail(data, "dedupe-1"),
    ).resolves.toMatchObject({
      state: "waiting",
      action: "reactivated_failed",
      queueAccepted: true,
      newlyQueued: true,
    });
    expect(existing.retry).toHaveBeenCalledWith("failed", {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("reuses the runnable job when another scheduler wins the retry race", async () => {
    const existing = job("failed", "waiting");
    existing.retry.mockRejectedValueOnce(
      new Error("Job is not in failed state"),
    );
    mocks.getJob.mockResolvedValue(existing);

    await expect(
      enqueueCommunicationEmail(data, "dedupe-1"),
    ).resolves.toMatchObject({
      state: "waiting",
      action: "existing",
      queueAccepted: true,
      newlyQueued: false,
    });
  });

  it.each(["waiting", "active", "delayed"])(
    "reuses an existing %s job without reporting it as newly queued",
    async (state) => {
      const existing = job(state);
      mocks.getJob.mockResolvedValue(existing);

      await expect(
        enqueueCommunicationEmail(data, "dedupe-1"),
      ).resolves.toMatchObject({
        state,
        action: "existing",
        queueAccepted: true,
        newlyQueued: false,
      });
      expect(existing.retry).not.toHaveBeenCalled();
      expect(mocks.add).not.toHaveBeenCalled();
    },
  );

  it("fails closed for a completed job unless safe stale recovery explicitly reactivates it", async () => {
    const existing = job("completed");
    mocks.getJob.mockResolvedValue(existing);

    await expect(
      enqueueCommunicationEmail(data, "dedupe-1"),
    ).resolves.toMatchObject({
      state: "completed",
      action: "existing",
      queueAccepted: false,
      newlyQueued: false,
    });
    expect(existing.retry).not.toHaveBeenCalled();
  });

  it("reactivates completed jobs only for a durable pre-provider stale recovery", async () => {
    const existing = job("completed", "waiting");
    mocks.getJob.mockResolvedValue(existing);

    await expect(
      enqueueCommunicationEmail(data, "dedupe-1", {
        allowCompletedRetry: true,
      }),
    ).resolves.toMatchObject({
      state: "waiting",
      action: "reactivated_completed",
      queueAccepted: true,
      newlyQueued: true,
    });
    expect(existing.retry).toHaveBeenCalledWith("completed", {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
  });

  it("reports an unknown BullMQ state as unaccepted for manual reconciliation", async () => {
    mocks.getJob.mockResolvedValue(job("unknown"));

    await expect(
      enqueueCommunicationEmail(data, "dedupe-1"),
    ).resolves.toMatchObject({
      state: "unknown",
      queueAccepted: false,
      newlyQueued: false,
    });
  });
});
