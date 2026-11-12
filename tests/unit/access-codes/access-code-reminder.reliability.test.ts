import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  bookingFind: vi.fn(),
  bookingUpdateOne: vi.fn(),
  ownership: vi.fn(),
  consentFind: vi.fn(),
  suppressionFind: vi.fn(),
  eligibleUsers: vi.fn(),
  allowedUsers: vi.fn(),
  repo: {
    upsertPending: vi.fn(),
    claimForSending: vi.fn(),
    beginProviderAttempt: vi.fn(),
    markSent: vi.fn(),
    markKnownNotSent: vi.fn(),
    markSkipped: vi.fn(),
    markAmbiguous: vi.fn(),
    recoverStaleClaims: vi.fn(),
    areAllCompleted: vi.fn(),
  },
}));

vi.mock("@/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendEmail,
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
    updateOne: mocks.bookingUpdateOne,
  },
}));
vi.mock(
  "@/modules/communication-automations/services/communication-automation-ownership.service.js",
  () => ({
    hasCommunicationAutomationBookingReminderOwner: mocks.ownership,
  }),
);
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationConsentModel: { find: mocks.consentFind },
  CommunicationSuppressionModel: { find: mocks.suppressionFind },
}));
vi.mock(
  "@/modules/access-codes/course-reminder-delivery.repository.js",
  () => ({ courseReminderDeliveryRepository: mocks.repo }),
);
vi.mock("@/modules/access-codes/access-code.utils.js", () => ({
  formatDateTimeRange: vi.fn(() => "04.08.2026 12:00–14:00"),
}));
vi.mock(
  "@/modules/access-codes/services/access-code-reminder-policy.service.js",
  () => ({
    getEligibleLegacyCourseReminderUsers: mocks.eligibleUsers,
    getAllowedLegacyCourseReminderUsers: mocks.allowedUsers,
  }),
);

import {
  buildCourseReminderIdempotencyKey,
  buildCourseReminderMessageId,
  deliverClaimedCourseReminder,
  sendUpcomingCourseReminders,
} from "@/modules/access-codes/services/access-code-reminder.service.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");

const delivery = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: "delivery-1",
    tenant: "tenant-1",
    booking: "booking-1",
    recipientUser: "user-1",
    recipientEmail: "anna@example.com",
    idempotencyKey: "course-reminder-key-1",
    messageId: "<course-reminder-key-1@mail.shario.io>",
    subject: "Reminder",
    textContent: "Starts soon",
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    ...overrides,
  }) as any;

const deliverApproved = (row: any) =>
  deliverClaimedCourseReminder(row, async (claimed) => ({
    mail: {
      recipientEmail: claimed.recipientEmail,
      subject: claimed.subject,
      textContent: claimed.textContent,
    },
    skipReason: "",
  }));

const leanExec = <T>(value: T) => ({
  lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(value) })),
});

const bookingsQuery = <T>(value: T) => {
  const chain: Record<string, any> = {};
  chain.populate = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.lean = vi.fn().mockReturnValue(chain);
  chain.exec = vi.fn().mockResolvedValue(value);
  return chain;
};

describe("legacy course reminder delivery reliability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.sendEmail.mockResolvedValue({ providerMessageId: "smtp-message-1" });
    mocks.repo.recoverStaleClaims.mockResolvedValue({
      requeued: 0,
      ambiguous: 0,
    });
    mocks.repo.markSent.mockResolvedValue(true);
    mocks.repo.markKnownNotSent.mockResolvedValue(true);
    mocks.repo.markSkipped.mockResolvedValue(true);
    mocks.repo.markAmbiguous.mockResolvedValue(true);
    mocks.repo.areAllCompleted.mockResolvedValue(false);
    mocks.ownership.mockResolvedValue(false);
    mocks.eligibleUsers.mockImplementation(({ orders }) =>
      orders.map((order: any) => order.createdBy),
    );
    mocks.allowedUsers.mockImplementation(({ users }) => users);
    mocks.consentFind.mockReturnValue(leanExec([]));
    mocks.suppressionFind.mockReturnValue(leanExec([]));
    mocks.bookingUpdateOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    });
  });

  it("builds a deterministic occurrence key and RFC-style message ID", () => {
    const input = {
      tenantId: "tenant-1",
      bookingId: "booking-1",
      bookingStart: NOW,
      recipientUserId: "user-1",
    };
    const first = buildCourseReminderIdempotencyKey(input);
    expect(buildCourseReminderIdempotencyKey(input)).toBe(first);
    expect(first).toMatch(/^course-reminder-[a-f0-9]{64}$/);
    expect(buildCourseReminderMessageId(first)).toBe(`<${first}@mail.shario.io>`);
  });

  it("lets only one overlapping replica cross the provider boundary", async () => {
    const row = delivery();
    mocks.repo.claimForSending
      .mockResolvedValueOnce({ ...row, status: "sending" })
      .mockResolvedValueOnce(null);
    mocks.repo.beginProviderAttempt.mockResolvedValue({
      ...row,
      status: "sending",
      attempts: 1,
    });

    await expect(
      Promise.all([deliverApproved(row), deliverApproved(row)]),
    ).resolves.toEqual(
      expect.arrayContaining([
        { status: "sent", sent: true },
        { status: "already_claimed", sent: false },
      ]),
    );
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.repo.beginProviderAttempt).toHaveBeenCalledTimes(1);
  });

  it("sends the stable delivery metadata recorded in the outbox", async () => {
    const row = delivery();
    mocks.repo.claimForSending.mockResolvedValue({
      ...row,
      status: "sending",
    });
    mocks.repo.beginProviderAttempt.mockResolvedValue({
      ...row,
      status: "sending",
      attempts: 1,
    });

    await deliverApproved(row);

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "anna@example.com",
        messageId: "<course-reminder-key-1@mail.shario.io>",
        tenantId: "tenant-1",
        headers: {
          "Message-ID": "<course-reminder-key-1@mail.shario.io>",
          "X-Shario-Delivery-Key": "course-reminder-key-1",
          "X-Shario-Booking-Id": "booking-1",
          "X-Shario-Recipient-Id": "user-1",
        },
      }),
    );
  });

  it("terminally skips an invalid claimed source before the SMTP boundary", async () => {
    const row = delivery();
    mocks.repo.claimForSending.mockResolvedValue({
      ...row,
      status: "sending",
    });

    await expect(
      deliverClaimedCourseReminder(row, async () => ({
        mail: null,
        skipReason: "Recipient is now suppressed.",
      })),
    ).resolves.toEqual({ status: "skipped", sent: false });

    expect(mocks.repo.markSkipped).toHaveBeenCalledWith({
      tenant: "tenant-1",
      deliveryId: "delivery-1",
      claimToken: expect.any(String),
      reason: "Recipient is now suppressed.",
    });
    expect(mocks.repo.beginProviderAttempt).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("retries only SMTP failures known not to have sent", async () => {
    const row = delivery();
    const started = { ...row, status: "sending", attempts: 1 };
    mocks.repo.claimForSending.mockResolvedValue(started);
    mocks.repo.beginProviderAttempt.mockResolvedValue(started);
    mocks.sendEmail.mockRejectedValue(
      Object.assign(new Error("Authentication rejected"), { code: "EAUTH" }),
    );

    await expect(deliverApproved(row)).resolves.toEqual({
      status: "failed",
      sent: false,
    });
    expect(mocks.repo.markKnownNotSent).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "EAUTH",
        exhausted: false,
        nextAttemptAt: new Date("2026-08-04T12:00:30.000Z"),
      }),
    );
    expect(mocks.repo.markAmbiguous).not.toHaveBeenCalled();
  });

  it("stops automatic retries after the durable attempt budget is exhausted", async () => {
    const row = delivery({ attempts: 4, maxAttempts: 5 });
    const started = { ...row, status: "sending", attempts: 5 };
    mocks.repo.claimForSending.mockResolvedValue(started);
    mocks.repo.beginProviderAttempt.mockResolvedValue(started);
    mocks.sendEmail.mockRejectedValue(
      Object.assign(new Error("Authentication rejected"), { code: "EAUTH" }),
    );

    await deliverApproved(row);

    expect(mocks.repo.markKnownNotSent).toHaveBeenCalledWith(
      expect.objectContaining({
        exhausted: true,
        nextAttemptAt: null,
      }),
    );
  });

  it("quarantines an unknown provider outcome instead of blind retrying", async () => {
    const row = delivery();
    const started = { ...row, status: "sending", attempts: 1 };
    mocks.repo.claimForSending.mockResolvedValue(started);
    mocks.repo.beginProviderAttempt.mockResolvedValue(started);
    mocks.sendEmail.mockRejectedValue(
      Object.assign(new Error("Socket closed after DATA"), { command: "DATA" }),
    );

    await expect(deliverApproved(row)).resolves.toEqual({
      status: "ambiguous",
      sent: false,
    });
    expect(mocks.repo.markAmbiguous).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: expect.any(String),
        reason: expect.stringContaining("outcome is unknown"),
      }),
    );
    expect(mocks.repo.markKnownNotSent).not.toHaveBeenCalled();
  });

  it("never downgrades an accepted SMTP result when sent persistence fails", async () => {
    const row = delivery();
    const started = { ...row, status: "sending", attempts: 1 };
    mocks.repo.claimForSending.mockResolvedValue(started);
    mocks.repo.beginProviderAttempt.mockResolvedValue(started);
    mocks.repo.markSent.mockRejectedValue(new Error("database unavailable"));

    await expect(deliverApproved(row)).resolves.toEqual({
      status: "ambiguous",
      sent: false,
    });
    expect(mocks.repo.markAmbiguous).toHaveBeenCalled();
    expect(mocks.repo.markKnownNotSent).not.toHaveBeenCalled();
  });

  it("does not claim a recipient that was already sent", async () => {
    await expect(
      deliverApproved(delivery({ status: "sent" })),
    ).resolves.toEqual({ status: "sent", sent: false });
    expect(mocks.repo.claimForSending).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("keeps successful recipients terminal while retrying a different failed recipient", async () => {
    const first = delivery({
      _id: "delivery-a",
      recipientUser: "user-a",
      recipientEmail: "a@example.com",
      idempotencyKey: "key-a",
      messageId: "<key-a@mail.shario.io>",
    });
    const second = delivery({
      _id: "delivery-b",
      recipientUser: "user-b",
      recipientEmail: "b@example.com",
      idempotencyKey: "key-b",
      messageId: "<key-b@mail.shario.io>",
    });
    const byKey = new Map([
      ["key-a", first],
      ["key-b", second],
    ]);
    mocks.repo.claimForSending.mockImplementation(
      async ({ idempotencyKey }: { idempotencyKey: string }) => ({
        ...byKey.get(idempotencyKey),
        status: "sending",
      }),
    );
    mocks.repo.beginProviderAttempt.mockImplementation(
      async ({ deliveryId }: { deliveryId: string }) => ({
        ...(deliveryId === "delivery-a" ? first : second),
        status: "sending",
        attempts: 1,
      }),
    );
    mocks.sendEmail
      .mockResolvedValueOnce({ providerMessageId: "postmark-a" })
      .mockRejectedValueOnce(
        Object.assign(new Error("Recipient rejected"), {
          command: "RCPT TO",
        }),
      )
      .mockResolvedValueOnce({ providerMessageId: "postmark-b" });

    await deliverApproved(first);
    await deliverApproved(second);
    await deliverApproved({ ...first, status: "sent" });
    await deliverApproved({ ...second, status: "failed" });

    expect(mocks.sendEmail.mock.calls.map(([mail]) => mail.to)).toEqual([
      "a@example.com",
      "b@example.com",
      "b@example.com",
    ]);
  });

  it("runs stale-claim recovery during every scheduler tick", async () => {
    mocks.bookingFind.mockReturnValue(bookingsQuery([]));
    mocks.repo.recoverStaleClaims.mockResolvedValue({
      requeued: 1,
      ambiguous: 1,
    });

    await expect(sendUpcomingCourseReminders()).resolves.toBe(0);
    expect(mocks.repo.recoverStaleClaims).toHaveBeenCalledWith({ now: NOW });
  });

  it("does not create reminders or mark suppressed imported courses as sent", async () => {
    mocks.bookingFind.mockImplementation((query) => {
      expect(query["atelierKleiMigration.suppressHistoricalNotifications"])
        .toEqual({ $ne: true });
      return bookingsQuery([]);
    });

    await expect(sendUpcomingCourseReminders()).resolves.toBe(0);
    expect(mocks.repo.upsertPending).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateOne).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("rechecks migration suppression after a course reminder was selected", async () => {
    const booking = {
      _id: "booking-1", tenant: "tenant-1",
      start: new Date("2026-08-04T18:00:00.000Z"),
      end: new Date("2026-08-04T20:00:00.000Z"),
      orders: [{ createdBy: { _id: "user-1", email: "anna@example.com" } }],
    };
    mocks.bookingFind.mockImplementation((query) => {
      expect(query["atelierKleiMigration.suppressHistoricalNotifications"])
        .toEqual({ $ne: true });
      // Suppression was enabled after the initial scheduler snapshot.
      return bookingsQuery(query._id ? [] : [booking]);
    });
    mocks.repo.upsertPending.mockImplementation(async (input) => delivery(input));
    mocks.repo.claimForSending.mockResolvedValue(delivery({
      bookingStart: booking.start, status: "sending",
    }));
    mocks.repo.areAllCompleted.mockResolvedValue(true);

    await expect(sendUpcomingCourseReminders()).resolves.toBe(0);
    expect(mocks.repo.markSkipped).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining("no longer an eligible"),
    }));
    expect(mocks.repo.beginProviderAttempt).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateOne).toHaveBeenCalledWith(expect.objectContaining({
      "atelierKleiMigration.suppressHistoricalNotifications": { $ne: true },
    }), { $set: { wasReminderSent: true } });
  });

  it("sets the legacy booking flag only after every recipient row is complete", async () => {
    const rows = new Map<string, any>();
    const booking = {
      _id: "booking-1",
      tenant: "tenant-1",
      start: new Date("2026-08-04T18:00:00.000Z"),
      end: new Date("2026-08-04T20:00:00.000Z"),
      updatedAt: NOW,
      bookingProduct: { name: "Wheel course" },
      location: {
        _id: "location-1",
        name: "Studio",
        booking: { timezone: "Europe/Prague" },
      },
      orders: [
        {
          createdBy: {
            _id: "user-a",
            email: "a@example.com",
          },
        },
        {
          createdBy: {
            _id: "user-b",
            email: "b@example.com",
          },
        },
      ],
    };
    mocks.bookingFind.mockReturnValue(bookingsQuery([booking]));
    mocks.repo.upsertPending.mockImplementation(async (input: any) => {
      const existing = rows.get(input.idempotencyKey);
      if (existing) return existing;
      const row = delivery({
        ...input,
        _id: `delivery-${String(input.recipientUser)}`,
      });
      rows.set(input.idempotencyKey, row);
      return row;
    });
    mocks.repo.claimForSending.mockImplementation(
      async ({ idempotencyKey }: { idempotencyKey: string }) => {
        const row = rows.get(idempotencyKey);
        return row?.status === "sent" ? null : { ...row, status: "sending" };
      },
    );
    mocks.repo.beginProviderAttempt.mockImplementation(
      async ({ deliveryId }: { deliveryId: string }) => {
        const row = [...rows.values()].find(
          (candidate) => candidate._id === deliveryId,
        );
        return row ? { ...row, status: "sending", attempts: 1 } : null;
      },
    );
    mocks.repo.markSent.mockImplementation(
      async ({ deliveryId }: { deliveryId: string }) => {
        const row = [...rows.values()].find(
          (candidate) => candidate._id === deliveryId,
        );
        if (row) row.status = "sent";
        return Boolean(row);
      },
    );
    mocks.repo.areAllCompleted
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(sendUpcomingCourseReminders()).resolves.toBe(2);
    expect(mocks.bookingUpdateOne).not.toHaveBeenCalled();

    await expect(sendUpcomingCourseReminders()).resolves.toBe(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.bookingUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("completes a policy-blocked recipient as skipped without calling SMTP", async () => {
    const booking = {
      _id: "booking-policy",
      tenant: "tenant-1",
      start: new Date("2026-08-04T18:00:00.000Z"),
      end: new Date("2026-08-04T20:00:00.000Z"),
      updatedAt: NOW,
      bookingProduct: { name: "Wheel course" },
      location: {
        _id: "location-1",
        name: "Studio",
        booking: { timezone: "Europe/Prague" },
      },
      orders: [
        {
          createdBy: {
            _id: "user-policy",
            email: "policy@example.com",
          },
        },
      ],
    };
    mocks.bookingFind.mockReturnValue(bookingsQuery([booking]));
    mocks.allowedUsers
      .mockImplementationOnce(({ users }) => users)
      .mockImplementationOnce(() => []);
    mocks.repo.upsertPending.mockImplementation(async (input: any) =>
      delivery({ ...input, _id: "delivery-policy" }),
    );
    mocks.repo.claimForSending.mockImplementation(
      async ({ idempotencyKey }: { idempotencyKey: string }) =>
        delivery({
          _id: "delivery-policy",
          tenant: booking.tenant,
          booking: booking._id,
          bookingStart: booking.start,
          recipientUser: "user-policy",
          recipientEmail: "policy@example.com",
          idempotencyKey,
          status: "sending",
        }),
    );
    mocks.repo.areAllCompleted.mockResolvedValue(true);

    await expect(sendUpcomingCourseReminders()).resolves.toBe(0);

    expect(mocks.repo.markSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-policy",
        reason: expect.stringContaining("consent or suppression"),
      }),
    );
    expect(mocks.repo.beginProviderAttempt).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "booking-policy",
        status: "processed",
        paymentStatus: "CONFIRMED",
        start: booking.start,
        wasReminderSent: false,
      }),
      { $set: { wasReminderSent: true } },
    );
  });
});
