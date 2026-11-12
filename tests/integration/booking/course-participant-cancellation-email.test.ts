import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
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

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), promote: vi.fn() }));
vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  enqueueCommunicationEmail: mocks.enqueue,
}));
vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  promoteWaitlistEntry: mocks.promote,
}));

import Booking from "@/modules/booking/booking.model.js";
import { cancelPaidCourseParticipants } from "@/modules/booking/services/booking.course-participant-cancellation.service.js";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import {
  CommunicationConsentModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import { processPostmarkOutboundWebhook } from "@/modules/communications/services/postmark-outbound-webhook.service.js";
import Location from "@/modules/location/location.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Order } from "@/modules/order/order.model.js";
import Product from "@/modules/product/product.model.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import UserMemberNumberCounter from "@/modules/user/user-member-number-counter.model.js";
import { WaitlistAuditModel } from "@/modules/waitlist/waitlist.model.js";
import { encryptSecret } from "@/shared/security/encryption.js";
import { processBookingLifecycleEmail } from "@/workers/booking-lifecycle-email.processor.js";

const tenant = new mongoose.Types.ObjectId();
const customer = new mongoose.Types.ObjectId();
const staff = new mongoose.Types.ObjectId();
const booking = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const order = new mongoose.Types.ObjectId();
const otherOrder = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const now = new Date("2026-10-24T10:00:00Z");
const input = {
  tenantId: String(tenant),
  sessionId: String(booking),
  orderId: String(order),
  actorUserId: String(staff),
  reason: "Customer asked the studio to cancel",
  now,
};
const models = [
  Booking,
  Order,
  Tenant,
  User,
  Location,
  Product,
  MoneyCredit,
  UserMemberNumberCounter,
  WaitlistAuditModel,
  CommunicationEmailLogModel,
  RegisteredSenderEmailModel,
  CommunicationConsentModel,
  CommunicationSuppressionModel,
];

describe("durable paid Class participant cancellation notices", () => {
  let replica: MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { autoIndex: false });
    await Promise.all(models.map((model) => model.createCollection()));
    // Exercise the production uniqueness fence, including concurrent cancellation.
    await CommunicationEmailLogModel.collection.createIndex(
      { tenant: 1, deduplicationKey: 1 },
      {
        unique: true,
        partialFilterExpression: {
          deduplicationKey: { $type: "string", $gt: "" },
        },
      },
    );
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    mocks.enqueue
      .mockReset()
      .mockResolvedValue({ queueAccepted: true, state: "waiting" });
    mocks.promote.mockReset().mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Unexpected external request")),
    );
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await Tenant.collection.insertOne({
      _id: tenant,
      slug: "course-cancellation",
      status: "active",
      settings: { currency: "CZK", defaultLanguage: "en" },
    } as never);
    await Location.collection.insertOne({
      _id: location,
      tenant,
      name: "Course Studio",
      booking: { timezone: "Europe/Prague" },
    } as never);
    await User.create({
      _id: customer,
      tenant,
      firstname: "Test",
      lastname: "Purchaser",
      email: "purchaser@example.test",
      customId: "U-CLASS",
      memberNumber: 42,
      moneyCredits: 0,
      moneyCreditsMinor: 0,
    });
    await Product.collection.insertOne({
      _id: product,
      tenant,
      name: { EN: "Wheel Class" },
      price: 250,
      currency: "CZK",
    } as never);
    await Order.create({
      _id: order,
      cart: new mongoose.Types.ObjectId(),
      tenant,
      createdBy: customer,
      status: "processed_order",
      isPaid: true,
      currency: "CZK",
      grossAmountMinor: 50000,
      expectedAmountMinor: 50000,
      courseBookings: [
        { bookingId: booking, quantity: 2, capacityReserved: true },
      ],
      lineItems: [
        {
          booking,
          product,
          description: "Wheel Class",
          quantity: 2,
          unitGrossMinor: 25000,
          grossAmountMinor: 50000,
          netAmountMinor: 50000,
          taxAmountMinor: 0,
          taxRateBps: 0,
          locationIds: [location],
        },
      ],
      paymentAllocations: [{ method: "stripe", amountMinor: 50000 }],
    });
    await Booking.create({
      _id: booking,
      tenant,
      location,
      createdBy: staff,
      bookingProduct: product,
      author: { name: "Studio staff", customId: "S-CLASS" },
      orders: [order, otherOrder],
      participants: [
        { firstname: "Test", lastname: "One", order },
        { firstname: "Test", lastname: "Two", order },
        { firstname: "Other", lastname: "Customer", order: otherOrder },
      ],
      start: new Date("2026-10-26T10:00:00Z"),
      end: new Date("2026-10-26T12:00:00Z"),
      numberOfHours: 2,
      numberOfGuests: 3,
      tag: "class",
      status: "processed",
      paymentStatus: "CONFIRMED",
    });
  });

  it("commits one notice/refund under concurrent duplicate cancellations without cancelling other places", async () => {
    const results = await Promise.all([
      cancelPaidCourseParticipants(input),
      cancelPaidCourseParticipants(input),
    ]);
    expect(results.map((value) => value.idempotent).sort()).toEqual([
      false,
      true,
    ]);
    const session = await Booking.findById(booking).lean();
    expect(session).toMatchObject({
      status: "processed",
      createdBy: staff,
      numberOfGuests: 1,
      participants: [
        { firstname: "Other", lastname: "Customer", order: otherOrder },
      ],
    });
    const ledger = await MoneyCredit.findOne({ tenant, user: customer }).lean();
    expect(ledger?.balanceMinor).toBe(50000);
    expect(ledger?.transactions).toHaveLength(1);
    expect((await User.findById(customer).lean())?.memberNumber).toBe(42);
    expect(
      (await Order.findById(order).lean())?.courseCancellations,
    ).toHaveLength(1);
    expect(await WaitlistAuditModel.countDocuments()).toBe(1);
    expect(await CommunicationEmailLogModel.countDocuments()).toBe(1);
    const log = await CommunicationEmailLogModel.findOne().lean();
    expect(log).toMatchObject({
      user: customer,
      sourceOrderId: order,
      relatedEntityId: booking,
      location,
      recipientEmail: "purchaser@example.test",
      emailType: "bookingCancelled",
      allowanceClass: "essential_system",
      status: "queued",
      automation: null,
    });
    expect(log?.body).toContain("Cancelled places: 2");
    expect(log?.body).toContain("500.00 was returned as studio credit.");
    expect(log?.body).toContain(
      "This notice does not cancel other participants' places.",
    );
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("persists a recoverable scheduled notice when queue dispatch fails, without re-refunding on replay", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("Redis unavailable"));
    await cancelPaidCourseParticipants(input);
    const log = await CommunicationEmailLogModel.findOne().lean();
    expect(log).toMatchObject({
      status: "scheduled",
      attempts: 0,
      sourceOrderId: order,
    });
    await expect(cancelPaidCourseParticipants(input)).resolves.toMatchObject({
      idempotent: true,
    });
    expect(await CommunicationEmailLogModel.countDocuments()).toBe(1);
    expect(
      (await MoneyCredit.findOne({ tenant, user: customer }).lean())
        ?.transactions,
    ).toHaveLength(1);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    // The shared recovery/worker can claim the durable row without re-running cancellation.
    expect(
      await communicationEmailLogRepository.claimForSending({
        tenantId: String(tenant),
        logId: String(log?._id),
        jobId: "recovery",
        claimToken: "recovered",
      }),
    ).not.toBeNull();
  });

  it("refunds the immutable paid amount after attendance removal without releasing the same places twice", async () => {
    await Booking.updateOne(
      { _id: booking },
      {
        $set: {
          attendanceManaged: true,
          numberOfGuests: 1,
          "participants.$[paid].attendanceStatus": "removed",
        },
      },
      { arrayFilters: [{ "paid.order": order }] },
    );
    const result = await cancelPaidCourseParticipants(input);
    expect(result).toMatchObject({
      removedParticipants: 0,
      refund: { amount: 500, amountMinor: 50000 },
    });
    const updated = await Booking.findById(booking).lean();
    expect(updated?.numberOfGuests).toBe(1);
    expect(
      updated?.participants.filter(
        (participant) => String(participant.order) === String(order),
      ),
    ).toHaveLength(2);
    expect(updated?.orders.map(String)).not.toContain(String(order));
    expect(
      (await MoneyCredit.findOne({ tenant, user: customer }).lean())
        ?.balanceMinor,
    ).toBe(50000);
    expect(
      (await Order.findById(order).lean())?.courseCancellations[0],
    ).toMatchObject({
      quantity: 2,
      releasedQuantity: 0,
      refundAmountMinor: 50000,
    });
    expect((await CommunicationEmailLogModel.findOne().lean())?.body).toContain(
      "Cancelled places: 2",
    );
    expect(mocks.promote).not.toHaveBeenCalled();
    await expect(cancelPaidCourseParticipants(input)).resolves.toMatchObject({
      idempotent: true,
      removedParticipants: 0,
    });
    expect(
      (await MoneyCredit.findOne({ tenant, user: customer }).lean())
        ?.transactions,
    ).toHaveLength(1);
  });

  it("keeps cancellation notices distinct for different paid orders in the same session", async () => {
    const original = (await Order.findById(order))!.toObject();
    await Order.create({
      ...original,
      _id: otherOrder,
      cart: new mongoose.Types.ObjectId(),
      grossAmountMinor: 25000,
      expectedAmountMinor: 25000,
      courseBookings: [
        { bookingId: booking, quantity: 1, capacityReserved: true },
      ],
      lineItems: original.lineItems.map((line) => ({
        ...line,
        quantity: 1,
        grossAmountMinor: 25000,
        netAmountMinor: 25000,
      })),
      paymentAllocations: [{ method: "stripe", amountMinor: 25000 }],
    });
    await cancelPaidCourseParticipants(input);
    await cancelPaidCourseParticipants({
      ...input,
      orderId: String(otherOrder),
    });
    const logs = await CommunicationEmailLogModel.find().lean();
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((log) => log.deduplicationKey)).size).toBe(2);
    expect(new Set(logs.map((log) => String(log.sourceOrderId)))).toEqual(
      new Set([String(order), String(otherOrder)]),
    );
    expect((await Booking.findById(booking).lean())?.numberOfGuests).toBe(0);
    expect(
      (await MoneyCredit.findOne({ tenant, user: customer }).lean())
        ?.balanceMinor,
    ).toBe(75000);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  it("refuses delivery when the source order no longer belongs to the recipient", async () => {
    await cancelPaidCourseParticipants(input);
    await Order.collection.updateOne(
      { _id: order },
      { $set: { createdBy: staff } },
    );
    const log = await CommunicationEmailLogModel.findOne().lean();
    const claim = await communicationEmailLogRepository.claimForSending({
      tenantId: String(tenant),
      logId: String(log?._id),
      jobId: "scope",
      claimToken: "scope",
    });
    expect(
      await processBookingLifecycleEmail({
        tenantId: String(tenant),
        emailLogId: String(log?._id),
        jobId: "scope",
        claimToken: "scope",
        log: claim!,
      }),
    ).toMatchObject({
      skipped: true,
      reason:
        "Course order no longer has a completed participant cancellation.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await CommunicationEmailLogModel.findById(log?._id).lean(),
    ).toMatchObject({ status: "canceled" });
  });

  it("rolls back seats, refund and audit if the durable email cannot be recorded", async () => {
    vi.spyOn(
      CommunicationEmailLogModel.prototype,
      "save",
    ).mockRejectedValueOnce(new Error("Outbox unavailable"));
    await expect(cancelPaidCourseParticipants(input)).rejects.toThrow(
      "Outbox unavailable",
    );
    expect((await Booking.findById(booking).lean())?.numberOfGuests).toBe(3);
    expect((await Booking.findById(booking).lean())?.participants).toHaveLength(
      3,
    );
    expect(
      (await Order.findById(order).lean())?.courseCancellations,
    ).toHaveLength(0);
    expect((await User.findById(customer).lean())?.moneyCreditsMinor).toBe(0);
    expect(await MoneyCredit.countDocuments()).toBe(0);
    expect(await WaitlistAuditModel.countDocuments()).toBe(0);
    expect(await CommunicationEmailLogModel.countDocuments()).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it("does not create an email or remove places if the refund fails", async () => {
    vi.spyOn(MoneyCredit.prototype, "save").mockRejectedValueOnce(
      new Error("Ledger unavailable"),
    );
    await expect(cancelPaidCourseParticipants(input)).rejects.toThrow(
      "Ledger unavailable",
    );
    expect((await Booking.findById(booking).lean())?.numberOfGuests).toBe(3);
    expect(await CommunicationEmailLogModel.countDocuments()).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each(["signed-in", "guest"])(
    "delivers once to the %s purchaser and correlates provider delivery",
    async (identity) => {
      const guest = identity === "guest";
      const to = guest ? "guest@example.test" : "purchaser@example.test";
      if (guest)
        await User.collection.updateOne(
          { _id: customer },
          {
            $set: {
              customId: "G-0123456789abcdefabcd",
              isAccessGranted: false,
              guestContact: { email: to, locale: "en" },
            },
            $unset: { email: 1 },
          },
        );
      vi.stubEnv("COMMUNICATION_SECRET_KEY", "course-cancellation-test-key");
      vi.stubEnv("POSTMARK_FROM_DOMAIN", "notify.shario.io");
      vi.stubEnv("POSTMARK_MESSAGE_STREAM", "outbound");
      await RegisteredSenderEmailModel.collection.insertOne({
        tenant,
        provider: "postmark_managed",
        isActive: true,
        isDefault: true,
        email: "class@notify.shario.io",
        displayName: "Class Studio",
        replyToEmail: "studio@example.test",
        replyToVerifiedAt: now,
        providerServerId: 12345,
        providerProvisionedAt: now,
        providerProvisioningStatus: "ready",
        encryptedPostmarkServerToken: encryptSecret("test-only-token"),
      } as never);
      const providerMessageId = "d05e16c6-a9c9-4e99-9001-42bb91994ee0";
      const fetchEmail = vi.fn(async (_url: unknown, init: RequestInit) => {
        const persisted = await CommunicationEmailLogModel.findOne().lean();
        expect(persisted?.status).toBe("sending");
        expect(persisted?.providerAttemptStartedAt).toBeInstanceOf(Date);
        const payload = JSON.parse(String(init.body));
        expect(payload).toMatchObject({
          To: to,
          Subject: "Course Studio | Booking cancelled",
          Metadata: {
            tenantId: String(tenant),
            emailLogId: String(persisted?._id),
          },
        });
        expect(payload.TextBody).toContain("Cancelled places: 2");
        expect(payload.TextBody).toContain(
          guest ? "contact the studio" : "Manage bookings",
        );
        return new Response(
          JSON.stringify({ ErrorCode: 0, MessageID: providerMessageId }),
          { status: 200 },
        );
      });
      vi.stubGlobal("fetch", fetchEmail);
      await cancelPaidCourseParticipants(input);
      const log = await CommunicationEmailLogModel.findOne().lean();
      const claim = await communicationEmailLogRepository.claimForSending({
        tenantId: String(tenant),
        logId: String(log?._id),
        jobId: "course-cancel",
        claimToken: "course-claim",
      });
      expect(claim).not.toBeNull();
      expect(
        await processBookingLifecycleEmail({
          tenantId: String(tenant),
          emailLogId: String(log?._id),
          jobId: "course-cancel",
          claimToken: "course-claim",
          log: claim!,
        }),
      ).toMatchObject({ sent: true });
      expect(fetchEmail).toHaveBeenCalledOnce();
      expect(fetchEmail.mock.calls[0][0]).toBe(
        "https://api.postmarkapp.com/email",
      );
      expect(
        await processPostmarkOutboundWebhook({
          RecordType: "Delivery",
          MessageID: providerMessageId,
          Recipient: to,
          DeliveredAt: now.toISOString(),
          Details: "250 accepted",
          ServerID: 12345,
          MessageStream: "outbound",
        }),
      ).toMatchObject({ automationLogUpdated: true });
      expect(
        await CommunicationEmailLogModel.findById(log?._id).lean(),
      ).toMatchObject({ status: "delivered" });
      expect(
        await communicationEmailLogRepository.claimForSending({
          tenantId: String(tenant),
          logId: String(log?._id),
          jobId: "replay",
          claimToken: "replay",
        }),
      ).toBeNull();
      await expect(cancelPaidCourseParticipants(input)).resolves.toMatchObject({
        idempotent: true,
      });
      expect(fetchEmail).toHaveBeenCalledOnce();
    },
  );
});
