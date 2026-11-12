import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inboundCreate: vi.fn(),
  inboundFindOneAndUpdate: vi.fn(),
  deliveryFindOne: vi.fn(),
  messageFindById: vi.fn(),
  suppressionFindOneAndUpdate: vi.fn(),
}));

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationConversationModel: {},
  CommunicationDeliveryModel: { findOne: mocks.deliveryFindOne },
  CommunicationInboundEventModel: {
    create: mocks.inboundCreate,
    findOneAndUpdate: mocks.inboundFindOneAndUpdate,
  },
  CommunicationMessageModel: { findById: mocks.messageFindById },
  CommunicationRoutingRuleModel: {},
  CommunicationSettingsModel: {},
  CommunicationSuppressionModel: {
    findOneAndUpdate: mocks.suppressionFindOneAndUpdate,
  },
}));

import {
  ingestCommunicationEvent,
} from "@/modules/communications/services/ingestion.service.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");

const buildInboundEvent = () => {
  const event: Record<string, any> = {
    _id: "event-record-1",
    status: "received",
    processedAt: null,
    error: "",
  };
  event.save = vi.fn(async () => event);
  return event;
};

const buildDelivery = (overrides: Record<string, unknown> = {}) => {
  const delivery: Record<string, any> = {
    _id: "delivery-1",
    tenantId: "tenant-1",
    messageId: "message-1",
    status: "sent",
    attempts: 1,
    maxAttempts: 4,
    nextAttemptAt: null,
    failure: { code: "", message: "", permanent: false },
    eventHistory: [],
    ...overrides,
  };
  delivery.save = vi.fn(async () => delivery);
  return delivery;
};

const settings = { tenantId: "tenant-1" };

const input = (values: Record<string, unknown>) =>
  ({
    provider: "meta",
    eventId: "status-event-1",
    eventType: "delivery.delivered",
    providerMessageId: "wamid.outgoing-1",
    providerThreadId: "",
    occurredAt: NOW,
    sender: { name: "", email: "", phone: "", whatsappId: "", externalId: "" },
    recipients: [],
    subject: "",
    text: "",
    html: "",
    kind: "text",
    attachments: [],
    locationId: null,
    relatedEntities: [],
    raw: {},
    ...values,
  }) as any;

describe("communications inbound delivery state safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.inboundCreate.mockResolvedValue(buildInboundEvent());
    mocks.inboundFindOneAndUpdate.mockResolvedValue(null);
    mocks.messageFindById.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        recipients: [{ email: "anna@example.com" }],
      }),
    });
    mocks.suppressionFindOneAndUpdate.mockResolvedValue({
      _id: "suppression-1",
    });
  });

  it("advances sent delivery to delivered", async () => {
    const delivery = buildDelivery({ status: "sent" });
    mocks.deliveryFindOne.mockResolvedValue(delivery);

    await ingestCommunicationEvent({
      settings,
      channel: "whatsapp",
      input: input({
        eventType: "delivery.delivered",
        deliveryStatus: "delivered",
      }),
    });

    expect(delivery.status).toBe("delivered");
    expect(delivery.deliveredAt).toEqual(NOW);
  });

  it("does not regress read delivery when an older sent receipt arrives late", async () => {
    const readAt = new Date("2026-07-22T11:59:00.000Z");
    const delivery = buildDelivery({ status: "read", readAt });
    mocks.deliveryFindOne.mockResolvedValue(delivery);

    await ingestCommunicationEvent({
      settings,
      channel: "whatsapp",
      input: input({
        eventType: "delivery.sent",
        deliveryStatus: "sent",
        occurredAt: new Date("2026-07-22T11:58:00.000Z"),
      }),
    });

    expect(delivery.status).toBe("read");
    expect(delivery.readAt).toEqual(readAt);
  });

  it("schedules a retry when the provider later reports a transient failure", async () => {
    const delivery = buildDelivery({ status: "sent", attempts: 1, maxAttempts: 4 });
    mocks.deliveryFindOne.mockResolvedValue(delivery);

    await ingestCommunicationEvent({
      settings: {
        ...settings,
        delivery: { retryBaseSeconds: 60 },
      },
      channel: "whatsapp",
      input: input({
        eventType: "delivery.failed",
        deliveryStatus: "failed",
        failure: {
          code: "TEMPORARY_UNAVAILABLE",
          message: "Try later",
          permanent: false,
        },
      }),
    });

    expect(delivery.status).toBe("failed");
    expect(delivery.nextAttemptAt).toEqual(
      new Date("2026-07-22T12:01:00.000Z"),
    );
  });

  it("keeps permanent provider failures terminal", async () => {
    const delivery = buildDelivery({ status: "sent" });
    mocks.deliveryFindOne.mockResolvedValue(delivery);

    await ingestCommunicationEvent({
      settings,
      channel: "email",
      input: input({
        eventType: "delivery.bounced",
        deliveryStatus: "bounced",
        failure: {
          code: "HARD_BOUNCE",
          message: "Mailbox does not exist",
          permanent: true,
        },
      }),
    });

    expect(delivery.status).toBe("bounced");
    expect(delivery.nextAttemptAt).toBeNull();
  });

  it("treats a duplicate provider event as an idempotent no-op", async () => {
    mocks.inboundCreate.mockRejectedValue(
      Object.assign(new Error("duplicate"), { code: 11000 }),
    );

    await expect(
      ingestCommunicationEvent({
        settings,
        channel: "email",
        input: input({}),
      }),
    ).resolves.toEqual({ duplicate: true });
    expect(mocks.deliveryFindOne).not.toHaveBeenCalled();
  });

  it("reclaims a failed inbound event when the provider retries it", async () => {
    const event = buildInboundEvent();
    const delivery = buildDelivery({ status: "sent" });
    mocks.inboundCreate
      .mockResolvedValueOnce(event)
      .mockRejectedValueOnce(
        Object.assign(new Error("duplicate"), { code: 11000 }),
      );
    mocks.inboundFindOneAndUpdate.mockResolvedValue(event);
    mocks.deliveryFindOne
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockResolvedValueOnce(delivery);

    const request = {
      settings,
      channel: "whatsapp" as const,
      input: input({
        eventType: "delivery.delivered",
        deliveryStatus: "delivered",
      }),
    };

    await expect(ingestCommunicationEvent(request)).rejects.toThrow(
      "temporary database failure",
    );
    expect(event.status).toBe("failed");

    await expect(ingestCommunicationEvent(request)).resolves.toMatchObject({
      duplicate: false,
      delivery,
    });
    expect(mocks.inboundFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        eventId: "status-event-1",
        status: "failed",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "received" }),
      }),
      { returnDocument: "after" },
    );
    expect(event.status).toBe("processed");
    expect(delivery.status).toBe("delivered");
  });
});
