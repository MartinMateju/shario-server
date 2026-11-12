import { randomUUID } from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { POSTMARK_PROVISIONING_TOKEN_HEADER } from "@/infrastructure/email/postmark-webhook-provisioning.js";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import {
  CommunicationDeliveryModel,
  CommunicationMessageModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import postmarkOutboundWebhookRouter from "@/modules/communications/routes/postmark-outbound-webhook.routes.js";
import type { PostmarkOutboundWebhookPayload } from "@/modules/communications/postmark-outbound-webhook.validators.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import { registeredSenderEmailRepository } from "@/modules/registered-sender-email/registered-sender-email.repository.js";
import { registeredSenderEmailService } from "@/modules/registered-sender-email/services/registered-sender-email.service.js";
import { encryptSecret } from "@/shared/security/encryption.js";

const webhookPath = "/webhooks/postmark/outbound";
const username = "integration-webhook-user";
const password = "integration-webhook-password-at-least-32-characters";
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const boundServerId = 81001;
// Deliberately differs from the persisted tenant Server. These are synthetic
// events, not a claim about the exact sample values used by Postmark.
const sampleServerId = 23;

const probes: PostmarkOutboundWebhookPayload[] = [
  {
    RecordType: "Delivery",
    MessageID: "synthetic-delivery",
    MessageStream: "outbound",
    ServerID: sampleServerId,
    Recipient: "sample@example.com",
    DeliveredAt: "2026-10-06T09:55:00.000Z",
  },
  {
    RecordType: "Bounce",
    MessageID: "synthetic-bounce",
    MessageStream: "outbound",
    ServerID: sampleServerId,
    ID: 101,
    Type: "HardBounce",
    TypeCode: 1,
    Email: "sample@example.com",
    BouncedAt: "2026-10-06T09:55:00.000Z",
  },
  {
    RecordType: "SpamComplaint",
    MessageID: "synthetic-complaint",
    MessageStream: "outbound",
    ServerID: sampleServerId,
    ID: 102,
    Email: "sample@example.com",
    BouncedAt: "2026-10-06T09:55:00.000Z",
  },
];

const app = express();
app.use(webhookPath, postmarkOutboundWebhookRouter);
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ code: "UNEXPECTED_TEST_ERROR", message: error.message });
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe.sequential("Postmark provisioning with persisted attempt correlation", () => {
  let mongo: MongoMemoryServer;
  const fetchMock = vi.fn();
  const models = [
    RegisteredSenderEmailModel,
    CommunicationDeliveryModel,
    CommunicationMessageModel,
    CommunicationSuppressionModel,
    CommunicationEmailLogModel,
  ];

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    await RegisteredSenderEmailModel.syncIndexes();
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    vi.stubEnv("EMAIL_SECRET_KEY", "integration-encryption-secret");
    vi.stubEnv("COMMUNICATION_SECRET_KEY", "integration-encryption-secret");
    vi.stubEnv("POSTMARK_API_URL", "https://postmark.integration.invalid");
    vi.stubEnv("POSTMARK_FROM_DOMAIN", "notify.shario.io");
    vi.stubEnv("POSTMARK_MESSAGE_STREAM", "outbound");
    vi.stubEnv("POSTMARK_OUTBOUND_WEBHOOK_URL", `https://api.integration.invalid${webhookPath}`);
    vi.stubEnv("POSTMARK_OUTBOUND_WEBHOOK_USERNAME", username);
    vi.stubEnv("POSTMARK_OUTBOUND_WEBHOOK_PASSWORD", password);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => {
      throw new Error("Unexpected provider request: network access is disabled in this test.");
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  const createFailedSender = () => RegisteredSenderEmailModel.create({
    tenant: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    email: "studio-integration@notify.shario.io",
    displayName: "Integration studio",
    provider: "postmark_managed",
    providerServerId: boundServerId,
    encryptedPostmarkServerToken: encryptSecret("integration-server-token"),
    providerProvisioningStatus: "error",
    providerProvisioningErrorCode: "POSTMARK_1364",
    providerProvisionedAt: null,
    isActive: true,
    replyToEmail: "owner@example.com",
    replyToVerifiedAt: new Date(),
  });

  const postProbe = (attemptId: string, metadata?: Record<string, string>) =>
    request(app)
      .post(webhookPath)
      .set("Authorization", authorization)
      .set(POSTMARK_PROVISIONING_TOKEN_HEADER, attemptId)
      .send({ ...probes[0], ...(metadata ? { Metadata: metadata } : {}) });

  const expectNoEmailSideEffects = async () => {
    const counts = await Promise.all([
      CommunicationDeliveryModel.countDocuments(),
      CommunicationMessageModel.countDocuments(),
      CommunicationSuppressionModel.countDocuments(),
      CommunicationEmailLogModel.countDocuments(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0]);
    const stored = await RegisteredSenderEmailModel.findOne()
      .select("+managedTestCorrelations +lastTestProviderMessageId")
      .lean();
    expect(stored?.lastTestStatus).toBe("untested");
    expect(stored?.lastTestProviderMessageId).toBe("");
    expect(stored?.managedTestCorrelations).toEqual([]);
  };

  it.each([
    { forwardAttemptHeader: true, statusShape: "aggregate", existingWebhook: false },
    { forwardAttemptHeader: false, statusShape: "aggregate", existingWebhook: false },
    { forwardAttemptHeader: true, statusShape: "per-trigger", existingWebhook: false },
    { forwardAttemptHeader: true, statusShape: "per-trigger", existingWebhook: true },
    { forwardAttemptHeader: false, statusShape: "per-trigger", existingWebhook: true },
  ])(
    "completes setup only when callbacks pass ($statusShape, existing: $existingWebhook, header: $forwardAttemptHeader)",
    async ({ forwardAttemptHeader, statusShape, existingWebhook }) => {
      const sender = await createFailedSender();
      const observedStates: unknown[] = [];
      const callbackStatuses: number[] = [];
      let configuredAttemptId = "";

      fetchMock.mockImplementation(async (input: string, init: RequestInit) => {
        const url = new URL(input);
        if (url.origin !== "https://postmark.integration.invalid") {
          throw new Error("Unexpected provider origin.");
        }
        if (init.method === "GET" && url.pathname === "/webhooks") {
          return jsonResponse({ Webhooks: existingWebhook ? [{
            ID: 90001,
            Url: `https://api.integration.invalid${webhookPath}`,
            MessageStream: "outbound",
          }] : [] });
        }
        if (init.method !== (existingWebhook ? "PUT" : "POST") ||
            url.pathname !== (existingWebhook ? "/webhooks/90001" : "/webhooks")) {
          throw new Error("Only webhook configuration is permitted; email dispatch is forbidden.");
        }
        const body = JSON.parse(String(init.body));
        configuredAttemptId = body.HttpHeaders.find(
          (header: { Name: string }) => header.Name === POSTMARK_PROVISIONING_TOKEN_HEADER,
        ).Value;
        const providerAuthorization = `Basic ${Buffer.from(
          `${body.HttpAuth.Username}:${body.HttpAuth.Password}`,
        ).toString("base64")}`;
        for (const probe of probes) {
          observedStates.push(await RegisteredSenderEmailModel.findById(sender._id)
            .select("providerProvisioningStatus providerProvisionedAt +providerProvisioningAttemptId")
            .lean());
          let callback = request(app).post(new URL(body.Url).pathname)
            .set("Authorization", providerAuthorization);
          if (forwardAttemptHeader) {
            for (const header of body.HttpHeaders) callback = callback.set(header.Name, header.Value);
          }
          callbackStatuses.push((await callback.send(probe)).status);
        }
        const verified = callbackStatuses.every((status) => status === 200);
        return verified
          ? jsonResponse(statusShape === "aggregate"
            ? { ID: 90001, Status: "verified" }
            : {
              ID: 90001,
              Url: body.Url,
              MessageStream: "outbound",
              Triggers: {
                ...body.Triggers,
                Delivery: { Enabled: true, Status: "verified" },
                Bounce: { Enabled: true, IncludeContent: false, Status: "verified" },
                SpamComplaint: { Enabled: true, IncludeContent: false, Status: "verified" },
              },
            })
          : jsonResponse({
            ErrorCode: 1364,
            Message: "Webhook verification failed.",
            Results: probes.map((probe, index) => ({
              TriggerType: probe.RecordType,
              Success: callbackStatuses[index] === 200,
              StatusCode: callbackStatuses[index],
            })),
          }, 422);
      });

      const setup = registeredSenderEmailService.update(
        String(sender.tenant), String(sender._id), { displayName: "Updated studio" },
      );
      if (forwardAttemptHeader) {
        await expect(setup).resolves.toMatchObject({ providerProvisioningStatus: "ready" });
      } else {
        await expect(setup).rejects.toMatchObject({ code: "POSTMARK_1364" });
      }
      expect(configuredAttemptId).toMatch(/^[0-9a-f-]{36}$/);
      expect(callbackStatuses).toEqual(Array(3).fill(forwardAttemptHeader ? 200 : 503));
      expect(observedStates).toHaveLength(3);
      for (const state of observedStates) expect(state).toMatchObject({
        providerProvisioningStatus: "pending",
        providerProvisionedAt: null,
        providerProvisioningAttemptId: configuredAttemptId,
      });
      const stored = await RegisteredSenderEmailModel.findById(sender._id)
        .select("+providerProvisioningAttemptId").lean();
      expect(stored?.providerProvisioningStatus).toBe(forwardAttemptHeader ? "ready" : "error");
      expect(stored?.providerProvisioningAttemptId).toBe("");
      expect(stored?.providerProvisionedAt !== null).toBe(forwardAttemptHeader);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
        "/webhooks", existingWebhook ? "/webhooks/90001" : "/webhooks",
      ]);
      await expectNoEmailSideEffects();
      // Postmark keeps its header, but successful or failed setup clears the
      // persisted attempt so replay cannot acknowledge an unmatched real event.
      expect((await postProbe(configuredAttemptId)).status).toBe(503);
    },
  );

  it.each(["expired", "superseded", "completed", "failed"] as const)(
    "rejects an otherwise valid callback for a %s attempt",
    async (state) => {
      const sender = await createFailedSender();
      const attempt = {
        id: randomUUID(),
        at: new Date(Date.now() - (state === "expired" ? 6 * 60_000 : 0)),
      };
      const pending = await registeredSenderEmailRepository.beginPostmarkProvisioning(sender, attempt);
      expect(pending).not.toBeNull();
      if (state === "superseded") {
        await registeredSenderEmailRepository.beginPostmarkProvisioning(pending!, { id: randomUUID(), at: new Date() });
      } else if (state === "completed") {
        await registeredSenderEmailRepository.markPostmarkServerReady(pending!, attempt.id);
      } else if (state === "failed") {
        await registeredSenderEmailRepository.markProvisioningFailure(
          String(sender.tenant), String(sender._id), attempt.id,
          { code: "POSTMARK_1364", message: "Test failure", attemptedAt: attempt.at },
        );
      }
      const response = await postProbe(attempt.id);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("POSTMARK_MESSAGE_NOT_READY");
      expect(fetchMock).not.toHaveBeenCalled();
      await expectNoEmailSideEffects();
    },
  );

  it("preserves retry semantics for a real message even with the current attempt header", async () => {
    const sender = await createFailedSender();
    const attempt = { id: randomUUID(), at: new Date() };
    await registeredSenderEmailRepository.beginPostmarkProvisioning(sender, attempt);
    const response = await postProbe(attempt.id, {
      tenantId: String(sender.tenant),
      managedSenderId: String(sender._id),
    });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("POSTMARK_MESSAGE_NOT_READY");
    // The exact same active attempt accepts a metadata-free synthetic probe.
    expect((await postProbe(attempt.id)).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    await expectNoEmailSideEffects();
  });
});
