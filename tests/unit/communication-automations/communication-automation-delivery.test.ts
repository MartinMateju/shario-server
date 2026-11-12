import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFind: vi.fn(),
  userFindOne: vi.fn(),
  consentFind: vi.fn(),
  suppressionFind: vi.fn(),
  templateFindOne: vi.fn(),
  upsertScheduled: vi.fn(),
  markQueued: vi.fn(),
  markQueueStateAmbiguous: vi.fn(),
  enqueue: vi.fn(),
}));

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["select", "sort", "limit"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.lean = vi.fn().mockResolvedValue(value);
  return chain;
};

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    find: mocks.userFind,
    findOne: mocks.userFindOne,
  },
}));
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationConsentModel: { find: mocks.consentFind },
  CommunicationSuppressionModel: { find: mocks.suppressionFind },
}));
vi.mock("@/modules/email-template/email-template.model.js", () => ({
  default: { findOne: mocks.templateFindOne },
}));
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.repository.js",
  () => ({
    communicationEmailLogRepository: {
      upsertScheduled: mocks.upsertScheduled,
      markQueued: mocks.markQueued,
      markQueueStateAmbiguous: mocks.markQueueStateAmbiguous,
    },
  }),
);
vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  enqueueCommunicationEmail: mocks.enqueue,
}));

import {
  materializeAutomationDeliveries,
  resolveAutomationRecipients,
} from "@/modules/communication-automations/services/communication-automation-delivery.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const AUTOMATION_ID = "507f191e810c19729de860ea";
const SENDER_ID = "507f191e810c19729de860eb";
const USER_ID = "507f191e810c19729de860ec";

describe("communication automation delivery policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFind.mockReturnValue(query([]));
    mocks.userFindOne.mockReturnValue(query(null));
    mocks.consentFind.mockReturnValue(query([]));
    mocks.suppressionFind.mockReturnValue(query([]));
    mocks.markQueued.mockResolvedValue(true);
    mocks.markQueueStateAmbiguous.mockResolvedValue(true);
    mocks.enqueue.mockResolvedValue({
      job: { id: "job" },
      state: "waiting",
      action: "submitted",
      queueAccepted: true,
      newlyQueued: true,
    });
  });

  it("broadcasts only to eligible customers and does not require marketing consent for transactional mail", async () => {
    mocks.userFind.mockReturnValue(
      query([
        {
          _id: USER_ID,
          firstname: "Ada",
          lastname: "Lovelace",
          email: "ADA@example.com",
        },
      ]),
    );

    const recipients = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: {
        sendToAllRecipients: true,
        purpose: "transactional",
        defaultLocale: "en",
      },
    });

    expect(mocks.userFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantRole: "customer",
        isAccessGranted: { $ne: false },
      }),
    );
    expect(mocks.consentFind).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "transactional",
        customerId: { $in: [USER_ID] },
      }),
    );
    expect(recipients).toEqual([
      expect.objectContaining({
        email: "ada@example.com",
        allowed: true,
        reason: "transactional_necessity",
      }),
    ]);
  });

  it("excludes removed course attendance from reminders without suppressing purchase confirmations", async () => {
    const booking = {
      tag: "class",
      attendanceManaged: true,
      participants: [{ order: "order-id", attendanceStatus: "removed" }],
      orders: [{
        _id: "order-id", isPaid: true,
        createdBy: { _id: USER_ID, tenant: TENANT_ID, tenantRole: "customer", email: "ada@example.com" },
      }],
    };
    expect(await resolveAutomationRecipients({ tenantId: TENANT_ID, booking, automation: { scheduleType: "beforeBooking" } })).toEqual([]);
    expect(await resolveAutomationRecipients({ tenantId: TENANT_ID, booking, automation: { scheduleType: "afterBookingCreated" } })).toEqual([
      expect.objectContaining({ userId: USER_ID, email: "ada@example.com", allowed: true }),
    ]);
    expect(mocks.userFindOne).not.toHaveBeenCalled();
  });

  it("requires marketing opt-in and always applies suppression", async () => {
    mocks.userFindOne.mockReturnValue(
      query({
        _id: USER_ID,
        firstname: "Ada",
        lastname: "Lovelace",
        email: "ada@example.com",
      }),
    );

    const marketing = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: { purpose: "marketing", defaultLocale: "en" },
      sourceRecipientUserId: USER_ID,
    });
    expect(marketing[0]).toMatchObject({
      allowed: false,
      reason: "marketing_opt_in_required",
    });

    mocks.suppressionFind.mockReturnValue(
      query([{ identity: "ada@example.com" }]),
    );
    const transactional = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: { purpose: "transactional", defaultLocale: "en" },
      sourceRecipientUserId: USER_ID,
    });
    expect(transactional[0]).toMatchObject({
      allowed: false,
      reason: "recipient_suppressed",
    });
  });

  it("honors revoked and expired transactional consent", async () => {
    mocks.userFindOne.mockReturnValue(
      query({
        _id: USER_ID,
        firstname: "Ada",
        lastname: "Lovelace",
        email: "ada@example.com",
      }),
    );
    mocks.consentFind.mockReturnValue(
      query([
        {
          customerId: USER_ID,
          status: "revoked",
        },
      ]),
    );

    const revoked = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: { purpose: "transactional", defaultLocale: "en" },
      sourceRecipientUserId: USER_ID,
    });
    expect(revoked[0]).toMatchObject({
      allowed: false,
      reason: "consent_revoked",
    });

    mocks.consentFind.mockReturnValue(
      query([
        {
          customerId: USER_ID,
          status: "granted",
          expiresAt: "2026-07-01T00:00:00.000Z",
        },
      ]),
    );
    const expired = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: { purpose: "transactional", defaultLocale: "en" },
      sourceRecipientUserId: USER_ID,
    });
    expect(expired[0]).toMatchObject({
      allowed: false,
      reason: "consent_expired",
    });
  });

  it("derives course recipients from paid customer orders instead of the staff booking creator", async () => {
    const secondUserId = "507f191e810c19729de860dd";
    const recipients = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: { purpose: "transactional", defaultLocale: "en" },
      booking: {
        createdBy: "507f191e810c19729de860ff",
        language: "en",
        orders: [
          {
            _id: "507f191e810c19729de860f1",
            isPaid: true,
            createdBy: {
              _id: USER_ID,
              tenant: TENANT_ID,
              tenantRole: "customer",
              firstname: "Ada",
              lastname: "Lovelace",
              email: "ada@example.com",
            },
          },
          {
            _id: "507f191e810c19729de860f2",
            isPaid: true,
            createdBy: {
              _id: secondUserId,
              tenant: TENANT_ID,
              tenantRole: "customer",
              firstname: "Grace",
              lastname: "Hopper",
              email: "grace@example.com",
            },
          },
          {
            _id: "507f191e810c19729de860f3",
            isPaid: false,
            createdBy: {
              _id: "507f191e810c19729de860f4",
              tenant: TENANT_ID,
              tenantRole: "customer",
              email: "unpaid@example.com",
            },
          },
        ],
      },
    });

    expect(recipients.map((recipient) => recipient.email)).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
    expect(mocks.userFindOne).not.toHaveBeenCalled();
  });

  it.each(["course", "class"])("does not fall back to the %s creator when there is no paid purchaser", async (tag) => {
    const recipients = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: { purpose: "transactional", defaultLocale: "en" },
      booking: {
        tag,
        createdBy: "507f191e810c19729de860ff",
        orders: [{ isPaid: false, createdBy: USER_ID }],
      },
    });

    expect(recipients).toEqual([]);
    expect(mocks.userFindOne).not.toHaveBeenCalled();
  });

  it("sends a booking confirmation only to its order purchaser and records that order", async () => {
    const sourceOrderId = "507f191e810c19729de860ed";
    const paidAt = new Date("2026-10-12T10:00:00Z");
    const booking = {
      _id: "507f191e810c19729de860ee", tag: "class",
      orders: [
        { _id: sourceOrderId, isPaid: true, paidAt, createdBy: {
          _id: USER_ID, tenant: TENANT_ID, email: "ada@example.com", tenantRole: "customer",
        } },
        { _id: "507f191e810c19729de860ef", isPaid: true, paidAt, createdBy: {
          _id: "507f191e810c19729de860fa", tenant: TENANT_ID,
          email: "other@example.com", tenantRole: "customer",
        } },
      ],
    };
    mocks.upsertScheduled.mockResolvedValue({
      created: true, log: { _id: "507f191e810c19729de860fb", status: "scheduled" },
    });
    await expect(materializeAutomationDeliveries({
      tenantId: TENANT_ID,
      automation: {
        _id: AUTOMATION_ID, senderEmail: SENDER_ID, scheduleType: "afterBookingCreated",
        subject: "Booking confirmed", body: "Your place is reserved.",
        defaultLocale: "en", appliesToAllLocations: true,
      },
      booking, scheduledFor: new Date("2026-10-12T10:02:00Z"), occurrenceKey: "confirmation:order",
      source: { entity: booking, entityType: "booking", orderId: sourceOrderId, scheduledAt: paidAt },
    })).resolves.toEqual({ queued: 1, suppressed: 0, existing: 0 });
    expect(mocks.upsertScheduled).toHaveBeenCalledOnce();
    const input = mocks.upsertScheduled.mock.calls[0][0];
    expect(input.recipientEmail).toBe("ada@example.com");
    expect(String(input.sourceOrderId)).toBe(sourceOrderId);
    expect(input.sourceScheduledAt).toEqual(paidAt);
    await expect(resolveAutomationRecipients({
      tenantId: TENANT_ID, automation: { sendToAllRecipients: true }, booking,
      sourceOrderId: "507f191e810c19729de860fc",
    })).resolves.toEqual([]);
    expect(mocks.userFind).not.toHaveBeenCalled();
  });

  it("canonicalizes a resolved user's email and name instead of trusting payload overrides", async () => {
    mocks.userFind.mockReturnValue(
      query([
        {
          _id: USER_ID,
          firstname: "Ada",
          lastname: "Lovelace",
          email: "ada@example.com",
          customId: "C-1",
        },
      ]),
    );

    const recipients = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: {
        purpose: "transactional",
        defaultLocale: "en",
        recipients: [
          {
            user: USER_ID,
            email: "attacker@example.com",
            name: "Wrong Recipient",
          },
        ],
      },
    });

    expect(mocks.userFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantRole: "customer",
        isAccessGranted: { $ne: false },
      }),
    );
    expect(recipients[0]).toMatchObject({
      userId: USER_ID,
      email: "ada@example.com",
      name: "Ada Lovelace",
    });
  });

  it("does not downgrade an unresolved user reference into an arbitrary email recipient", async () => {
    mocks.userFind.mockReturnValue(query([]));
    const recipients = await resolveAutomationRecipients({
      tenantId: TENANT_ID,
      automation: {
        purpose: "transactional",
        defaultLocale: "en",
        recipients: [
          {
            user: USER_ID,
            email: "attacker@example.com",
          },
        ],
      },
    });

    expect(recipients).toEqual([]);
  });

  it("persists format and immutable source anchor, then queues exactly once", async () => {
    mocks.userFindOne.mockReturnValue(
      query({
        _id: USER_ID,
        firstname: "Ada",
        lastname: "Lovelace",
        email: "ada@example.com",
      }),
    );
    mocks.upsertScheduled.mockResolvedValue({
      created: true,
      log: { _id: "507f191e810c19729de860ed", status: "scheduled" },
    });
    const end = new Date("2026-08-01T12:00:00.000Z");

    await expect(
      materializeAutomationDeliveries({
        tenantId: TENANT_ID,
        automation: {
          _id: AUTOMATION_ID,
          senderEmail: SENDER_ID,
          scheduleType: "afterBooking",
          purpose: "transactional",
          subject: "Hello",
          htmlContent: "Plain body",
          body: "Plain body",
          format: "plain",
          defaultLocale: "en",
          appliesToAllLocations: true,
        },
        scheduledFor: new Date("2026-08-01T12:30:00.000Z"),
        occurrenceKey: "after:booking:1",
        source: {
          entity: { _id: "507f191e810c19729de860ee" },
          entityType: "booking",
          recipientUserId: USER_ID,
          locale: "en",
          scheduledAt: end,
        },
      }),
    ).resolves.toEqual({ queued: 1, suppressed: 0, existing: 0 });

    expect(mocks.upsertScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        contentFormat: "plain",
        sourceScheduledAt: end,
        purpose: "transactional",
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.markQueued).toHaveBeenCalledOnce();
  });

  it("does not enqueue a future scheduled defer again during rematerialization", async () => {
    mocks.userFindOne.mockReturnValue(
      query({
        _id: USER_ID,
        firstname: "Ada",
        lastname: "Lovelace",
        email: "ada@example.com",
      }),
    );
    mocks.upsertScheduled.mockResolvedValue({
      created: false,
      log: {
        _id: "507f191e810c19729de860ed",
        status: "scheduled",
        scheduledFor: new Date("2026-08-02T08:00:00.000Z"),
      },
    });

    await expect(
      materializeAutomationDeliveries({
        tenantId: TENANT_ID,
        automation: {
          _id: AUTOMATION_ID,
          senderEmail: SENDER_ID,
          scheduleType: "afterBooking",
          purpose: "transactional",
          subject: "Hello",
          body: "Body",
          defaultLocale: "en",
          appliesToAllLocations: true,
        },
        scheduledFor: new Date("2026-08-02T08:00:00.000Z"),
        occurrenceKey: "after:booking:deferred",
        source: {
          entity: { _id: "507f191e810c19729de860ee" },
          entityType: "booking",
          recipientUserId: USER_ID,
          locale: "en",
        },
      }),
    ).resolves.toEqual({ queued: 0, suppressed: 0, existing: 1 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.markQueueStateAmbiguous).not.toHaveBeenCalled();
  });

  it("keeps a linked template's locale and format when inline fields are empty", async () => {
    mocks.templateFindOne.mockReturnValue(
      query({
        _id: "507f191e810c19729de860ef",
        tenant: TENANT_ID,
        isActive: true,
        subject: "English reminder",
        body: "Plain reminder",
        htmlContent: "Plain reminder",
        format: "plain",
        defaultLocale: "en",
        contentVariants: {
          en: {
            subject: "English reminder",
            body: "Plain reminder",
            htmlContent: "Plain reminder",
            format: "plain",
          },
        },
      }),
    );
    mocks.upsertScheduled.mockResolvedValue({
      created: true,
      log: { _id: "507f191e810c19729de860ed", status: "scheduled" },
    });

    await materializeAutomationDeliveries({
      tenantId: TENANT_ID,
      automation: {
        _id: AUTOMATION_ID,
        senderEmail: SENDER_ID,
        templateId: "507f191e810c19729de860ef",
        scheduleType: "daily",
        purpose: "transactional",
        subject: "",
        htmlContent: "",
        body: "",
        // These are persistence defaults, not explicit template overrides.
        format: "html",
        defaultLocale: "cs",
        recipients: [{ email: "ada@example.com" }],
        appliesToAllLocations: true,
      },
      scheduledFor: new Date("2026-08-01T09:00:00.000Z"),
      occurrenceKey: "daily:template-defaults",
    });

    expect(mocks.upsertScheduled).toHaveBeenCalledWith(
      expect.objectContaining({
        contentFormat: "plain",
        locale: "en",
        subject: "English reminder",
      }),
    );
  });

  it("does not enqueue a delivery whose deduplication log is already queued", async () => {
    mocks.upsertScheduled.mockResolvedValue({
      created: false,
      log: { _id: "507f191e810c19729de860ed", status: "queued" },
    });

    await expect(
      materializeAutomationDeliveries({
        tenantId: TENANT_ID,
        automation: {
          _id: AUTOMATION_ID,
          senderEmail: SENDER_ID,
          scheduleType: "daily",
          purpose: "transactional",
          subject: "Hello",
          htmlContent: "<p>Hello</p>",
          format: "html",
          defaultLocale: "en",
          recipients: [{ email: "ada@example.com", locale: "en" }],
          appliesToAllLocations: true,
        },
        scheduledFor: new Date("2026-08-01T09:00:00.000Z"),
        occurrenceKey: "daily:2026-08-01",
      }),
    ).resolves.toEqual({ queued: 0, suppressed: 0, existing: 1 });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("deduplicates one occurrence by stable user id after an email change", async () => {
    mocks.userFindOne
      .mockReturnValueOnce(
        query({
          _id: USER_ID,
          firstname: "Ada",
          email: "old@example.com",
        }),
      )
      .mockReturnValueOnce(
        query({
          _id: USER_ID,
          firstname: "Ada",
          email: "new@example.com",
        }),
      );
    const logs = new Map<string, Record<string, any>>();
    mocks.upsertScheduled.mockImplementation(async (input: any) => {
      const existing = logs.get(input.deduplicationKey);
      if (existing) return { created: false, log: existing };
      const log = {
        _id: "507f191e810c19729de860ed",
        status: "queued",
      };
      logs.set(input.deduplicationKey, log);
      return { created: true, log };
    });
    const request = {
      tenantId: TENANT_ID,
      automation: {
        _id: AUTOMATION_ID,
        senderEmail: SENDER_ID,
        scheduleType: "afterBooking",
        purpose: "transactional",
        subject: "Hello",
        htmlContent: "<p>Hello</p>",
        format: "html",
        defaultLocale: "en",
        appliesToAllLocations: true,
      },
      scheduledFor: new Date("2026-08-01T12:30:00.000Z"),
      occurrenceKey: "after:booking:stable-user",
      source: {
        entity: { _id: "507f191e810c19729de860ee" },
        entityType: "booking" as const,
        recipientUserId: USER_ID,
        scheduledAt: new Date("2026-08-01T12:00:00.000Z"),
      },
    };

    await expect(materializeAutomationDeliveries(request)).resolves.toEqual({
      queued: 1,
      suppressed: 0,
      existing: 0,
    });
    await expect(materializeAutomationDeliveries(request)).resolves.toEqual({
      queued: 0,
      suppressed: 0,
      existing: 1,
    });

    const firstKey = mocks.upsertScheduled.mock.calls[0][0].deduplicationKey;
    const secondKey = mocks.upsertScheduled.mock.calls[1][0].deduplicationKey;
    expect(firstKey).toBe(secondKey);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
});
