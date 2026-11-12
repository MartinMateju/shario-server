import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  preparePostmarkAttachments,
  provisionPostmarkServer,
  sendPostmarkEmail,
} from "@/infrastructure/email/postmark.client.js";

describe("Postmark API client", () => {
  beforeEach(() => {
    vi.stubEnv("POSTMARK_API_URL", "https://api.postmarkapp.com");
    vi.stubEnv("POSTMARK_ACCOUNT_TOKEN", "account-token");
    vi.stubEnv("POSTMARK_MESSAGE_STREAM", "outbound");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reuses an exact deterministic tenant Server before creating one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          TotalCount: 1,
          Servers: [
            {
              ID: 42,
              Name: "shario-prod-tenant-1",
              ApiTokens: ["tenant-server-token"],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provisionPostmarkServer("shario-prod-tenant-1"),
    ).resolves.toEqual({
      serverId: 42,
      serverName: "shario-prod-tenant-1",
      serverToken: "tenant-server-token",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "X-Postmark-Account-Token": "account-token",
    });
  });

  it("creates an outbound-only Server when no exact binding exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ TotalCount: 0, Servers: [] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ID: 43,
            Name: "shario-prod-tenant-2",
            ApiTokens: ["new-tenant-token"],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provisionPostmarkServer("shario-prod-tenant-2"),
    ).resolves.toMatchObject({ serverId: 43, serverToken: "new-tenant-token" });
    const [, createOptions] = fetchMock.mock.calls[1];
    expect(createOptions).toMatchObject({
      method: "POST",
      headers: { "X-Postmark-Account-Token": "account-token" },
    });
    expect(JSON.parse(createOptions.body)).toEqual({
      Name: "shario-prod-tenant-2",
      Color: "Turquoise",
      SmtpApiActivated: false,
      RawEmailEnabled: false,
    });
  });

  it("recovers when a concurrent retry creates the deterministic Server first", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ TotalCount: 0, Servers: [] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ErrorCode: 603,
            Message: "A server with this name already exists.",
          }),
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            TotalCount: 1,
            Servers: [
              {
                ID: 44,
                Name: "shario-prod-tenant-race",
                ApiTokens: ["concurrent-tenant-token"],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provisionPostmarkServer("shario-prod-tenant-race"),
    ).resolves.toEqual({
      serverId: 44,
      serverName: "shario-prod-tenant-race",
      serverToken: "concurrent-tenant-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends with the tenant Server token, Reply-To and reconciliation metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ErrorCode: 0,
          Message: "OK",
          MessageID: "postmark-message-1",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendPostmarkEmail({
        serverToken: "tenant-token",
        from: '"Studio" <studio@notify.shario.io>',
        to: "anna@example.com",
        replyTo: "owner@example.com",
        subject: "Hello",
        text: "Hello Anna",
        metadata: { tenantId: "tenant-1", deliveryId: "delivery-1" },
      }),
    ).resolves.toEqual({
      provider: "postmark",
      providerMessageId: "postmark-message-1",
      status: "sent",
    });
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toMatchObject({
      "X-Postmark-Server-Token": "tenant-token",
    });
    expect(JSON.parse(options.body)).toMatchObject({
      From: '"Studio" <studio@notify.shario.io>',
      ReplyTo: "owner@example.com",
      Metadata: { tenantId: "tenant-1", deliveryId: "delivery-1" },
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
    });
    expect(JSON.parse(options.body)).not.toHaveProperty("Attachments");
  });

  it("serializes bounded PDF attachments using the provider API shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ErrorCode: 0, MessageID: "voucher-mail-1" }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const pdf = Buffer.from("%PDF-1.7\nbinary:\u0000\u00ff\n%%EOF");

    await sendPostmarkEmail({
      serverToken: "tenant-token",
      from: '"Studio" <studio@notify.shario.io>',
      to: "anna@example.com",
      subject: "Gift voucher",
      text: "Your purchased voucher is attached.",
      attachments: preparePostmarkAttachments([
        {
          filename: "dárkový-poukaz.pdf",
          content: pdf,
          contentType: "application/pdf",
        },
      ]),
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Attachments).toEqual([
      {
        Name: "dárkový-poukaz.pdf",
        Content: pdf.toString("base64"),
        ContentType: "application/pdf",
      },
    ]);
    expect(Buffer.from(body.Attachments[0].Content, "base64")).toEqual(pdf);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts exact metadata limits while preserving voucher correlation and the Message-ID header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ErrorCode: 0, MessageID: "voucher-mail-1" }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const deliveryId = "a".repeat(64);
    const messageId = `<voucher.${deliveryId}@shario.io>`;
    const metadata = {
      tenantId: "6ad7764537008d8771ea7648",
      orderId: "6ad776cb37008d8771ea7664",
      deliveryId,
      ["n".repeat(20)]: "v".repeat(80),
      ...Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`field${index}`, "value"]),
      ),
    };

    await sendPostmarkEmail({
      serverToken: "tenant-token",
      from: "studio@notify.shario.io",
      to: "anna@example.com",
      subject: "Gift voucher",
      text: "Your voucher is ready.",
      headers: [{ Name: "Message-ID", Value: messageId }],
      metadata,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(messageId).toHaveLength(84);
    expect(body.Metadata).toEqual(metadata);
    expect(body.Headers).toEqual([{ Name: "Message-ID", Value: messageId }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["a name over 20 characters", { ["n".repeat(21)]: "value" }],
    ["a value over 80 characters", { deliveryId: "v".repeat(81) }],
    [
      "an 84-character voucher Message-ID",
      { messageId: `<voucher.${"a".repeat(64)}@shario.io>` },
    ],
    [
      "more than 10 fields",
      Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => [`field${index}`, "value"]),
      ),
    ],
    [
      "case-insensitive duplicate names",
      { tenantId: "tenant-1", TenantId: "tenant-1" },
    ],
  ])(
    "rejects metadata with %s before contacting Postmark",
    async (_name, metadata) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        sendPostmarkEmail({
          serverToken: "tenant-token",
          from: "studio@notify.shario.io",
          to: "anna@example.com",
          subject: "Gift voucher",
          text: "Your voucher is ready.",
          metadata: metadata as Record<string, string>,
        }),
      ).rejects.toMatchObject({
        code: "EMAIL_METADATA_INVALID",
        permanent: true,
        deliveryOutcome: "not_sent",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed provider attachment content without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      sendPostmarkEmail({
        serverToken: "tenant-token",
        from: "studio@notify.shario.io",
        to: "anna@example.com",
        subject: "Gift voucher",
        text: "Voucher",
        attachments: [
          {
            Name: "voucher.pdf",
            Content: "https://example.com/file.pdf",
            ContentType: "application/pdf",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_ATTACHMENT_INVALID",
      deliveryOutcome: "not_sent",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a Postmark ErrorCode as a definite non-send even on HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ErrorCode: 300,
            Message: "Invalid email request",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      sendPostmarkEmail({
        serverToken: "tenant-token",
        from: "studio@notify.shario.io",
        to: "anna@example.com",
        subject: "Hello",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "POSTMARK_300",
      deliveryOutcome: "not_sent",
    });
  });

  it("leaves a network failure after dispatch ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("socket closed")),
    );

    await expect(
      sendPostmarkEmail({
        serverToken: "tenant-token",
        from: "studio@notify.shario.io",
        to: "anna@example.com",
        subject: "Hello",
        text: "Hello",
      }),
    ).rejects.toMatchObject({ code: "POSTMARK_OUTCOME_UNKNOWN" });
    await sendPostmarkEmail({
      serverToken: "tenant-token",
      from: "studio@notify.shario.io",
      to: "anna@example.com",
      subject: "Hello",
      text: "Hello",
    }).catch((error) => {
      expect(error.deliveryOutcome).toBeUndefined();
    });
  });
});
