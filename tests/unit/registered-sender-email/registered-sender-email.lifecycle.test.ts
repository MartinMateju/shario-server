import { describe, expect, it } from "vitest";

import {
  createRegisteredSenderEmailSchema,
  updateRegisteredSenderEmailSchema,
} from "@/modules/registered-sender-email/registered-sender-email.validators.js";
import {
  getManagedSenderReadiness,
  sanitizeRegisteredSenderEmail,
} from "@/modules/registered-sender-email/registered-sender-email.utils.js";

describe("managed registered sender lifecycle", () => {
  it("accepts only managed identity fields and rejects legacy SMTP credentials", () => {
    expect(
      createRegisteredSenderEmailSchema.parse({
        replyToEmail: " Owner@Studio.Example ",
        displayName: "Studio",
      }),
    ).toMatchObject({
      replyToEmail: "owner@studio.example",
      displayName: "Studio",
    });

    expect(
      createRegisteredSenderEmailSchema.safeParse({
        replyToEmail: "owner@studio.example",
        smtpHost: "smtp.example",
        smtpPassword: "secret",
      }).success,
    ).toBe(false);
    expect(
      updateRegisteredSenderEmailSchema.safeParse({
        provider: "smtp",
        smtpPort: 587,
      }).success,
    ).toBe(false);
  });

  it("reports readiness without exposing provider or verification secrets", () => {
    const sender = {
      _id: "507f1f77bcf86cd799439011",
      email: "tenant@notify.shario.io",
      replyToEmail: "owner@studio.example",
      replyToVerifiedAt: new Date("2026-08-01T10:00:00.000Z"),
      provider: "postmark_managed",
      providerServerId: 123,
      providerProvisionedAt: new Date("2026-08-01T09:00:00.000Z"),
      providerProvisioningStatus: "ready",
      isActive: true,
      encryptedPostmarkServerToken: "encrypted-token",
      replyToVerificationCodeHash: "verification-hash",
      managedTestCorrelations: [{ providerMessageId: "message-1" }],
    };

    expect(getManagedSenderReadiness(sender)).toBe("ready");
    const publicSender = sanitizeRegisteredSenderEmail(sender);
    expect(publicSender.readiness).toBe("ready");
    expect(publicSender).not.toHaveProperty("encryptedPostmarkServerToken");
    expect(publicSender).not.toHaveProperty("replyToVerificationCodeHash");
    expect(publicSender).not.toHaveProperty("managedTestCorrelations");
  });
});
