import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadInstagramMedia,
  getInstagramTokenState,
  normalizeProviderWebhook,
  refreshInstagramLongLivedToken,
  sendThroughCommunicationProvider,
  verifyCommunicationWebhookSignature,
} from "@/modules/communications/services/provider.service.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Instagram communication provider", () => {
  it("verifies Meta's signature against the exact raw request bytes", () => {
    vi.stubEnv("INSTAGRAM_WEBHOOK_SECRET", "instagram-app-secret");
    const rawBody = Buffer.from('{"object":"instagram","entry":[]}');
    const signature = createHmac("sha256", "instagram-app-secret")
      .update(rawBody)
      .digest("hex");

    expect(
      verifyCommunicationWebhookSignature({
        channel: "instagram",
        body: {},
        rawBody,
        signature: `sha256=${signature}`,
      }),
    ).toBe(true);
    expect(
      verifyCommunicationWebhookSignature({
        channel: "instagram",
        body: {},
        rawBody: Buffer.concat([rawBody, Buffer.from(" ")]),
        signature: `sha256=${signature}`,
      }),
    ).toBe(false);
  });

  it("normalizes a story voice reply with account-scoped identity and private media placeholder", () => {
    const [event] = normalizeProviderWebhook("instagram", {
      object: "instagram",
      entry: [
        {
          id: "ig-business-1",
          time: 1784721600000,
          messaging: [
            {
              sender: { id: "igsid-customer-1", username: "anna.ceramics" },
              recipient: { id: "ig-business-1" },
              timestamp: 1784721600000,
              message: {
                mid: "ig-mid-1",
                text: "Can I book this class?",
                reply_to: { story: { id: "story-1" } },
                attachments: [
                  {
                    type: "audio",
                    payload: {
                      url: "https://lookaside.fbsbx.com/instagram/audio-1",
                    },
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
      eventId: "message:ig-mid-1",
      eventType: "message.received",
      providerAccountId: "ig-business-1",
      providerThreadId: "igsid-customer-1",
      sender: {
        instagramScopedId: "igsid-customer-1",
        instagramUsername: "anna.ceramics",
      },
      subject: "Instagram story reply",
      kind: "voice",
      providerContext: {
        sourceType: "story_reply",
        isStoryReply: true,
        storyId: "story-1",
      },
    });
    expect((event.attachments as any[])[0].url).toMatch(
      /^instagram-media:\/\//,
    );
    expect(String((event.attachments as any[])[0].url)).not.toContain(
      "lookaside.fbsbx.com",
    );
  });

  it("turns echoes into receipts and normalizes delivery/read/postback events deterministically", () => {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "ig-business-1",
          time: 1784721600000,
          messaging: [
            {
              sender: { id: "ig-business-1" },
              recipient: { id: "igsid-customer-1" },
              message: { mid: "ig-echo-1", is_echo: true, text: "Reply" },
            },
            {
              sender: { id: "igsid-customer-1" },
              delivery: { mids: ["ig-out-1"], watermark: 1784721600100 },
            },
            {
              sender: { id: "igsid-customer-1" },
              read: { watermark: 1784721600200 },
            },
            {
              sender: { id: "igsid-customer-1" },
              postback: { mid: "ig-postback-1", title: "Book now", payload: "BOOK" },
            },
          ],
        },
      ],
    };
    const first = normalizeProviderWebhook("instagram", payload);
    const retry = normalizeProviderWebhook("instagram", payload);

    expect(first.map((event) => event.eventType)).toEqual([
      "delivery.sent",
      "delivery.delivered",
      "delivery.read",
      "message.received",
    ]);
    expect(first.map((event) => event.eventId)).toEqual(
      retry.map((event) => event.eventId),
    );
    expect(first[3]).toMatchObject({
      providerMessageId: "ig-postback-1",
      text: "Book now",
      providerContext: { sourceType: "postback", postbackPayload: "BOOK" },
    });
  });

  it("keeps Instagram delivery retired even in local provider mode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("COMMUNICATION_DELIVERY_MODE", "local");
    const message = {
      tenantId: "tenant-1",
      channel: "instagram" as const,
      to: [{ instagramScopedId: "igsid-customer-1" }],
      text: "Thanks for your message.",
      idempotencyKey: "comm-instagram-1",
    };

    for (const instagramReplyWindowOpen of [false, true]) {
      await expect(
        sendThroughCommunicationProvider({
          ...message,
          instagramReplyWindowOpen,
        }),
      ).rejects.toMatchObject({ code: "CHANNEL_RETIRED" });
    }
  });

  it("classifies token expiry and refreshes a long-lived token", async () => {
    const now = new Date("2026-07-22T12:00:00.000Z");
    expect(getInstagramTokenState(null, now)).toBe("unknown");
    expect(
      getInstagramTokenState("2026-07-23T12:00:00.000Z", now),
    ).toBe("expiring");
    expect(
      getInstagramTokenState("2026-09-23T12:00:00.000Z", now),
    ).toBe("valid");
    expect(
      getInstagramTokenState("2026-07-21T12:00:00.000Z", now),
    ).toBe("expired");

    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshInstagramLongLivedToken("old-token")).resolves.toEqual({
      accessToken: "refreshed-token",
      expiresAt: new Date("2026-07-22T13:00:00.000Z"),
    });
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("grant_type")).toBe("ig_refresh_token");
  });

  it("refuses non-Meta media hosts before making a request", async () => {
    vi.stubEnv("COMMUNICATION_DELIVERY_MODE", "live");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const encoded = Buffer.from(
      "https://attacker.example/customer-audio.ogg",
      "utf8",
    ).toString("base64url");
    await expect(
      downloadInstagramMedia({
        tenantId: "tenant-1",
        mediaUri: `instagram-media://${encoded}`,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_HOST_NOT_ALLOWED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
