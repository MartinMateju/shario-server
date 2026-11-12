import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendManagedTenantEmail: vi.fn(),
}));

vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendManagedTenantEmail,
}));

import {
  normalizeProviderWebhook,
  sendThroughCommunicationProvider,
  verifyCommunicationWebhookSignature,
} from "@/modules/communications/services/provider.service.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("communications provider and mailbox ingestion safeguards", () => {
  it("verifies an email webhook against the exact raw request body", () => {
    vi.stubEnv("EMAIL_INBOUND_WEBHOOK_SECRET", "email-secret");
    const rawBody = '{"eventId":"event-1","text":"Hello"}';
    const signature = createHmac("sha256", "email-secret")
      .update(rawBody)
      .digest("hex");

    expect(
      verifyCommunicationWebhookSignature({
        channel: "email",
        body: JSON.parse(rawBody),
        rawBody,
        signature,
      }),
    ).toBe(true);
    expect(
      verifyCommunicationWebhookSignature({
        channel: "email",
        body: JSON.parse(rawBody),
        rawBody: `${rawBody} `,
        signature,
      }),
    ).toBe(false);
  });

  it("verifies timestamped signatures and rejects replayed requests", () => {
    vi.stubEnv("WHATSAPP_WEBHOOK_SECRET", "whatsapp-secret");
    const rawBody = '{"entry":[]}';
    const now = Date.parse("2026-07-22T12:00:00.000Z");
    const timestamp = String(now / 1000);
    const signature = createHmac("sha256", "whatsapp-secret")
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    expect(
      verifyCommunicationWebhookSignature({
        channel: "whatsapp",
        body: {},
        rawBody,
        timestamp,
        signature: `sha256=${signature}`,
        now,
      }),
    ).toBe(true);
    expect(
      verifyCommunicationWebhookSignature({
        channel: "whatsapp",
        body: {},
        rawBody,
        timestamp,
        signature,
        now: now + 5 * 60_000 + 1,
      }),
    ).toBe(false);
  });

  it("fails closed for unsigned production webhooks", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMMUNICATION_WEBHOOK_SECRET", "");

    expect(
      verifyCommunicationWebhookSignature({
        channel: "email",
        body: { eventId: "event-1" },
      }),
    ).toBe(false);
  });

  it("normalizes a WhatsApp text message with stable provider identity", () => {
    const [event] = normalizeProviderWebhook("whatsapp", {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: "Anna Novak" } }],
                messages: [
                  {
                    id: "wamid.message-1",
                    from: "420777123456",
                    timestamp: "1784721600",
                    type: "text",
                    text: { body: "Can I move my booking?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(event).toMatchObject({
      provider: "meta",
      eventId: "message:wamid.message-1",
      eventType: "message.received",
      providerMessageId: "wamid.message-1",
      sender: {
        name: "Anna Novak",
        phone: "420777123456",
        whatsappId: "420777123456",
      },
      text: "Can I move my booking?",
      kind: "text",
      attachments: [],
    });
    expect(event.occurredAt).toBeInstanceOf(Date);
  });

  it("normalizes every event in a batched WhatsApp webhook", () => {
    const events = normalizeProviderWebhook("whatsapp", {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.message-1",
                    from: "420777123456",
                    timestamp: "1784721600",
                    type: "text",
                    text: { body: "First message" },
                  },
                ],
              },
            },
            {
              value: {
                statuses: [
                  {
                    id: "wamid.outgoing-1",
                    status: "delivered",
                    timestamp: "1784721601",
                  },
                ],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.message-2",
                    from: "420777000000",
                    timestamp: "1784721602",
                    type: "text",
                    text: { body: "Second message" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(events.map((event) => event.eventId)).toEqual([
      "message:wamid.message-1",
      "status:wamid.outgoing-1:delivered:1784721601",
      "message:wamid.message-2",
    ]);
  });

  it("preserves WhatsApp voice media for later transcription", () => {
    const [event] = normalizeProviderWebhook("whatsapp", {
      messages: [
        {
          id: "wamid.voice-1",
          from: "420777123456",
          timestamp: "1784721600",
          type: "audio",
          audio: { id: "media-1", mime_type: "audio/ogg" },
        },
      ],
    });

    expect(event).toMatchObject({
      eventId: "message:wamid.voice-1",
      kind: "voice",
      attachments: [
        {
          name: "voice-message.ogg",
          contentType: "audio/ogg",
          url: "whatsapp-media://media-1",
        },
      ],
    });
  });

  it.each([
    ["sent", "delivery.sent", "sent"],
    ["delivered", "delivery.delivered", "delivered"],
    ["read", "delivery.read", "read"],
    ["failed", "delivery.failed", "failed"],
  ])(
    "normalizes WhatsApp %s delivery receipts",
    (providerStatus, eventType, deliveryStatus) => {
      const [event] = normalizeProviderWebhook("whatsapp", {
        statuses: [
          {
            id: "wamid.outgoing-1",
            status: providerStatus,
            timestamp: "1784721600",
          },
        ],
      });

      expect(event).toMatchObject({
        eventId: `status:wamid.outgoing-1:${providerStatus}:1784721600`,
        eventType,
        providerMessageId: "wamid.outgoing-1",
        deliveryStatus,
      });
    },
  );

  it("uses email Message-ID for retry-safe mailbox ingestion", () => {
    const [event] = normalizeProviderWebhook("email", {
      provider: "mailgun",
      headers: { "message-id": "<mail-123@example.com>" },
      from: { name: "Anna", email: "anna@example.com" },
      to: { email: "studio@inbound.shario.io" },
      subject: "Booking question",
      textBody: "Can I arrive later?",
    });

    expect(event).toMatchObject({
      provider: "mailgun",
      eventId: "<mail-123@example.com>",
      providerMessageId: "<mail-123@example.com>",
      eventType: "message.received",
      sender: { name: "Anna", email: "anna@example.com" },
      recipients: [{ email: "studio@inbound.shario.io" }],
      subject: "Booking question",
      text: "Can I arrive later?",
    });
  });

  it("derives a deterministic event identity when a provider omits Message-ID", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const payload = {
      provider: "generic-email",
      from: { email: "anna@example.com" },
      subject: "Question",
      text: "Where can I collect my bowl?",
    };
    const first = normalizeProviderWebhook("email", payload)[0];

    vi.setSystemTime(new Date("2026-07-22T12:00:01.000Z"));
    const retry = normalizeProviderWebhook("email", payload)[0];

    expect(retry.eventId).toBe(first.eventId);
    expect(String(first.eventId)).not.toMatch(/^\d+$/);
  });

  it("returns deterministic local provider results without external delivery", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("COMMUNICATION_DELIVERY_MODE", "dry-run");

    await expect(
      sendThroughCommunicationProvider({
        tenantId: "tenant-1",
        channel: "email",
        to: [{ email: "anna@example.com" }],
        subject: "Your pieces are ready",
        text: "You can collect them tomorrow.",
        idempotencyKey: "comm_test",
      }),
    ).resolves.toEqual({
      provider: "local",
      providerMessageId: "local-email-comm_test",
      status: "sent",
    });
  });

  it("retires WhatsApp before any Meta provider call", async () => {
    vi.stubEnv("NODE_ENV", "test");

    await expect(
      sendThroughCommunicationProvider({
        tenantId: "tenant-1",
        channel: "whatsapp",
        to: [{}],
        text: "Hello",
        idempotencyKey: "comm_test",
      }),
    ).rejects.toMatchObject({
      permanent: true,
      code: "CHANNEL_RETIRED",
      deliveryOutcome: "not_sent",
    });
  });

  it("routes live email through the fail-closed managed sender with durable metadata", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mocks.sendManagedTenantEmail.mockResolvedValue({
      provider: "postmark",
      providerMessageId: "postmark-message-1",
      status: "sent",
    });

    await expect(
      sendThroughCommunicationProvider({
        tenantId: "tenant-1",
        channel: "email",
        to: [{ email: "anna@example.com" }],
        subject: "Your pieces are ready",
        text: "Collect them tomorrow.",
        idempotencyKey: "comm_test",
        deliveryId: "delivery-1",
        messageId: "message-1",
      }),
    ).resolves.toMatchObject({
      provider: "postmark",
      providerMessageId: "postmark-message-1",
    });
    expect(mocks.sendManagedTenantEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        deliveryId: "delivery-1",
        messageId: "message-1",
        idempotencyKey: "comm_test",
      }),
    );
  });

  it("rejects attachments before contacting Postmark", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      sendThroughCommunicationProvider({
        tenantId: "tenant-1",
        channel: "email",
        to: [{ email: "anna@example.com" }],
        text: "Attachment",
        attachments: [
          {
            name: "invoice.pdf",
            url: "https://assets.example.com/invoice.pdf",
          },
        ],
        idempotencyKey: "comm_attachment",
      }),
    ).rejects.toMatchObject({
      code: "ATTACHMENTS_NOT_SUPPORTED",
      deliveryOutcome: "not_sent",
    });
    expect(mocks.sendManagedTenantEmail).not.toHaveBeenCalled();
  });
});
