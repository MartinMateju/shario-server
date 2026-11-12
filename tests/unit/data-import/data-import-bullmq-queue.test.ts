import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queue: { getJob: vi.fn(), add: vi.fn(), on: vi.fn() },
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue() {
    return mocks.queue;
  }),
}));
vi.mock("@/config/e2e-mode.js", () => ({ isE2ETestMode: () => false }));
vi.mock("@/config/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/infrastructure/redis/redis.js", () => ({
  bullMqPrefix: "shario",
  bullMqProducerConnection: {},
}));
vi.mock("@/infrastructure/queues/e2e-disabled.queue.js", () => ({
  createE2EDisabledQueue: vi.fn(),
}));

import { enqueueDataImportRollback } from "../../../src/infrastructure/queues/data-import.queue.js";

const job = (states: string[]) => ({
  getState: vi.fn(async () => states.shift() || "waiting"),
  retry: vi.fn(async () => undefined),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queue.getJob.mockResolvedValue(null);
});

describe("rollback BullMQ enqueue idempotency", () => {
  const data = {
    tenantId: "tenant-a",
    sessionId: "session-a",
    entityType: "customers" as const,
    rollbackRevision: 9,
  };

  it("uses a deterministic job id and submits the rollback operation once", async () => {
    const submitted = job(["waiting"]);
    mocks.queue.add.mockResolvedValue(submitted);

    const result = await enqueueDataImportRollback(data);

    expect(mocks.queue.getJob).toHaveBeenCalledWith(
      "data-import-rollback-session-a-r9",
    );
    expect(mocks.queue.add).toHaveBeenCalledWith(
      "rollback",
      { ...data, operation: "rollback" },
      { jobId: "data-import-rollback-session-a-r9" },
    );
    expect(result).toMatchObject({ action: "submitted", queueAccepted: true });
  });

  it("reuses a retained runnable job without submitting a duplicate", async () => {
    const existing = job(["delayed"]);
    mocks.queue.getJob.mockResolvedValue(existing);

    const result = await enqueueDataImportRollback(data);

    expect(mocks.queue.add).not.toHaveBeenCalled();
    expect(existing.retry).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: "existing",
      state: "delayed",
      queueAccepted: true,
    });
  });

  it.each(["failed", "completed"] as const)(
    "reactivates a retained %s job",
    async (state) => {
      const existing = job([state, "waiting"]);
      mocks.queue.getJob.mockResolvedValue(existing);

      const result = await enqueueDataImportRollback(data);

      expect(existing.retry).toHaveBeenCalledWith(state, {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      expect(result).toMatchObject({
        action:
          state === "failed" ? "reactivated_failed" : "reactivated_completed",
        queueAccepted: true,
      });
    },
  );

  it("accepts the winner when two requests race to reactivate the same job", async () => {
    const existing = job(["failed", "waiting"]);
    existing.retry.mockRejectedValue(new Error("already retried"));
    mocks.queue.getJob.mockResolvedValue(existing);

    await expect(enqueueDataImportRollback(data)).resolves.toMatchObject({
      action: "existing",
      state: "waiting",
      queueAccepted: true,
    });
  });

  it("does not claim a retained non-runnable job was accepted", async () => {
    const existing = job(["unknown"]);
    mocks.queue.getJob.mockResolvedValue(existing);

    await expect(enqueueDataImportRollback(data)).resolves.toMatchObject({
      action: "existing",
      queueAccepted: false,
    });
  });
});
