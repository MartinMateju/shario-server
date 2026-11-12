import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Only unrelated catalog/cart dependencies are stubbed. Order uses its real
// schema and every repository claim/update executes against MongoDB.
vi.mock("@/modules/product/product.model.js", () => ({ default: {} }));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/cart/cart.repository.js", () => ({
  createCartRepository: vi.fn(),
}));

import { Order } from "@/modules/order/order.model.js";
import {
  acquireOrderNotificationLock,
  findOrderNotificationCandidates,
  markFirstOrderNotificationClaimed,
  markOrderNotificationAmbiguous,
  markOrderNotificationFailed,
  markOrderNotificationProviderStarted,
  markRetryOrderNotificationClaimed,
} from "@/modules/order/order.repository.js";

let mongo: MongoMemoryServer;
const now = new Date("2026-10-19T12:00:00Z");
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), {
    autoIndex: false,
    autoCreate: false,
  });
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it("fences paid piece confirmation candidates, concurrent claims, provider submission and late outcomes in real MongoDB", async () => {
  const tenant = new mongoose.Types.ObjectId();
  const makeOrder = (
    method: "card" | "credits",
    overrides: Record<string, any> = {},
  ) => ({
    _id: new mongoose.Types.ObjectId(),
    tenant,
    createdBy: new mongoose.Types.ObjectId(),
    isPaid: true,
    status: "processed_order",
    legacyOrder: false,
    paidAt: now,
    notificationLog: [],
    pieceCheckout: { method, state: "paid", refundedAmountMinor: 0 },
    ...overrides,
  });
  const card = makeOrder("card");
  const credits = makeOrder("credits");
  const unpaid = makeOrder("card", { isPaid: false });
  const refunded = makeOrder("credits", {
    pieceCheckout: {
      method: "credits",
      state: "refunded",
      refundedAmountMinor: 100,
    },
  });
  const partialRefund = makeOrder("card", {
    pieceCheckout: { method: "card", state: "paid", refundedAmountMinor: 1 },
  });
  const pending = makeOrder("credits", {
    pieceCheckout: {
      method: "credits",
      state: "pending",
      refundedAmountMinor: 0,
    },
  });
  await Order.collection.insertMany([
    card,
    credits,
    unpaid,
    refunded,
    partialRefund,
    pending,
  ]);
  const ids = (await findOrderNotificationCandidates(now)).map((row) =>
    String(row._id),
  );
  expect(new Set(ids)).toEqual(
    new Set([String(card._id), String(credits._id)]),
  );
  for (const order of [unpaid, refunded, partialRefund, pending]) {
    expect(
      await acquireOrderNotificationLock({
        orderId: order._id,
        lockOwner: "ineligible",
        now,
      }),
    ).toBeNull();
  }

  // Multiple hosts racing the lease and then the first event each get one winner.
  const owners = Array.from({ length: 8 }, (_, index) => `worker-${index}`);
  const locks = await Promise.all(
    owners.map((lockOwner) =>
      acquireOrderNotificationLock({ orderId: card._id, lockOwner, now }),
    ),
  );
  expect(locks.filter(Boolean)).toHaveLength(1);
  const lockOwner = owners[locks.findIndex(Boolean)];
  const claimIds = Array.from({ length: 8 }, (_, index) => `claim-${index}`);
  const claims = await Promise.all(
    claimIds.map((claimId) =>
      markFirstOrderNotificationClaimed({
        orderId: card._id,
        lockOwner,
        claimId,
        to: "buyer@example.test",
        claimTime: now,
      }),
    ),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claimId = claimIds[claims.findIndex(Boolean)];
  const claim = { orderId: card._id, lockOwner, claimId };
  const beforeStart = await Order.collection.findOne({ _id: card._id });
  expect(beforeStart!.notificationLog).toHaveLength(1);
  expect(beforeStart!.notificationLog[0]).toMatchObject({
    claimId,
    status: "PROCESSING",
    deliveryVersion: 1,
    attempt: 1,
    providerStartedAt: null,
  });

  expect(
    await markOrderNotificationProviderStarted({
      ...claim,
      claimId: "superseded-claim",
      now,
    }),
  ).toBe(false);
  expect(
    await markOrderNotificationProviderStarted({
      ...claim,
      lockOwner: "other-worker",
      now,
    }),
  ).toBe(false);
  const starts = await Promise.all(
    Array.from({ length: 8 }, () =>
      markOrderNotificationProviderStarted({ ...claim, now }),
    ),
  );
  expect(starts.filter(Boolean)).toHaveLength(1);
  const started = await Order.collection.findOne({ _id: card._id });
  expect(started!.notificationLog[0]).toMatchObject({
    claimId,
    provider: "postmark",
    providerStartedAt: now,
  });

  // A signed provider webhook may finalize before the worker receives its reply.
  await Order.collection.updateOne(
    { _id: card._id, "notificationLog.claimId": claimId },
    {
      $set: {
        "notificationLog.0.status": "SENT",
        "notificationLog.0.providerMessageId": "provider-accepted-1",
      },
    },
  );
  await markOrderNotificationFailed({
    ...claim,
    errorMessage: "late socket error",
  });
  await markOrderNotificationAmbiguous({
    ...claim,
    errorMessage: "late response timeout",
  });
  const finalized = await Order.collection.findOne({ _id: card._id });
  expect(finalized!.notificationLog[0]).toMatchObject({
    status: "SENT",
    providerMessageId: "provider-accepted-1",
    providerStartedAt: now,
  });

  // A refund after a claim but before any provider call invalidates submission.
  const creditClaim = {
    orderId: credits._id,
    lockOwner: "credit-worker",
    claimId: "credit-claim",
  };
  expect(
    await acquireOrderNotificationLock({ ...creditClaim, now }),
  ).not.toBeNull();
  expect(
    await markFirstOrderNotificationClaimed({
      ...creditClaim,
      to: "credit-buyer@example.test",
      claimTime: now,
    }),
  ).not.toBeNull();
  await Order.collection.updateOne(
    { _id: credits._id },
    { $set: { "pieceCheckout.refundedAmountMinor": 1 } },
  );
  expect(
    await markOrderNotificationProviderStarted({ ...creditClaim, now }),
  ).toBe(false);
  expect(
    (await Order.collection.findOne({ _id: credits._id }))!.notificationLog[0]
      .providerStartedAt,
  ).toBeNull();

  // Model provider acceptance followed by a failed DB finalization: the durable
  // started marker remains PROCESSING. A new lease must not grant another send.
  const interrupted = makeOrder("credits");
  await Order.collection.insertOne(interrupted);
  const oldClaim = {
    orderId: interrupted._id,
    lockOwner: "old-worker",
    claimId: "accepted-but-unfinalized",
  };
  await acquireOrderNotificationLock({ ...oldClaim, now });
  await markFirstOrderNotificationClaimed({
    ...oldClaim,
    to: "other@example.test",
    claimTime: now,
  });
  expect(await markOrderNotificationProviderStarted({ ...oldClaim, now })).toBe(
    true,
  );
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  expect(
    (await findOrderNotificationCandidates(later)).map((row) =>
      String(row._id),
    ),
  ).toContain(String(interrupted._id));
  const replacement = {
    orderId: interrupted._id,
    lockOwner: "replacement-worker",
    claimId: "must-not-send",
  };
  expect(
    await acquireOrderNotificationLock({ ...replacement, now: later }),
  ).not.toBeNull();
  expect(
    await markRetryOrderNotificationClaimed({
      ...replacement,
      to: "other@example.test",
      claimTime: later,
      retryCutoff: new Date(later.getTime() - 15 * 60 * 1000),
    }),
  ).toBeNull();
  const stale = await Order.collection.findOne({ _id: interrupted._id });
  expect(stale!.notificationLog[0]).toMatchObject({
    status: "PROCESSING",
    claimId: oldClaim.claimId,
    providerStartedAt: now,
    attempt: 1,
  });

  // Exercise array-filter casting through the real schema. Versioned definite
  // failures and the exact old loopback refusal are safe; an unversioned
  // timeout does not establish whether the provider accepted the message.
  const retryCases = [
    {
      name: "versioned-definite-failure",
      deliveryVersion: 1,
      error: "Provider explicitly rejected request: rate limited",
      allowed: true,
    },
    {
      name: "legacy-loopback-refusal",
      error: "connect ECONNREFUSED 127.0.0.1:1025",
      allowed: true,
    },
    {
      name: "legacy-uncertain-timeout",
      error: "socket timeout after DATA",
      allowed: false,
    },
  ];
  for (const retryCase of retryCases) {
    const previousEvent = {
      type: "order_confirm",
      status: "FAILED",
      attempt: 1,
      sentAt: new Date(now.getTime() - 30 * 60 * 1000),
      to: "retry@example.test",
      error: retryCase.error,
      retryable: true,
      providerStartedAt: null,
      ...(retryCase.deliveryVersion ? { deliveryVersion: retryCase.deliveryVersion } : {}),
    };
    const retryOrder = makeOrder("credits", { notificationLog: [previousEvent] });
    await Order.collection.insertOne(retryOrder);
    const retryClaim = {
      orderId: retryOrder._id,
      lockOwner: `${retryCase.name}-worker`,
      claimId: `${retryCase.name}-claim`,
    };
    expect(await acquireOrderNotificationLock({ ...retryClaim, now })).not.toBeNull();
    const retried = await markRetryOrderNotificationClaimed({
      ...retryClaim,
      to: "retry@example.test",
      claimTime: now,
      retryCutoff: new Date(now.getTime() - 15 * 60 * 1000),
    });
    const stored = await Order.collection.findOne({ _id: retryOrder._id });
    if (retryCase.allowed) {
      expect(retried, retryCase.name).not.toBeNull();
      expect(stored!.notificationLog).toHaveLength(1);
      expect(stored!.notificationLog[0]).toMatchObject({
        status: "PROCESSING", attempt: 2, claimId: retryClaim.claimId,
        deliveryVersion: 1, providerStartedAt: null, retryable: true,
        sentAt: now, error: "",
      });
    } else {
      expect(retried, retryCase.name).toBeNull();
      expect(stored!.notificationLog).toEqual([previousEvent]);
    }
  }
});
