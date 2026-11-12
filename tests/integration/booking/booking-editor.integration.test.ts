import mongoose from "mongoose";
import express from "express";
import request from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const notifications = vi.hoisted(() => ({
  record: vi.fn(),
  dispatch: vi.fn(),
  promote: vi.fn(),
}));
vi.mock(
  "@/modules/booking/services/booking.customer-notification.service.js",
  () => ({
    recordBookingLifecycleEmailInSession: notifications.record,
    recordCourseParticipantCancellationEmailInSession: notifications.record,
    dispatchBookingLifecycleEmailSafely: notifications.dispatch,
  }),
);
vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  promoteWaitlistEntry: notifications.promote,
  reconcileWaitlistAfterDirectCourseBooking: vi.fn(),
}));

import Booking from "@/modules/booking/booking.model.js";
import Location from "@/modules/location/location.model.js";
import Product from "@/modules/product/product.model.js";
import User from "@/modules/user/user.model.js";
import { Order } from "@/modules/order/order.model.js";
import { getMyOrderConfirmation } from "@/modules/order/order.customer.service.js";
import { AccessCodeNotification } from "@/modules/access-codes/access-code.model.js";
import { WaitlistAuditModel } from "@/modules/waitlist/waitlist.model.js";
import {
  findBookingEditorCustomer,
  getBookingEditor,
  saveBookingEditor,
} from "@/modules/booking/booking.editor.service.js";
import { cancelPaidCourseParticipants } from "@/modules/booking/services/booking.course-participant-cancellation.service.js";
import {
  processCourseBookingsAfterPayment,
  processGuestIncreaseBookingsAfterPayment,
} from "@/modules/checkout/services/checkout.webhook.service.js";
import {
  cancelBookingWithRefund,
  resolveBookingRefundSnapshot,
} from "@/modules/booking/services/booking.refund.service.js";
import {
  getCustomerBookingCapabilities,
  getMyBooking,
  rescheduleMyBooking,
} from "@/modules/booking/booking.customer.service.js";
import { assertExtensionHours, resolveExtensionPrice } from "@/modules/booking/booking.extension.service.js";
import { getCustomerBookingRescheduleAvailability, rescheduleCustomerBooking } from "@/modules/booking/booking.customer.controller.js";
import { errorHandler } from "@/shared/http/errorHandler.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";

const ids = Object.fromEntries(
  [
    "tenant",
    "location",
    "product",
    "booking",
    "customer",
    "staff",
    "otherTenant",
    "otherCustomer",
    "order",
  ].map((key) => [key, new mongoose.Types.ObjectId()]),
);
const now = new Date("2035-01-01T09:00:00Z");
const start = new Date("2035-01-08T10:00:00Z");
const end = new Date("2035-01-08T12:00:00Z");
const context = {
  tenantId: String(ids.tenant),
  bookingId: String(ids.booking),
  actorUserId: String(ids.staff),
  now,
};
const models = [
  Booking,
  Location,
  Product,
  User,
  Order,
  AccessCodeNotification,
  WaitlistAuditModel,
];

describe("staff booking editor transaction boundary", () => {
  let replica: MongoMemoryReplSet;
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { autoIndex: false });
    await Promise.all(models.map((model) => model.createCollection()));
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });
  beforeEach(async () => {
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    notifications.record.mockReset().mockResolvedValue(null);
    notifications.dispatch.mockReset();
    notifications.promote.mockReset().mockResolvedValue(null);
    await User.collection.insertMany([
      {
        _id: ids.customer,
        tenant: ids.tenant,
        firstname: "Customer",
        lastname: "One",
        customId: "C-1",
        memberNumber: 1,
        tenantRole: "customer",
        platformRole: "none",
        isAccessGranted: true,
      },
      {
        _id: ids.staff,
        tenant: ids.tenant,
        firstname: "Staff",
        customId: "S-1",
        memberNumber: 2,
        tenantRole: "staff",
        isAccessGranted: true,
      },
      {
        _id: ids.otherCustomer,
        tenant: ids.otherTenant,
        firstname: "Other",
        customId: "C-OTHER",
        memberNumber: 3,
        tenantRole: "customer",
        isAccessGranted: true,
      },
    ] as any);
    await Location.collection.insertOne({
      _id: ids.location,
      tenant: ids.tenant,
      name: "Studio",
      isActive: true,
      booking: {
        enabled: true,
        timezone: "Europe/Prague",
        globalCapacity: 4,
        allowPublicOverlap: true,
        maxConcurrentOpenStudioBookings: 10,
        groupBookingBlocksAll: false,
        slotStepMinutes: 30,
      },
      openingHours: Object.fromEntries(
        [
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
        ].map((day) => [
          day,
          { isOpen: true, openTime: "06:00", closeTime: "22:00" },
        ]),
      ),
    } as any);
    await Product.collection.insertOne({
      _id: ids.product,
      tenant: ids.tenant,
      name: { EN: "Class" },
      maxNumberOfParticipants: 4,
      price: 250,
      currency: "CZK",
    } as any);
    await Booking.create({
      _id: ids.booking,
      tenant: ids.tenant,
      location: ids.location,
      createdBy: ids.customer,
      bookingProduct: ids.product,
      author: { name: "Customer", customId: "C-1", memberNumber: 1 },
      start,
      end,
      numberOfHours: 2,
      numberOfGuests: 2,
      tag: "class",
      status: "processed",
      paymentStatus: "CONFIRMED",
      bookingType: "public",
      note: "Old note",
      lecturer: "Old lecturer",
      orders: [ids.order],
      participants: [
        {
          firstname: "Customer",
          lastname: "One",
          order: ids.order,
          memberNumber: 1,
          customId: "C-1",
        },
        {
          firstname: "Customer_GUEST_1",
          lastname: "One_GUEST_1",
          order: ids.order,
        },
      ],
    });
  });
  const editor = () => getBookingEditor(context);
  const save = async (input: Record<string, unknown>) =>
    saveBookingEditor({
      ...context,
      input: { revision: (await editor()).revision, ...input },
    });

  const overnightCustomerApp = () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Inject the same authenticated identity shape used by production JWT
      // middleware; real controller validation and tenant-scoped services run.
      (req as any).userInfo = {
        id: String(ids.customer),
        tenant: String(ids.tenant),
      };
      next();
    });
    app.get(
      "/bookings/mine/:bookingId/reschedule/availability",
      getCustomerBookingRescheduleAvailability,
    );
    app.patch(
      "/bookings/mine/:bookingId/reschedule",
      rescheduleCustomerBooking,
    );
    app.use(errorHandler);
    return app;
  };

  const prepareOvernightBooking = async () => {
    const location: any = await Location.findById(ids.location).lean();
    const openingHours = Object.fromEntries(
      Object.keys(location.openingHours).map((day) => [
        day,
        { isOpen: true, openTime: "05:00", closeTime: "01:00" },
      ]),
    );
    await Location.updateOne({ _id: ids.location }, { $set: { openingHours } });
    await Booking.updateOne(
      { _id: ids.booking },
      {
        $set: {
          tag: "open-studio",
          participants: [],
          end: new Date("2035-01-08T11:00:00Z"),
          numberOfHours: 1,
        },
      },
    );
    return { ...location, openingHours };
  };

  it("saves the advertised after-midnight customer slot through real HTTP and preserves the closed gap", async () => {
    const location = await prepareOvernightBooking();
    const app = overnightCustomerApp();
    const path = `/bookings/mine/${ids.booking}/reschedule`;
    const availability = await request(app)
      .get(`${path}/availability`)
      .query({ date: "2035-01-08" });
    expect(availability.status).toBe(200);
    const midnight = availability.body.slots.find(
      (slot: any) => slot.start === "2035-01-08T23:00:00.000Z",
    );
    expect(midnight).toMatchObject({
      available: true,
      end: "2035-01-09T00:00:00.000Z",
    });
    const before: any = await Booking.findById(ids.booking).lean();
    const moved = await request(app)
      .patch(path)
      .send({ start: midnight.start });
    expect(moved.status).toBe(200);
    const stored: any = await Booking.findById(ids.booking).lean();
    expect(stored).toMatchObject({
      start: new Date(midnight.start),
      end: new Date(midnight.end),
      paymentStatus: before.paymentStatus,
      orders: before.orders,
      numberOfGuests: before.numberOfGuests,
    });
    expect(() =>
      assertExtensionHours(
        { start: midnight.start },
        location,
        new Date(midnight.end),
      ),
    ).not.toThrow();
    expect(() =>
      assertExtensionHours(
        { start: midnight.start },
        location,
        new Date("2035-01-09T00:30:00Z"),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CUSTOMER_BOOKING_EXTENSION_OUTSIDE_HOURS",
      }),
    );
    for (const start of ["2035-01-09T00:00:00Z", "2035-01-09T03:30:00Z"]) {
      const denied = await request(app).patch(path).send({ start });
      expect(denied.status).toBe(409);
      expect(denied.body.code).toBe(
        "CUSTOMER_BOOKING_RESCHEDULE_OUTSIDE_HOURS",
      );
      expect((await Booking.findById(ids.booking).lean())?.start).toEqual(
        stored.start,
      );
    }
    expect(
      (await request(app).patch(path).send({ start: "2035-01-09T04:00:00Z" }))
        .status,
    ).toBe(200);
  });

  it("still rejects a capacity-blocked after-midnight move in the real transaction", async () => {
    await prepareOvernightBooking();
    const original: any = await Booking.findById(ids.booking).lean();
    await Booking.create({
      ...original,
      _id: new mongoose.Types.ObjectId(),
      start: new Date("2035-01-08T23:00:00Z"),
      end: new Date("2035-01-09T00:00:00Z"),
      numberOfGuests: 4,
    });
    const app = overnightCustomerApp();
    const path = `/bookings/mine/${ids.booking}/reschedule`;
    const availability = await request(app)
      .get(`${path}/availability`)
      .query({ date: "2035-01-08" });
    expect(availability.status).toBe(200);
    expect(
      availability.body.slots.find(
        (slot: any) => slot.start === "2035-01-08T23:00:00.000Z",
      ).available,
    ).toBe(false);
    const denied = await request(app)
      .patch(path)
      .send({ start: "2035-01-08T23:00:00Z" });
    expect(denied.status).toBe(409);
    expect((await Booking.findById(ids.booking).lean())?.start).toEqual(
      original.start,
    );
  });

  it("clears metadata, names new guests, retains paid rows and derives active occupancy", async () => {
    const initial = await editor();
    expect(initial.participants.map((p) => p.id)).toEqual([
      "legacy-0",
      "legacy-1",
    ]);
    expect(initial.participants[1].unnamed).toBe(true);
    const result = await save({
      note: "",
      lecturer: "",
      participants: [
        { id: "legacy-0" },
        { name: "Guest", email: "guest@example.test" },
      ],
    });
    expect(result.booking).toMatchObject({
      note: "",
      lecturer: "",
      numberOfGuests: 2,
    });
    const stored = await Booking.findById(ids.booking).lean();
    expect(stored).toMatchObject({
      financialNumberOfGuests: 2,
      attendanceManaged: true,
      paymentStatus: "CONFIRMED",
      orders: [ids.order],
    });
    expect(stored?.participants).toHaveLength(3);
    expect(stored?.participants[1]).toMatchObject({
      participantId: "legacy-1",
      attendanceStatus: "removed",
      order: ids.order,
    });
    expect(stored?.participants[2]).toMatchObject({
      firstname: "Guest",
      email: "guest@example.test",
      source: "staff",
    });
    expect(notifications.record).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant records, platform/synthetic actors, and injected protected fields", async () => {
    await expect(
      getBookingEditor({ ...context, tenantId: String(ids.otherTenant) }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      save({ participants: [{ customerId: String(ids.otherCustomer) }] }),
    ).rejects.toMatchObject({ code: "BOOKING_EDITOR_CUSTOMER_NOT_FOUND" });
    for (const ineligible of [
      { platformRole: "support" },
      { isAccessGranted: false, customId: "G-12345678901234567890" },
    ]) {
      const customer = new mongoose.Types.ObjectId();
      await User.collection.insertOne({
        _id: customer,
        tenant: ids.tenant,
        firstname: "Ineligible",
        tenantRole: "customer",
        isAccessGranted: true,
        customId: "C-INELIGIBLE",
        ...ineligible,
      } as any);
      await expect(
        save({ participants: [{ customerId: String(customer) }] }),
      ).rejects.toMatchObject({ code: "BOOKING_EDITOR_CUSTOMER_NOT_FOUND" });
    }
    await expect(save({ numberOfGuests: 25 })).rejects.toMatchObject({
      code: "BOOKING_EDIT_INVALID",
    });
    await expect(
      save({ participants: [{ name: "Injected", order: String(ids.order) }] }),
    ).rejects.toMatchObject({ code: "BOOKING_EDIT_INVALID" });
    await expect(
      findBookingEditorCustomer({ ...context, identifier: "#0001" }),
    ).resolves.toMatchObject({
      customer: { id: String(ids.customer), memberNumber: 1 },
    });
    await expect(
      findBookingEditorCustomer({ ...context, identifier: "Customer" }),
    ).rejects.toMatchObject({ code: "BOOKING_EDITOR_CUSTOMER_NOT_FOUND" });
  });

  it("serializes simultaneous edits and rejects stale form replays", async () => {
    const initial = await editor();
    const attempts = await Promise.allSettled(
      ["A", "B"].map((name) =>
        saveBookingEditor({
          ...context,
          input: {
            revision: initial.revision,
            participants: [{ id: "legacy-0" }, { id: "legacy-1" }, { name }],
          },
        }),
      ),
    );
    expect(
      attempts.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        attempts.find(
          (value) => value.status === "rejected",
        ) as PromiseRejectedResult
      ).reason.code,
    ).toBe("BOOKING_EDIT_STALE");
    expect((await Booking.findById(ids.booking).lean())?.numberOfGuests).toBe(
      3,
    );
  });

  it("accounts for waitlist holds and rolls back all changes on capacity failure", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      {
        $set: {
          waitlistCapacityHolds: [
            {
              entry: new mongoose.Types.ObjectId(),
              offerGeneration: 1,
              expiresAt: end,
            },
          ],
        },
      },
    );
    await expect(
      save({
        note: "Must not persist",
        participants: [
          { id: "legacy-0" },
          { id: "legacy-1" },
          { name: "Third" },
          { name: "Fourth" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BOOKING_EDIT_CAPACITY_EXCEEDED" });
    expect((await Booking.findById(ids.booking).lean())?.note).toBe("Old note");
    expect((await Booking.findById(ids.booking).lean())?.numberOfGuests).toBe(
      2,
    );
  });

  it("does not oversell when staff addition races course checkout for the last place", async () => {
    await Product.updateOne(
      { _id: ids.product },
      { $set: { maxNumberOfParticipants: 3 } },
    );
    const initial = await editor();
    const results = await Promise.allSettled([
      saveBookingEditor({
        ...context,
        input: {
          revision: initial.revision,
          participants: [
            ...initial.participants.map(({ id }) => ({ id })),
            { name: "Third" },
          ],
        },
      }),
      checkoutRepository.reserveCourseCapacity({
        tenantId: String(ids.tenant),
        orderId: String(new mongoose.Types.ObjectId()),
        reservations: [
          {
            bookingId: String(ids.booking),
            productId: String(ids.product),
            quantity: 1,
            capacity: 3,
          },
        ],
        expiresAt: end,
        now,
      }),
    ]);
    expect(
      results.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    const stored = await Booking.findById(ids.booking).lean();
    expect(
      Number(stored?.numberOfGuests) +
        Array.from(stored?.capacityReservations ?? []).reduce(
          (sum: number, hold) => sum + hold.quantity,
          0,
        ),
    ).toBe(3);
  });

  it("keeps a removed paid place refundable without decrementing occupancy twice", async () => {
    await Order.create({
      _id: ids.order,
      cart: new mongoose.Types.ObjectId(),
      tenant: ids.tenant,
      createdBy: ids.customer,
      status: "processed_order",
      isPaid: true,
      currency: "CZK",
      grossAmountMinor: 0,
      expectedAmountMinor: 0,
      courseBookings: [{ bookingId: ids.booking, quantity: 2 }],
      lineItems: [
        {
          booking: ids.booking,
          product: ids.product,
          description: "Class",
          quantity: 2,
          unitGrossMinor: 0,
          grossAmountMinor: 0,
          netAmountMinor: 0,
          taxAmountMinor: 0,
          taxRateBps: 0,
          locationIds: [ids.location],
        },
      ],
      paymentAllocations: [{ method: "free", amountMinor: 0 }],
    });
    await save({ participants: [{ name: "Unrelated guest" }] });
    const cancelled = await cancelPaidCourseParticipants({
      tenantId: context.tenantId,
      sessionId: context.bookingId,
      orderId: String(ids.order),
      actorUserId: String(ids.staff),
      reason: "Separate payment cancellation",
      now,
    });
    expect(cancelled.removedParticipants).toBe(0);
    expect((await Booking.findById(ids.booking).lean())?.numberOfGuests).toBe(
      1,
    );
    expect(
      (await Order.findById(ids.order).lean())?.courseCancellations[0],
    ).toMatchObject({ quantity: 2, releasedQuantity: 0 });
    await expect(
      cancelPaidCourseParticipants({
        tenantId: context.tenantId,
        sessionId: context.bookingId,
        orderId: String(ids.order),
        actorUserId: String(ids.staff),
        reason: "Replay",
        now,
      }),
    ).resolves.toMatchObject({ idempotent: true, removedParticipants: 0 });
    await processCourseBookingsAfterPayment(
      {
        _id: ids.order,
        createdBy: ids.customer,
        customer: { firstname: "Customer", lastname: "One" },
        courseBookings: [{ bookingId: ids.booking, quantity: 2 }],
      } as any,
      { tenantId: String(ids.tenant) },
    );
    expect((await Booking.findById(ids.booking).lean())?.numberOfGuests).toBe(
      1,
    );
  });

  it("preserves legacy refunds, prices explicit extensions for attendees, and synchronizes later paid increases", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      { $set: { tag: "open-studio", participants: [] } },
    );
    const result = await save({ participants: [{ id: "legacy-place-0" }] });
    expect(result.booking.numberOfGuests).toBe(1);
    const stored: any = await Booking.findById(ids.booking).lean();
    expect(
      resolveBookingRefundSnapshot(
        {
          ...stored,
          bookingProduct: { _id: ids.product, price: 250, currency: "CZK" },
          orders: [],
        },
        "CZK",
      ).refundAmount,
    ).toBe(1000);
    expect(
      resolveExtensionPrice(stored, { price: 250, currency: "CZK" }, [], 30)
        .amountMinor,
    ).toBe(25000);
    const paidOrder = new mongoose.Types.ObjectId();
    await processGuestIncreaseBookingsAfterPayment(
      {
        _id: paidOrder,
        guestIncreaseBookings: [{ bookingId: ids.booking, addGuests: 1 }],
      } as any,
      { tenantId: String(ids.tenant) },
    );
    await processGuestIncreaseBookingsAfterPayment(
      {
        _id: paidOrder,
        guestIncreaseBookings: [{ bookingId: ids.booking, addGuests: 1 }],
      } as any,
      { tenantId: String(ids.tenant) },
    );
    const after = await Booking.findById(ids.booking).lean();
    expect(after).toMatchObject({
      numberOfGuests: 2,
      financialNumberOfGuests: 3,
    });
    expect(
      after?.participants.filter((p) => p.attendanceStatus !== "removed"),
    ).toHaveLength(2);
  });

  it.each(["issued", "legacy"])(
    "moves a paid %s-access booking without reopening customer edits or losing its history",
    async (source) => {
      await Order.collection.insertOne({
        _id: ids.order,
        tenant: ids.tenant,
        createdBy: ids.customer,
        workshopBookings: [ids.booking],
        isPaid: true,
        status: "processed",
        currency: "CZK",
      } as any);
      await Booking.updateOne(
        { _id: ids.booking },
        {
          $set: {
            tag: "workshop",
            participants: [],
            ...(source === "legacy"
              ? { "atelierKleiMigration.suppressAccessNotifications": true }
              : { accessCodeDelivery: { status: "sent", deliveredAt: now } }),
          },
        },
      );
      if (source === "issued") {
        await AccessCodeNotification.create({
          tenant: ids.tenant,
          booking: ids.booking,
          user: ids.customer,
          accessCode: new mongoose.Types.ObjectId(),
          channel: "email",
          bookingStart: start,
          status: "sent",
          sentAt: now,
          provider: "postmark",
          providerAttemptStartedAt: now,
          providerMessageId: "original-delivery",
          claimToken: "original-claim",
          recipientEmail: "customer@example.test",
        });
      }
      const current = await editor();
      expect(current.capabilities).toMatchObject({
        canEditParticipants: true,
        canReschedule: true,
      });
      const nextStart = new Date("2035-01-09T11:00:00Z");
      const nextEnd = new Date("2035-01-09T13:00:00Z");
      const result = await saveBookingEditor({
        ...context,
        input: {
          revision: current.revision,
          start: nextStart.toISOString(),
          end: nextEnd.toISOString(),
        },
      });
      expect(result.booking).toMatchObject({
        start: nextStart,
        end: nextEnd,
        paymentStatus: "CONFIRMED",
        numberOfGuests: 2,
      });
      const stored = await Booking.findById(ids.booking)
        .select("+atelierKleiMigration +scheduleChangeHistory")
        .lean();
      expect(stored).toMatchObject({
        orders: [ids.order],
        createdBy: ids.customer,
        paymentStatus: "CONFIRMED",
        numberOfGuests: 2,
        accessCodeDelivery: { status: "idle", deliveredAt: null },
        accessCodeCustomerModificationLockedAt: now,
        accessCodeStaffRescheduledStart: nextStart,
      });
      expect(Number(stored?.numberOfHours)).toBe(2);
      expect(stored?.scheduleChangeHistory).toHaveLength(1);
      expect(stored?.scheduleChangeHistory[0]).toMatchObject({
        actor: ids.staff,
        changedAt: now,
        previousStart: start,
        previousEnd: end,
        nextStart,
        nextEnd,
        legacyAccessSuppressed: source === "legacy",
      });
      const transitionId = stored?.scheduleChangeHistory[0].transitionId;
      expect(transitionId).toBeTruthy();
      if (source === "legacy") {
        expect(stored?.atelierKleiMigration).toMatchObject({
          suppressAccessNotifications: true,
        });
      } else {
        const notification = await AccessCodeNotification.findOne({
          booking: ids.booking,
        }).lean();
        expect(notification).toMatchObject({
          status: "pending",
          bookingStart: nextStart,
        });
        expect(notification?.deliveryHistory).toEqual([
          expect.objectContaining({
            providerMessageId: "original-delivery",
            claimToken: "original-claim",
            bookingStart: start,
            status: "sent",
            transitionId,
          }),
        ]);
      }
      expect(notifications.record).toHaveBeenCalledOnce();
      expect(notifications.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "rescheduled",
          userId: String(ids.customer),
          transitionKey: transitionId,
        }),
        expect.anything(),
      );
      expect(getCustomerBookingCapabilities(stored!, now)).toMatchObject({
        canCancel: false,
        canReschedule: false,
      });
      expect(
        await getMyBooking({
          tenantId: context.tenantId,
          userId: String(ids.customer),
          bookingId: context.bookingId,
        }),
      ).toMatchObject({
        canCancel: false,
        canReschedule: false,
        location: { arrival: { accessCodeDelivered: false } },
      });
      expect(
        await getMyOrderConfirmation({
          tenantId: context.tenantId,
          userId: String(ids.customer),
          orderId: String(ids.order),
        }),
      ).toMatchObject({
        bookings: [
          {
            canCancel: false,
            canReschedule: false,
            location: { arrival: { accessCodeDelivered: false } },
          },
        ],
      });
      await expect(
        rescheduleMyBooking({
          tenantId: context.tenantId,
          userId: String(ids.customer),
          bookingId: context.bookingId,
          start: new Date("2035-01-10T11:00:00Z"),
          now,
        }),
      ).rejects.toMatchObject({
        code: "CUSTOMER_BOOKING_RESCHEDULE_NOT_ALLOWED",
      });
      await expect(
        cancelBookingWithRefund({
          tenantId: context.tenantId,
          userId: ids.customer,
          bookingId: ids.booking,
        }),
      ).rejects.toMatchObject({ code: "BOOKING_ACCESS_ALREADY_ISSUED" });
      await expect(
        saveBookingEditor({
          ...context,
          input: {
            revision: current.revision,
            start: nextStart.toISOString(),
            end: nextEnd.toISOString(),
          },
        }),
      ).rejects.toMatchObject({ code: "BOOKING_EDIT_STALE" });
      expect(notifications.record).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["processing", new Date("2035-01-01T09:15:00Z"), null],
    ["processing", new Date("2035-01-01T08:55:00Z"), now],
    ["delivery_unknown", null, now],
  ] as const)(
    "blocks %s access delivery with lease %s and provider attempt %s before any schedule write",
    async (status, leaseExpiresAt, providerAttemptStartedAt) => {
      await Booking.updateOne(
        { _id: ids.booking },
        { $set: { tag: "open-studio", participants: [] } },
      );
      await AccessCodeNotification.create({
        tenant: ids.tenant,
        booking: ids.booking,
        user: ids.customer,
        accessCode: new mongoose.Types.ObjectId(),
        channel: "email",
        bookingStart: start,
        status,
        leaseExpiresAt,
        providerAttemptStartedAt,
        claimToken: "busy-claim",
      });
      expect((await editor()).capabilities).toMatchObject({
        canReschedule: false,
        scheduleReason: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS",
      });
      await expect(
        save({
          start: "2035-01-09T11:00:00Z",
          end: "2035-01-09T13:00:00Z",
          note: "Must roll back",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS",
      });
      const stored = await Booking.findById(ids.booking)
        .select("+scheduleChangeHistory")
        .lean();
      expect(stored).toMatchObject({
        start,
        end,
        note: "Old note",
        scheduleChangeHistory: [],
        accessCodeCustomerModificationLockedAt: null,
      });
      expect(notifications.record).not.toHaveBeenCalled();
      await expect(save({ note: "Review delivery" })).resolves.toMatchObject({
        booking: { note: "Review delivery" },
      });
    },
  );

  it("also blocks a booking-level ambiguous delivery without a notification row", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      {
        $set: {
          tag: "open-studio",
          participants: [],
          accessCodeDelivery: { status: "delivery_unknown" },
        },
      },
    );
    expect((await editor()).capabilities).toMatchObject({
      scheduleReason: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS",
    });
    await expect(
      save({ start: "2035-01-09T11:00:00Z", end: "2035-01-09T13:00:00Z" }),
    ).rejects.toMatchObject({
      code: "BOOKING_EDIT_ACCESS_DELIVERY_IN_PROGRESS",
    });
  });

  it("rolls back an issued-access move when the new date is unavailable", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      {
        $set: {
          tag: "open-studio",
          participants: [],
          accessCodeDelivery: { status: "sent", deliveredAt: now },
        },
      },
    );
    const source = await Booking.findById(ids.booking).lean();
    const neighborId = new mongoose.Types.ObjectId();
    await Booking.collection.insertOne({
      ...source!,
      _id: neighborId,
      start: new Date("2035-01-09T11:00:00Z"),
      end: new Date("2035-01-09T13:00:00Z"),
      bookingType: "private",
      bookingMode: "private",
    } as any);
    await expect(
      save({
        start: "2035-01-09T11:00:00Z",
        end: "2035-01-09T13:00:00Z",
        note: "Rejected move",
      }),
    ).rejects.toMatchObject({ code: "BOOKING_EDIT_CAPACITY_EXCEEDED" });
    expect(
      await Booking.findById(ids.booking)
        .select("+scheduleChangeHistory")
        .lean(),
    ).toMatchObject({
      start,
      end,
      note: "Old note",
      accessCodeDelivery: { status: "sent" },
      accessCodeCustomerModificationLockedAt: null,
      scheduleChangeHistory: [],
      orders: [ids.order],
    });
    expect(notifications.record).not.toHaveBeenCalled();
  });

  it("commits one audit and notice when two staff moves race on issued access", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      {
        $set: {
          tag: "open-studio",
          participants: [],
          accessCodeDelivery: { status: "sent", deliveredAt: now },
        },
      },
    );
    const current = await editor();
    const attempts = await Promise.allSettled(
      [9, 10].map((day) =>
        saveBookingEditor({
          ...context,
          input: {
            revision: current.revision,
            start: `2035-01-${String(day).padStart(2, "0")}T11:00:00Z`,
            end: `2035-01-${String(day).padStart(2, "0")}T13:00:00Z`,
          },
        }),
      ),
    );
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        attempts.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason.code,
    ).toBe("BOOKING_EDIT_STALE");
    const stored = await Booking.findById(ids.booking)
      .select("+scheduleChangeHistory")
      .lean();
    expect(stored?.scheduleChangeHistory).toHaveLength(1);
    expect(stored?.accessCodeCustomerModificationLockedAt).toEqual(now);
    expect(notifications.record).toHaveBeenCalledOnce();
  });

  it("keeps metadata editable when a legacy roster requires manual review", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      { $set: { numberOfGuests: 1 } },
    );
    expect((await editor()).capabilities).toMatchObject({
      canEdit: true,
      canEditParticipants: false,
    });
    await expect(save({ note: "Review this roster" })).resolves.toMatchObject({
      booking: { note: "Review this roster", numberOfGuests: 1 },
    });
  });

  it("moves a course through opening-hours validation without changing sold orders or emailing staff", async () => {
    const result = await save({
      start: "2035-01-08T10:30:00Z",
      end: "2035-01-08T12:30:00Z",
    });
    expect(new Date(result.booking.start).toISOString()).toBe(
      "2035-01-08T10:30:00.000Z",
    );
    expect((await Booking.findById(ids.booking).lean())?.orders).toEqual([
      ids.order,
    ]);
    expect(result.booking.paymentStatus).toBe("CONFIRMED");
    expect(notifications.record).not.toHaveBeenCalled();
    await expect(
      save({ start: "2035-01-08T23:00:00Z", end: "2035-01-09T01:00:00Z" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("locks course schedule while a waitlist offer is outstanding, but permits an attendance reduction", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      {
        $set: {
          waitlistCapacityHolds: [
            {
              entry: new mongoose.Types.ObjectId(),
              offerGeneration: 1,
              expiresAt: end,
            },
          ],
        },
      },
    );
    expect((await editor()).capabilities).toMatchObject({
      canReschedule: false,
      canEditParticipants: true,
      scheduleReason: "BOOKING_EDIT_PAYMENT_IN_PROGRESS",
    });
    await expect(
      save({ start: "2035-01-08T10:30:00Z", end: "2035-01-08T12:30:00Z" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      save({ participants: [{ id: "legacy-0" }] }),
    ).resolves.toMatchObject({ booking: { numberOfGuests: 1 } });
  });

  it("prevents paid studio duration edits and rearms a legitimate move", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      { $set: { tag: "open-studio", participants: [] } },
    );
    await expect(save({ end: "2035-01-08T13:00:00Z" })).rejects.toMatchObject({
      code: "BOOKING_EDIT_DURATION_REQUIRES_PAYMENT_WORKFLOW",
    });
    await save({ start: "2035-01-08T10:30:00Z", end: "2035-01-08T12:30:00Z" });
    const stored = await Booking.findById(ids.booking).lean();
    expect(Number(stored?.numberOfHours)).toBe(2);
    expect(stored?.accessCodeDelivery?.status).toBe("idle");
    expect(notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: String(ids.customer),
        event: "rescheduled",
      }),
      expect.anything(),
    );
  });

  it("adds an exact registered customer and rejects duplicate customer seats", async () => {
    const customer = new mongoose.Types.ObjectId();
    await User.collection.insertOne({
      _id: customer,
      tenant: ids.tenant,
      firstname: "Registered",
      lastname: "Guest",
      customId: "C-42",
      memberNumber: 42,
      tenantRole: "customer",
      isAccessGranted: true,
    } as any);
    const found = await findBookingEditorCustomer({
      ...context,
      identifier: "C-42",
    });
    expect(found.customer.id).toBe(String(customer));
    const result = await save({
      participants: [
        { id: "legacy-0" },
        { id: "legacy-1" },
        { customerId: String(customer) },
      ],
    });
    expect(result.participants[2]).toMatchObject({
      customerId: String(customer),
      memberNumber: 42,
      name: "Registered Guest",
    });
    await expect(
      save({
        participants: [
          ...result.participants.map(({ id }) => ({ id })),
          { customerId: String(customer) },
        ],
      }),
    ).rejects.toMatchObject({ code: "BOOKING_EDIT_INVALID" });
    expect((await Booking.findById(ids.booking).lean())?.numberOfGuests).toBe(
      3,
    );
  });

  it("allows active owner and staff identities that can book in customer mode", async () => {
    await User.updateOne(
      { _id: ids.staff },
      { $set: { tenantRole: "owner", memberNumber: 9999 } },
    );
    await expect(
      findBookingEditorCustomer({ ...context, identifier: "#9999" }),
    ).resolves.toMatchObject({ customer: { id: String(ids.staff) } });
    const result = await save({
      participants: [{ id: "legacy-0" }, { customerId: String(ids.staff) }],
    });
    expect(result.participants[1]).toMatchObject({
      customerId: String(ids.staff),
      memberNumber: 9999,
    });
    await User.updateOne({ _id: ids.staff }, { $set: { tenantRole: "staff" } });
    await expect(
      findBookingEditorCustomer({ ...context, identifier: "#9999" }),
    ).resolves.toMatchObject({ customer: { id: String(ids.staff) } });
  });

  it("detects scalar edits even when timestamp and array version have not changed", async () => {
    const initial = await editor();
    await Booking.updateOne(
      { _id: ids.booking },
      { $set: { note: "Changed in the same millisecond" } },
      { timestamps: false },
    );
    await expect(
      saveBookingEditor({
        ...context,
        input: { revision: initial.revision, lecturer: "Stale form" },
      }),
    ).rejects.toMatchObject({ code: "BOOKING_EDIT_STALE" });
    expect((await Booking.findById(ids.booking).lean())?.lecturer).toBe(
      "Old lecturer",
    );
  });

  it("preserves an expired but still consumable course payment hold while allowing reduction", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      {
        $set: {
          capacityReservations: [
            {
              order: new mongoose.Types.ObjectId(),
              quantity: 1,
              expiresAt: new Date("2034-12-31T00:00:00Z"),
            },
          ],
        },
      },
    );
    const current = await editor();
    expect(current.capabilities).toMatchObject({
      canEditParticipants: true,
      canAddParticipants: false,
      canReschedule: false,
      addParticipantsReason: "BOOKING_EDIT_PAYMENT_IN_PROGRESS",
    });
    await expect(
      save({
        participants: [
          ...current.participants.map(({ id }) => ({ id })),
          { name: "Late checkout race" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BOOKING_EDIT_PAYMENT_IN_PROGRESS" });
    await expect(
      save({ participants: [{ id: "legacy-0" }] }),
    ).resolves.toMatchObject({ booking: { numberOfGuests: 1 } });
    expect(
      (await Booking.findById(ids.booking).lean())?.capacityReservations,
    ).toHaveLength(1);
  });

  it("retains the implicit owner of an older zero-guest studio visit", async () => {
    await Booking.updateOne(
      { _id: ids.booking },
      { $set: { tag: "open-studio", numberOfGuests: 0, participants: [] } },
    );
    const current = await editor();
    expect(current.booking.numberOfGuests).toBe(1);
    expect(current.participants).toHaveLength(1);
    expect(current.participants[0]).toMatchObject({
      id: "legacy-place-0",
      customerId: String(ids.customer),
      memberNumber: 1,
    });
    await save({ participants: [{ id: "legacy-place-0" }, { name: "Guest" }] });
    const updated: any = await Booking.findById(ids.booking).lean();
    expect(updated).toMatchObject({
      numberOfGuests: 2,
      financialNumberOfGuests: 0,
    });
    expect(
      resolveBookingRefundSnapshot(
        {
          ...updated,
          bookingProduct: { _id: ids.product, price: 250, currency: "CZK" },
          orders: [],
        },
        "CZK",
      ).refundAmount,
    ).toBe(500);
    await processGuestIncreaseBookingsAfterPayment(
      {
        _id: new mongoose.Types.ObjectId(),
        guestIncreaseBookings: [{ bookingId: ids.booking, addGuests: 1 }],
      },
      { tenantId: String(ids.tenant) },
    );
    expect(await Booking.findById(ids.booking).lean()).toMatchObject({
      numberOfGuests: 3,
      financialNumberOfGuests: 2,
    });
  });
});
