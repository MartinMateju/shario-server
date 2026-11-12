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

import Booking from "@/modules/booking/booking.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import {
  createE2EBookingLifecycleRouter,
  E2E_LIFECYCLE_SCOPE as scope,
} from "../../e2e/support/e2e-booking-lifecycle.js";

const bookingId = new mongoose.Types.ObjectId();
const start = new Date("2035-01-09T11:00:00Z");
const messages: Record<string, any>[] = [];
const provider = vi.fn(async (url: string | URL, options: RequestInit) => {
  expect(String(url)).toBe("http://127.0.0.1:4100/email");
  expect(new Headers(options.headers).get("X-Postmark-Server-Token")).toBe(
    "e2e-postmark-system-server-token",
  );
  const body = JSON.parse(String(options.body));
  expect(body.To).toBe(scope.recipient);
  messages.push(body);
  return new Response(
    JSON.stringify({
      ErrorCode: 0,
      MessageID: `captured-${messages.length}`,
      Message: "OK",
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
});
const app = () => {
  const result = express();
  result.use(express.json());
  result.use("/__e2e", createE2EBookingLifecycleRouter());
  result.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ message: error.message });
    },
  );
  return result;
};
const drain = (server = app()) =>
  request(server)
    .post("/__e2e/booking-lifecycle-delivery")
    .set("x-e2e-key", "shario-e2e-local-key")
    .send({ bookingId: String(bookingId) });

describe("isolated booking lifecycle delivery control", () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri("booking-e2e-lifecycle"), {
      autoIndex: false,
    });
  }, 60_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("E2E_TEST_MODE", "true");
    vi.stubEnv("E2E_TEST_KEY", "shario-e2e-local-key");
    vi.stubEnv("POSTMARK_API_URL", "http://127.0.0.1:4100");
    vi.stubEnv(
      "POSTMARK_SYSTEM_SERVER_TOKEN",
      "e2e-postmark-system-server-token",
    );
    vi.stubEnv("POSTMARK_FROM_DOMAIN", "notify.shario.io");
    vi.stubEnv("COMMUNICATION_SECRET_KEY", "e2e-test-encryption-key");
    vi.stubGlobal("fetch", provider);
    provider.mockClear();
    messages.length = 0;
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(
      collections.map((collection) => collection.deleteMany({})),
    );
    await Tenant.collection.insertOne({
      _id: new mongoose.Types.ObjectId(scope.tenant),
      status: "active",
      planVersion: 3,
    } as any);
    await User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(scope.customer),
      tenant: new mongoose.Types.ObjectId(scope.tenant),
      email: scope.recipient,
      isAccessGranted: true,
    } as any);
    await Booking.collection.insertOne({
      _id: bookingId,
      tenant: new mongoose.Types.ObjectId(scope.tenant),
      createdBy: new mongoose.Types.ObjectId(scope.customer),
      location: new mongoose.Types.ObjectId(scope.location),
      bookingProduct: new mongoose.Types.ObjectId(scope.product),
      status: "processed",
      paymentStatus: "CONFIRMED",
      start,
    } as any);
    await CommunicationEmailLogModel.create({
      tenant: scope.tenant,
      user: scope.customer,
      relatedEntityId: bookingId,
      relatedEntityType: "booking",
      location: scope.location,
      appliesToAllLocations: false,
      recipientEmail: scope.recipient,
      emailType: "bookingRescheduled",
      purpose: "transactional",
      allowanceClass: "essential_system",
      subject: "Booking rescheduled",
      body: "Booking moved to 9 January 2035, 11:00–13:00.",
      contentFormat: "plain",
      locale: "en",
      status: "scheduled",
      scheduledFor: new Date(0),
      sourceScheduledAt: start,
      deduplicationKey: "a".repeat(64),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("claims the actual immutable notice, runs the canonical processor and does not resend", async () => {
    const first = await drain();
    expect(first.status, first.text).toBe(200);
    expect(first.body.logs).toEqual([
      expect.objectContaining({
        emailType: "bookingRescheduled",
        status: "sent",
        providerMessageId: "captured-1",
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      To: scope.recipient,
      Subject: "Booking rescheduled",
      TextBody: "Booking moved to 9 January 2035, 11:00–13:00.",
      Metadata: { emailLogId: first.body.logs[0].id, tenantId: scope.tenant },
    });
    expect(messages[0].Metadata.deliveryId).toBeTruthy();
    expect(
      (await CommunicationEmailLogModel.findById(first.body.logs[0].id).lean())
        ?.attempts,
    ).toBe(1);
    const second = await drain();
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(messages).toHaveLength(1);
  });

  it("requires the control key and refuses production mode", async () => {
    const server = app();
    expect(
      (
        await request(server)
          .post("/__e2e/booking-lifecycle-delivery")
          .send({ bookingId: String(bookingId) })
      ).status,
    ).toBe(403);
    vi.stubEnv("NODE_ENV", "production");
    expect((await drain(server)).status).toBe(404);
    expect(() => createE2EBookingLifecycleRouter()).toThrow();
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ["POSTMARK_API_URL", "https://api.postmarkapp.com"],
    ["POSTMARK_API_URL", "http://127.0.0.1:4101"],
    ["POSTMARK_SYSTEM_SERVER_TOKEN", "unexpected-token"],
  ])("refuses unsafe provider configuration %s", async (key, value) => {
    vi.stubEnv(key, value);
    const result = await drain();
    expect(result.status).toBe(500);
    expect(result.body.message).toContain("isolated database and loopback");
    expect(provider).not.toHaveBeenCalled();
    expect(await RegisteredSenderEmailModel.countDocuments()).toBe(0);
  });

  it.each(["tenant", "createdBy", "location", "bookingProduct"])(
    "cannot deliver for a booking outside fixture %s",
    async (field) => {
      await Booking.collection.updateOne(
        { _id: bookingId },
        { $set: { [field]: new mongoose.Types.ObjectId() } },
      );
      expect((await drain()).status).toBe(404);
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it("never retries a log with an ambiguous provider outcome", async () => {
    await CommunicationEmailLogModel.updateMany(
      {},
      {
        $set: {
          status: "sending",
          providerAttemptStartedAt: new Date(),
          manualReviewRequiredAt: new Date(),
        },
      },
    );
    const result = await drain();
    expect(result.status).toBe(200);
    expect(result.body.logs[0].status).toBe("sending");
    expect(provider).not.toHaveBeenCalled();
  });
});
