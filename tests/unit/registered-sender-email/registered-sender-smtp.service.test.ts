import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  decryptEmailPassword: vi.fn(),
  resolveConfiguredSmtpEndpoint: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: mocks.createTransport,
  },
}));

vi.mock("@/shared/security/encryption.js", () => ({
  decryptEmailPassword: mocks.decryptEmailPassword,
}));

vi.mock(
  "@/modules/registered-sender-email/services/smtp-network-policy.js",
  () => ({
    resolveConfiguredSmtpEndpoint: mocks.resolveConfiguredSmtpEndpoint,
  }),
);

import {
  buildRegisteredSenderTransporter,
  verifyRegisteredSenderSmtp,
} from "@/modules/registered-sender-email/services/registered-sender-smtp.service.js";

const sender = {
  encryptedSmtpPassword: "encrypted",
  provider: "custom",
  smtpHost: "mail.example.com",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "studio@example.com",
} as never;

describe("registered sender SMTP transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decryptEmailPassword.mockReturnValue("decrypted-password");
    mocks.resolveConfiguredSmtpEndpoint.mockResolvedValue({
      address: "203.1.1.10",
      family: 4,
      hostname: "mail.example.com",
      servername: "mail.example.com",
    });
    mocks.createTransport.mockReturnValue({
      close: mocks.close,
      verify: mocks.verify,
    });
    mocks.verify.mockResolvedValue(true);
  });

  it("connects to the policy-approved IP and keeps the hostname for TLS", async () => {
    await buildRegisteredSenderTransporter(sender);

    expect(mocks.resolveConfiguredSmtpEndpoint).toHaveBeenCalledWith({
      provider: "custom",
      hostname: "mail.example.com",
      port: 587,
      lookup: undefined,
    });
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "203.1.1.10",
        port: 587,
        secure: false,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
        auth: {
          user: "studio@example.com",
          pass: "decrypted-password",
        },
        tls: expect.objectContaining({
          rejectUnauthorized: true,
          servername: "mail.example.com",
        }),
      }),
    );
  });

  it("always closes the test transporter after a successful verification", async () => {
    await expect(verifyRegisteredSenderSmtp(sender)).resolves.toBeUndefined();

    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("closes the test transporter when verification fails", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("SMTP timed out"));

    await expect(verifyRegisteredSenderSmtp(sender)).rejects.toThrow(
      "SMTP timed out",
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
