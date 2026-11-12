import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueImport: vi.fn(),
  enqueueRollback: vi.fn(),
  queueRollbackState: vi.fn(),
  getSession: vi.fn(),
  serializeSession: vi.fn((value: unknown) => value),
  audit: vi.fn(),
  sessionModel: { findOneAndUpdate: vi.fn(), updateOne: vi.fn() },
  mutationModel: { updateMany: vi.fn() },
  rowModel: { updateMany: vi.fn() },
  startSession: vi.fn(),
}));

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  chain.lean = vi.fn(async () => value);
  chain.then = (
    resolve: (result: T) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
};

vi.mock("mongoose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongoose")>();
  return {
    ...actual,
    default: { ...actual.default, startSession: mocks.startSession },
  };
});
vi.mock("@/infrastructure/queues/data-import.queue.js", () => ({
  enqueueDataImport: mocks.enqueueImport,
  enqueueDataImportRollback: mocks.enqueueRollback,
}));
vi.mock(
  "../../../src/modules/data-import/data-import-session.model.js",
  () => ({
    default: mocks.sessionModel,
  }),
);
vi.mock(
  "../../../src/modules/data-import/data-import-mutation.model.js",
  () => ({
    default: mocks.mutationModel,
  }),
);
vi.mock("../../../src/modules/data-import/data-import-row.model.js", () => ({
  default: mocks.rowModel,
}));
vi.mock(
  "../../../src/modules/data-import/services/data-import.service.js",
  () => ({
    getTenantImportSession: mocks.getSession,
    serializeImportSession: mocks.serializeSession,
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-audit.service.js",
  () => ({ recordDataImportAudit: mocks.audit }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-rollback.service.js",
  () => ({ queueImportRollbackState: mocks.queueRollbackState }),
);

import {
  DATA_IMPORT_LIMITS,
  DATA_IMPORT_ROLLBACK_STATUS,
} from "../../../src/modules/data-import/data-import.constants.js";
import {
  queueDataImportSession,
  queueImportRollbackSession,
} from "../../../src/modules/data-import/services/data-import-queue.service.js";

const transaction = {
  withTransaction: vi.fn(async (callback: () => Promise<void>) => callback()),
  endSession: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  transaction.withTransaction.mockImplementation(
    async (callback: () => Promise<void>) => callback(),
  );
  mocks.startSession.mockResolvedValue(transaction);
  mocks.sessionModel.updateOne.mockResolvedValue({ matchedCount: 1 });
  mocks.mutationModel.updateMany.mockResolvedValue({ matchedCount: 1 });
  mocks.rowModel.updateMany.mockResolvedValue({ matchedCount: 1 });
});

describe("data import queue durability", () => {
  it("reverts an ordinary import to validated if the queue does not accept it", async () => {
    const current = {
      _id: "session-a",
      entityType: "customers",
      status: "validated",
      validationRevision: "revision-a",
    };
    mocks.getSession.mockResolvedValue(current);
    mocks.sessionModel.findOneAndUpdate.mockReturnValue(
      query({ ...current, status: "queued" }),
    );
    mocks.enqueueImport.mockResolvedValue({ queueAccepted: false });

    await expect(
      queueDataImportSession({
        tenantId: "tenant-a",
        sessionId: "session-a",
        validationRevision: "revision-a",
        actorId: "actor-a",
      }),
    ).rejects.toThrow("not in a runnable state");

    expect(mocks.sessionModel.updateOne).toHaveBeenCalledWith(
      { _id: "session-a", tenant: "tenant-a", status: "queued" },
      {
        $set: {
          status: "validated",
          lastError: {
            code: "IMPORT_QUEUE_UNAVAILABLE",
            message: "The import could not be queued. Please try again.",
          },
        },
      },
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("returns a queued rollback after the durable state is accepted", async () => {
    const queued = {
      _id: "session-a",
      entityType: "credits",
      rollback: { revision: 8, status: "queued" },
    };
    mocks.queueRollbackState.mockResolvedValue(queued);
    mocks.enqueueRollback.mockResolvedValue({ queueAccepted: true });

    await expect(
      queueImportRollbackSession({
        tenantId: "tenant-a",
        sessionId: "session-a",
        revision: 7,
        previewToken: "a".repeat(64),
        idempotencyKey: "request-a",
        actorId: "actor-a",
      }),
    ).resolves.toBe(queued);

    expect(mocks.enqueueRollback).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      sessionId: "session-a",
      entityType: "credits",
      rollbackRevision: 8,
    });
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("atomically marks enqueue failure and restores retention for session, rows and journals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    const queued = {
      _id: "session-a",
      entityType: "membership-plans",
      rollback: { revision: 3, status: DATA_IMPORT_ROLLBACK_STATUS.QUEUED },
    };
    mocks.queueRollbackState.mockResolvedValue(queued);
    mocks.enqueueRollback.mockRejectedValue(new Error("redis unavailable"));

    await expect(
      queueImportRollbackSession({
        tenantId: "tenant-a",
        sessionId: "session-a",
        revision: 2,
        previewToken: "b".repeat(64),
        idempotencyKey: "request-b",
        actorId: "actor-a",
      }),
    ).rejects.toThrow("redis unavailable");

    const retentionUntil = new Date(
      Date.now() + DATA_IMPORT_LIMITS.ROW_RETENTION_DAYS * 86_400_000,
    );
    expect(transaction.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.sessionModel.updateOne).toHaveBeenCalledWith(
      {
        _id: "session-a",
        tenant: "tenant-a",
        "rollback.status": "queued",
        "rollback.revision": 3,
      },
      {
        $set: expect.objectContaining({
          "rollback.status": "failed",
          "rollback.lastError": expect.objectContaining({
            code: "IMPORT_ROLLBACK_QUEUE_UNAVAILABLE",
          }),
          rollbackAvailableUntil: retentionUntil,
          reportAvailableUntil: retentionUntil,
        }),
      },
      { session: transaction },
    );
    expect(mocks.mutationModel.updateMany).toHaveBeenCalledWith(
      { tenant: "tenant-a", session: "session-a" },
      { $set: { expiresAt: retentionUntil } },
      { session: transaction },
    );
    expect(mocks.rowModel.updateMany).toHaveBeenCalledWith(
      { tenant: "tenant-a", session: "session-a" },
      { $set: { expiresAt: retentionUntil } },
      { session: transaction },
    );
    expect(transaction.endSession).toHaveBeenCalledTimes(1);
  });

  it("treats a non-runnable retained rollback job as enqueue failure", async () => {
    mocks.queueRollbackState.mockResolvedValue({
      _id: "session-a",
      entityType: "vouchers",
      rollback: { revision: 2, status: "queued" },
    });
    mocks.enqueueRollback.mockResolvedValue({ queueAccepted: false });

    await expect(
      queueImportRollbackSession({
        tenantId: "tenant-a",
        sessionId: "session-a",
        revision: 1,
        previewToken: "c".repeat(64),
        idempotencyKey: "request-c",
        actorId: "actor-a",
      }),
    ).rejects.toThrow("not in a runnable state");
    expect(transaction.withTransaction).toHaveBeenCalledTimes(1);
  });
});
