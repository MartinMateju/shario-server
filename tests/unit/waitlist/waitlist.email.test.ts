import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  outboxUpdateMany: vi.fn(),
  outboxFindOneAndUpdate: vi.fn(),
  outboxUpdateOne: vi.fn(),
  entryFindOne: vi.fn(),
  verificationFindOne: vi.fn(),
  tenantFindById: vi.fn(),
  sendEmail: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/modules/waitlist/waitlist.model.js", () => ({
  WaitlistEmailOutboxModel: {
    updateMany: mocks.outboxUpdateMany,
    findOneAndUpdate: mocks.outboxFindOneAndUpdate,
    updateOne: mocks.outboxUpdateOne,
  },
  WaitlistEntryModel: { findOne: mocks.entryFindOne },
  WaitlistVerificationModel: { findOne: mocks.verificationFindOne },
}));

vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendEmail,
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.loggerError },
}));

import {
  processWaitlistEmailOutbox,
  waitlistEmailInternals,
} from "@/modules/waitlist/waitlist.email.service.js";
import {
  deriveWaitlistToken,
  hashWaitlistToken,
} from "@/modules/waitlist/waitlist.policy.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ENTRY_ID = "507f1f77bcf86cd799439012";
const SESSION_ID = "507f1f77bcf86cd799439013";

const query = (value: unknown) => {
  const q: any = {};
  for (const method of ["select", "lean", "populate"])
    q[method] = vi.fn(() => q);
  q.exec = vi.fn().mockResolvedValue(value);
  return q;
};
const execResult = (value: unknown) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const managementEntry = (overrides: Record<string, unknown> = {}) => {
  const generation = 1;
  const token = deriveWaitlistToken({
    subject: ENTRY_ID,
    purpose: "manage",
    generation,
  });
  return {
    _id: ENTRY_ID,
    tenant: TENANT_ID,
    state: "waiting",
    isLive: true,
    locale: "en",
    email: "ada@example.test",
    firstName: "Ada",
    lastName: "Lovelace",
    managementGeneration: generation,
    managementExpiresAt: new Date("2026-08-10T10:00:00.000Z"),
    managementTokenHash: hashWaitlistToken(token, "manage"),
    product: { name: "Wheel class" },
    courseSession: {
      _id: SESSION_ID,
      start: new Date("2026-08-09T10:00:00.000Z"),
      location: { name: "Studio Olivie" },
    },
    ...overrides,
  };
};

describe("waitlist email outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CLIENT_URL", "http://shario.localhost:3000");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T10:00:00.000Z"));
    process.env.WAITLIST_TOKEN_PEPPER = "email-test-pepper".repeat(3);
    mocks.outboxUpdateMany
      .mockReturnValueOnce(execResult({ modifiedCount: 0 }))
      .mockReturnValueOnce(execResult({ modifiedCount: 0 }));
    mocks.outboxUpdateOne.mockReturnValue(execResult({ modifiedCount: 1 }));
    mocks.tenantFindById.mockReturnValue(
      query({ slug: "studio-olivie", name: "Studio Olivie", domains: [] }),
    );
    vi.spyOn(mongoose, "model").mockReturnValue({
      findById: mocks.tenantFindById,
    } as never);
  });

  it("uses a deterministic Message-ID and distinguishes safe retry errors from ambiguous SMTP outcomes", () => {
    const first = waitlistEmailInternals.messageIdFor(
      `waitlist:${ENTRY_ID}:joined`,
    );
    expect(first).toBe(
      waitlistEmailInternals.messageIdFor(`waitlist:${ENTRY_ID}:joined`),
    );
    expect(first).not.toBe(
      waitlistEmailInternals.messageIdFor(`waitlist:${ENTRY_ID}:offered:1`),
    );
    expect(first).toMatch(/^<waitlist\.[a-f0-9]{64}@shario\.io>$/);
    expect(waitlistEmailInternals.knownNotSent({ responseCode: 550 })).toBe(
      true,
    );
    expect(waitlistEmailInternals.knownNotSent({ code: "EAUTH" })).toBe(true);
    expect(waitlistEmailInternals.knownNotSent({ code: "ETIMEDOUT" })).toBe(
      false,
    );
  });

  it("requeues only claims that definitely never reached SMTP and quarantines ambiguous attempts", async () => {
    mocks.outboxUpdateMany.mockReset();
    mocks.outboxUpdateMany
      .mockReturnValueOnce(execResult({ modifiedCount: 2 }))
      .mockReturnValueOnce(execResult({ modifiedCount: 1 }));
    await expect(
      waitlistEmailInternals.recoverStaleClaims(
        new Date("2026-08-07T10:00:00.000Z"),
      ),
    ).resolves.toEqual({ requeued: 2, ambiguous: 1 });
    expect(mocks.outboxUpdateMany.mock.calls[0][0]).toMatchObject({
      status: "sending",
      providerAttemptStartedAt: null,
    });
    expect(mocks.outboxUpdateMany.mock.calls[0][1]).toMatchObject({
      $set: { status: "pending", nextAttemptAt: expect.any(Date) },
    });
    expect(mocks.outboxUpdateMany.mock.calls[1][0]).toMatchObject({
      status: "sending",
      providerAttemptStartedAt: { $ne: null },
    });
    expect(mocks.outboxUpdateMany.mock.calls[1][1].$set.status).toBe(
      "ambiguous",
    );
  });

  it("claims oldest-first, sends a token only in the URL fragment, and records success once", async () => {
    const outbox = {
      _id: "507f1f77bcf86cd799439099",
      tenant: TENANT_ID,
      entry: ENTRY_ID,
      recipientEmail: "ada@example.test",
      recipientName: "Ada Lovelace",
      type: "waitlist_joined",
      tokenPurpose: "manage",
      tokenGeneration: 1,
      deduplicationKey: `waitlist:${ENTRY_ID}:joined`,
    };
    mocks.outboxFindOneAndUpdate
      .mockReturnValueOnce(query(outbox))
      .mockReturnValueOnce(query({ ...outbox, attempts: 1 }))
      .mockReturnValueOnce(query(null));
    mocks.entryFindOne.mockReturnValue(query(managementEntry()));
    mocks.sendEmail.mockResolvedValue({ providerMessageId: "provider-1" });

    await expect(processWaitlistEmailOutbox()).resolves.toBe(1);
    expect(mocks.outboxFindOneAndUpdate.mock.calls[0][2]).toEqual({
      returnDocument: "after",
      sort: { createdAt: 1, _id: 1 },
    });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    const mail = mocks.sendEmail.mock.calls[0][0];
    expect(mail.tenantId).toBe(TENANT_ID);
    expect(mail.headers["Message-ID"]).toBe(mail.messageId);
    expect(mail.messageId).toBe(
      waitlistEmailInternals.messageIdFor(outbox.deduplicationKey),
    );
    expect(mail.text).toContain(
      "http://studio-olivie.localhost:3000/en/waitlists/manage#manage=",
    );
    expect(mail.text).not.toContain("?token=");
    expect(mail.html).toContain("Studio Olivie");
    const sentUpdate = mocks.outboxUpdateOne.mock.calls.find(
      ([, update]) => update?.$set?.status === "sent",
    );
    expect(sentUpdate).toBeDefined();
  });

  it("skips stale joined mail after withdrawal instead of leaking a management link", async () => {
    const outbox = {
      _id: "507f1f77bcf86cd799439099",
      tenant: TENANT_ID,
      entry: ENTRY_ID,
      recipientEmail: "ada@example.test",
      type: "waitlist_joined",
      tokenPurpose: "manage",
      tokenGeneration: 1,
      deduplicationKey: `waitlist:${ENTRY_ID}:joined`,
    };
    mocks.outboxFindOneAndUpdate
      .mockReturnValueOnce(query(outbox))
      .mockReturnValueOnce(query(null));
    mocks.entryFindOne.mockReturnValue(
      query(managementEntry({ state: "withdrawn", isLive: false })),
    );

    await expect(processWaitlistEmailOutbox()).resolves.toBe(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: outbox._id, status: "sending" }),
      {
        $set: expect.objectContaining({
          status: "skipped",
          nextAttemptAt: null,
        }),
      },
    );
  });

  it("sends a localized, amount-accurate card refund confirmation instead of a generic expiry", async () => {
    const refundSnapshot = {
      refundId: "re_waitlist_1",
      status: "succeeded",
      amountMinor: 5_000,
      currency: "JPY",
      paymentMethod: "card",
      refundedAt: new Date("2026-08-07T10:00:00.000Z"),
    };
    const outbox = {
      _id: "507f1f77bcf86cd799439099",
      tenant: TENANT_ID,
      entry: ENTRY_ID,
      recipientEmail: "ada@example.test",
      type: "waitlist_refunded",
      tokenPurpose: "",
      tokenGeneration: null,
      refundSnapshot,
      deduplicationKey: `waitlist:${ENTRY_ID}:refunded`,
    };
    mocks.outboxFindOneAndUpdate
      .mockReturnValueOnce(query(outbox))
      .mockReturnValueOnce(query({ ...outbox, attempts: 1 }))
      .mockReturnValueOnce(query(null));
    mocks.entryFindOne.mockReturnValue(
      query(
        managementEntry({
          state: "expired",
          isLive: false,
          locale: "en",
          refundSnapshot,
        }),
      ),
    );
    mocks.sendEmail.mockResolvedValue({ providerMessageId: "provider-refund-1" });

    await expect(processWaitlistEmailOutbox()).resolves.toBe(1);
    const mail = mocks.sendEmail.mock.calls[0][0];
    expect(mail.subject).toContain("Payment refunded");
    expect(mail.text).toContain("card payment of 5000 JPY");
    expect(mail.text).toContain("refunded successfully");
    expect(mail.text).not.toContain("offer window ended");
  });

  it("retries a known rejection with backoff but quarantines an unknown outcome", async () => {
    const outbox = {
      _id: "507f1f77bcf86cd799439099",
      tenant: TENANT_ID,
      entry: ENTRY_ID,
      recipientEmail: "ada@example.test",
      type: "waitlist_joined",
      tokenPurpose: "manage",
      tokenGeneration: 1,
      deduplicationKey: `waitlist:${ENTRY_ID}:joined`,
    };
    mocks.outboxFindOneAndUpdate
      .mockReturnValueOnce(query(outbox))
      .mockReturnValueOnce(query({ ...outbox, attempts: 1 }))
      .mockReturnValueOnce(query(null));
    mocks.entryFindOne.mockReturnValue(query(managementEntry()));
    const rejection: any = new Error("Mailbox rejected");
    rejection.responseCode = 550;
    mocks.sendEmail.mockRejectedValue(rejection);

    await expect(processWaitlistEmailOutbox()).resolves.toBe(0);
    const failed = mocks.outboxUpdateOne.mock.calls.find(
      ([, update]) => update?.$set?.status === "failed",
    );
    expect(failed?.[1].$set).toMatchObject({
      status: "failed",
      providerAttemptStartedAt: null,
      lastError: "Mailbox rejected",
    });
    expect(failed?.[1].$set.nextAttemptAt).toEqual(
      new Date("2026-08-07T10:02:00.000Z"),
    );
  });
});

afterEach(() => vi.unstubAllEnvs());
