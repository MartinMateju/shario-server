import { describe, expect, it } from "vitest";

import { toOutboundOnlyCommunicationSettings } from "@/modules/communications/services/outbound-communication-settings.service.js";

describe("outbound-only communication settings", () => {
  it("omits inbound aliases and all live Meta configuration", () => {
    const value = toOutboundOnlyCommunicationSettings({
      tenantId: "tenant-1",
      tenantKey: "legacy-key",
      inbox: {
        defaultAssignee: "user-1",
        forwardingLocalPart: "studio",
        senderName: "Legacy Studio",
        senderEmail: "legacy@example.com",
        replyToEmail: "legacy-reply@example.com",
      },
      channels: {
        email: { enabled: true, provider: "smtp", inboundEnabled: true },
        whatsapp: {
          enabled: true,
          phoneNumberId: "phone-1",
          encryptedAccessToken: "secret",
        },
        instagram: {
          enabled: true,
          instagramAccountId: "instagram-1",
          encryptedAccessToken: "secret",
        },
        inApp: { enabled: true },
      },
      inbound: { emailAddress: "studio@inbound.shario.io" },
    });

    expect(value).not.toHaveProperty("inbox");
    expect(value.channels).toEqual({
      email: {
        enabled: true,
        provider: "postmark",
        inboundEnabled: false,
      },
      inApp: { enabled: true },
    });
    expect(value).not.toHaveProperty("inbound");
    expect(value).not.toHaveProperty("tenantKey");
    expect(JSON.stringify(value)).not.toContain("encryptedAccessToken");
    expect(JSON.stringify(value)).not.toContain("whatsapp");
    expect(JSON.stringify(value)).not.toContain("instagram");
  });
});
