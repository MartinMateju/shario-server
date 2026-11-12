import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveManagedSender: vi.fn(),
  conflict: vi.fn((value: { message: string; code: string }) => {
    throw Object.assign(new Error(value.message), {
      statusCode: 409,
      code: value.code,
    });
  }),
  badRequest: vi.fn((value: { message: string; code: string }) => {
    throw Object.assign(new Error(value.message), {
      statusCode: 400,
      code: value.code,
    });
  }),
}));

vi.mock(
  "@/modules/registered-sender-email/services/managed-sender-resolver.service.js",
  () => ({ resolveManagedSender: mocks.resolveManagedSender }),
);
vi.mock("@/shared/http/httpErrors.js", () => ({
  badRequest: mocks.badRequest,
  conflict: mocks.conflict,
}));

import {
  assertOutboundEmailContentSupported,
  resolveOutboundComposeSender,
} from "@/modules/communications/services/outbound-email-readiness.service.js";

describe("manual communication email readiness gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires the central managed sender resolver before email materialization", async () => {
    const expected = {
      id: "sender-1",
      tenantId: "tenant-1",
      fromEmail: "studio@notify.shario.io",
      displayName: "Studio",
      replyToEmail: "owner@example.com",
      postmarkServerToken: "server-token",
      providerServerId: 42,
    };
    mocks.resolveManagedSender.mockResolvedValue(expected);

    await expect(
      resolveOutboundComposeSender({ tenantId: "tenant-1", channel: "email" }),
    ).resolves.toBe(expected);
    expect(mocks.resolveManagedSender).toHaveBeenCalledWith({
      tenantId: "tenant-1",
    });
  });

  it("returns a typed conflict before materializing unready email", async () => {
    const error = Object.assign(new Error("Reply-To is not verified."), {
      code: "REPLY_TO_NOT_VERIFIED",
      deliveryOutcome: "not_sent",
    });
    mocks.resolveManagedSender.mockRejectedValue(error);

    await expect(
      resolveOutboundComposeSender({ tenantId: "tenant-1", channel: "email" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "REPLY_TO_NOT_VERIFIED",
    });
    expect(mocks.conflict).toHaveBeenCalledWith({
      message: "Reply-To is not verified.",
      code: "REPLY_TO_NOT_VERIFIED",
    });
  });

  it("does not require Postmark for internal in-app notes", async () => {
    await expect(
      resolveOutboundComposeSender({ tenantId: "tenant-1", channel: "in_app" }),
    ).resolves.toBeNull();
    expect(mocks.resolveManagedSender).not.toHaveBeenCalled();
  });

  it("rejects email attachments before a message or delivery can be created", () => {
    expect(() =>
      assertOutboundEmailContentSupported({
        channel: "email",
        attachments: [{ name: "invoice.pdf" }],
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        code: "ATTACHMENTS_NOT_SUPPORTED",
      }),
    );
  });
});
