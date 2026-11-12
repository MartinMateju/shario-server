import { describe, expect, it } from "vitest";

import { registeredSenderEmailSchema } from "@/modules/registered-sender-email/registered-sender-email.schema.js";
import { sanitizeRegisteredSenderEmail } from "@/modules/registered-sender-email/registered-sender-email.utils.js";
import { createRegisteredSenderEmailSchema } from "@/modules/registered-sender-email/registered-sender-email.validators.js";

const managed = {
  _id: "sender-1",
  tenant: "tenant-1",
  email: "studio-abc@notify.shario.io",
  provider: "postmark_managed",
  isActive: true,
  providerServerId: 42,
  providerProvisionedAt: new Date("2026-08-10T09:00:00.000Z"),
  providerProvisioningStatus: "ready",
  replyToEmail: "owner@example.com",
  replyToVerifiedAt: new Date("2026-08-10T10:00:00.000Z"),
};

describe("managed sender public contract", () => {
  it("accepts only managed identity input and rejects SMTP credentials", () => {
    expect(
      createRegisteredSenderEmailSchema.parse({
        replyToEmail: "Owner@Example.com",
        displayName: "Studio",
      }),
    ).toMatchObject({
      replyToEmail: "owner@example.com",
      displayName: "Studio",
    });
    expect(() =>
      createRegisteredSenderEmailSchema.parse({
        replyToEmail: "owner@example.com",
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpUser: "owner@example.com",
        smtpPassword: "secret",
      }),
    ).toThrow();
  });

  it.each([
    [{}, "ready"],
    [{ replyToVerifiedAt: null, replyToEmail: "" }, "reply_to_pending"],
    [
      { providerProvisioningStatus: "pending", providerProvisionedAt: null },
      "provisioning",
    ],
    [{ providerProvisioningStatus: "error" }, "error"],
    [{ isActive: false }, "disabled"],
  ])("emits a stable readiness state", (override, readiness) => {
    expect(
      sanitizeRegisteredSenderEmail({ ...managed, ...override }),
    ).toMatchObject({ readiness });
  });

  it("exposes only normalized provisioning diagnostics", () => {
    const attemptedAt = new Date("2026-08-10T11:30:00.000Z");
    const sanitized = sanitizeRegisteredSenderEmail({
      ...managed,
      providerProvisioningStatus: "error",
      providerProvisioningError: "X-Postmark-Server-Token=secret",
      providerProvisioningErrorCode: "POSTMARK_1364",
      providerProvisioningAttemptedAt: attemptedAt,
      providerProvisioningAttemptId: "private-attempt-id",
    });

    expect(sanitized).toMatchObject({
      readiness: "error",
      providerProvisioningErrorCode: "POSTMARK_1364",
      providerProvisioningAttemptedAt: attemptedAt,
    });
    expect(sanitized).not.toHaveProperty("providerProvisioningError");
    expect(sanitized).not.toHaveProperty("providerProvisioningAttemptId");
    expect(JSON.stringify(sanitized)).not.toContain("secret");

    expect(
      sanitizeRegisteredSenderEmail({
        ...managed,
        providerProvisioningStatus: "error",
        providerProvisioningErrorCode: "unsafe provider message",
      }),
    ).toMatchObject({ providerProvisioningErrorCode: "" });
  });

  it("enforces one managed identity per tenant even after deactivation", () => {
    const index = registeredSenderEmailSchema
      .indexes()
      .find(([keys]) => keys.tenant === 1 && keys.provider === 1);
    expect(index?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { provider: "postmark_managed" },
    });
    expect(index?.[1]?.partialFilterExpression).not.toHaveProperty("isActive");
  });

  it("keeps a bounded test-delivery correlation private and indexed", () => {
    const sanitized = sanitizeRegisteredSenderEmail({
      ...managed,
      lastTestProviderMessageId: "postmark-message-1",
      lastTestRecipientEmail: "owner@example.com",
      lastTestStatus: "pending",
      lastTestedAt: new Date("2026-08-10T12:00:00.000Z"),
      managedTestCorrelations: [
        {
          providerMessageId: "postmark-message-1",
          recipientEmail: "owner@example.com",
        },
      ],
    });
    expect(sanitized).not.toHaveProperty("lastTestProviderMessageId");
    expect(sanitized).not.toHaveProperty("lastTestRecipientEmail");
    expect(sanitized).not.toHaveProperty("managedTestCorrelations");
    expect(sanitized).toMatchObject({
      lastTestStatus: "pending",
      lastTestedAt: new Date("2026-08-10T12:00:00.000Z"),
    });

    const index = registeredSenderEmailSchema
      .indexes()
      .find(
        ([keys]) => keys["managedTestCorrelations.providerMessageId"] === 1,
      );
    expect(index?.[1]).toMatchObject({ unique: true });
  });
});
