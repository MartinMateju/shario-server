import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findManagedForResolution: vi.fn(),
  decryptSecret: vi.fn(),
}));

vi.mock(
  "@/modules/registered-sender-email/registered-sender-email.repository.js",
  () => ({
    registeredSenderEmailRepository: {
      findManagedForResolution: mocks.findManagedForResolution,
    },
  }),
);
vi.mock("@/shared/security/encryption.js", () => ({
  decryptSecret: mocks.decryptSecret,
}));

import { resolveManagedSender } from "@/modules/registered-sender-email/services/managed-sender-resolver.service.js";

const readySender = {
  _id: "sender-1",
  email: "studio-abc@notify.shario.io",
  displayName: "Studio",
  provider: "postmark_managed",
  isActive: true,
  replyToEmail: "owner@example.com",
  replyToVerifiedAt: new Date("2026-08-10T10:00:00.000Z"),
  providerServerId: 42,
  providerProvisionedAt: new Date("2026-08-10T09:00:00.000Z"),
  providerProvisioningStatus: "ready",
  encryptedPostmarkServerToken: "encrypted-token",
};

describe("managed sender resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("POSTMARK_FROM_DOMAIN", "notify.shario.io");
    mocks.findManagedForResolution.mockResolvedValue({ ...readySender });
    mocks.decryptSecret.mockReturnValue("postmark-server-token");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("returns only a fully provisioned and verified managed identity", async () => {
    await expect(
      resolveManagedSender({ tenantId: "tenant-1", senderEmailId: "sender-1" }),
    ).resolves.toMatchObject({
      id: "sender-1",
      fromEmail: "studio-abc@notify.shario.io",
      replyToEmail: "owner@example.com",
      postmarkServerToken: "postmark-server-token",
    });
  });

  it.each([
    [{ provider: "custom" }, "MANAGED_SENDER_NOT_READY"],
    [{ replyToVerifiedAt: null }, "REPLY_TO_NOT_VERIFIED"],
    [{ providerServerId: null }, "POSTMARK_SERVER_NOT_PROVISIONED"],
    [{ email: "owner@example.com" }, "MANAGED_FROM_DOMAIN_INVALID"],
  ])("fails closed for an invalid sender binding", async (override, code) => {
    mocks.findManagedForResolution.mockResolvedValue({
      ...readySender,
      ...override,
    });

    await expect(
      resolveManagedSender({ tenantId: "tenant-1" }),
    ).rejects.toMatchObject({
      code,
      permanent: true,
      deliveryOutcome: "not_sent",
    });
  });

  it("never falls back when no managed identity exists", async () => {
    mocks.findManagedForResolution.mockResolvedValue(null);

    await expect(
      resolveManagedSender({ tenantId: "tenant-1" }),
    ).rejects.toMatchObject({ code: "MANAGED_SENDER_NOT_CONFIGURED" });
    expect(mocks.decryptSecret).not.toHaveBeenCalled();
  });
});
