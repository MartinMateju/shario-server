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

const deliveryMocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  enqueueCommunicationEmail: deliveryMocks.enqueue,
}));

// Keep notification delivery outside this database transaction regression.
vi.mock("@/modules/customer-notifications/index.js", () => ({
  publishCustomerBookingLifecycleNotificationSafely: vi.fn(),
  publishCustomerRefundNotificationSafely: vi.fn(),
}));
vi.mock(
  "@/modules/workspace-notifications/workspace-notification.business-events.js",
  () => ({
    emitPaymentRefundedNotificationSafely: vi.fn(),
  }),
);

import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import Location from "@/modules/location/location.model.js";
import { communicationEmailLogRepository } from "@/modules/communication-email-logs/communication-email-log.repository.js";
import { processBookingLifecycleEmail } from "@/workers/booking-lifecycle-email.processor.js";
import { processPostmarkOutboundWebhook } from "@/modules/communications/services/postmark-outbound-webhook.service.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import {
  CommunicationConsentModel,
  CommunicationSuppressionModel,
} from "@/modules/communications/communications.models.js";
import { encryptSecret } from "@/shared/security/encryption.js";
import Booking from "@/modules/booking/booking.model.js";
import { cancelBookingWithRefund } from "@/modules/booking/services/booking.refund.service.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Order } from "@/modules/order/order.model.js";
import Product from "@/modules/product/product.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import UserMemberNumberCounter from "@/modules/user/user-member-number-counter.model.js";
import { AccessCodeNotification } from "@/modules/access-codes/access-code.model.js";

const tenant = new mongoose.Types.ObjectId();
const user = new mongoose.Types.ObjectId();
const booking = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const order = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const input = {
  tenantId: String(tenant),
  userId: String(user),
  bookingId: String(booking),
};

describe("booking cancellation with a studio-credit refund", () => {
  let replica: MongoMemoryReplSet | undefined;

  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { autoIndex: false });
    await Promise.all([
      Booking.createCollection(),
      Location.createCollection(),
      CommunicationEmailLogModel.createCollection(),
      MoneyCredit.createCollection(),
      Order.createCollection(),
      Product.createCollection(),
      Tenant.createCollection(),
      User.createCollection(),
      UserMemberNumberCounter.createCollection(),
      AccessCodeNotification.createCollection(),
    ]);
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
    deliveryMocks.enqueue
      .mockReset()
      .mockResolvedValue({ queueAccepted: true, state: "waiting" });
    await Promise.all(
      [
        Booking,
        MoneyCredit,
        Order,
        Product,
        Tenant,
        User,
        Location,
        CommunicationEmailLogModel,
        UserMemberNumberCounter,
        AccessCodeNotification,
        RegisteredSenderEmailModel,
        CommunicationConsentModel,
        CommunicationSuppressionModel,
      ].map((model) => model.collection.deleteMany({})),
    );
    await Tenant.collection.insertOne({
      _id: tenant,
      slug: "cancellation-test",
      status: "active",
      settings: { currency: "CZK", defaultLanguage: "en" },
    } as never);
    await Location.collection.insertOne({
      _id: location,
      tenant,
      name: "Refund Studio",
      booking: { timezone: "Europe/Prague" },
    } as never);
    await User.create({
      _id: user,
      tenant,
      firstname: "Test",
      lastname: "Customer",
      email: "cancel-test@example.test",
      customId: "U-REFUND",
      memberNumber: 42,
      moneyCredits: 0,
      moneyCreditsMinor: 0,
    });
    await Product.collection.insertOne({
      _id: product,
      tenant,
      name: { EN: "Open Studio" },
      price: 900,
      currency: "CZK",
    } as never);
    await Order.collection.insertOne({
      _id: order,
      tenant,
      createdBy: user,
      isPaid: true,
      currency: "CZK",
      workshopBookings: [booking],
      lineItems: [{ booking, product, grossAmountMinor: 25000 }],
      paymentAllocations: [{ method: "money_credit", amountMinor: 25000 }],
    } as never);
    await Booking.create({
      _id: booking,
      tenant,
      location,
      createdBy: user,
      bookingProduct: product,
      orders: [order],
      author: { name: "Test Customer", customId: "U-REFUND" },
      start: new Date(Date.now() + 86400000),
      end: new Date(Date.now() + 90000000),
      numberOfHours: 1,
      numberOfGuests: 1,
      tag: "open-studio",
      status: "processed",
      paymentStatus: "CONFIRMED",
    });
  });

  it("commits cancellation and exactly one paid-amount refund without changing the member number", async () => {
    await expect(cancelBookingWithRefund(input)).resolves.toMatchObject({
      refundAmount: 250,
      currency: "CZK",
      newCreditBalance: 250,
    });
    expect(await Booking.findById(booking).lean()).toMatchObject({
      status: "cancelled",
      accessCodeDelivery: { status: "cancelled" },
    });
    expect(await User.findById(user).lean()).toMatchObject({
      memberNumber: 42,
      moneyCredits: 250,
      moneyCreditsMinor: 25000,
    });
    const ledger = await MoneyCredit.findOne({ tenant, user }).lean();
    expect(ledger).toMatchObject({
      balance: 250,
      balanceMinor: 25000,
      currency: "CZK",
    });
    expect(ledger?.transactions).toHaveLength(1);
    expect(ledger?.transactions[0]).toMatchObject({
      type: "refund",
      amountMinor: 25000,
      relatedBooking: booking,
      relatedOrder: order,
    });
    expect(await UserMemberNumberCounter.countDocuments()).toBe(0);
    const email = await CommunicationEmailLogModel.findOne({
      tenant,
      relatedEntityId: booking,
    }).lean();
    expect(email).toMatchObject({
      automation: null,
      user,
      recipientEmail: "cancel-test@example.test",
      emailType: "bookingCancelled",
      status: "queued",
      purpose: "transactional",
      allowanceClass: "essential_system",
      location,
      appliesToAllLocations: false,
    });
    expect(email?.body).toContain(
      "Your booking has been cancelled successfully.",
    );
    expect(email?.body).toContain("CZK");
    expect(email?.body).toContain("250.00 was returned as studio credit.");
    expect(deliveryMocks.enqueue).toHaveBeenCalledTimes(1);

    await expect(cancelBookingWithRefund(input)).rejects.toThrow(
      "Booking is already cancelled",
    );
    expect(
      (await MoneyCredit.findOne({ tenant, user }).lean())?.transactions,
    ).toHaveLength(1);
    expect((await User.findById(user).lean())?.moneyCreditsMinor).toBe(25000);
    expect(await CommunicationEmailLogModel.countDocuments()).toBe(1);
    expect(deliveryMocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it("refunds the original booking and paid extension together exactly once", async () => {
    const extension = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({
      _id: extension,
      tenant,
      createdBy: user,
      isPaid: true,
      currency: "CZK",
      paidAmountMinor: 0,
      grossAmountMinor: 12500,
      workshopBookings: [booking],
      lineItems: [{ booking, product, grossAmountMinor: 12500 }],
      paymentAllocations: [{ method: "credits", amountMinor: 12500 }],
      bookingExtension: { bookingId: booking, amountMinor: 12500 },
    } as never);
    await Booking.updateOne(
      { _id: booking },
      {
        $push: { orders: extension },
        $set: { numberOfHours: 1.5, extensionBaseDurationMinutes: 60 },
      },
    );
    await expect(cancelBookingWithRefund(input)).resolves.toMatchObject({
      refundAmount: 375,
    });
    const ledger = await MoneyCredit.findOne({ tenant, user }).lean();
    expect(ledger?.balanceMinor).toBe(37500);
    expect(ledger?.transactions).toHaveLength(1);
    expect(ledger?.transactions[0].amountMinor).toBe(37500);
    const email = await CommunicationEmailLogModel.findOne({
      tenant,
      relatedEntityId: booking,
    }).lean();
    expect(email?.body).toContain("375.00 was returned as studio credit.");
    await expect(cancelBookingWithRefund(input)).rejects.toThrow(
      "Booking is already cancelled",
    );
    expect(
      (await MoneyCredit.findOne({ tenant, user }).lean())?.balanceMinor,
    ).toBe(37500);
    expect(await CommunicationEmailLogModel.countDocuments()).toBe(1);
  });

  it("rolls back cancellation and the balance if recording the refund fails", async () => {
    vi.spyOn(MoneyCredit.prototype, "save").mockRejectedValueOnce(
      new Error("Ledger unavailable"),
    );
    await expect(cancelBookingWithRefund(input)).rejects.toThrow(
      "Ledger unavailable",
    );
    expect((await Booking.findById(booking).lean())?.status).toBe("processed");
    expect(await User.findById(user).lean()).toMatchObject({
      memberNumber: 42,
      moneyCredits: 0,
      moneyCreditsMinor: 0,
    });
    expect(await MoneyCredit.countDocuments()).toBe(0);
    expect(await CommunicationEmailLogModel.countDocuments()).toBe(0);
    expect(deliveryMocks.enqueue).not.toHaveBeenCalled();
  });
  it("persists a recoverable email when the queue is unavailable, without losing the cancellation or refund", async () => {
    deliveryMocks.enqueue.mockRejectedValueOnce(new Error("Queue offline"));
    await expect(cancelBookingWithRefund(input)).resolves.toMatchObject({
      refundAmount: 250,
    });
    expect((await Booking.findById(booking).lean())?.status).toBe("cancelled");
    expect((await User.findById(user).lean())?.moneyCreditsMinor).toBe(25000);
    expect(
      await CommunicationEmailLogModel.findOne({
        tenant,
        relatedEntityId: booking,
      }).lean(),
    ).toMatchObject({
      status: "scheduled",
      attempts: 0,
      emailType: "bookingCancelled",
    });
  });

  it("rolls back the cancellation and refund if its durable email cannot be saved", async () => {
    vi.spyOn(
      CommunicationEmailLogModel.prototype,
      "save",
    ).mockRejectedValueOnce(new Error("Email outbox unavailable"));
    await expect(cancelBookingWithRefund(input)).rejects.toThrow(
      "Email outbox unavailable",
    );
    expect((await Booking.findById(booking).lean())?.status).toBe("processed");
    expect((await User.findById(user).lean())?.moneyCreditsMinor).toBe(0);
    expect(await MoneyCredit.countDocuments()).toBe(0);
    expect(await CommunicationEmailLogModel.countDocuments()).toBe(0);
    expect(deliveryMocks.enqueue).not.toHaveBeenCalled();
  });

  it("sends the committed cancellation through the real managed transport and records a correlated delivery webhook", async () => {
    vi.stubEnv("COMMUNICATION_SECRET_KEY", "cancellation-integration-only-key");
    vi.stubEnv("POSTMARK_FROM_DOMAIN", "notify.shario.io");
    vi.stubEnv("POSTMARK_MESSAGE_STREAM", "outbound");
    await RegisteredSenderEmailModel.collection.insertOne({
      tenant,
      provider: "postmark_managed",
      isActive: true,
      isDefault: true,
      email: "cancel-studio@notify.shario.io",
      displayName: "Cancellation Studio",
      replyToEmail: "studio@example.test",
      replyToVerifiedAt: new Date(),
      providerServerId: 12345,
      providerProvisionedAt: new Date(),
      providerProvisioningStatus: "ready",
      encryptedPostmarkServerToken: encryptSecret("test-only-postmark-token"),
    } as never);
    // Owner identities may book as customers; required notices do not require
    // a tenant's editable automation modules or a metered email allowance.
    await User.collection.updateOne(
      { _id: user },
      { $set: { tenantRole: "owner" } },
    );
    await Tenant.collection.updateOne(
      { _id: tenant },
      {
        $set: {
          modules: { automations: false, communications: false },
          limits: { monthlyEmails: 0 },
        },
      },
    );
    const providerMessageId = "d05e16c6-a9c9-4e99-9001-42bb91994ee0";
    const fetchEmail = vi
      .fn()
      .mockImplementation(async (_url: unknown, init: RequestInit) => {
        const persisted = await CommunicationEmailLogModel.findOne({
          tenant,
        }).lean();
        expect(persisted?.status).toBe("sending");
        expect(persisted?.providerAttemptStartedAt).toBeInstanceOf(Date);
        const payload = JSON.parse(String(init.body));
        expect(payload).toMatchObject({
          To: "cancel-test@example.test",
          From: '"Cancellation Studio" <cancel-studio@notify.shario.io>',
          ReplyTo: "studio@example.test",
          Subject: "Refund Studio | Booking cancelled",
          Metadata: {
            tenantId: String(tenant),
            emailLogId: String(persisted?._id),
          },
        });
        expect(payload.TextBody).toContain(
          "250.00 was returned as studio credit.",
        );
        return new Response(
          JSON.stringify({ ErrorCode: 0, MessageID: providerMessageId }),
          { status: 200 },
        );
      });
    vi.stubGlobal("fetch", fetchEmail);
    await cancelBookingWithRefund({
      ...input,
      actorUserId: String(new mongoose.Types.ObjectId()),
    });
    const queued = await CommunicationEmailLogModel.findOne({ tenant }).lean();
    const claim = await communicationEmailLogRepository.claimForSending({
      tenantId: String(tenant),
      logId: String(queued?._id),
      jobId: "cancellation-test",
      claimToken: "cancel-claim",
    });
    expect(claim).not.toBeNull();
    expect(
      await processBookingLifecycleEmail({
        tenantId: String(tenant),
        emailLogId: String(queued?._id),
        jobId: "cancellation-test",
        claimToken: "cancel-claim",
        log: claim!,
      }),
    ).toMatchObject({ sent: true, providerMessageId });
    expect(fetchEmail).toHaveBeenCalledTimes(1);
    expect(fetchEmail.mock.calls[0][0]).toBe(
      "https://api.postmarkapp.com/email",
    );
    expect(
      await CommunicationEmailLogModel.findById(queued?._id).lean(),
    ).toMatchObject({
      status: "sent",
      provider: "postmark",
      providerMessageId,
    });
    const webhook = {
      RecordType: "Delivery" as const,
      MessageID: providerMessageId,
      Recipient: "cancel-test@example.test",
      DeliveredAt: new Date().toISOString(),
      Details: "250 accepted",
      ServerID: 12345,
      MessageStream: "outbound",
    };
    expect(
      await processPostmarkOutboundWebhook({ ...webhook, ServerID: 99999 }),
    ).toMatchObject({ automationLogUpdated: false });
    expect(await processPostmarkOutboundWebhook(webhook)).toMatchObject({
      automationLogUpdated: true,
    });
    expect(
      await CommunicationEmailLogModel.findById(queued?._id).lean(),
    ).toMatchObject({ status: "delivered", deliveredAt: expect.any(Date) });
    expect(
      await communicationEmailLogRepository.claimForSending({
        tenantId: String(tenant),
        logId: String(queued?._id),
        jobId: "duplicate",
        claimToken: "duplicate",
      }),
    ).toBeNull();
    expect(fetchEmail).toHaveBeenCalledTimes(1);
  });
});
