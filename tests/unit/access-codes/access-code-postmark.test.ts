import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/modules/registered-sender-email/services/managed-sender-resolver.service.js",
  () => ({
    resolveManagedSender: vi.fn().mockResolvedValue({
      id: "507f1f77bcf86cd799439013",
      displayName: "Example Studio",
      fromEmail: "studio@notify.shario.io",
      replyToEmail: "owner@example.test",
      postmarkServerToken: "test-server-token",
    }),
  }),
);
vi.mock("@/infrastructure/email/tenant-email-layout.service.js", () => ({
  applyTenantEmailLayout: vi.fn(async ({ html }) => html),
}));
vi.mock("@/modules/booking/customer-booking-link.service.js", () => ({
  resolveCustomerBookingLink: vi.fn().mockResolvedValue({
    locale: "cs",
    url: "https://studio.example/cs/portal",
  }),
}));

import { sendManagedTenantEmail } from "@/infrastructure/email/managed-email.service.js";
import { sendAccessCodeEmail } from "@/modules/access-codes/services/access-code-email.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const bookingId = "507f1f77bcf86cd799439012";
const deliveryId = "33d690e2-85e9-4c70-b91c-421f514eab40";
const bookingStart = new Date("2026-10-26T13:00:00.000Z");
const fetchMock = vi.fn();

describe("door-code email Postmark payload", () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(
      new Response(JSON.stringify({ ErrorCode: 0, MessageID: "postmark-1" })),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a real-sized door-code payload and retains webhook correlation", async () => {
    const beforeSend = vi.fn(async () => {
      expect(fetchMock).not.toHaveBeenCalled();
    });
    const messageId = `<access-code-${tenantId}-${bookingId}-${bookingStart.getTime()}@shario.io>`;

    await expect(
      sendAccessCodeEmail({
        tenantId,
        bookingId,
        deliveryId,
        to: "customer@example.test",
        studioName: "Example Studio",
        timezone: "Europe/Prague",
        entryCode: "test-7391",
        bookingStart,
        bookingEnd: new Date("2026-10-26T14:00:00.000Z"),
        beforeSend,
      }),
    ).resolves.toMatchObject({ providerMessageId: "postmark-1" });

    expect(messageId).toHaveLength(87);
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Metadata).toEqual({
      tenantId,
      managedSenderId: "507f1f77bcf86cd799439013",
      deliveryId,
      accessCodeBookingId: bookingId,
      messageIdHash: createHash("sha256").update(messageId).digest("hex"),
    });
    expect(body.Headers).toContainEqual({ Name: "Message-ID", Value: messageId });
    expect(body.TextBody).toContain("test-7391");
    expect(JSON.stringify(body.Metadata)).not.toContain("test-7391");
  });

  it("also preserves a long course-reminder header without exceeding metadata limits", async () => {
    const messageId = `<course-reminder-${"a".repeat(64)}@mail.shario.io>`;
    await sendManagedTenantEmail({
      tenantId,
      to: "customer@example.test",
      subject: "Course reminder",
      text: "Your course starts tomorrow.",
      messageId,
      headers: { "Message-ID": messageId },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Metadata.messageId).toBeUndefined();
    expect(body.Metadata.messageIdHash).toBe(
      createHash("sha256").update(messageId).digest("hex"),
    );
    expect(body.Headers).toContainEqual({ Name: "Message-ID", Value: messageId });
  });

  it("retains existing short message metadata unchanged", async () => {
    await sendManagedTenantEmail({
      tenantId,
      to: "customer@example.test",
      subject: "Existing delivery",
      text: "Content",
      messageId: bookingId,
      deliveryId,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Metadata.messageId).toBe(bookingId);
    expect(body.Metadata.messageIdHash).toBeUndefined();
    expect(body.Metadata.deliveryId).toBe(deliveryId);
  });

  it("still rejects oversized lookup identifiers before claiming or sending", async () => {
    const beforeSend = vi.fn();
    await expect(
      sendManagedTenantEmail({
        tenantId,
        to: "customer@example.test",
        subject: "Invalid delivery",
        text: "Content",
        deliveryId: "a".repeat(81),
        beforeSend,
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_METADATA_INVALID",
      deliveryOutcome: "not_sent",
    });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
