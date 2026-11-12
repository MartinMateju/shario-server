import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Order } from "@/modules/order/order.model.js";
import {
  findOrderReceiptForPostmarkEvent,
  transitionOrderReceiptFromPostmark,
} from "@/modules/communications/services/order-receipt-webhook.service.js";
import type { PostmarkOutboundTransition } from "@/modules/communications/services/postmark-outbound-webhook.core.js";

const ORDER_ID = new mongoose.Types.ObjectId();
const TENANT_ID = new mongoose.Types.ObjectId();
const STARTED_AT = new Date("2026-10-19T12:00:00Z");
const DELIVERED_AT = new Date("2026-10-19T12:00:10Z");
const CLAIM_ID = "receipt-attempt-1";
const MESSAGE_ID = "postmark-receipt-message";
const event = {
  RecordType: "Delivery" as const,
  MessageID: MESSAGE_ID,
  Recipient: "customer@example.com",
  DeliveredAt: DELIVERED_AT.toISOString(),
  ServerID: 23,
  MessageStream: "outbound",
  Metadata: {
    orderId: String(ORDER_ID),
    tenantId: String(TENANT_ID),
    deliveryId: CLAIM_ID,
  },
};
const transition = (
  status: PostmarkOutboundTransition["status"],
): PostmarkOutboundTransition => ({
  status,
  at: DELIVERED_AT,
  eventKey: `${status}:event-1`,
  providerEventId: "event-1",
  code: status === "delivered" ? "" : "POSTMARK_HARD_BOUNCE",
  reason: status === "delivered" ? "Delivered" : "Mailbox rejected the message",
  permanent: status !== "delivered",
});
const receipt = (overrides: Record<string, unknown> = {}) => ({
  type: "order_confirm",
  status: "AMBIGUOUS",
  to: event.Recipient,
  sentAt: STARTED_AT,
  provider: "postmark",
  providerMessageId: "",
  claimId: CLAIM_ID,
  deliveryVersion: 1,
  providerStartedAt: STARTED_AT,
  providerDeliveryStatus: "",
  providerStatusAt: null,
  deliveredAt: null,
  attempt: 1,
  error: "Provider outcome is unknown",
  ...overrides,
});
const otherNotification = {
  type: "course_confirm",
  status: "FAILED",
  to: "other@example.com",
  claimId: "other-claim",
  error: "Unrelated failure",
};
const insertOrder = async (overrides: Record<string, unknown> = {}) => {
  await Order.collection.insertOne({
    _id: ORDER_ID,
    tenant: TENANT_ID,
    isPaid: true,
    status: "processed_order",
    notificationLog: [receipt(overrides), otherNotification],
  } as never);
};
const readOrder = () => Order.collection.findOne({ _id: ORDER_ID });

describe("order receipt Postmark webhook persistence", () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
  });
  beforeEach(async () => {
    await Order.collection.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it.each(["PROCESSING", "AMBIGUOUS"])(
    "recovers a %s attempt whose accepted MessageID was never persisted",
    async (status) => {
      await insertOrder({ status });

      const reference = await findOrderReceiptForPostmarkEvent(event);
      expect(reference).toMatchObject({
        id: ORDER_ID,
        tenantId: TENANT_ID,
        recipientEmail: event.Recipient,
        claimId: CLAIM_ID,
        providerStartedAt: STARTED_AT,
        providerMessageId: MESSAGE_ID,
      });
      expect(
        await transitionOrderReceiptFromPostmark(
          reference!,
          transition("delivered"),
        ),
      ).toBe(true);

      const saved = await readOrder();
      expect(saved?.notificationLog[0]).toMatchObject({
        status: "SENT",
        providerMessageId: MESSAGE_ID,
        providerDeliveryStatus: "delivered",
        providerStatusAt: DELIVERED_AT,
        deliveredAt: DELIVERED_AT,
        claimId: CLAIM_ID,
        attempt: 1,
        error: "",
      });
      expect(saved?.notificationLog[1]).toEqual(otherNotification);
      expect(saved).toMatchObject({ isPaid: true, status: "processed_order" });
    },
  );

  it("uses the persisted provider MessageID rather than untrusted correlation metadata", async () => {
    await insertOrder({ status: "SENT", providerMessageId: MESSAGE_ID });
    const reference = await findOrderReceiptForPostmarkEvent({
      ...event,
      Metadata: { orderId: "wrong", tenantId: "wrong", deliveryId: "wrong" },
    });

    expect(reference).toMatchObject({
      id: ORDER_ID,
      tenantId: TENANT_ID,
      claimId: CLAIM_ID,
    });
    expect(
      await transitionOrderReceiptFromPostmark(
        reference!,
        transition("delivered"),
      ),
    ).toBe(true);
  });

  it("makes duplicates idempotent and never lets late delivery undo bounce or complaint", async () => {
    await insertOrder();
    const reference = (await findOrderReceiptForPostmarkEvent(event))!;
    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("delivered"),
      ),
    ).toBe(true);
    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("delivered"),
      ),
    ).toBe(false);
    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("bounced"),
      ),
    ).toBe(true);
    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("delivered"),
      ),
    ).toBe(false);
    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("complained"),
      ),
    ).toBe(true);
    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("bounced"),
      ),
    ).toBe(false);
    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("complained"),
      ),
    ).toBe(false);

    expect((await readOrder())?.notificationLog[0]).toMatchObject({
      status: "SENT",
      providerDeliveryStatus: "complained",
      deliveredAt: DELIVERED_AT,
      error: "Mailbox rejected the message",
    });
  });

  it("cannot update a newer attempt after correlation was read", async () => {
    await insertOrder();
    const reference = (await findOrderReceiptForPostmarkEvent(event))!;
    await Order.collection.updateOne(
      { _id: ORDER_ID },
      {
        $set: {
          "notificationLog.0.claimId": "receipt-attempt-2",
          "notificationLog.0.status": "PROCESSING",
          "notificationLog.0.providerStartedAt": new Date(
            "2026-10-19T12:01:00Z",
          ),
        },
      },
    );

    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("delivered"),
      ),
    ).toBe(false);
    expect((await readOrder())?.notificationLog[0]).toMatchObject({
      claimId: "receipt-attempt-2",
      status: "PROCESSING",
      providerMessageId: "",
    });
  });

  it("cannot replace a different provider MessageID written after correlation", async () => {
    await insertOrder();
    const reference = (await findOrderReceiptForPostmarkEvent(event))!;
    await Order.collection.updateOne(
      { _id: ORDER_ID },
      {
        $set: { "notificationLog.0.providerMessageId": "another-message" },
      },
    );

    expect(
      await transitionOrderReceiptFromPostmark(
        reference,
        transition("delivered"),
      ),
    ).toBe(false);
    expect((await readOrder())?.notificationLog[0].providerMessageId).toBe(
      "another-message",
    );
  });

  it.each([
    { tenantId: String(new mongoose.Types.ObjectId()) },
    { orderId: String(new mongoose.Types.ObjectId()) },
    { deliveryId: "earlier-attempt" },
    { tenantId: "not-an-id" },
    { deliveryId: "" },
  ])("rejects mismatched or incomplete metadata %j", async (metadata) => {
    await insertOrder();

    expect(
      await findOrderReceiptForPostmarkEvent({
        ...event,
        Metadata: { ...event.Metadata, ...metadata },
      }),
    ).toBeNull();
    expect((await readOrder())?.notificationLog[0].status).toBe("AMBIGUOUS");
  });

  it.each([
    { status: "FAILED" },
    { providerStartedAt: null },
    { deliveryVersion: 0 },
    { provider: "nodemailer" },
    { providerMessageId: "different-message" },
  ])("does not recover an ineligible attempt %j", async (overrides) => {
    await insertOrder(overrides);

    expect(await findOrderReceiptForPostmarkEvent(event)).toBeNull();
  });
});
