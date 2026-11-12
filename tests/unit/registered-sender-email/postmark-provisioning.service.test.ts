import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  provisionServer: vi.fn(),
  configureWebhook: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("@/infrastructure/email/postmark.client.js", () => ({
  provisionPostmarkServer: mocks.provisionServer,
  configurePostmarkOutboundWebhook: mocks.configureWebhook,
}));
vi.mock("@/shared/security/encryption.js", () => ({
  encryptSecret: mocks.encrypt,
  decryptSecret: mocks.decrypt,
}));

import {
  configureStoredManagedTenantWebhook,
  provisionManagedTenantServer,
} from "@/modules/registered-sender-email/services/postmark-provisioning.service.js";

describe("managed Postmark Server provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.provisionServer.mockResolvedValue({
      serverId: 23,
      serverToken: "plain-server-token",
      serverName: "shario-test-tenant",
    });
    mocks.configureWebhook.mockResolvedValue({
      webhookId: 42,
      status: "verified",
    });
    mocks.encrypt.mockReturnValue("encrypted-server-token");
    mocks.decrypt.mockReturnValue("plain-server-token");
  });

  it("returns an encrypted Server binding without configuring the webhook", async () => {
    const result = await provisionManagedTenantServer(
      "507f1f77bcf86cd799439011",
    );
    expect(mocks.provisionServer).toHaveBeenCalledOnce();
    expect(mocks.encrypt).toHaveBeenCalledWith("plain-server-token");
    expect(mocks.configureWebhook).not.toHaveBeenCalled();
    expect(result).toEqual({
      providerServerId: 23,
      encryptedPostmarkServerToken: "encrypted-server-token",
    });
  });

  it("configures a stored tenant Server using its decrypted token", async () => {
    const attemptId = "6444f850-f150-4a65-b9a4-12d5dc66fdad";
    await configureStoredManagedTenantWebhook("encrypted-server-token", attemptId);
    expect(mocks.decrypt).toHaveBeenCalledWith("encrypted-server-token");
    expect(mocks.configureWebhook).toHaveBeenCalledWith("plain-server-token", attemptId);
  });
});
