import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const effects = vi.hoisted(() => ({ enqueue: vi.fn(), send: vi.fn() }));
vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  enqueueCommunicationEmail: effects.enqueue,
}));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: effects.send,
}));
import EmailLog from "@/modules/communication-email-logs/communication-email-log.model.js";
import {
  CommunicationAuditModel as Audit,
  CommunicationConsentModel as Consent,
  CommunicationSuppressionModel as Suppression,
} from "@/modules/communications/communications.models.js";
import {
  decorateCommunicationEmailLogs,
  retryCommunicationEmailLog,
} from "@/modules/communication-email-logs/services/communication-email-log-retry.service.js";
import { communicationEmailLogRepository as logs } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import { processBookingLifecycleEmail } from "@/workers/booking-lifecycle-email.processor.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import Booking from "@/modules/booking/booking.model.js";

let replica: MongoMemoryReplSet;
const tenant = new mongoose.Types.ObjectId();
const actor = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const customer = new mongoose.Types.ObjectId();
const seed = (patch: Record<string, any> = {}) =>
  EmailLog.create({
    tenant,
    automation: new mongoose.Types.ObjectId(),
    user: customer,
    location,
    appliesToAllLocations: false,
    recipientEmail: "maker@example.test",
    subject: "Studio notice",
    body: "Original private notice",
    htmlContent: "<p>Original private notice</p>",
    contentFormat: "html",
    emailType: "oneTimeEmail",
    purpose: "transactional",
    allowanceClass: "metered",
    deduplicationKey: new mongoose.Types.ObjectId().toHexString(),
    occurrenceKey: "original-occurrence",
    status: "failed",
    failedAt: new Date(),
    attempts: 6,
    retryable: false,
    ...patch,
  });
const retry = (log: any, overrides: Record<string, any> = {}) =>
  retryCommunicationEmailLog({
    tenantId: String(tenant),
    actorId: String(actor),
    logId: String(log._id),
    expectedManualRetryCount: 0,
    allowedLocationIds: [String(location)],
    ...overrides,
  });

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([
    EmailLog.init(),
    Audit.init(),
    Consent.init(),
    Suppression.init(),
  ]);
}, 120_000);
beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    EmailLog.deleteMany({}),
    Audit.deleteMany({}),
    Consent.deleteMany({}),
    Suppression.deleteMany({}),
    Tenant.deleteMany({}),
    User.deleteMany({}),
    Booking.deleteMany({}),
  ]);
  effects.enqueue.mockResolvedValue({ queueAccepted: true, state: "waiting" });
  effects.send.mockImplementation(async (mail) => {
    await mail.beforeSend();
    return { provider: "postmark", providerMessageId: "accepted" };
  });
});
afterAll(async () => {
  await mongoose.disconnect();
  await replica?.stop();
});

describe("email history manual retry", () => {
  it.each(["failed", "canceled", "suppressed"] as const)(
    "accepts the real persisted %s transition and clears its historical reason",
    async (status) => {
      const original = await seed({
        status: "queued",
        attempts: 0,
        retryable: true,
        failedAt: null,
      });
      await logs.claimForSending({
        tenantId: String(tenant),
        logId: String(original._id),
        jobId: "original-job",
        claimToken: "original-claim",
      });
      if (status === "failed") {
        await logs.markFailed(
          String(tenant),
          String(original._id),
          "Sender is not ready",
          "original-claim",
          true,
          { retryable: false, countAttempt: true },
        );
      } else {
        await logs.markCanceled(
          String(tenant),
          String(original._id),
          status === "suppressed"
            ? "consent_revoked"
            : "Managed sender is inactive, unverified, or not provisioned.",
          status,
          "original-claim",
        );
      }
      await expect(retry(original)).resolves.toMatchObject({
        queued: true,
        log: {
          status: "queued",
          manualRetryCount: 1,
          cancelReason: "",
          errorMessage: "",
        },
      });
      expect(
        await logs.beginProviderAttempt({
          tenantId: String(tenant),
          logId: String(original._id),
          jobId: "original-job",
          claimToken: "original-claim",
        }),
      ).toBeNull();
    },
  );
  it("accepts only one simultaneous retry, preserves payload, and commits its audit with the outbox", async () => {
    const original = await seed();
    const results = await Promise.allSettled([
      retry(original),
      retry(original),
      retry(original),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .map((result: any) => result.reason.code),
    ).toEqual([
      "COMMUNICATION_EMAIL_RETRY_STALE",
      "COMMUNICATION_EMAIL_RETRY_STALE",
    ]);
    expect(effects.enqueue).toHaveBeenCalledTimes(1);
    expect(effects.send).not.toHaveBeenCalled();
    const current = await EmailLog.findById(original._id).lean();
    expect(current).toMatchObject({
      status: "queued",
      attempts: 6,
      retryCycleStartAttempt: 6,
      manualRetryCount: 1,
      retryable: true,
      body: original.body,
      subject: original.subject,
      recipientEmail: original.recipientEmail,
      deduplicationKey: original.deduplicationKey,
    });
    expect(String(current.lastManualRetryBy)).toBe(String(actor));
    const audit = await Audit.findOne({ resourceId: original._id }).lean();
    expect(audit).toMatchObject({
      action: "email_log.retry",
      before: { status: "failed", attempts: 6, manualRetryCount: 0 },
      after: { status: "scheduled", manualRetryCount: 1 },
    });
    expect(JSON.stringify(audit)).not.toContain(original.body);
    expect(effects.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: String(tenant),
        emailLogId: String(original._id),
        automationId: String(original.automation),
      }),
      original.deduplicationKey,
      { allowCompletedRetry: true },
    );
    await EmailLog.updateOne(
      { _id: original._id },
      { $set: { status: "failed", queuedAt: null } },
    );
    await expect(retry(original)).rejects.toMatchObject({
      code: "COMMUNICATION_EMAIL_RETRY_STALE",
    });
    expect(effects.enqueue).toHaveBeenCalledTimes(1);
  });
  it("rolls back the retry if its audit cannot be persisted", async () => {
    const log = await seed();
    vi.spyOn(Audit, "create").mockRejectedValueOnce(
      new Error("audit unavailable") as never,
    );
    await expect(retry(log)).rejects.toThrow("audit unavailable");
    expect(await EmailLog.findById(log._id)).toMatchObject({
      status: "failed",
      manualRetryCount: 0,
      attempts: 6,
    });
    expect(effects.enqueue).not.toHaveBeenCalled();
  });
  it("leaves a durable recovery candidate when Redis is unavailable", async () => {
    const log = await seed();
    effects.enqueue.mockRejectedValueOnce(new Error("Redis offline"));
    const result = await retry(log);
    expect(result).toMatchObject({
      queued: false,
      log: { status: "scheduled", manualRetryCount: 1, canRetry: false },
    });
    expect(await Audit.countDocuments({ resourceId: log._id })).toBe(1);
    const candidates = await logs.listQueueReconciliationCandidates();
    expect(candidates.map((entry) => String(entry._id))).toContain(
      String(log._id),
    );
  });
  it.each(["completed", "unknown"])(
    "reports blocked rather than scheduled when the queue is unexpectedly %s",
    async (state) => {
      const log = await seed();
      effects.enqueue.mockResolvedValueOnce({ queueAccepted: false, state });
      await expect(retry(log)).rejects.toMatchObject({
        code: "COMMUNICATION_EMAIL_RETRY_BLOCKED",
        details: { reason: "delivery_outcome_unknown" },
      });
      expect(await EmailLog.findById(log._id)).toMatchObject({
        status: "ambiguous",
        manualReviewRequiredAt: expect.any(Date),
        manualRetryCount: 1,
      });
      expect(await logs.listQueueReconciliationCandidates()).toHaveLength(0);
    },
  );
  it.each([
    { tenantId: String(new mongoose.Types.ObjectId()) },
    { allowedLocationIds: [] },
    { allowedLocationIds: [String(new mongoose.Types.ObjectId())] },
  ])("does not expose or queue inaccessible history: %j", async (scope) => {
    const log = await seed();
    await expect(retry(log, scope)).rejects.toMatchObject({
      code: "COMMUNICATION_EMAIL_LOG_NOT_FOUND",
    });
    expect(effects.enqueue).not.toHaveBeenCalled();
  });
  it("hides workspace-wide logs from location-restricted senders", async () => {
    const log = await seed({ appliesToAllLocations: true });
    await expect(retry(log)).rejects.toMatchObject({
      code: "COMMUNICATION_EMAIL_LOG_NOT_FOUND",
    });
  });
  it.each(["hard_bounce", "spam_complaint"])(
    "preserves active %s suppression and reveals its reason",
    async (reason) => {
      const log = await seed({
        status: "suppressed",
        cancelReason: "recipient_suppressed",
      });
      await Suppression.create({
        tenantId: tenant,
        channel: "email",
        identity: log.recipientEmail,
        active: true,
        reason,
      });
      expect(
        (await decorateCommunicationEmailLogs(String(tenant), [log]))[0],
      ).toMatchObject({
        canRetry: false,
        retryBlockedReason: reason,
        reasonCode: reason,
      });
      await expect(retry(log)).rejects.toMatchObject({
        code: "COMMUNICATION_EMAIL_RETRY_BLOCKED",
        details: { reason },
      });
      expect(await Suppression.countDocuments({ active: true })).toBe(1);
      expect(effects.enqueue).not.toHaveBeenCalled();
    },
  );
  it("re-evaluates consent before allowing a formerly suppressed message", async () => {
    const log = await seed({
      status: "suppressed",
      cancelReason: "consent_revoked",
    });
    const consent = await Consent.create({
      tenantId: tenant,
      customerId: customer,
      channel: "email",
      purpose: "transactional",
      status: "revoked",
    });
    await expect(retry(log)).rejects.toMatchObject({
      details: { reason: "consent_revoked" },
    });
    await Consent.updateOne(
      { _id: consent._id },
      { $set: { status: "granted" } },
    );
    await expect(retry(log)).resolves.toMatchObject({
      queued: true,
      log: { status: "queued" },
    });
  });

  const seedBookingNotice = async (bookingStatus = "cancelled") => {
    const bookingId = new mongoose.Types.ObjectId();
    await Tenant.collection.insertOne({
      _id: tenant,
      status: "active",
      planVersion: 3,
    });
    await User.collection.insertOne({
      _id: customer,
      tenant,
      email: "maker@example.test",
    });
    await Booking.collection.insertOne({
      _id: bookingId,
      tenant,
      createdBy: customer,
      location,
      status: bookingStatus,
      start: new Date(),
    });
    return seed({
      automation: null,
      emailType: "bookingCancelled",
      allowanceClass: "essential_system",
      contentFormat: "plain",
      relatedEntityId: bookingId,
      relatedEntityType: "booking",
    });
  };
  const process = async (log: any) => {
    const claim = await logs.claimForSending({
      tenantId: String(tenant),
      logId: String(log._id),
      jobId: "job",
      claimToken: "new-worker-claim",
    });
    expect(claim).not.toBeNull();
    return processBookingLifecycleEmail({
      tenantId: String(tenant),
      emailLogId: String(log._id),
      jobId: "job",
      claimToken: "new-worker-claim",
      log: claim!,
    });
  };
  it("keeps stale-source validation in the original worker", async () => {
    const log = await seedBookingNotice("confirmed");
    await retry(log);
    await expect(process(log)).resolves.toMatchObject({
      skipped: true,
      reason: "Booking is no longer cancelled.",
    });
    expect(await EmailLog.findById(log._id)).toMatchObject({
      status: "canceled",
      attempts: 6,
    });
    expect(effects.send).not.toHaveBeenCalled();
  });
  it("rechecks suppression added after the retry request", async () => {
    const log = await seedBookingNotice();
    await retry(log);
    await Suppression.create({
      tenantId: tenant,
      channel: "email",
      identity: log.recipientEmail,
      active: true,
      reason: "manual",
    });
    await expect(process(log)).resolves.toMatchObject({
      skipped: true,
      reason: "recipient_suppressed",
    });
    expect(effects.send).not.toHaveBeenCalled();
  });
  it("uses the original booking processor with a fresh bounded cycle and fences out the old worker", async () => {
    const log = await seedBookingNotice();
    await retry(log);
    expect(
      await logs.beginProviderAttempt({
        tenantId: String(tenant),
        logId: String(log._id),
        jobId: "old-job",
        claimToken: "old-claim",
      }),
    ).toBeNull();
    await expect(process(log)).resolves.toMatchObject({ sent: true });
    expect(await EmailLog.findById(log._id)).toMatchObject({
      status: "sent",
      attempts: 7,
      retryCycleStartAttempt: 6,
      manualRetryCount: 1,
    });
    expect(effects.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: log.recipientEmail,
        subject: log.subject,
        text: log.body,
      }),
    );
  });
});
