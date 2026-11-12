import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  isProvisioningAttemptActive: vi.fn(),
}));

vi.mock(
  "@/modules/communications/services/postmark-outbound-webhook.service.js",
  () => ({
    processPostmarkOutboundWebhook: mocks.process,
    isManagedPostmarkProvisioningAttemptActive:
      mocks.isProvisioningAttemptActive,
  }),
);

import postmarkOutboundWebhookRouter from "@/modules/communications/routes/postmark-outbound-webhook.routes.js";

const username = "postmark-test-user";
const password = "postmark-test-password-at-least-32-characters";
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const provisioningHeader = "X-Shario-Postmark-Provisioning-Token";
const provisioningAttemptId = "a634445f-0875-4df0-ab82-8f184301f951";
const staleProvisioningAttemptId = "044f805f-f7f1-4486-af59-25238c1560a7";
const unmatchedResult = {
  matched: false,
  providerMessageMatched: false,
  correlationMismatch: false,
};
const payload = {
  RecordType: "Delivery",
  MessageID: "883953f4-6105-42a2-a16a-77a8eac79483",
  Recipient: "ada@example.com",
  DeliveredAt: "2026-08-10T13:28:10.273Z",
  Details: "250 accepted",
  ServerID: 23,
  MessageStream: "outbound",
};

const app = express();
app.use("/webhooks/postmark/outbound", postmarkOutboundWebhookRouter);
app.use((error: any, _request: any, response: any, _next: any) => {
  response
    .status(Number(error?.status || 500))
    .json({ error: "request failed" });
});

describe("Postmark outbound webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("POSTMARK_OUTBOUND_WEBHOOK_USERNAME", username);
    vi.stubEnv("POSTMARK_OUTBOUND_WEBHOOK_PASSWORD", password);
    vi.stubEnv("POSTMARK_MESSAGE_STREAM", "outbound");
    mocks.isProvisioningAttemptActive.mockResolvedValue(false);
    mocks.process.mockResolvedValue({
      matched: true,
      correlationMismatch: false,
      deliveryUpdated: true,
      automationLogUpdated: false,
      managedTestUpdated: false,
      suppressions: 0,
    });
  });

  it("rejects unauthenticated requests before processing", async () => {
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set(provisioningHeader, provisioningAttemptId)
      .send(payload);
    expect(response.status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
  });

  it("accepts a valid authenticated event", async () => {
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .send(payload);
    expect(response.status).toBe(200);
    expect(mocks.process).toHaveBeenCalledOnce();
    expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
  });

  it("reconciles a normal event even when its provisioning header has expired", async () => {
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .set(provisioningHeader, staleProvisioningAttemptId)
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body.deliveryUpdated).toBe(true);
    expect(mocks.process).toHaveBeenCalledWith(payload);
    expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
  });

  it("acknowledges a persisted managed-test correlation", async () => {
    mocks.process.mockResolvedValue({
      matched: true,
      correlationMismatch: false,
      deliveryUpdated: false,
      automationLogUpdated: false,
      managedTestUpdated: true,
      suppressions: 0,
    });
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .send(payload);
    expect(response.status).toBe(200);
    expect(response.body.managedTestUpdated).toBe(true);
  });

  it("rejects content-bearing or oversized JSON", async () => {
    const contentResponse = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .set(provisioningHeader, provisioningAttemptId)
      .send({ ...payload, Content: "email body" });
    expect(contentResponse.status).toBe(400);

    const oversizedResponse = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .set(provisioningHeader, provisioningAttemptId)
      .send({ ...payload, Details: "x".repeat(40_000) });
    expect(oversizedResponse.status).toBe(413);
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
  });

  it("acknowledges a reconciled order receipt without requesting another delivery", async () => {
    mocks.process.mockResolvedValue({
      matched: true,
      correlationMismatch: false,
      deliveryUpdated: false,
      automationLogUpdated: false,
      managedTestUpdated: false,
      orderReceiptUpdated: true,
      suppressions: 0,
    });
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .send({ ...payload, Metadata: { orderId: "64b000000000000000000001" } });

    expect(response.status).toBe(200);
    expect(response.body.orderReceiptUpdated).toBe(true);
    expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
  });

  it("does not treat an unmatched order receipt as a provisioning probe", async () => {
    mocks.process.mockResolvedValue(unmatchedResult);
    mocks.isProvisioningAttemptActive.mockResolvedValue(true);
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .set(provisioningHeader, provisioningAttemptId)
      .send({ ...payload, Metadata: { orderId: "64b000000000000000000001" } });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("POSTMARK_MESSAGE_NOT_READY");
    expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
  });

  it("rejects another message stream even with a valid provisioning header", async () => {
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .set(provisioningHeader, provisioningAttemptId)
      .send({ ...payload, MessageStream: "broadcast" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("POSTMARK_WEBHOOK_STREAM_MISMATCH");
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
  });

  it.each([
    ["Delivery", { ...payload, ServerID: 123456 }],
    [
      "Bounce",
      {
        RecordType: "Bounce",
        MessageID: "probe-bounce",
        MessageStream: "outbound",
        ID: 101,
        Type: "HardBounce",
        TypeCode: 1,
        ServerID: 123456,
        Email: "ada@example.com",
        BouncedAt: "2026-08-10T13:28:10.273Z",
      },
    ],
    [
      "SpamComplaint",
      {
        RecordType: "SpamComplaint",
        MessageID: "probe-spam",
        MessageStream: "outbound",
        ID: 102,
        ServerID: 123456,
        Email: "ada@example.com",
        BouncedAt: "2026-08-10T13:28:10.273Z",
      },
    ],
  ])(
    "acknowledges a %s verification probe by attempt token despite a synthetic ServerID",
    async (_recordType, probe) => {
      mocks.process.mockResolvedValue(unmatchedResult);
      mocks.isProvisioningAttemptActive.mockResolvedValue(true);

      const response = await request(app)
        .post("/webhooks/postmark/outbound")
        .set("Authorization", authorization)
        .set(provisioningHeader, provisioningAttemptId)
        .send(probe);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        ignored: true,
        code: "POSTMARK_PROVISIONING_PROBE_ACCEPTED",
      });
      expect(mocks.process).toHaveBeenCalledWith(probe);
      expect(mocks.isProvisioningAttemptActive).toHaveBeenCalledExactlyOnceWith(
        provisioningAttemptId,
      );
      expect(mocks.process.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.isProvisioningAttemptActive.mock.invocationCallOrder[0],
      );
    },
  );

  it.each([
    [{ tenantId: "tenant-1", managedSenderId: "sender-1" }],
    [{ tenantId: "tenant-1" }],
    [{ managedSenderId: "sender-1" }],
    [{ deliveryId: "delivery-1" }],
    [{ emailLogId: "email-log-1" }],
    [{ idempotencyKey: "idempotency-1" }],
    [{ messageId: "message-1" }],
    [{ automationId: "automation-1" }],
  ])(
    "keeps retry semantics for unmatched shario-correlated metadata %o",
    async (metadata) => {
      mocks.process.mockResolvedValue(unmatchedResult);
      mocks.isProvisioningAttemptActive.mockResolvedValue(true);

      const response = await request(app)
        .post("/webhooks/postmark/outbound")
        .set("Authorization", authorization)
        .set(provisioningHeader, provisioningAttemptId)
        .send({
          ...payload,
          Metadata: metadata,
        });

      expect(response.status).toBe(503);
      expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
    },
  );

  it("asks Postmark to retry when MessageID persistence loses the race", async () => {
    mocks.process.mockResolvedValue(unmatchedResult);
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .send(payload);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("POSTMARK_MESSAGE_NOT_READY");
    expect(mocks.isProvisioningAttemptActive).toHaveBeenCalledExactlyOnceWith(
      undefined,
    );
  });

  it.each([
    ["unknown", provisioningAttemptId],
    ["stale", staleProvisioningAttemptId],
  ])(
    "retries an unmatched event with an %s attempt token",
    async (_label, token) => {
      mocks.process.mockResolvedValue(unmatchedResult);

      const response = await request(app)
        .post("/webhooks/postmark/outbound")
        .set("Authorization", authorization)
        .set(provisioningHeader, token)
        .send(payload);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe("POSTMARK_MESSAGE_NOT_READY");
      expect(mocks.isProvisioningAttemptActive).toHaveBeenCalledExactlyOnceWith(
        token,
      );
    },
  );

  it("acknowledges a permanent correlation mismatch without mutation retries", async () => {
    mocks.process.mockResolvedValue({
      matched: false,
      providerMessageMatched: true,
      correlationMismatch: true,
    });
    const response = await request(app)
      .post("/webhooks/postmark/outbound")
      .set("Authorization", authorization)
      .set(provisioningHeader, provisioningAttemptId)
      .send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      ignored: true,
      code: "POSTMARK_MESSAGE_CORRELATION_MISMATCH",
    });
    expect(mocks.isProvisioningAttemptActive).not.toHaveBeenCalled();
  });
});
