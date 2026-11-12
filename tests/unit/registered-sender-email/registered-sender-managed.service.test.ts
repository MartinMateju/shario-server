import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByIdWithSecrets: vi.fn(),
  armReplyToVerification: vi.fn(),
  clearReplyToVerification: vi.fn(),
  recordFailedReplyToVerification: vi.fn(),
  consumeReplyToVerification: vi.fn(),
  recordManagedTestAccepted: vi.fn(),
  updateManaged: vi.fn(),
  beginPostmarkProvisioning: vi.fn(),
  bindPostmarkServerPending: vi.fn(),
  markPostmarkServerReady: vi.fn(),
  markProvisioningFailure: vi.fn(),
  configureStoredManagedTenantWebhook: vi.fn(),
  provisionManagedTenantServer: vi.fn(),
  sendSystemPostmarkEmail: vi.fn(),
  sendManagedTenantEmail: vi.fn(),
}));

vi.mock(
  "@/modules/registered-sender-email/registered-sender-email.repository.js",
  () => ({
    registeredSenderEmailRepository: {
      findByIdWithSecrets: mocks.findByIdWithSecrets,
      armReplyToVerification: mocks.armReplyToVerification,
      clearReplyToVerification: mocks.clearReplyToVerification,
      recordFailedReplyToVerification: mocks.recordFailedReplyToVerification,
      consumeReplyToVerification: mocks.consumeReplyToVerification,
      recordManagedTestAccepted: mocks.recordManagedTestAccepted,
      updateManaged: mocks.updateManaged,
      beginPostmarkProvisioning: mocks.beginPostmarkProvisioning,
      bindPostmarkServerPending: mocks.bindPostmarkServerPending,
      markPostmarkServerReady: mocks.markPostmarkServerReady,
      markProvisioningFailure: mocks.markProvisioningFailure,
    },
  }),
);
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendSystemPostmarkEmail: mocks.sendSystemPostmarkEmail,
  sendManagedTenantEmail: mocks.sendManagedTenantEmail,
}));
vi.mock(
  "@/modules/registered-sender-email/services/postmark-provisioning.service.js",
  () => ({
    buildManagedSenderEmail: vi.fn(),
    provisionManagedTenantServer: mocks.provisionManagedTenantServer,
    configureStoredManagedTenantWebhook:
      mocks.configureStoredManagedTenantWebhook,
  }),
);
vi.mock("@/shared/http/httpErrors.js", () => {
  const fail = (message: string) => {
    throw new Error(message);
  };
  return { badRequest: fail, conflict: fail, notFound: fail };
});

import { registeredSenderEmailService } from "@/modules/registered-sender-email/services/registered-sender-email.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const SENDER_ID = "507f191e810c19729de860ea";
const PENDING_EMAIL = "owner@example.com";
const sender = {
  _id: SENDER_ID,
  tenant: TENANT_ID,
  email: "studio-abc@notify.shario.io",
  displayName: "Studio",
  provider: "postmark_managed",
  providerServerId: 42,
  providerProvisionedAt: new Date("2026-08-10T09:00:00.000Z"),
  providerProvisioningStatus: "ready",
  encryptedPostmarkServerToken: "encrypted-token",
  isActive: true,
  pendingReplyToEmail: PENDING_EMAIL,
  replyToEmail: "",
  replyToVerifiedAt: null,
  replyToVerificationAttempts: 0,
};

const codeHash = (code: string) =>
  createHmac("sha256", "verification-pepper")
    .update(`${SENDER_ID}\n${PENDING_EMAIL}\n${code}`)
    .digest("hex");

describe("managed sender Reply-To verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    vi.stubEnv("EMAIL_SECRET_KEY", "verification-pepper");
    vi.stubEnv("REPLY_TO_VERIFICATION_TTL_SECONDS", "900");
    vi.stubEnv("REPLY_TO_VERIFICATION_RESEND_SECONDS", "60");
    vi.stubEnv("REPLY_TO_VERIFICATION_MAX_ATTEMPTS", "5");
    mocks.findByIdWithSecrets.mockResolvedValue({ ...sender });
    mocks.beginPostmarkProvisioning.mockImplementation(
      async (current) => ({
        ...current,
        providerProvisionedAt: null,
        providerProvisioningStatus: "pending",
      }),
    );
    mocks.bindPostmarkServerPending.mockImplementation(
      async (current, _attemptId, binding) => ({
        ...current,
        ...binding,
      }),
    );
    mocks.provisionManagedTenantServer.mockResolvedValue({
      providerServerId: 42,
      encryptedPostmarkServerToken: "encrypted-token",
    });
    mocks.armReplyToVerification.mockImplementation(async (input) => ({
      ...sender,
      replyToVerificationCodeHash: input.codeHash,
      replyToVerificationExpiresAt: input.expiresAt,
      replyToVerificationSentAt: input.sentAt,
    }));
    mocks.sendSystemPostmarkEmail.mockResolvedValue({
      provider: "postmark",
      providerMessageId: "verification-message-1",
      status: "sent",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("stores only a peppered hash and sends a six-digit code through the system Server", async () => {
    await expect(
      registeredSenderEmailService.requestReplyToVerification(
        TENANT_ID,
        SENDER_ID,
      ),
    ).resolves.toMatchObject({ message: "Verification code sent." });

    const verificationMessage = mocks.sendSystemPostmarkEmail.mock.calls[0][0];
    const code = String(verificationMessage.text).match(/\b(\d{6})\b/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(mocks.armReplyToVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        id: SENDER_ID,
        pendingReplyToEmail: PENDING_EMAIL,
        codeHash: codeHash(String(code)),
        expiresAt: new Date("2026-08-10T12:15:00.000Z"),
      }),
    );
    expect(
      JSON.stringify(mocks.armReplyToVerification.mock.calls[0][0]),
    ).not.toContain(`"code":"${code}"`);
  });

  it("clears the armed challenge if the verification email is definitely rejected", async () => {
    mocks.sendSystemPostmarkEmail.mockRejectedValueOnce(
      Object.assign(new Error("Rejected"), { deliveryOutcome: "not_sent" }),
    );

    await expect(
      registeredSenderEmailService.requestReplyToVerification(
        TENANT_ID,
        SENDER_ID,
      ),
    ).rejects.toThrow("Rejected");
    expect(mocks.clearReplyToVerification).toHaveBeenCalledWith(
      TENANT_ID,
      SENDER_ID,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });

  it("increments failed attempts against the current challenge without changing Reply-To", async () => {
    mocks.findByIdWithSecrets.mockResolvedValue({
      ...sender,
      replyToVerificationCodeHash: codeHash("123456"),
      replyToVerificationExpiresAt: new Date("2026-08-10T12:15:00.000Z"),
    });

    await expect(
      registeredSenderEmailService.confirmReplyToVerification(
        TENANT_ID,
        SENDER_ID,
        { code: "654321" },
      ),
    ).rejects.toThrow("invalid or expired");
    expect(mocks.recordFailedReplyToVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        codeHash: codeHash("123456"),
        pendingReplyToEmail: PENDING_EMAIL,
        maximumAttempts: 5,
      }),
    );
    expect(mocks.consumeReplyToVerification).not.toHaveBeenCalled();
  });

  it("atomically consumes a matching code bound to the pending address", async () => {
    const storedHash = codeHash("123456");
    mocks.findByIdWithSecrets.mockResolvedValue({
      ...sender,
      replyToVerificationCodeHash: storedHash,
      replyToVerificationExpiresAt: new Date("2026-08-10T12:15:00.000Z"),
    });
    mocks.consumeReplyToVerification.mockResolvedValue({
      ...sender,
      pendingReplyToEmail: "",
      replyToEmail: PENDING_EMAIL,
      replyToVerifiedAt: new Date("2026-08-10T12:00:00.000Z"),
    });

    await expect(
      registeredSenderEmailService.confirmReplyToVerification(
        TENANT_ID,
        SENDER_ID,
        { code: "123456" },
      ),
    ).resolves.toMatchObject({ message: "Reply-To address verified." });
    expect(mocks.consumeReplyToVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        id: SENDER_ID,
        pendingReplyToEmail: PENDING_EMAIL,
        codeHash: storedHash,
        maximumAttempts: 5,
      }),
    );
  });

  it("persists accepted test MessageID and recipient for webhook correlation", async () => {
    const verifiedSender = {
      ...sender,
      pendingReplyToEmail: "",
      replyToEmail: PENDING_EMAIL,
      replyToVerifiedAt: new Date("2026-08-10T11:00:00.000Z"),
    };
    mocks.findByIdWithSecrets.mockResolvedValue(verifiedSender);
    mocks.sendManagedTenantEmail.mockResolvedValue({
      provider: "postmark",
      providerMessageId: "test-message-1",
      status: "sent",
    });
    mocks.recordManagedTestAccepted.mockResolvedValue(verifiedSender);

    await expect(
      registeredSenderEmailService.test(TENANT_ID, SENDER_ID),
    ).resolves.toMatchObject({
      providerMessageId: "test-message-1",
    });
    expect(mocks.recordManagedTestAccepted).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      id: SENDER_ID,
      recipientEmail: PENDING_EMAIL,
      providerMessageId: "test-message-1",
      acceptedAt: new Date("2026-08-10T12:00:00.000Z"),
    });
  });

  it("retries a stored Postmark binding as pending before marking it ready", async () => {
    const failedSender = {
      ...sender,
      providerProvisionedAt: null,
      providerProvisioningStatus: "error",
      providerProvisioningError: "Webhook was temporarily unavailable.",
    };
    const pendingSender = {
      ...failedSender,
      providerProvisioningStatus: "pending",
      providerProvisioningError: "",
    };
    const readySender = {
      ...pendingSender,
      providerProvisionedAt: new Date("2026-08-10T12:00:00.000Z"),
      providerProvisioningStatus: "ready",
    };
    mocks.findByIdWithSecrets.mockResolvedValue(failedSender);
    mocks.updateManaged.mockResolvedValue(failedSender);
    mocks.beginPostmarkProvisioning.mockResolvedValue(pendingSender);
    mocks.configureStoredManagedTenantWebhook.mockResolvedValue({
      webhookId: 7,
      status: "verified",
    });
    mocks.markPostmarkServerReady.mockResolvedValue(readySender);

    await expect(
      registeredSenderEmailService.update(TENANT_ID, SENDER_ID, {
        displayName: "Recovered Studio",
      }),
    ).resolves.toMatchObject({
      providerProvisioningStatus: "ready",
      readiness: "reply_to_pending",
    });
    expect(mocks.beginPostmarkProvisioning).toHaveBeenCalledWith(
      failedSender,
      expect.objectContaining({
        id: expect.any(String),
        at: new Date("2026-08-10T12:00:00.000Z"),
      }),
    );
    const attemptId =
      mocks.beginPostmarkProvisioning.mock.calls[0][1].id;
    expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mocks.configureStoredManagedTenantWebhook).toHaveBeenCalledWith(
      "encrypted-token",
      attemptId,
    );
    expect(mocks.markPostmarkServerReady).toHaveBeenCalledWith(
      pendingSender,
      attemptId,
      new Date("2026-08-10T12:00:00.000Z"),
    );
    expect(
      mocks.beginPostmarkProvisioning.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.configureStoredManagedTenantWebhook.mock.invocationCallOrder[0],
    );
    expect(
      mocks.configureStoredManagedTenantWebhook.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.markPostmarkServerReady.mock.invocationCallOrder[0],
    );
  });

  it("persists a new tenant Server binding before configuring its webhook", async () => {
    const unbound = {
      ...sender,
      providerServerId: null,
      encryptedPostmarkServerToken: "",
      providerProvisionedAt: null,
      providerProvisioningStatus: "error",
    };
    const pending = {
      ...unbound,
      providerProvisioningStatus: "pending",
    };
    const bound = {
      ...pending,
      providerServerId: 42,
      encryptedPostmarkServerToken: "encrypted-token",
    };
    mocks.findByIdWithSecrets.mockResolvedValue(unbound);
    mocks.updateManaged.mockResolvedValue(unbound);
    mocks.beginPostmarkProvisioning.mockResolvedValue(pending);
    mocks.bindPostmarkServerPending.mockResolvedValue(bound);
    mocks.markPostmarkServerReady.mockResolvedValue({
      ...bound,
      providerProvisionedAt: new Date("2026-08-10T12:00:00.000Z"),
      providerProvisioningStatus: "ready",
    });

    await registeredSenderEmailService.update(TENANT_ID, SENDER_ID, {});

    expect(mocks.provisionManagedTenantServer).toHaveBeenCalledWith(TENANT_ID);
    const attemptId =
      mocks.beginPostmarkProvisioning.mock.calls[0][1].id;
    expect(mocks.bindPostmarkServerPending).toHaveBeenCalledWith(
      pending,
      attemptId,
      {
        providerServerId: 42,
        encryptedPostmarkServerToken: "encrypted-token",
      },
    );
    expect(mocks.configureStoredManagedTenantWebhook).toHaveBeenCalledWith(
      "encrypted-token",
      attemptId,
    );
    expect(mocks.markPostmarkServerReady).toHaveBeenCalledWith(
      bound,
      attemptId,
      new Date("2026-08-10T12:00:00.000Z"),
    );
    expect(
      mocks.bindPostmarkServerPending.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.configureStoredManagedTenantWebhook.mock.invocationCallOrder[0],
    );
  });

  it("stores only a safe Postmark error code when verification fails", async () => {
    const failedSender = {
      ...sender,
      providerProvisionedAt: null,
      providerProvisioningStatus: "error",
    };
    const pendingSender = {
      ...failedSender,
      providerProvisioningStatus: "pending",
    };
    mocks.findByIdWithSecrets.mockResolvedValue(failedSender);
    mocks.updateManaged.mockResolvedValue(failedSender);
    mocks.beginPostmarkProvisioning.mockResolvedValue(pendingSender);
    mocks.configureStoredManagedTenantWebhook.mockRejectedValue(
      Object.assign(new Error("Raw provider detail must stay private."), {
        code: "POSTMARK_1364",
      }),
    );

    await expect(
      registeredSenderEmailService.update(TENANT_ID, SENDER_ID, {}),
    ).rejects.toThrow("Raw provider detail");

    const attemptId =
      mocks.beginPostmarkProvisioning.mock.calls[0][1].id;
    expect(mocks.markProvisioningFailure).toHaveBeenCalledWith(
      TENANT_ID,
      SENDER_ID,
      attemptId,
      {
        message: "Raw provider detail must stay private.",
        code: "POSTMARK_1364",
        attemptedAt: new Date("2026-08-10T12:00:00.000Z"),
      },
    );
    expect(mocks.markPostmarkServerReady).not.toHaveBeenCalled();
  });

  it("uses a stable fallback instead of persisting arbitrary error codes", async () => {
    const failedSender = {
      ...sender,
      providerProvisionedAt: null,
      providerProvisioningStatus: "error",
    };
    mocks.findByIdWithSecrets.mockResolvedValue(failedSender);
    mocks.updateManaged.mockResolvedValue(failedSender);
    mocks.beginPostmarkProvisioning.mockResolvedValue({
      ...failedSender,
      providerProvisioningStatus: "pending",
    });
    mocks.configureStoredManagedTenantWebhook.mockRejectedValue(
      Object.assign(new Error("Unexpected internal detail."), {
        code: "arbitrary free-form code",
      }),
    );

    await expect(
      registeredSenderEmailService.update(TENANT_ID, SENDER_ID, {}),
    ).rejects.toThrow("Unexpected internal detail");

    expect(mocks.markProvisioningFailure).toHaveBeenCalledWith(
      TENANT_ID,
      SENDER_ID,
      expect.any(String),
      expect.objectContaining({
        code: "MANAGED_EMAIL_PROVISIONING_FAILED",
        attemptedAt: new Date("2026-08-10T12:00:00.000Z"),
      }),
    );
  });

});
