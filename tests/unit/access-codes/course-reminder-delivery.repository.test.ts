import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  updateMany: vi.fn(),
  countDocuments: vi.fn(),
}));

vi.mock("@/modules/access-codes/course-reminder-delivery.model.js", () => ({
  default: mocks,
}));

import { courseReminderDeliverySchema } from "@/modules/access-codes/course-reminder-delivery.schema.js";
import { courseReminderDeliveryRepository } from "@/modules/access-codes/course-reminder-delivery.repository.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const LEASE_UNTIL = new Date("2026-08-04T12:05:00.000Z");

const execResult = <T>(value: T) => ({
  exec: vi.fn().mockResolvedValue(value),
});

describe("legacy course reminder durable outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOneAndUpdate.mockReturnValue(execResult(null));
    mocks.findOne.mockReturnValue(execResult(null));
    mocks.updateOne.mockReturnValue(execResult({ modifiedCount: 0 }));
    mocks.updateMany.mockReturnValue(execResult({ modifiedCount: 0 }));
    mocks.countDocuments.mockReturnValue(execResult(0));
  });

  it("has a unique stable idempotency key and lease recovery index", () => {
    const indexes = courseReminderDeliverySchema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ idempotencyKey: 1 }, expect.objectContaining({ unique: true })],
        [{ status: 1, leaseExpiresAt: 1 }, expect.any(Object)],
      ]),
    );
  });

  it("materializes a recipient occurrence with set-on-insert semantics", async () => {
    const delivery = { _id: "delivery-1", idempotencyKey: "key-1" };
    mocks.findOneAndUpdate.mockReturnValue(execResult(delivery));

    await expect(
      courseReminderDeliveryRepository.upsertPending({
        tenant: "tenant-1" as never,
        booking: "booking-1" as never,
        bookingStart: NOW,
        recipientUser: "user-1" as never,
        recipientEmail: "anna@example.com",
        idempotencyKey: "key-1",
        messageId: "<key-1@mail.shario.io>",
        subject: "Reminder",
        textContent: "Starts soon",
      }),
    ).resolves.toBe(delivery);

    const [filter, update, options] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ tenant: "tenant-1", idempotencyKey: "key-1" });
    expect(update).toMatchObject({
      $setOnInsert: {
        status: "pending",
        recipientEmail: "anna@example.com",
        messageId: "<key-1@mail.shario.io>",
      },
    });
    expect(options).toMatchObject({
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    });
  });

  it("atomically claims only pending or due failed rows with capacity left", async () => {
    await courseReminderDeliveryRepository.claimForSending({
      tenant: "tenant-1",
      idempotencyKey: "key-1",
      claimToken: "claim-1",
      now: NOW,
      leaseUntil: LEASE_UNTIL,
    });

    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      tenant: "tenant-1",
      idempotencyKey: "key-1",
      $expr: { $lt: ["$attempts", "$maxAttempts"] },
      $or: [
        { status: "pending" },
        {
          status: "failed",
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: NOW } }],
        },
      ],
    });
    expect(update.$set).toMatchObject({
      status: "sending",
      claimToken: "claim-1",
      leaseExpiresAt: LEASE_UNTIL,
      providerAttemptStartedAt: null,
    });
  });

  it("persists the provider boundary only for the live claim owner", async () => {
    await courseReminderDeliveryRepository.beginProviderAttempt({
      tenant: "tenant-1",
      deliveryId: "delivery-1",
      claimToken: "claim-1",
      now: NOW,
    });

    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      _id: "delivery-1",
      status: "sending",
      claimToken: "claim-1",
      leaseExpiresAt: { $gt: NOW },
      providerAttemptStartedAt: null,
    });
    expect(update).toEqual({
      $set: { providerAttemptStartedAt: NOW },
      $inc: { attempts: 1 },
    });
  });

  it("requeues only expired pre-provider claims and quarantines provider-started claims", async () => {
    mocks.updateMany
      .mockReturnValueOnce(execResult({ modifiedCount: 2 }))
      .mockReturnValueOnce(execResult({ modifiedCount: 1 }));

    await expect(
      courseReminderDeliveryRepository.recoverStaleClaims({ now: NOW }),
    ).resolves.toEqual({ requeued: 2, ambiguous: 1 });

    const [safeFilter, safeUpdate] = mocks.updateMany.mock.calls[0];
    expect(safeFilter).toEqual({
      status: "sending",
      leaseExpiresAt: { $lte: NOW },
      providerAttemptStartedAt: null,
    });
    expect(safeUpdate.$set).toMatchObject({
      status: "pending",
      claimToken: "",
      leaseExpiresAt: null,
    });

    const [uncertainFilter, uncertainUpdate] = mocks.updateMany.mock.calls[1];
    expect(uncertainFilter).toEqual({
      status: "sending",
      leaseExpiresAt: { $lte: NOW },
      providerAttemptStartedAt: { $ne: null },
    });
    expect(uncertainUpdate.$set).toMatchObject({
      status: "ambiguous",
      manualReviewRequiredAt: NOW,
      failureCode: "STALE_PROVIDER_ATTEMPT",
    });
  });

  it("terminally skips only the exact pre-provider claim owner and clears its lease", async () => {
    mocks.updateOne.mockReturnValue(execResult({ modifiedCount: 1 }));

    await expect(
      courseReminderDeliveryRepository.markSkipped({
        tenant: "tenant-1",
        deliveryId: "delivery-1",
        claimToken: "claim-1",
        reason: "Recipient is now suppressed.",
        now: NOW,
      }),
    ).resolves.toBe(true);

    const [filter, update] = mocks.updateOne.mock.calls[0];
    expect(filter).toEqual({
      _id: "delivery-1",
      tenant: "tenant-1",
      status: "sending",
      claimToken: "claim-1",
      providerAttemptStartedAt: null,
    });
    expect(update.$set).toMatchObject({
      status: "skipped",
      skippedAt: NOW,
      skipReason: "Recipient is now suppressed.",
      processingStartedAt: null,
      claimToken: "",
      leaseExpiresAt: null,
      providerAttemptStartedAt: null,
      nextAttemptAt: null,
    });
  });

  it("requires every requested recipient row to be sent or skipped", async () => {
    mocks.countDocuments.mockReturnValueOnce(execResult(1));
    await expect(
      courseReminderDeliveryRepository.areAllCompleted({
        tenant: "tenant-1",
        booking: "booking-1",
        idempotencyKeys: ["key-1", "key-2"],
      }),
    ).resolves.toBe(false);

    mocks.countDocuments.mockReturnValueOnce(execResult(2));
    await expect(
      courseReminderDeliveryRepository.areAllCompleted({
        tenant: "tenant-1",
        booking: "booking-1",
        idempotencyKeys: ["key-1", "key-2", "key-2"],
      }),
    ).resolves.toBe(true);

    const [filter] = mocks.countDocuments.mock.calls[1];
    expect(filter.status).toEqual({ $in: ["sent", "skipped"] });
  });
});
