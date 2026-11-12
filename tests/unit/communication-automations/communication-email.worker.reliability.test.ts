import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  sendManagedTenantEmail: vi.fn(),
  enqueue: vi.fn(),
  logFindOne: vi.fn(),
  bookingFindOne: vi.fn(),
  userFindOne: vi.fn(),
  tenantFindOne: vi.fn(),
  automationFindOne: vi.fn(),
  automationExists: vi.fn(),
  settingsFindOne: vi.fn(),
  suppressionExists: vi.fn(),
  consentFindOne: vi.fn(),
  claim: vi.fn(),
  beginProvider: vi.fn(),
  markSent: vi.fn(),
  markFailed: vi.fn(),
  markAmbiguous: vi.fn(),
  markCanceled: vi.fn(),
  defer: vi.fn(),
  recoverStale: vi.fn(),
  listCandidates: vi.fn(),
  claimReconciliation: vi.fn(),
  markReconciledQueued: vi.fn(),
  markReconciliationAmbiguous: vi.fn(),
  deferReconciliation: vi.fn(),
  quietHours: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  closeDatabaseConnection: vi.fn(),
  queueClose: vi.fn(),
  workerOn: vi.fn(),
  workerPause: vi.fn(),
  workerClose: vi.fn(),
  workerConstructor: vi.fn(),
  onNotificationEvent: vi.fn(() => vi.fn()),
  emitNotification: vi.fn(),
  processLifecycle: vi.fn(),
  processFiring: vi.fn(),
  refreshFiring: vi.fn(),
}));

vi.mock("@/workers/booking-lifecycle-email.processor.js", () => ({
  processBookingLifecycleEmail: mocks.processLifecycle,
}));
vi.mock("@/workers/firing-ready-email.processor.js", () => ({
  processFiringReadyEmail: mocks.processFiring,
}));
vi.mock("@/modules/firing/services/firing-email-status.service.js", () => ({
  refreshFiringEmailLogStatusSafely: mocks.refreshFiring,
}));

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["select", "populate"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.lean = vi.fn().mockResolvedValue(value);
  return chain;
};

vi.mock("@/config/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
    info: vi.fn(),
    fatal: vi.fn(),
  },
}));
vi.mock("@/infrastructure/database/connect-db.js", () => ({
  default: mocks.connectDB,
  closeDatabaseConnection: mocks.closeDatabaseConnection,
}));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendManagedTenantEmail,
}));
vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  communicationEmailQueueName: "communication-emails",
  communicationEmailQueue: { close: mocks.queueClose },
  enqueueCommunicationEmail: mocks.enqueue,
}));
vi.mock("@/infrastructure/redis/redis.js", () => ({
  bullMqPrefix: "shario",
  bullMqWorkerConnection: {},
  redisConnection: {},
}));
vi.mock("bullmq", () => ({
  Worker: class MockWorker {
    constructor(...args: unknown[]) {
      mocks.workerConstructor(...args);
    }

    on = mocks.workerOn;
    pause = mocks.workerPause;
    close = mocks.workerClose;
  },
  Job: vi.fn(),
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { findOne: mocks.bookingFindOne },
}));
vi.mock(
  "@/modules/communication-automations/communication-automation.model.js",
  () => ({
    default: {
      findOne: mocks.automationFindOne,
      exists: mocks.automationExists,
    },
  }),
);
vi.mock(
  "@/modules/communication-automations/services/communication-email-variables.service.js",
  () => ({ buildCommunicationEmailVariables: () => ({}) }),
);
vi.mock(
  "@/modules/communication-automations/services/communication-automation-schedule.service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/communication-automations/services/communication-automation-schedule.service.js")
    >()),
    isWithinAutomationQuietHours: mocks.quietHours,
    moveAfterAutomationQuietHours: () => new Date("2026-08-04T13:00:00.000Z"),
  }),
);
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.model.js",
  () => ({ default: { findOne: mocks.logFindOne } }),
);
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.repository.js",
  () => ({
    communicationEmailLogRepository: {
      claimForSending: mocks.claim,
      beginProviderAttempt: mocks.beginProvider,
      markSent: mocks.markSent,
      markFailed: mocks.markFailed,
      markAmbiguous: mocks.markAmbiguous,
      markCanceled: mocks.markCanceled,
      defer: mocks.defer,
      recoverStaleSending: mocks.recoverStale,
      listQueueReconciliationCandidates: mocks.listCandidates,
      claimQueueReconciliation: mocks.claimReconciliation,
      markReconciledQueued: mocks.markReconciledQueued,
      markReconciliationAmbiguous: mocks.markReconciliationAmbiguous,
      deferQueueReconciliation: mocks.deferReconciliation,
    },
  }),
);
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationSettingsModel: { findOne: mocks.settingsFindOne },
  CommunicationSuppressionModel: { exists: mocks.suppressionExists },
  CommunicationConsentModel: { findOne: mocks.consentFindOne },
}));
vi.mock("@/modules/communications/services/consent.service.js", () => ({
  isCommunicationAllowed: () => ({ allowed: true, reason: "allowed" }),
}));
vi.mock("@/modules/email-template/email-template.rendering.js", () => ({
  renderEmailContent: () => ({
    subject: "Hello",
    html: "<p>Hello</p>",
    text: "Hello",
  }),
}));
vi.mock("@/modules/order/order.model.js", () => ({ default: {} }));
vi.mock("@/modules/pottery-piece/pottery-piece.model.js", () => ({
  PotteryPiece: { findOne: vi.fn() },
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findOne: mocks.tenantFindOne },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.userFindOne },
}));
vi.mock(
  "@/modules/workspace-notifications/workspace-notification.events.js",
  () => ({
    emitWorkspaceNotificationEvent: mocks.emitNotification,
    onWorkspaceNotificationEvent: mocks.onNotificationEvent,
  }),
);

import {
  processCommunicationEmailJob,
  recoverStaleCommunicationEmailJobs,
  startCommunicationEmailWorker,
} from "@/workers/communication-email.worker.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const LOG_ID = "507f191e810c19729de860ea";
const AUTOMATION_ID = "507f191e810c19729de860eb";
const log = {
  _id: LOG_ID,
  tenant: TENANT_ID,
  automation: AUTOMATION_ID,
  status: "queued",
  recipientEmail: "ada@example.com",
  recipientName: "Ada",
  purpose: "transactional",
  locale: "en",
  subject: "Hello",
  body: "Hello",
  htmlContent: "<p>Hello</p>",
  contentFormat: "html",
  deduplicationKey: "dedupe-1",
  toObject() {
    return { ...this };
  },
};
const automation = {
  _id: AUTOMATION_ID,
  tenant: TENANT_ID,
  isActive: true,
  automationStatus: "active",
  scheduleType: "afterBooking",
  purpose: "transactional",
  respectQuietHours: true,
  senderEmail: {
    _id: "507f191e810c19729de860ec",
    isActive: true,
    provider: "postmark_managed",
    replyToEmail: "studio-owner@example.com",
    replyToVerifiedAt: new Date("2026-08-01T10:00:00.000Z"),
    providerServerId: 42,
    providerProvisionedAt: new Date("2026-08-01T09:00:00.000Z"),
    providerProvisioningStatus: "ready",
  },
};
const job = {
  id: "email-dedupe-1",
  data: {
    tenantId: TENANT_ID,
    emailLogId: LOG_ID,
    automationId: AUTOMATION_ID,
  },
};

describe("communication email worker reliability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectDB.mockResolvedValue(undefined);
    mocks.closeDatabaseConnection.mockResolvedValue(undefined);
    mocks.queueClose.mockResolvedValue(undefined);
    mocks.workerPause.mockResolvedValue(undefined);
    mocks.workerClose.mockResolvedValue(undefined);
    mocks.logFindOne.mockReturnValue(query(log));
    mocks.bookingFindOne.mockReturnValue(query(null));
    mocks.userFindOne.mockReturnValue(query(null));
    mocks.tenantFindOne.mockReturnValue(
      query({
        _id: TENANT_ID,
        status: "active",
        settings: { timezone: "UTC" },
      }),
    );
    mocks.automationFindOne.mockReturnValue(query(automation));
    mocks.automationExists.mockResolvedValue(true);
    mocks.settingsFindOne.mockReturnValue(
      query({
        quietHours: { enabled: false },
        businessHours: { timezone: "UTC" },
      }),
    );
    mocks.suppressionExists.mockResolvedValue(null);
    mocks.consentFindOne.mockReturnValue(query(null));
    mocks.claim.mockResolvedValue(log);
    mocks.beginProvider.mockResolvedValue(log);
    mocks.markSent.mockResolvedValue(true);
    mocks.markFailed.mockResolvedValue(true);
    mocks.markAmbiguous.mockResolvedValue(true);
    mocks.markCanceled.mockResolvedValue(true);
    mocks.defer.mockResolvedValue(true);
    mocks.quietHours.mockReturnValue(false);
    mocks.sendManagedTenantEmail.mockResolvedValue({
      provider: "postmark",
      providerMessageId: "postmark-1",
    });
    mocks.recoverStale.mockResolvedValue({ requeued: [], ambiguous: 0 });
    mocks.listCandidates.mockResolvedValue([]);
    mocks.processLifecycle.mockResolvedValue({ sent: true });
    mocks.processFiring.mockResolvedValue({ sent: true });
  });

  const registrationDelivery = ({
    activatedAt = new Date("2026-08-04T10:00:00Z"),
    createdAt = new Date("2026-08-04T10:01:00Z"),
  } = {}) => {
    const userId = "507f191e810c19729de860ed";
    const registrationLog = {
      ...log,
      user: userId,
      emailType: "afterRegistration",
      relatedEntityType: "user",
      relatedEntityId: userId,
      sourceScheduledAt: createdAt,
      scheduledFor: new Date("2026-08-04T11:01:00Z"),
    };
    mocks.logFindOne.mockReturnValue(query(registrationLog));
    mocks.claim.mockResolvedValue(registrationLog);
    mocks.automationFindOne.mockReturnValue(
      query({
        ...automation,
        scheduleType: "afterRegistration",
        activatedAt,
      }),
    );
    mocks.userFindOne.mockReturnValue(
      query({
        _id: userId,
        tenant: TENANT_ID,
        tenantRole: "customer",
        isAccessGranted: true,
        isEmailVerified: false,
        createdAt,
      }),
    );
    return { ...job, data: { ...job.data, userId } };
  };

  it("cancels a queued registration from before the current activation without contacting the provider", async () => {
    const delivery = registrationDelivery({
      activatedAt: new Date("2026-08-04T10:02:00Z"),
    });

    await expect(processCommunicationEmailJob(delivery as never)).resolves.toMatchObject({
      skipped: true,
      reason: "Customer registered before this automation was activated.",
    });
    expect(mocks.markCanceled).toHaveBeenCalled();
    expect(mocks.beginProvider).not.toHaveBeenCalled();
    expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
  });

  it("still delivers a current registration without requiring email verification", async () => {
    await expect(
      processCommunicationEmailJob(registrationDelivery() as never),
    ).resolves.toMatchObject({ sent: true });
    expect(mocks.sendManagedTenantEmail).toHaveBeenCalledOnce();
  });

  it("stops a registration delivery if the automation is reactivated during processing", async () => {
    const delivery = registrationDelivery();
    const reactivatedAt = new Date("2026-08-04T10:02:00Z");
    // The automation remains active, but its activation changed after loading.
    mocks.automationExists.mockImplementation(
      async (filter) =>
        !filter.activatedAt || filter.activatedAt.getTime() === reactivatedAt.getTime(),
    );

    await expect(processCommunicationEmailJob(delivery as never)).resolves.toMatchObject({
      skipped: true,
      reason: "Automation was deactivated or reactivated before delivery.",
    });
    expect(mocks.beginProvider).not.toHaveBeenCalled();
    expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
  });

  it("routes a trusted persisted system log without an automation identifier", async () => {
    const systemLog = {
      ...log,
      automation: null,
      emailType: "bookingCancelled",
      allowanceClass: "essential_system",
    };
    mocks.logFindOne.mockReturnValue(query(systemLog));
    mocks.claim.mockResolvedValue(systemLog);
    await expect(
      processCommunicationEmailJob({
        ...job,
        data: { tenantId: TENANT_ID, emailLogId: LOG_ID },
      } as never),
    ).resolves.toEqual({ sent: true });
    expect(mocks.processLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        emailLogId: LOG_ID,
        log: systemLog,
      }),
    );
    expect(mocks.automationFindOne).not.toHaveBeenCalled();
    expect(mocks.quietHours).not.toHaveBeenCalled();
  });

  it("cannot elevate an ordinary automation into the built-in path using queue data or allowance", async () => {
    const forgedLog = { ...log, allowanceClass: "essential_system" };
    mocks.logFindOne.mockReturnValue(query(forgedLog));
    mocks.claim.mockResolvedValue(forgedLog);
    await expect(
      processCommunicationEmailJob({
        ...job,
        data: { ...job.data, emailType: "bookingCancelled" },
      } as never),
    ).resolves.toMatchObject({
      skipped: true,
      reason: "Invalid automation delivery contract.",
    });
    expect(mocks.processLifecycle).not.toHaveBeenCalled();
    expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
  });

  it.each(["delivered", "ambiguous", "failed"])(
    "never reclaims terminal %s lifecycle logs",
    async (status) => {
      mocks.logFindOne.mockReturnValue(
        query({
          ...log,
          automation: null,
          emailType: "bookingCancelled",
          allowanceClass: "essential_system",
          status,
          ...(status === "failed" ? { retryable: false } : {}),
        }),
      );
      await expect(
        processCommunicationEmailJob(job as never),
      ).resolves.toMatchObject({ skipped: true });
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(mocks.processLifecycle).not.toHaveBeenCalled();
    },
  );

  it.each(["bookingRescheduled", "firingReady"])(
    "recovers a committed %s system log after enqueue failure without inventing an automation id",
    async (emailType) => {
      const systemLog = {
        ...log,
        automation: null,
        emailType,
        allowanceClass: "essential_system",
        attempts: 0,
      };
      mocks.listCandidates.mockResolvedValue([systemLog]);
      mocks.claimReconciliation.mockResolvedValue(systemLog);
      mocks.enqueue.mockResolvedValue({
        state: "waiting",
        queueAccepted: true,
      });
      mocks.markReconciledQueued.mockResolvedValue(true);
      await expect(recoverStaleCommunicationEmailJobs()).resolves.toMatchObject(
        {
          queueAccepted: 1,
        },
      );
      expect(mocks.enqueue).toHaveBeenCalledWith(
        { tenantId: TENANT_ID, emailLogId: LOG_ID },
        "dedupe-1",
        { allowCompletedRetry: true },
      );
      expect(mocks.markReconciliationAmbiguous).not.toHaveBeenCalled();
    },
  );

  it("does not call Postmark when the durable log claim is not acquired", async () => {
    mocks.claim.mockResolvedValue(null);
    await expect(
      processCommunicationEmailJob(job as never),
    ).resolves.toMatchObject({
      skipped: true,
      reason: "not_claimable",
    });
    expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "revalidates a queued booking through the database when private migration suppression is %s",
    async (suppressed) => {
      const bookingId = "507f191e810c19729de860ed";
      const end = new Date("2026-08-04T12:00:00.000Z");
      const bookingLog = {
        ...log,
        relatedEntityType: "booking",
        relatedEntityId: bookingId,
        sourceScheduledAt: end,
      };
      mocks.logFindOne.mockReturnValue(query(bookingLog));
      mocks.claim.mockResolvedValue(bookingLog);
      mocks.bookingFindOne.mockImplementation((filter) => {
        // Mongo filters on private provenance before projecting select:false
        // fields. The resulting booking deliberately contains no provenance.
        const excluded =
          suppressed &&
          filter["atelierKleiMigration.suppressHistoricalNotifications"]
            ?.$ne === true;
        return query(
          excluded
            ? null
            : {
                _id: bookingId,
                tenant: TENANT_ID,
                status: "processed",
                paymentStatus: "CONFIRMED",
                end,
                orders: [],
              },
        );
      });

      const result = await processCommunicationEmailJob(job as never);
      expect(mocks.bookingFindOne).toHaveBeenCalledWith({
        _id: bookingId,
        tenant: TENANT_ID,
        "atelierKleiMigration.suppressHistoricalNotifications": { $ne: true },
      });
      if (suppressed) {
        expect(result).toMatchObject({
          skipped: true,
          reason: "Source entity no longer exists.",
        });
        expect(mocks.markCanceled).toHaveBeenCalledWith(
          TENANT_ID,
          LOG_ID,
          "Source entity no longer exists.",
          "canceled",
          expect.any(String),
        );
        expect(mocks.beginProvider).not.toHaveBeenCalled();
        expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ sent: true });
        expect(mocks.sendManagedTenantEmail).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not reconnect MongoDB for every job after worker startup owns the connection", async () => {
    await expect(
      processCommunicationEmailJob(job as never),
    ).resolves.toMatchObject({ sent: true });

    expect(mocks.connectDB).not.toHaveBeenCalled();
  });

  it("sends through the managed Postmark path with reconciliation metadata", async () => {
    await expect(
      processCommunicationEmailJob(job as never),
    ).resolves.toMatchObject({ sent: true });

    expect(mocks.sendManagedTenantEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        senderEmailId: automation.senderEmail._id,
        emailLogId: LOG_ID,
        automationId: AUTOMATION_ID,
        idempotencyKey: "dedupe-1",
        headers: expect.objectContaining({
          "Message-ID": "<dedupe-1@notify.shario.io>",
        }),
      }),
    );
  });

  it("connects before consuming jobs and closes worker-owned dependencies in shutdown order", async () => {
    const runtime = await startCommunicationEmailWorker({
      registerSignalHandlers: false,
    });

    expect(mocks.connectDB).toHaveBeenCalledOnce();
    expect(mocks.workerConstructor).toHaveBeenCalledOnce();
    expect(mocks.connectDB.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.workerConstructor.mock.invocationCallOrder[0],
    );

    const result = await runtime.shutdown("SIGTERM");

    expect(result).toMatchObject({
      drainTimedOut: false,
      cleanupTimedOut: [],
      errors: [],
    });
    expect(mocks.workerPause).toHaveBeenCalledWith(true);
    expect(mocks.workerClose).toHaveBeenCalledOnce();
    expect(mocks.queueClose).toHaveBeenCalledOnce();
    expect(mocks.closeDatabaseConnection).toHaveBeenCalledOnce();
    expect(mocks.queueClose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeDatabaseConnection.mock.invocationCallOrder[0],
    );
  });

  it("does not call Postmark when provider-attempt ownership is lost", async () => {
    mocks.beginProvider.mockResolvedValue(null);
    await expect(
      processCommunicationEmailJob(job as never),
    ).resolves.toMatchObject({
      reason: "claim_lost_before_provider",
    });
    expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
  });

  it("retries a definite Postmark rejection with the claim token", async () => {
    mocks.sendManagedTenantEmail.mockRejectedValue(
      Object.assign(new Error("Postmark rejected the message"), {
        code: "POSTMARK_300",
        deliveryOutcome: "not_sent",
        permanent: true,
      }),
    );
    await expect(processCommunicationEmailJob(job as never)).rejects.toThrow(
      "Postmark rejected the message",
    );
    expect(mocks.markFailed).toHaveBeenCalledWith(
      TENANT_ID,
      LOG_ID,
      "Postmark rejected the message",
      expect.any(String),
      true,
    );
    expect(mocks.markAmbiguous).not.toHaveBeenCalled();
  });

  it("moves a network loss with unknown Postmark outcome to manual review without retry", async () => {
    mocks.sendManagedTenantEmail.mockRejectedValue(
      Object.assign(new Error("Socket closed"), {
        code: "POSTMARK_OUTCOME_UNKNOWN",
      }),
    );
    await expect(
      processCommunicationEmailJob(job as never),
    ).resolves.toMatchObject({
      ambiguous: true,
      reason: "provider_outcome_unknown",
    });
    expect(mocks.markAmbiguous).toHaveBeenCalledWith(
      TENANT_ID,
      LOG_ID,
      expect.stringContaining("Postmark delivery outcome is unknown"),
      expect.any(String),
    );
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it("treats a Postmark timeout as ambiguous because acceptance is unknown", async () => {
    mocks.sendManagedTenantEmail.mockRejectedValue(
      Object.assign(new Error("Request timed out after dispatch"), {
        code: "POSTMARK_OUTCOME_UNKNOWN",
      }),
    );

    await expect(
      processCommunicationEmailJob(job as never),
    ).resolves.toMatchObject({
      ambiguous: true,
      reason: "provider_outcome_unknown",
    });
    expect(mocks.markAmbiguous).toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it.each(["returns false", "throws"])(
    "never downgrades an accepted Postmark message when markSent %s",
    async (mode) => {
      if (mode === "returns false") mocks.markSent.mockResolvedValue(false);
      else mocks.markSent.mockRejectedValue(new Error("Mongo unavailable"));

      await expect(
        processCommunicationEmailJob(job as never),
      ).resolves.toMatchObject({
        ambiguous: true,
      });
      expect(mocks.markAmbiguous).toHaveBeenCalled();
      expect(mocks.markFailed).not.toHaveBeenCalled();
    },
  );

  it("does not enqueue a deferred job when the token-owned defer transition loses", async () => {
    mocks.quietHours.mockReturnValue(true);
    mocks.defer.mockResolvedValue(false);

    await expect(
      processCommunicationEmailJob(job as never),
    ).resolves.toMatchObject({
      reason: "claim_lost_before_defer",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("reactivates an exhausted Bull job through the periodic durable reconciler", async () => {
    const candidate = {
      ...log,
      status: "failed",
      attempts: 2,
      queueRecoveryAttempts: 0,
    };
    mocks.listCandidates.mockResolvedValue([candidate]);
    mocks.claimReconciliation.mockResolvedValue(candidate);
    mocks.enqueue.mockResolvedValue({
      jobId: "email-dedupe-1",
      state: "waiting",
      action: "reactivated_failed",
      queueAccepted: true,
      newlyQueued: true,
    });
    mocks.markReconciledQueued.mockResolvedValue(true);

    await expect(recoverStaleCommunicationEmailJobs()).resolves.toMatchObject({
      queueAccepted: 1,
    });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.markReconciledQueued).toHaveBeenCalledWith(
      TENANT_ID,
      LOG_ID,
      expect.any(String),
      expect.any(Date),
    );
    expect(mocks.emitNotification).not.toHaveBeenCalled();
  });

  it.each(["firingReady", "bookingRescheduled"])(
    "respects explicit retry cycles only for firing notices, not %s contracts generally",
    async (emailType) => {
      const candidate = {
        ...log,
        automation: null,
        emailType,
        allowanceClass: "essential_system",
        status: "scheduled",
        attempts: 6,
        retryCycleStartAttempt: 6,
        queueRecoveryAttempts: 0,
      };
      mocks.listCandidates.mockResolvedValue([candidate]);
      mocks.claimReconciliation.mockResolvedValue(candidate);
      mocks.enqueue.mockResolvedValue({
        state: "waiting",
        queueAccepted: true,
      });
      mocks.markReconciledQueued.mockResolvedValue(true);
      mocks.markReconciliationAmbiguous.mockResolvedValue(true);
      const result = await recoverStaleCommunicationEmailJobs();
      if (emailType === "firingReady") {
        expect(result).toMatchObject({ queueAccepted: 1 });
        expect(mocks.markReconciliationAmbiguous).not.toHaveBeenCalled();
        expect(mocks.enqueue).toHaveBeenCalledWith(
          { tenantId: TENANT_ID, emailLogId: LOG_ID },
          "dedupe-1",
          { allowCompletedRetry: true },
        );
      } else {
        expect(result).toMatchObject({ ambiguous: 1 });
        expect(mocks.enqueue).not.toHaveBeenCalled();
      }
    },
  );

  it("notifies only after durable delivery recovery is exhausted", async () => {
    const candidate = {
      ...log,
      status: "failed",
      attempts: 6,
      queueRecoveryAttempts: 0,
    };
    mocks.listCandidates.mockResolvedValue([candidate]);
    mocks.claimReconciliation.mockResolvedValue(candidate);
    mocks.markReconciliationAmbiguous.mockResolvedValue(true);

    await expect(recoverStaleCommunicationEmailJobs()).resolves.toMatchObject({
      ambiguous: 1,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        eventType: "communication.failed",
        sourceId: LOG_ID,
        requiredPermission: "communications.audit.view",
      }),
    );
  });

  it("lets only one reconciler act when the other loses the durable claim", async () => {
    const candidate = { ...log, status: "queued", attempts: 1 };
    mocks.listCandidates.mockResolvedValue([candidate]);
    mocks.claimReconciliation
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(null);
    mocks.enqueue.mockResolvedValue({
      state: "waiting",
      queueAccepted: true,
      newlyQueued: false,
    });
    mocks.markReconciledQueued.mockResolvedValue(true);

    await Promise.all([
      recoverStaleCommunicationEmailJobs(),
      recoverStaleCommunicationEmailJobs(),
    ]);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
});
