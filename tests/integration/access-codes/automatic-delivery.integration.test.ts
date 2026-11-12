import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock(
  "@/modules/registered-sender-email/services/managed-sender-resolver.service.js",
  () => ({
    resolveManagedSender: vi.fn().mockResolvedValue({}),
    ManagedSenderNotReadyError: class extends Error {},
  }),
);
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: transport.send,
}));
vi.mock("@/modules/booking/customer-booking-link.service.js", () => ({
  resolveCustomerBookingLink: vi
    .fn()
    .mockResolvedValue({ locale: "en", url: "https://example.test/en/portal" }),
}));
import Booking from "@/modules/booking/booking.model.js";
import Location from "@/modules/location/location.model.js";
import { locationRepository } from "@/modules/location/location.repository.js";
import { updateLocationSchema } from "@/modules/location/location.validators.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import Subscription from "@/modules/tenant-subscription/tenant-subscription.schema.js";
import {
  AccessCode,
  AccessCodePool,
  AccessCodeNotification,
} from "@/modules/access-codes/access-code.model.js";
import { encryptAccessCode } from "@/modules/access-codes/access-code.crypto.js";
import { sendAccessCodeNotifications } from "@/modules/access-codes/services/access-code-notification.service.js";
import {
  getDoorAccessAutomation,
  updateDoorAccessAutomation,
} from "@/modules/access-codes/services/door-access-automation.service.js";
import {
  findDoorAccessForPostmarkEvent,
  transitionDoorAccessFromPostmark,
} from "@/modules/communications/services/door-access-webhook.service.js";
import {
  accessCodeNotificationRepository,
  accessCodeRepository,
} from "@/modules/access-codes/access-code.repository.js";

let mongo: MongoMemoryServer;
const tenant = new Types.ObjectId(),
  location = new Types.ObjectId(),
  pool = new Types.ObjectId(),
  user = new Types.ObjectId();
let booking: Types.ObjectId, code: Types.ObjectId;
beforeAll(async () => {
  process.env.ACCESS_CODE_ENCRYPTION_KEY =
    "test-delivery-encryption-key-with-32-characters";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), {
    autoIndex: false,
    autoCreate: false,
  });
  await AccessCodeNotification.collection.createIndex(
    { tenant: 1, booking: 1, channel: 1 },
    { unique: true },
  );
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
  transport.send.mockReset().mockImplementation(async (input) => {
    await input.beforeSend?.();
    return { provider: "postmark", providerMessageId: "provider-test-message" };
  });
  booking = new Types.ObjectId();
  code = new Types.ObjectId();
  await Tenant.collection.insertOne({
    _id: tenant,
    status: "active",
    plan: "studio_plus",
    planVersion: 3,
    modules: { access_codes: true },
  } as any);
  await Subscription.collection.insertOne({
    tenant,
    status: "active",
    billingPlan: "studio_plus",
    planVersion: 3,
  } as any);
  await Location.collection.insertOne({
    _id: location,
    tenant,
    name: "Test studio",
    isActive: true,
    booking: { timezone: "Europe/Prague", doorCodeMinutesBefore: 15 },
    access: { automaticEmailEnabled: true },
  } as any);
  await User.collection.insertOne({
    _id: user,
    tenant,
    email: "owner@example.test",
    isAccessGranted: true,
  } as any);
  await AccessCodePool.collection.insertOne({
    _id: pool,
    tenant,
    location,
    name: "Door",
    isActive: true,
  } as any);
  await AccessCode.collection.insertOne({
    _id: code,
    tenant,
    location,
    pool,
    type: "reusable",
    status: "available",
    canBeRepeated: true,
    usedCount: 0,
    verifiedAt: new Date(),
    expiresAt: null,
    validUntil: null,
    entryCode: encryptAccessCode({
      tenantId: String(tenant),
      poolId: String(pool),
      entryCode: "test-7391",
    }),
  } as any);
  await Booking.collection.insertOne({
    _id: booking,
    tenant,
    location,
    createdBy: user,
    start: new Date(Date.now() + 14 * 60_000),
    end: new Date(Date.now() + 74 * 60_000),
    status: "confirmed",
    paymentStatus: "CONFIRMED",
    tag: "open-studio",
  } as any);
});

describe("automatic reusable door-code delivery", () => {
  it("configures a scoped built-in automation without exposing codes or enabling ineligible plans", async () => {
    expect(
      (await getDoorAccessAutomation(String(tenant), [])).locations,
    ).toEqual([]);
    await expect(
      updateDoorAccessAutomation(String(tenant), String(location), true, []),
    ).rejects.toThrow("not found");
    const configured = await updateDoorAccessAutomation(
      String(tenant),
      String(location),
      true,
    );
    expect(configured.locations[0]).toMatchObject({
      enabled: true,
      minutesBefore: 15,
      availableCodes: 1,
      blockedReason: null,
    });
    expect(JSON.stringify(configured)).not.toContain("test-7391");
    await Tenant.collection.updateOne(
      { _id: tenant },
      { $set: { plan: "professional" } },
    );
    await expect(
      updateDoorAccessAutomation(String(tenant), String(location), true),
    ).rejects.toThrow("setup requirement");
    expect(
      (
        await updateDoorAccessAutomation(
          String(tenant),
          String(location),
          false,
        )
      ).locations[0],
    ).toMatchObject({ enabled: false, blockedReason: "plan" });
  });
  it("records a recipient snapshot, correlates early provider events, and keeps failed delivery visible", async () => {
    transport.send.mockImplementationOnce(async (input) => {
      await input.beforeSend();
      const reference = await findDoorAccessForPostmarkEvent({
        RecordType: "Delivery",
        MessageID: "provider-test-message",
        ServerID: 1,
        MessageStream: "outbound",
        Recipient: "owner@example.test",
        DeliveredAt: new Date().toISOString(),
        Metadata: {
          tenantId: String(tenant),
          accessCodeBookingId: String(booking),
          deliveryId: input.deliveryId,
        },
      });
      expect(reference?.recipientEmail).toBe("owner@example.test");
      await transitionDoorAccessFromPostmark(reference!, {
        status: "delivered",
        at: new Date(),
        eventKey: "test-delivery",
        providerEventId: "test-delivery",
        code: "",
        reason: "",
        permanent: false,
      });
      await transitionDoorAccessFromPostmark(reference!, {
        status: "bounced",
        at: new Date(),
        eventKey: "test-bounce",
        providerEventId: "test-bounce",
        code: "",
        reason: "",
        permanent: true,
      });
      expect(
        await transitionDoorAccessFromPostmark(reference!, {
          status: "delivered",
          at: new Date(),
          eventKey: "late-delivery",
          providerEventId: "late-delivery",
          code: "",
          reason: "",
          permanent: false,
        }),
      ).toBe(false);
      return {
        provider: "postmark",
        providerMessageId: "provider-test-message",
      };
    });
    await sendAccessCodeNotifications();
    const result = await getDoorAccessAutomation(String(tenant));
    expect(result.deliveries[0]).toMatchObject({
      status: "sent",
      providerDeliveryStatus: "bounced",
    });
    expect(JSON.stringify(result)).not.toContain("owner@example.test");
    expect(
      (await getDoorAccessAutomation(String(new Types.ObjectId()))).deliveries,
    ).toEqual([]);
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it("retries an explicitly rejected submission but never an ambiguous provider outcome", async () => {
    transport.send.mockImplementationOnce(async (input) => {
      await input.beforeSend();
      throw Object.assign(new Error("provider rejected"), {
        deliveryOutcome: "rejected",
      });
    });
    await sendAccessCodeNotifications();
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({ status: "failed", providerAttemptStartedAt: null });
    await AccessCodeNotification.updateOne(
      { booking },
      { $set: { nextAttemptAt: new Date(0) } },
    );
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledTimes(2);
  });
  it("preserves delivery opt-in when editing other location access instructions", async () => {
    await locationRepository.update(String(tenant), {
      id: String(location),
      access: { publicInstructions: "Use the front door" },
    });
    expect(await Location.findById(location).lean()).toMatchObject({
      access: {
        automaticEmailEnabled: true,
        publicInstructions: "Use the front door",
      },
    });
  });
  it("preserves door-email settings and booking configuration through partial location edits", async () => {
    await Location.collection.updateOne(
      { _id: location },
      {
        $set: {
          "access.privateInstructions": "Use the side entrance after 18:00",
        },
      },
    );
    await locationRepository.update(
      String(tenant),
      updateLocationSchema.parse({
        id: String(location),
        access: { publicInstructions: "Use the front door" },
      }),
    );
    await locationRepository.update(
      String(tenant),
      updateLocationSchema.parse({
        id: String(location),
        name: "Updated workspace",
      }),
    );
    expect(
      await Location.findById(location)
        .select("+access.privateInstructions")
        .lean(),
    ).toMatchObject({
      booking: { timezone: "Europe/Prague", doorCodeMinutesBefore: 15 },
      access: {
        automaticEmailEnabled: true,
        publicInstructions: "Use the front door",
        privateInstructions: "Use the side entrance after 18:00",
      },
      name: "Updated workspace",
    });
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it("decrypts a permanent code only for the booked customer and sends once across concurrent runs", async () => {
    await Promise.all([
      sendAccessCodeNotifications(),
      sendAccessCodeNotifications(),
    ]);
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send.mock.calls[0][0]).toMatchObject({
      tenantId: String(tenant),
      to: "owner@example.test",
      text: expect.stringContaining("test-7391"),
    });
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({
      status: "sent",
      provider: "postmark",
      providerMessageId: "provider-test-message",
    });
    expect(await Booking.findById(booking).lean()).toMatchObject({
      accessCodeDelivery: { status: "sent" },
    });
  });
  it.each([
    ["early", { start: new Date(Date.now() + 20 * 60_000) }],
    ["cancelled", { status: "cancelled" }],
    ["unpaid", { paymentStatus: "PENDING_PAYMENT" }],
    [
      "historical import",
      { atelierKleiMigration: { suppressAccessNotifications: true } },
    ],
    ["cross tenant", { tenant: new Types.ObjectId() }],
  ])("does not send for %s bookings", async (_name, patch) => {
    await Booking.collection.updateOne({ _id: booking }, { $set: patch });
    await sendAccessCodeNotifications();
    expect(transport.send).not.toHaveBeenCalled();
  });
  it.each([
    ["retired", { status: "retired" }],
    ["unverified", { verifiedAt: null }],
    ["emergency reserve", { type: "emergency_reserve" }],
    ["single use", { type: "single_booking", canBeRepeated: false }],
    ["expired", { validUntil: new Date(Date.now() - 1) }],
    [
      "expires before booking end",
      { expiresAt: new Date(Date.now() + 30 * 60_000) },
    ],
    ["legacy plaintext", { entryCode: "7391" }],
  ])("never selects %s inventory", async (_name, patch) => {
    await AccessCode.collection.updateOne({ _id: code }, { $set: patch });
    expect(
      await accessCodeRepository.reserveForLocation(
        String(tenant),
        location,
        new Date(),
        new Date(Date.now() + 74 * 60_000),
      ),
    ).toBeNull();
    await sendAccessCodeNotifications();
    expect(transport.send).not.toHaveBeenCalled();
  });
  it("requires location opt-in and an entitled active plan", async () => {
    await Location.collection.updateOne(
      { _id: location },
      { $set: { "access.automaticEmailEnabled": false } },
    );
    await sendAccessCodeNotifications();
    await Location.collection.updateOne(
      { _id: location },
      { $set: { "access.automaticEmailEnabled": true } },
    );
    await Tenant.collection.updateOne(
      { _id: tenant },
      { $set: { plan: "professional" } },
    );
    await sendAccessCodeNotifications();
    await Tenant.collection.updateOne(
      { _id: tenant },
      { $set: { plan: "studio_plus" } },
    );
    await Subscription.collection.updateOne(
      { tenant },
      { $set: { status: "canceled" } },
    );
    await sendAccessCodeNotifications();
    expect(transport.send).not.toHaveBeenCalled();
  });
  it("rechecks inventory after sender preparation and before provider submission", async () => {
    let submitted = false;
    transport.send.mockImplementation(async (input) => {
      await AccessCode.collection.updateOne(
        { _id: code },
        { $set: { status: "retired" } },
      );
      await input.beforeSend();
      submitted = true;
    });
    await sendAccessCodeNotifications();
    expect(submitted).toBe(false);
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({ status: "failed", providerAttemptStartedAt: null });
  });
  it("retries a definitive provider rejection but holds an uncertain result", async () => {
    transport.send.mockImplementationOnce(async (input) => {
      await input.beforeSend();
      throw Object.assign(new Error("rejected"), {
        deliveryOutcome: "not_sent",
      });
    });
    await sendAccessCodeNotifications();
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({ status: "failed", providerAttemptStartedAt: null });
    await AccessCodeNotification.updateOne(
      { booking },
      { $set: { nextAttemptAt: new Date(0) } },
    );
    transport.send.mockImplementationOnce(async (input) => {
      await input.beforeSend();
      throw new Error("connection lost after submission");
    });
    await sendAccessCodeNotifications();
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({ status: "delivery_unknown" });
  });
  it("never resubmits after a crash once provider submission began", async () => {
    await AccessCodeNotification.collection.insertOne({
      tenant,
      booking,
      user,
      accessCode: code,
      channel: "email",
      status: "processing",
      providerAttemptStartedAt: new Date(Date.now() - 20 * 60_000),
      leaseExpiresAt: new Date(0),
    } as any);
    expect(
      await accessCodeNotificationRepository.hasModificationLockForBooking({
        tenantId: String(tenant),
        bookingId: booking,
      }),
    ).toBe(true);
    await sendAccessCodeNotifications();
    expect(transport.send).not.toHaveBeenCalled();
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({ status: "delivery_unknown" });
  });

  it("requires explicit staff authorization to rearm a sent notification", async () => {
    await sendAccessCodeNotifications();
    const original = await AccessCodeNotification.findOne({ booking }).lean();
    const next = new Date(original!.bookingStart!.getTime() + 24 * 60 * 60_000);
    const move = {
      tenantId: String(tenant),
      bookingId: booking,
      bookingStart: next,
    };
    await expect(
      accessCodeNotificationRepository.rearmForReschedule(move),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "BOOKING_EDIT_ACCESS_DETAILS_ISSUED",
    });
    expect(await AccessCodeNotification.findOne({ booking }).lean()).toEqual(
      original,
    );
    await accessCodeNotificationRepository.rearmForReschedule({
      ...move,
      transitionId: "authorized-staff-move",
    });
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({
      status: "pending",
      bookingStart: next,
      sentAt: null,
      deliveryHistory: [
        {
          status: "sent",
          sentAt: original!.sentAt,
          claimToken: original!.claimToken,
          transitionId: "authorized-staff-move",
        },
      ],
    });
    expect(transport.send).toHaveBeenCalledOnce();
  });

  it("archives issued access, sends for the new occurrence, and routes late webhooks only to history", async () => {
    await sendAccessCodeNotifications();
    const original = await AccessCodeNotification.findOne({ booking }).lean();
    const event = {
      RecordType: "Delivery" as const,
      MessageID: "provider-test-message",
      ServerID: 1,
      MessageStream: "outbound",
      Recipient: "owner@example.test",
      DeliveredAt: new Date().toISOString(),
    };
    // A webhook may resolve its reference immediately before the reschedule.
    const referenceBeforeMove = await findDoorAccessForPostmarkEvent(event);
    const newStart = new Date(Date.now() + 13 * 60_000);
    await Booking.updateOne(
      { _id: booking },
      {
        $set: {
          start: newStart,
          end: new Date(newStart.getTime() + 60 * 60_000),
          accessCodeDelivery: { status: "idle" },
        },
      },
    );
    await accessCodeNotificationRepository.rearmForReschedule({
      tenantId: String(tenant),
      bookingId: booking,
      bookingStart: newStart,
      transitionId: "staff-move-1",
    });
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({
      status: "pending",
      bookingStart: newStart,
      providerMessageId: "",
      sentAt: null,
      deliveryHistory: [
        {
          transitionId: "staff-move-1",
          bookingStart: original!.bookingStart,
          status: "sent",
          sentAt: original!.sentAt,
          claimToken: original!.claimToken,
          providerMessageId: "provider-test-message",
          accessCode: code,
        },
      ],
    });
    expect(
      await accessCodeNotificationRepository.hasDeliveredForBooking({
        tenantId: String(tenant),
        bookingId: booking,
      }),
    ).toBe(false);
    expect(
      await accessCodeNotificationRepository.hasModificationLockForBooking({
        tenantId: String(tenant),
        bookingId: booking,
      }),
    ).toBe(true);
    expect(
      await accessCodeNotificationRepository.hasInFlightDeliveryForBooking({
        tenantId: String(tenant),
        bookingId: booking,
      }),
    ).toBe(false);
    expect(
      await accessCodeNotificationRepository.findDeliveredBookingIds({
        tenantId: String(tenant),
        bookingIds: [booking],
      }),
    ).toEqual([]);
    expect(
      await accessCodeNotificationRepository.findModificationLockedBookingIds({
        tenantId: String(tenant),
        bookingIds: [booking],
      }),
    ).toEqual([String(booking)]);
    transport.send.mockImplementationOnce(async (input) => {
      await input.beforeSend();
      return {
        provider: "postmark",
        providerMessageId: "new-occurrence-message",
      };
    });
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledTimes(2);
    const transition = {
      status: "bounced" as const,
      at: new Date(),
      eventKey: "old-bounce",
      providerEventId: "old-bounce",
      code: "",
      reason: "",
      permanent: true,
    };
    expect(
      await transitionDoorAccessFromPostmark(referenceBeforeMove!, transition),
    ).toBe(true);
    expect(
      await transitionDoorAccessFromPostmark(referenceBeforeMove!, transition),
    ).toBe(false);
    expect(await findDoorAccessForPostmarkEvent(event)).toMatchObject({
      claimId: original!.claimToken,
    });
    expect(
      await transitionDoorAccessFromPostmark(referenceBeforeMove!, {
        ...transition,
        status: "delivered",
        eventKey: "old-late-delivery",
      }),
    ).toBe(false);
    expect(
      await transitionDoorAccessFromPostmark(
        { ...referenceBeforeMove!, tenantId: new Types.ObjectId() },
        {
          ...transition,
          status: "complained",
          eventKey: "cross-tenant",
        },
      ),
    ).toBe(false);
    const current = await AccessCodeNotification.findOne({ booking }).lean();
    expect(current).toMatchObject({
      status: "sent",
      bookingStart: newStart,
      providerMessageId: "new-occurrence-message",
      providerDeliveryStatus: "",
      deliveryHistory: [{ providerDeliveryStatus: "bounced" }],
    });
    expect(JSON.stringify(current!.deliveryHistory)).not.toContain("entryCode");
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it("correlates historical metadata when the accepted provider message ID was not persisted", async () => {
    await sendAccessCodeNotifications();
    const original = await AccessCodeNotification.findOne({ booking }).lean();
    await AccessCodeNotification.updateOne(
      { booking },
      { $set: { providerMessageId: "" } },
    );
    await accessCodeNotificationRepository.rearmForReschedule({
      tenantId: String(tenant),
      bookingId: booking,
      bookingStart: new Date(Date.now() + 24 * 60 * 60_000),
      transitionId: "staff-move-metadata",
    });
    const reference = await findDoorAccessForPostmarkEvent({
      RecordType: "Delivery",
      MessageID: "recovered-old-message",
      ServerID: 1,
      MessageStream: "outbound",
      Recipient: "owner@example.test",
      DeliveredAt: new Date().toISOString(),
      Metadata: {
        tenantId: String(tenant),
        accessCodeBookingId: String(booking),
        deliveryId: original!.claimToken,
      },
    });
    expect(reference?.claimId).toBe(original!.claimToken);
    expect(
      await transitionDoorAccessFromPostmark(reference!, {
        status: "delivered",
        at: new Date(),
        eventKey: "late-recovery",
        providerEventId: "late-recovery",
        code: "",
        reason: "",
        permanent: false,
      }),
    ).toBe(true);
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({
      status: "pending",
      providerMessageId: "",
      providerDeliveryStatus: "",
      deliveryHistory: [
        {
          providerMessageId: "recovered-old-message",
          providerDeliveryStatus: "delivered",
        },
      ],
    });
  });

  it.each([
    ["live processing", "processing", new Date(Date.now() + 60_000), null],
    ["expired provider attempt", "processing", new Date(0), new Date()],
    ["ambiguous outcome", "delivery_unknown", null, new Date()],
  ] as const)(
    "refuses to rearm %s without changing delivery evidence",
    async (_label, status, leaseExpiresAt, providerAttemptStartedAt) => {
      const start = (await Booking.findById(booking).lean())!.start;
      await AccessCodeNotification.create({
        tenant,
        booking,
        user,
        accessCode: code,
        channel: "email",
        bookingStart: start,
        status,
        leaseExpiresAt,
        providerAttemptStartedAt,
        claimToken: "busy-claim",
      });
      expect(
        await accessCodeNotificationRepository.hasInFlightDeliveryForBooking({
          tenantId: String(tenant),
          bookingId: booking,
        }),
      ).toBe(true);
      await expect(
        accessCodeNotificationRepository.rearmForReschedule({
          tenantId: String(tenant),
          bookingId: booking,
          bookingStart: new Date(Date.now() + 60 * 60_000),
          transitionId: "blocked-move",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS",
      });
      expect(
        await AccessCodeNotification.findOne({ booking }).lean(),
      ).toMatchObject({
        status,
        bookingStart: start,
        claimToken: "busy-claim",
        deliveryHistory: [],
      });
    },
  );

  it("only staff can rearm a historical cancelled notification", async () => {
    const start = (await Booking.findById(booking).lean())!.start;
    await AccessCodeNotification.create({
      tenant,
      booking,
      user,
      accessCode: code,
      channel: "email",
      bookingStart: start,
      status: "cancelled",
    });
    const next = new Date(start.getTime() + 24 * 60 * 60_000);
    await accessCodeNotificationRepository.rearmForReschedule({
      tenantId: String(tenant),
      bookingId: booking,
      bookingStart: next,
    });
    expect(
      (await AccessCodeNotification.findOne({ booking }).lean())?.status,
    ).toBe("cancelled");
    await accessCodeNotificationRepository.rearmForReschedule({
      tenantId: String(tenant),
      bookingId: booking,
      bookingStart: next,
      transitionId: "staff-reactivation",
    });
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({
      status: "pending",
      bookingStart: next,
      deliveryHistory: [
        { status: "cancelled", transitionId: "staff-reactivation" },
      ],
    });
  });

  it("supersedes an expired unsubmitted claim without allowing its old completion to win", async () => {
    const start = (await Booking.findById(booking).lean())!.start;
    await AccessCodeNotification.create({
      tenant,
      booking,
      user,
      accessCode: code,
      channel: "email",
      bookingStart: start,
      status: "processing",
      leaseExpiresAt: new Date(0),
      providerAttemptStartedAt: null,
      claimToken: "expired-unsent-claim",
    });
    expect(
      await accessCodeNotificationRepository.hasInFlightDeliveryForBooking({
        tenantId: String(tenant),
        bookingId: booking,
      }),
    ).toBe(false);
    const next = new Date(start.getTime() + 24 * 60 * 60_000);
    await accessCodeNotificationRepository.rearmForReschedule({
      tenantId: String(tenant),
      bookingId: booking,
      bookingStart: next,
      transitionId: "expired-claim-move",
    });
    expect(
      await accessCodeNotificationRepository.isClaimActive({
        tenantId: String(tenant),
        bookingId: booking,
        bookingStart: start,
        claimToken: "expired-unsent-claim",
        now: new Date(),
      }),
    ).toBe(false);
    expect(
      await accessCodeNotificationRepository.markSent({
        tenantId: String(tenant),
        bookingId: booking,
        userId: user,
        accessCodeId: code,
        bookingStart: start,
        claimToken: "expired-unsent-claim",
        provider: "postmark",
        providerMessageId: "late-old-completion",
      }),
    ).toBe(false);
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({
      status: "pending",
      bookingStart: next,
      claimToken: "",
      providerMessageId: "",
      deliveryHistory: [],
    });
  });

  it("rejects a worker claim that races the rearm read without clearing it", async () => {
    const start = (await Booking.findById(booking).lean())!.start;
    await AccessCodeNotification.create({
      tenant,
      booking,
      user,
      accessCode: code,
      channel: "email",
      bookingStart: start,
      status: "pending",
      claimToken: "",
    });
    const updateOne = AccessCodeNotification.updateOne.bind(
      AccessCodeNotification,
    );
    const updateSpy = vi
      .spyOn(AccessCodeNotification, "updateOne")
      .mockImplementationOnce(((filter: any, update: any, options: any) => ({
        exec: async () => {
          await AccessCodeNotification.collection.updateOne(
            { booking },
            {
              $set: {
                status: "processing",
                claimToken: "racing-worker-claim",
                leaseExpiresAt: new Date(Date.now() + 60_000),
                updatedAt: new Date(),
              },
            },
          );
          return updateOne(filter, update, options).exec();
        },
      })) as any);
    try {
      await expect(
        accessCodeNotificationRepository.rearmForReschedule({
          tenantId: String(tenant),
          bookingId: booking,
          bookingStart: new Date(start.getTime() + 24 * 60 * 60_000),
          transitionId: "racing-move",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS",
      });
    } finally {
      updateSpy.mockRestore();
    }
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({
      status: "processing",
      bookingStart: start,
      claimToken: "racing-worker-claim",
      deliveryHistory: [],
    });
  });

  it.each([false, true])(
    "only sends a legacy-suppressed booking for its exact staff-owned occurrence (authorized=%s)",
    async (authorized) => {
      const start = (await Booking.findById(booking).lean())!.start;
      await Booking.updateOne(
        { _id: booking },
        {
          $set: {
            atelierKleiMigration: { suppressAccessNotifications: true },
            accessCodeStaffRescheduledStart: authorized
              ? start
              : new Date(start.getTime() - 1),
          },
        },
      );
      await sendAccessCodeNotifications();
      expect(transport.send).toHaveBeenCalledTimes(authorized ? 1 : 0);
      expect(
        (await Booking.findById(booking).select("+atelierKleiMigration").lean())
          ?.atelierKleiMigration,
      ).toMatchObject({ suppressAccessNotifications: true });
    },
  );

  it("rechecks the exact legacy override at the provider boundary", async () => {
    const start = (await Booking.findById(booking).lean())!.start;
    await Booking.updateOne(
      { _id: booking },
      {
        $set: {
          atelierKleiMigration: { suppressAccessNotifications: true },
          accessCodeStaffRescheduledStart: start,
        },
      },
    );
    const providerSubmitted = vi.fn();
    transport.send.mockImplementationOnce(async (input) => {
      await Booking.updateOne(
        { _id: booking },
        { $set: { accessCodeStaffRescheduledStart: new Date(0) } },
      );
      await input.beforeSend();
      providerSubmitted();
      return { provider: "postmark", providerMessageId: "must-not-send" };
    });
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledOnce();
    expect(providerSubmitted).not.toHaveBeenCalled();
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({ status: "failed", providerAttemptStartedAt: null });
  });

  it("recovers an unsent stale-start retry created across a reschedule without sending the old occurrence", async () => {
    const start = (await Booking.findById(booking).lean())!.start;
    await AccessCodeNotification.create({
      tenant,
      booking,
      user,
      accessCode: code,
      channel: "email",
      bookingStart: new Date(start.getTime() - 24 * 60 * 60_000),
      status: "failed",
      providerAttemptStartedAt: null,
      nextAttemptAt: new Date(0),
      claimToken: "old-unsent-claim",
    });
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledOnce();
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({ status: "sent", bookingStart: start });
  });

  it("selects currently valid inventory for the new occurrence instead of replaying a retired issued code", async () => {
    await sendAccessCodeNotifications();
    const original = await AccessCode.findById(code)
      .select("+entryCode")
      .lean();
    await AccessCode.updateOne({ _id: code }, { $set: { status: "retired" } });
    const replacement = new Types.ObjectId();
    await AccessCode.collection.insertOne({
      ...original!,
      _id: replacement,
      status: "available",
      entryCode: encryptAccessCode({
        tenantId: String(tenant),
        poolId: String(pool),
        entryCode: "replacement-test-code",
      }),
    } as any);
    const newStart = new Date(Date.now() + 13 * 60_000);
    await Booking.updateOne(
      { _id: booking },
      {
        $set: {
          start: newStart,
          end: new Date(newStart.getTime() + 60 * 60_000),
          accessCodeDelivery: { status: "idle" },
        },
      },
    );
    await accessCodeNotificationRepository.rearmForReschedule({
      tenantId: String(tenant),
      bookingId: booking,
      bookingStart: newStart,
      transitionId: "retired-code-move",
    });
    await sendAccessCodeNotifications();
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(
      await AccessCodeNotification.findOne({ booking }).lean(),
    ).toMatchObject({
      status: "sent",
      accessCode: replacement,
      deliveryHistory: [{ accessCode: code }],
    });
    expect(transport.send.mock.calls[1][0].text).toContain(
      "replacement-test-code",
    );
    expect(transport.send.mock.calls[1][0].text).not.toContain("test-7391");
  });
});
