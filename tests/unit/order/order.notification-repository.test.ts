import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
}));
vi.mock("@/modules/order/order.model.js", () => ({ Order: mocks }));
vi.mock("@/modules/product/product.model.js", () => ({ default: {} }));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/cart/cart.repository.js", () => ({
  createCartRepository: vi.fn(),
}));

import {
  acquireOrderNotificationLock,
  findOrderNotificationCandidates,
  findOrderForNotification,
  markFirstOrderNotificationClaimed,
  markOrderNotificationExhausted,
  markOrderNotificationFailed,
  markOrderNotificationAmbiguous,
  markOrderNotificationProviderStarted,
  markOrderNotificationSent,
  markRetryOrderNotificationClaimed,
  releaseOrderNotificationLock,
  renewOrderNotificationLock,
} from "@/modules/order/order.repository.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const CLAIM = {
  orderId: new mongoose.Types.ObjectId(),
  lockOwner: "worker:unique-run",
  claimId: "attempt-1",
};
const query = (value: unknown) => ({
  sort: vi.fn().mockReturnThis(),
  populate: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});

describe("order confirmation persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.find.mockReturnValue(query([]));
    mocks.findOne.mockReturnValue(query(null));
    mocks.findOneAndUpdate.mockReturnValue(query({}));
    mocks.updateOne.mockReturnValue(
      query({ matchedCount: 1, modifiedCount: 1 }),
    );
  });

  it("selects only paid fulfilled orders and includes interrupted final attempts for exhaustion", async () => {
    await findOrderNotificationCandidates(NOW);
    const filter = mocks.find.mock.calls[0][0];
    expect(filter).toMatchObject({
      isPaid: true,
      status: "processed_order",
      legacyOrder: { $ne: true },
    });
    expect(filter.$and[0].$or).toContainEqual({
      "notificationLock.lockedUntil": { $lte: NOW },
    });
    expect(filter.$and[1].$or).toEqual([
      { pieceCheckout: null },
      {
        "pieceCheckout.state": "paid",
        "pieceCheckout.refundedAmountMinor": { $in: [null, 0] },
      },
    ]);
    const retry = filter.$and[2].$or[2].$and[1].notificationLog.$elemMatch;
    expect(retry.status.$in).toEqual(["FAILED", "PROCESSING"]);
    expect(retry).not.toHaveProperty("attempt");
    expect(retry.provider).toEqual({ $ne: "exhausted" });
    expect(retry.sentAt.$lte).toEqual(new Date(NOW.getTime() - 15 * 60_000));
  });

  it("rechecks fulfillment when acquiring a lock", async () => {
    await acquireOrderNotificationLock({ ...CLAIM, now: NOW });
    expect(mocks.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      _id: CLAIM.orderId,
      isPaid: true,
      status: "processed_order",
      legacyOrder: { $ne: true },
      $and: [expect.objectContaining({ $or: expect.any(Array) })],
    });
  });

  it("records PROCESSING under the live lease before the first send", async () => {
    await markFirstOrderNotificationClaimed({
      ...CLAIM,
      to: "customer@example.test",
      claimTime: NOW,
    });
    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      isPaid: true,
      status: "processed_order",
      $or: expect.any(Array),
      "notificationLock.lockedBy": CLAIM.lockOwner,
      "notificationLock.lockedUntil": { $gt: NOW },
      notificationLog: { $not: { $elemMatch: { type: "order_confirm" } } },
    });
    expect(update.$push.notificationLog).toMatchObject({
      status: "PROCESSING",
      attempt: 1,
      claimId: CLAIM.claimId,
      deliveryVersion: 1,
      providerStartedAt: null,
    });
  });

  it("can reclaim an interrupted attempt within the existing retry budget", async () => {
    const retryCutoff = new Date(NOW.getTime() - 15 * 60_000);
    await markRetryOrderNotificationClaimed({
      ...CLAIM,
      to: "customer@example.test",
      claimTime: NOW,
      retryCutoff,
    });
    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0];
    expect(filter["notificationLock.lockedBy"]).toBe(CLAIM.lockOwner);
    expect(filter.$or).toContainEqual({ pieceCheckout: null });
    expect(filter.notificationLog.$elemMatch).toMatchObject({
      $or: [
        {
          status: "FAILED",
          retryable: { $ne: false },
          $or: [
            { deliveryVersion: 1 },
            { error: /^connect ECONNREFUSED 127\.0\.0\.1:1025$/i },
          ],
        },
        { status: "PROCESSING", deliveryVersion: 1, providerStartedAt: null },
      ],
      attempt: { $lt: 3 },
      sentAt: { $lte: retryCutoff },
    });
    expect(update.$set["notificationLog.$[entry].status"]).toBe("PROCESSING");
    expect(update.$inc["notificationLog.$[entry].attempt"]).toBe(1);
  });

  it("renews only a still-live owner and reports a lost lease", async () => {
    await expect(
      renewOrderNotificationLock({ ...CLAIM, now: NOW }),
    ).resolves.toBe(true);
    expect(mocks.updateOne.mock.calls[0][0]).toMatchObject({
      isPaid: true,
      status: "processed_order",
      $or: expect.any(Array),
      "notificationLock.lockedBy": CLAIM.lockOwner,
      "notificationLock.lockedUntil": { $gt: NOW },
    });
    mocks.updateOne.mockReturnValue(
      query({ matchedCount: 0, modifiedCount: 0 }),
    );
    await expect(
      renewOrderNotificationLock({ ...CLAIM, now: NOW }),
    ).resolves.toBe(false);
  });

  it("fences success, failure, exhaustion and release against a replaced worker", async () => {
    await markOrderNotificationSent({ ...CLAIM, providerMessageId: "smtp-1" });
    await markOrderNotificationFailed({
      ...CLAIM,
      errorMessage: "SMTP failed",
    });
    await markOrderNotificationExhausted(CLAIM);
    await releaseOrderNotificationLock(CLAIM);
    for (const [filter] of mocks.updateOne.mock.calls) {
      expect(filter).toMatchObject({
        _id: CLAIM.orderId,
        "notificationLock.lockedBy": CLAIM.lockOwner,
      });
    }
    expect(mocks.updateOne.mock.calls[0][1].$set).toMatchObject({
      "notificationLog.$[entry].status": "SENT",
      "notificationLog.$[entry].providerMessageId": "smtp-1",
    });
  });

  it("loads paid unrefunded piece orders for their dedicated payment confirmation", async () => {
    await expect(findOrderForNotification(CLAIM.orderId)).resolves.toBeNull();
    expect(mocks.findOne).toHaveBeenCalledWith({
      _id: CLAIM.orderId,
      $or: [
        { pieceCheckout: null },
        {
          "pieceCheckout.state": "paid",
          "pieceCheckout.refundedAmountMinor": { $in: [null, 0] },
        },
      ],
    });
  });

  it("persists provider submission under the exact current claim before sending", async () => {
    await expect(
      markOrderNotificationProviderStarted({ ...CLAIM, now: NOW }),
    ).resolves.toBe(true);
    const [filter, update, options] = mocks.updateOne.mock.calls[0];
    expect(filter.notificationLog.$elemMatch).toMatchObject({
      claimId: CLAIM.claimId,
      status: "PROCESSING",
      providerStartedAt: null,
    });
    expect(update.$set["notificationLog.$[entry].providerStartedAt"]).toEqual(
      NOW,
    );
    expect(options.arrayFilters[0]).toMatchObject({
      "entry.claimId": CLAIM.claimId,
      "entry.status": { $in: ["PROCESSING"] },
    });
  });

  it("never overwrites a webhook-finalized send when marking an outcome ambiguous", async () => {
    await markOrderNotificationAmbiguous({ ...CLAIM, errorMessage: "timeout" });
    const [, update, options] = mocks.updateOne.mock.calls[0];
    expect(update.$set["notificationLog.$[entry].status"]).toBe("AMBIGUOUS");
    expect(options.arrayFilters[0]).toMatchObject({
      "entry.claimId": CLAIM.claimId,
      "entry.status": { $in: ["PROCESSING", "FAILED"] },
    });
  });

  it("only the first exhaustion transition can trigger an admin alert", async () => {
    await expect(markOrderNotificationExhausted(CLAIM)).resolves.toBe(true);
    expect(
      mocks.updateOne.mock.calls[0][0].notificationLog.$elemMatch,
    ).toMatchObject({
      provider: { $ne: "exhausted" },
      status: { $in: ["FAILED", "PROCESSING"] },
    });
    expect(mocks.updateOne.mock.calls[0][1].$set).toMatchObject({
      "notificationLog.$[entry].status": "FAILED",
      "notificationLog.$[entry].provider": "exhausted",
    });
    mocks.updateOne.mockReturnValue(
      query({ matchedCount: 0, modifiedCount: 0 }),
    );
    await expect(markOrderNotificationExhausted(CLAIM)).resolves.toBe(false);
  });
});
