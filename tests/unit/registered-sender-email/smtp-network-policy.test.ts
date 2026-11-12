import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isAllowedSmtpPort,
  isPublicSmtpAddress,
  resolveConfiguredSmtpEndpoint,
  resolvePublicSmtpEndpoint,
  SmtpEndpointPolicyError,
} from "@/modules/registered-sender-email/services/smtp-network-policy.js";

describe("SMTP network policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows only common SMTP ports by default", () => {
    expect(isAllowedSmtpPort(25)).toBe(true);
    expect(isAllowedSmtpPort(465)).toBe(true);
    expect(isAllowedSmtpPort(587)).toBe(true);
    expect(isAllowedSmtpPort(2_525)).toBe(true);
    expect(isAllowedSmtpPort(22)).toBe(false);
    expect(isAllowedSmtpPort(6_379)).toBe(false);
  });

  it("supports an explicit deployment-level SMTP port allowlist", () => {
    vi.stubEnv("SMTP_ALLOWED_PORTS", "587, 2465");

    expect(isAllowedSmtpPort(587)).toBe(true);
    expect(isAllowedSmtpPort(2_465)).toBe(true);
    expect(isAllowedSmtpPort(465)).toBe(false);
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicSmtpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPublicSmtpAddress(address)).toBe(true);
    },
  );

  it("pins a public DNS result while preserving the hostname for TLS", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "203.1.1.10", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    await expect(
      resolvePublicSmtpEndpoint({
        hostname: "Mail.Example.COM.",
        port: 587,
        lookup,
      }),
    ).resolves.toEqual({
      address: "203.1.1.10",
      family: 4,
      hostname: "mail.example.com",
      servername: "mail.example.com",
    });
    expect(lookup).toHaveBeenCalledWith("mail.example.com");
  });

  it("prefers an approved IPv4 address when DNS returns IPv6 first", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "203.1.1.10", family: 4 },
    ]);

    await expect(
      resolvePublicSmtpEndpoint({
        hostname: "mail.example.com",
        port: 587,
        lookup,
      }),
    ).resolves.toMatchObject({
      address: "203.1.1.10",
      family: 4,
    });
  });

  it("rejects the entire DNS answer when any address is private", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "203.1.1.10", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(
      resolvePublicSmtpEndpoint({
        hostname: "mail.example.com",
        port: 587,
        lookup,
      }),
    ).rejects.toBeInstanceOf(SmtpEndpointPolicyError);
  });

  it.each(["localhost", "smtp.internal", "mail.local", "127.0.0.1"])(
    "rejects local SMTP host %s",
    async (hostname) => {
      await expect(
        resolvePublicSmtpEndpoint({ hostname, port: 587 }),
      ).rejects.toBeInstanceOf(SmtpEndpointPolicyError);
    },
  );

  it("rejects non-SMTP ports before DNS is queried", async () => {
    const lookup = vi.fn();

    await expect(
      resolvePublicSmtpEndpoint({
        hostname: "mail.example.com",
        port: 6_379,
        lookup,
      }),
    ).rejects.toBeInstanceOf(SmtpEndpointPolicyError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("uses the fixed Gmail endpoint for Gmail senders", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue([{ address: "142.250.74.109", family: 4 }]);

    await resolveConfiguredSmtpEndpoint({
      provider: "gmail",
      hostname: "attacker.example",
      port: 465,
      lookup,
    });

    expect(lookup).toHaveBeenCalledWith("smtp.gmail.com");
  });
});
