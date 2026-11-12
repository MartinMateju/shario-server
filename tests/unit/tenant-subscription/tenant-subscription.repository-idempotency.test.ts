import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  eventReclaim: vi.fn(),
  deliveryUpsert: vi.fn(),
  deliveryUpdate: vi.fn(),
}));
vi.mock("@/modules/tenant-subscription/tenant-subscription.webhook-event.schema.js", () => ({
  default: { create: models.eventCreate, findOneAndUpdate: models.eventReclaim },
  STRIPE_WEBHOOK_EVENT_STATUS: { PROCESSING: "processing", PROCESSED: "processed", FAILED: "failed" },
}));
vi.mock("@/modules/tenant-subscription/tenant-subscription.email.schema.js", () => ({
  default: { findOneAndUpdate: models.deliveryUpsert, updateOne: models.deliveryUpdate },
}));

import { claimStripeWebhookEvent } from "@/modules/tenant-subscription/tenant-subscription.webhook-event.repository.js";
import { enqueueTenantBillingEmailDelivery } from "@/modules/tenant-subscription/tenant-subscription.email.repository.js";

const event = { eventId: "evt_repeat", type: "invoice.paid", stripeCreatedAt: 1_700_000_000 };
const delivery = {
  deliveryKey: "tenant:invoice:recovered",
  tenantId: "100000000000000000000001",
  type: "payment_recovered" as const,
  priority: 10,
  recipient: "owner@studio.test",
  locale: "en" as const,
  payload: { recipientName: "Owner", tenantName: "Studio", billingUrl: "https://studio.test/billing", timezone: "UTC" },
};
const duplicates = [
  ["Mongoose driver", new mongoose.mongo.MongoServerError({ code: 11000, message: "duplicate key" })],
  ["another driver", { name: "MongoServerError", code: 11000 }],
] as const;
const unrelated = [new Error("offline"), { code: 11001 }, { code: "11000" }, null];

beforeEach(() => {
  vi.resetAllMocks();
  models.eventReclaim.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
});

describe("subscription webhook duplicate recovery", () => {
  it("claims a newly persisted event once", async () => {
    models.eventCreate.mockResolvedValue({});
    expect(await claimStripeWebhookEvent(event)).toBe(true);
    expect(models.eventReclaim).not.toHaveBeenCalled();
  });

  it.each(duplicates)("leaves completed or actively leased duplicate events unclaimed (%s)", async (_label, error) => {
    models.eventCreate.mockRejectedValueOnce(error);
    expect(await claimStripeWebhookEvent(event)).toBe(false);
    const [filter, update] = models.eventReclaim.mock.calls[0];
    expect(filter).toEqual({
      eventId: event.eventId,
      $or: [
        { status: "failed" },
        { status: "processing", updatedAt: { $lt: expect.any(Date) } },
      ],
    });
    expect(update.$inc).toEqual({ attempts: 1 });
    expect(models.eventCreate).toHaveBeenCalledOnce();
  });

  it("allows a failed or expired lease to be reclaimed through its existing event identity", async () => {
    models.eventCreate.mockRejectedValueOnce(duplicates[0][1]);
    models.eventReclaim.mockReturnValueOnce({ exec: vi.fn().mockResolvedValue({ eventId: event.eventId }) });
    expect(await claimStripeWebhookEvent(event)).toBe(true);
    expect(models.eventReclaim.mock.calls[0][0].eventId).toBe(event.eventId);
  });

  it.each(unrelated)("rethrows non-duplicate event creation failures: %j", async (error) => {
    models.eventCreate.mockRejectedValueOnce(error);
    await expect(claimStripeWebhookEvent(event)).rejects.toBe(error);
    expect(models.eventReclaim).not.toHaveBeenCalled();
  });
});

describe("subscription billing email duplicate recovery", () => {
  it.each(duplicates)("does not enqueue or reset another delivery after a duplicate from %s", async (_label, error) => {
    models.deliveryUpsert.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(error) });
    await expect(enqueueTenantBillingEmailDelivery(delivery)).resolves.toBeUndefined();
    expect(models.deliveryUpsert).toHaveBeenCalledOnce();
    expect(models.deliveryUpsert.mock.calls[0][0]).toEqual({ deliveryKey: delivery.deliveryKey });
    expect(models.deliveryUpdate).not.toHaveBeenCalled();
  });

  it.each(unrelated)("rethrows non-duplicate delivery persistence failures: %j", async (error) => {
    models.deliveryUpsert.mockReturnValueOnce({ exec: vi.fn().mockRejectedValue(error) });
    await expect(enqueueTenantBillingEmailDelivery(delivery)).rejects.toBe(error);
    expect(models.deliveryUpdate).not.toHaveBeenCalled();
  });
});
