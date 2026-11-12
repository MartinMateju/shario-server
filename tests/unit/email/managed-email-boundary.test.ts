import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const mocks = vi.hoisted(() => ({
  applyTenantEmailLayout: vi.fn(),
  resolveManagedSender: vi.fn(),
  sendPostmarkEmail: vi.fn(),
}));

vi.mock("@/infrastructure/email/tenant-email-layout.service.js", () => ({ applyTenantEmailLayout: mocks.applyTenantEmailLayout }));

vi.mock(
  "@/modules/registered-sender-email/services/managed-sender-resolver.service.js",
  () => ({ resolveManagedSender: mocks.resolveManagedSender }),
);
vi.mock(
  "@/infrastructure/email/postmark.client.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/infrastructure/email/postmark.client.js")
    >()),
    sendPostmarkEmail: mocks.sendPostmarkEmail,
  }),
);

import { sendManagedTenantEmail } from "@/infrastructure/email/managed-email.service.js";
import {
  POSTMARK_ATTACHMENT_LIMIT_BYTES,
  PostmarkRequestError,
} from "@/infrastructure/email/postmark.client.js";

const sender = {
  id: "sender-1",
  displayName: "Example Studio",
  fromEmail: "studio-example@notify.shario.io",
  replyToEmail: "owner@example.com",
  postmarkServerToken: "test-server-token",
};
const input = {
  tenantId: "tenant-1",
  senderEmailId: "sender-1",
  to: "customer@example.com",
  subject: "Payment confirmation",
  text: "Your payment is complete.",
  orderId: "order-1",
  deliveryId: "claim-1",
  idempotencyKey: "order-confirm:order-1",
};
const sent = {
  provider: "postmark",
  providerMessageId: "provider-message-1",
  status: "sent",
} as const;

describe("managed email provider boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveManagedSender.mockResolvedValue(sender);
    mocks.applyTenantEmailLayout.mockImplementation(async (input) => input.html);
    mocks.sendPostmarkEmail.mockResolvedValue(sent);
  });

  it("does not claim a provider submission when sender lookup fails", async () => {
    const lookupError = new PostmarkRequestError("Sender is not ready", {
      code: "MANAGED_SENDER_NOT_READY",
      deliveryOutcome: "not_sent",
    });
    mocks.resolveManagedSender.mockRejectedValue(lookupError);
    const beforeSend = vi.fn();

    await expect(sendManagedTenantEmail({ ...input, beforeSend })).rejects.toBe(
      lookupError,
    );

    expect(beforeSend).not.toHaveBeenCalled();
    expect(mocks.sendPostmarkEmail).not.toHaveBeenCalled();
  });

  it("does not submit to the provider if the lease callback rejects", async () => {
    const leaseError = new PostmarkRequestError("The delivery lease expired", {
      code: "DELIVERY_LEASE_EXPIRED",
      deliveryOutcome: "not_sent",
    });
    const beforeSend = vi.fn().mockRejectedValue(leaseError);

    await expect(sendManagedTenantEmail({ ...input, beforeSend })).rejects.toBe(
      leaseError,
    );

    expect(mocks.resolveManagedSender).toHaveBeenCalledOnce();
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(mocks.sendPostmarkEmail).not.toHaveBeenCalled();
  });

  it("awaits sender resolution and the lease callback before sending order metadata", async () => {
    const events: string[] = [];
    let finishResolution!: (value: typeof sender) => void;
    let finishLease!: () => void;
    mocks.resolveManagedSender.mockImplementation(
      () =>
        new Promise<typeof sender>((resolve) => {
          finishResolution = (value) => {
            events.push("resolve");
            resolve(value);
          };
        }),
    );
    const beforeSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLease = () => {
            events.push("before");
            resolve();
          };
        }),
    );
    mocks.sendPostmarkEmail.mockImplementation(async () => {
      events.push("send");
      return sent;
    });

    const delivery = sendManagedTenantEmail({ ...input, beforeSend });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(mocks.sendPostmarkEmail).not.toHaveBeenCalled();

    finishResolution(sender);
    await vi.waitFor(() => expect(beforeSend).toHaveBeenCalledOnce());
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(mocks.sendPostmarkEmail).not.toHaveBeenCalled();

    finishLease();
    await expect(delivery).resolves.toBe(sent);

    expect(events).toEqual(["resolve", "before", "send"]);
    expect(mocks.resolveManagedSender).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      senderEmailId: "sender-1",
    });
    expect(mocks.sendPostmarkEmail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        serverToken: "test-server-token",
        from: '"Example Studio" <studio-example@notify.shario.io>',
        replyTo: "owner@example.com",
        to: "customer@example.com",
        subject: "Payment confirmation",
        text: "Your payment is complete.",
        metadata: {
          tenantId: "tenant-1",
          managedSenderId: "sender-1",
          idempotencyKey: "order-confirm:order-1",
          orderId: "order-1",
          deliveryId: "claim-1",
        },
      }),
    );
  });

  it("snapshots PDF bytes before the lease callback and retains tenant sender metadata", async () => {
    const pdf = Buffer.from(
      "%PDF-1.7\nVoucher code: TEST, value: CZK 20\n%%EOF",
    );
    const expected = pdf.toString("base64");
    const attachments = [{ filename: "voucher.pdf", content: pdf }];
    const beforeSend = vi.fn(async () => {
      pdf.fill(0);
      attachments[0].filename = "changed.pdf";
    });

    await expect(
      sendManagedTenantEmail({ ...input, attachments, beforeSend }),
    ).resolves.toBe(sent);

    expect(beforeSend).toHaveBeenCalledOnce();
    expect(mocks.sendPostmarkEmail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        from: '"Example Studio" <studio-example@notify.shario.io>',
        replyTo: "owner@example.com",
        attachments: [
          {
            Name: "voucher.pdf",
            Content: expected,
            ContentType: "application/pdf",
          },
        ],
        metadata: expect.objectContaining({
          tenantId: "tenant-1",
          orderId: "order-1",
          deliveryId: "claim-1",
        }),
      }),
    );
  });

  it.each([
    [
      "filesystem path",
      { filename: "voucher.pdf", path: "/private/receipt.pdf" },
    ],
    [
      "URL",
      { filename: "voucher.pdf", href: "https://example.com/receipt.pdf" },
    ],
    ["stream", { filename: "voucher.pdf", content: Readable.from(["pdf"]) }],
    ["string content", { filename: "voucher.pdf", content: "%PDF-1.7" }],
    ["empty buffer", { filename: "voucher.pdf", content: Buffer.alloc(0) }],
    ["missing filename", { content: Buffer.from("pdf") }],
    [
      "directory filename",
      { filename: "../voucher.pdf", content: Buffer.from("pdf") },
    ],
    [
      "header injection",
      { filename: "voucher\r\n.pdf", content: Buffer.from("pdf") },
    ],
    [
      "non-PDF filename",
      { filename: "voucher.html", content: Buffer.from("pdf") },
    ],
    [
      "non-PDF MIME",
      {
        filename: "voucher.pdf",
        content: Buffer.from("pdf"),
        contentType: "text/html",
      },
    ],
    [
      "extra path option",
      {
        filename: "voucher.pdf",
        content: Buffer.from("pdf"),
        path: "/private/receipt.pdf",
      },
    ],
  ])(
    "rejects %s before looking up a sender or claiming submission",
    async (_name, attachment) => {
      const beforeSend = vi.fn();
      await expect(
        sendManagedTenantEmail({
          ...input,
          attachments: [attachment],
          beforeSend,
        }),
      ).rejects.toMatchObject({
        code: "EMAIL_ATTACHMENT_INVALID",
        permanent: true,
        deliveryOutcome: "not_sent",
      });
      expect(mocks.resolveManagedSender).not.toHaveBeenCalled();
      expect(beforeSend).not.toHaveBeenCalled();
      expect(mocks.sendPostmarkEmail).not.toHaveBeenCalled();
    },
  );

  it("rejects an aggregate PDF payload over 6 MiB before the send fence", async () => {
    const beforeSend = vi.fn();
    await expect(
      sendManagedTenantEmail({
        ...input,
        attachments: [
          {
            filename: "first.pdf",
            content: Buffer.alloc(POSTMARK_ATTACHMENT_LIMIT_BYTES / 2),
          },
          {
            filename: "second.pdf",
            content: Buffer.alloc(POSTMARK_ATTACHMENT_LIMIT_BYTES / 2 + 1),
          },
        ],
        beforeSend,
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_ATTACHMENTS_TOO_LARGE",
      permanent: true,
      deliveryOutcome: "not_sent",
    });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(mocks.sendPostmarkEmail).not.toHaveBeenCalled();
  });

  it("accepts exactly 6 MiB of PDFs when the encoded message fits", async () => {
    await sendManagedTenantEmail({
      ...input,
      attachments: [
        {
          filename: "voucher.pdf",
          content: Buffer.alloc(POSTMARK_ATTACHMENT_LIMIT_BYTES),
        },
      ],
    });
    expect(mocks.sendPostmarkEmail).toHaveBeenCalledOnce();
  });

  it("rejects oversized encoded mail including the body before the send fence", async () => {
    const beforeSend = vi.fn();
    await expect(
      sendManagedTenantEmail({
        ...input,
        text: "x".repeat(700_000),
        attachments: [
          {
            filename: "voucher.pdf",
            content: Buffer.alloc(POSTMARK_ATTACHMENT_LIMIT_BYTES),
          },
        ],
        beforeSend,
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_MESSAGE_TOO_LARGE",
      permanent: true,
      deliveryOutcome: "not_sent",
    });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(mocks.sendPostmarkEmail).not.toHaveBeenCalled();
  });

  it("rejects more PDFs than a supported voucher purchase before the send fence", async () => {
    const beforeSend = vi.fn();
    await expect(
      sendManagedTenantEmail({
        ...input,
        attachments: Array.from({ length: 21 }, (_, index) => ({
          filename: `voucher-${index}.pdf`,
          content: Buffer.from("pdf"),
        })),
        beforeSend,
      }),
    ).rejects.toMatchObject({
      code: "EMAIL_ATTACHMENT_INVALID",
      deliveryOutcome: "not_sent",
    });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(mocks.sendPostmarkEmail).not.toHaveBeenCalled();
  });
});
