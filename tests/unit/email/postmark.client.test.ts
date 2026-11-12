import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configurePostmarkOutboundWebhook } from "@/infrastructure/email/postmark.client.js";

const attemptId = "6444f850-f150-4a65-b9a4-12d5dc66fdad";

const verifiedTriggers = () => ({
  Open: { Enabled: false, PostFirstOpenOnly: false },
  Click: { Enabled: false },
  Delivery: { Enabled: true, Status: "verified" },
  Bounce: { Enabled: true, IncludeContent: false, Status: "verified" },
  SpamComplaint: { Enabled: true, IncludeContent: false, Status: "verified" },
  SubscriptionChange: { Enabled: false },
});

const configuredTriggers = () => ({
  Delivery: { Enabled: true },
  Bounce: { Enabled: true, IncludeContent: false },
  SpamComplaint: { Enabled: true, IncludeContent: false },
});

const response = (
  payload: Record<string, unknown>,
  {
    status = 200,
    headers = {},
  }: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe.sequential("Postmark webhook provisioning", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("POSTMARK_API_URL", "https://api.postmarkapp.com");
    vi.stubEnv("POSTMARK_MESSAGE_STREAM", "outbound");
    vi.stubEnv(
      "POSTMARK_OUTBOUND_WEBHOOK_URL",
      "https://api.shario.io/webhooks/postmark/outbound",
    );
    vi.stubEnv("POSTMARK_OUTBOUND_WEBHOOK_USERNAME", "postmark-hook-user");
    vi.stubEnv(
      "POSTMARK_OUTBOUND_WEBHOOK_PASSWORD",
      "postmark-hook-password-at-least-32-characters",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("creates and verifies a status-only webhook with Basic Auth", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ Webhooks: [] }))
      .mockResolvedValueOnce(response({ ID: 123, Status: "verified" }));

    await expect(
      configurePostmarkOutboundWebhook("tenant-server-token", attemptId),
    ).resolves.toMatchObject({
      webhookId: 123,
      messageStream: "outbound",
      status: "verified",
    });

    const [url, options] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(options.body));
    expect(url).toBe("https://api.postmarkapp.com/webhooks");
    expect(options.method).toBe("POST");
    expect(options.headers["X-Postmark-Server-Token"]).toBe(
      "tenant-server-token",
    );
    expect(body).toMatchObject({
      MessageStream: "outbound",
      Verify: true,
      HttpAuth: {
        Username: "postmark-hook-user",
        Password: "postmark-hook-password-at-least-32-characters",
      },
      HttpHeaders: [
        { Name: "X-Shario-Postmark-Provisioning-Token", Value: attemptId },
      ],
      Triggers: {
        Delivery: { Enabled: true },
        Bounce: { Enabled: true, IncludeContent: false },
        SpamComplaint: { Enabled: true, IncludeContent: false },
      },
    });
    expect(JSON.stringify(body)).not.toContain("tenant-server-token");
  });

  it("updates and re-verifies an existing webhook without changing its stream", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({
          Webhooks: [
            {
              ID: 456,
              Url: "https://api.shario.io/webhooks/postmark/outbound",
              MessageStream: "outbound",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ ID: 456, Status: "verified" }));

    await configurePostmarkOutboundWebhook("tenant-server-token", attemptId);

    const [url, options] = fetchMock.mock.calls[1];
    const body = JSON.parse(String(options.body));
    expect(url).toBe("https://api.postmarkapp.com/webhooks/456");
    expect(options.method).toBe("PUT");
    expect(body).toMatchObject({
      Verify: true,
      HttpHeaders: [
        { Name: "X-Shario-Postmark-Provisioning-Token", Value: attemptId },
      ],
    });
    expect(body).not.toHaveProperty("MessageStream");
  });

  it.each(["create", "update"])(
    "accepts Postmark's per-trigger verification response on %s",
    async (operation) => {
      const webhook = {
        ID: 789,
        Url: "https://api.shario.io/webhooks/postmark/outbound",
        MessageStream: "outbound",
        Triggers: verifiedTriggers(),
      };
      fetchMock
        .mockResolvedValueOnce(
          response({ Webhooks: operation === "update" ? [webhook] : [] }),
        )
        .mockResolvedValueOnce(response(webhook));

      await expect(
        configurePostmarkOutboundWebhook("tenant-server-token", attemptId),
      ).resolves.toEqual({
        webhookId: 789,
        url: webhook.Url,
        messageStream: "outbound",
        status: "verified",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1].method).toBe(
        operation === "update" ? "PUT" : "POST",
      );
    },
  );

  it.each([
    { name: "null aggregate status", Status: null, Triggers: verifiedTriggers() },
    {
      name: "matching aggregate and trigger statuses",
      Status: "verified",
      Triggers: verifiedTriggers(),
    },
    {
      name: "documented aggregate status with trigger configuration",
      Status: "verified",
      Triggers: configuredTriggers(),
    },
  ])("accepts $name", async ({ name: _name, ...saved }) => {
    fetchMock
      .mockResolvedValueOnce(response({ Webhooks: [] }))
      .mockResolvedValueOnce(response({ ID: 789, ...saved }));

    await expect(
      configurePostmarkOutboundWebhook("tenant-server-token", attemptId),
    ).resolves.toMatchObject({ webhookId: 789, status: "verified" });
  });

  it.each([
    { name: "missing verification evidence", saved: {} },
    { name: "configuration without status", saved: { Triggers: configuredTriggers() } },
    {
      name: "aggregate failure despite verified triggers",
      saved: { Status: "unverified", Triggers: verifiedTriggers() },
    },
    {
      name: "unknown aggregate status despite verified triggers",
      saved: { Status: "active", Triggers: verifiedTriggers() },
    },
    ...[undefined, "verified"].map((Status) => ({
      name: `partial trigger statuses with aggregate ${Status ?? "absent"}`,
      saved: {
        ...(Status ? { Status } : {}),
        Triggers: {
          ...configuredTriggers(),
          Delivery: { Enabled: true, Status: "verified" },
        },
      },
    })),
    ...["Delivery", "Bounce", "SpamComplaint"].flatMap((name) => [
      {
        name: `aggregate success with missing ${name}`,
        saved: {
          Status: "verified",
          Triggers: { ...verifiedTriggers(), [name]: undefined },
        },
      },
      {
        name: `aggregate success with disabled ${name}`,
        saved: {
          Status: "verified",
          Triggers: {
            ...verifiedTriggers(),
            [name]: { Enabled: false, Status: "verified" },
          },
        },
      },
      {
        name: `aggregate success with unverified ${name}`,
        saved: {
          Status: "verified",
          Triggers: {
            ...verifiedTriggers(),
            [name]: { Enabled: true, Status: "unverified" },
          },
        },
      },
    ]),
    {
      name: "aggregate success with a null trigger status",
      saved: {
        Status: "verified",
        Triggers: {
          ...verifiedTriggers(),
          Delivery: { Enabled: true, Status: null },
        },
      },
    },
    ...[null, [], "verified"].map((Triggers) => ({
      name: `aggregate success with malformed triggers ${JSON.stringify(Triggers)}`,
      saved: { Status: "verified", Triggers },
    })),
  ])("rejects $name", async ({ saved }) => {
    fetchMock
      .mockResolvedValueOnce(response({ Webhooks: [] }))
      .mockResolvedValueOnce(response({ ID: 789, ...saved }));

    await expect(
      configurePostmarkOutboundWebhook("tenant-server-token", attemptId),
    ).rejects.toMatchObject({ code: "POSTMARK_WEBHOOK_NOT_VERIFIED" });
  });

  it.each(["", "not-an-attempt", "6444f850-f150-1a65-b9a4-12d5dc66fdad"])(
    "rejects invalid provisioning correlation before calling Postmark: %s",
    async (invalidAttemptId) => {
      await expect(
        configurePostmarkOutboundWebhook("tenant-server-token", invalidAttemptId),
      ).rejects.toMatchObject({ code: "POSTMARK_PROVISIONING_ATTEMPT_INVALID" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("reads webhook verification error 1364 from the response header", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ Webhooks: [] }))
      .mockResolvedValueOnce(
        response(
          {
            Message: "1/3 triggers verified successfully",
            Results: [
              {
                TriggerType: "Delivery",
                Success: false,
                StatusCode: 503,
                Message: "Remote server returned HTTP 503.",
              },
              {
                TriggerType: "Bounce",
                Success: true,
                StatusCode: 200,
                Message: "Remote server returned HTTP 200.",
              },
            ],
          },
          {
            status: 422,
            headers: { "X-PM-ApiErrorCode": "1364" },
          },
        ),
      );

    await expect(
      configurePostmarkOutboundWebhook("tenant-server-token", attemptId),
    ).rejects.toMatchObject({
      code: "POSTMARK_1364",
      httpStatus: 422,
      verificationResults: [
        {
          triggerType: "Delivery",
          success: false,
          statusCode: 503,
        },
        {
          triggerType: "Bounce",
          success: true,
          statusCode: 200,
        },
      ],
    });
  });

  it("treats a Postmark error header on HTTP 200 as a provider failure", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ Webhooks: [] }))
      .mockResolvedValueOnce(
        response(
          { Message: "Webhook verification failed." },
          { headers: { "X-PM-ApiErrorCode": "1364" } },
        ),
      );

    await expect(
      configurePostmarkOutboundWebhook("tenant-server-token", attemptId),
    ).rejects.toMatchObject({
      code: "POSTMARK_1364",
      httpStatus: 200,
      deliveryOutcome: "not_sent",
    });
  });

  it("does not accept an unverified webhook response as ready", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ Webhooks: [] }))
      .mockResolvedValueOnce(response({ ID: 789, Status: "unverified" }));

    await expect(
      configurePostmarkOutboundWebhook("tenant-server-token", attemptId),
    ).rejects.toMatchObject({
      code: "POSTMARK_WEBHOOK_NOT_VERIFIED",
    });
  });
});
