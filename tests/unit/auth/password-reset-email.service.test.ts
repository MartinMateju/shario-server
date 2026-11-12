import { describe, expect, it, vi } from "vitest";

import { createPasswordResetEmailService } from "@/modules/password_reset/services/password-reset-email.service.js";

describe("password reset email", () => {
  it("renders the English tenant-branded recovery message safely", async () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const service = createPasswordResetEmailService(sendEmail);

    await service.sendOtpEmail({
      tenantId: "64b000000000000000000001",
      expiresInMinutes: 15,
      locale: "en",
      otp: "123456",
      studioName: "Atelier <Nami>\r\nBcc: injected@example.test",
      to: "maker@example.test",
    });

    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Atelier <Nami> Bcc: injected@example.test: password reset",
        text: expect.stringContaining("The code expires in 15 minutes"),
        to: "maker@example.test",
      }),
    );

    const payload = sendEmail.mock.calls[0]?.[0];
    expect(payload.html).toContain('<html lang="en">');
    expect(payload.html).toContain("#F7F5F2");
    expect(payload.html).toContain("#4056D6");
    expect(payload.html).toContain("123456");
    expect(payload.html).toContain(
      "Atelier &lt;Nami&gt; Bcc: injected@example.test",
    );
    expect(payload.html).not.toContain("Atelier <Nami>");
    expect(payload.subject).not.toContain("\r");
    expect(payload.subject).not.toContain("\n");
  });

  it("keeps Czech as the backwards-compatible default locale", async () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const service = createPasswordResetEmailService(sendEmail);

    await service.sendOtpEmail({
      tenantId: "64b000000000000000000001",
      expiresInMinutes: 15,
      otp: "654321",
      studioName: "Ateliér Nami",
      to: "tvurce@example.test",
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Ateliér Nami: obnovení hesla",
        text: expect.stringContaining("Kód je platný 15 minut"),
      }),
    );
    expect(sendEmail.mock.calls[0]?.[0].html).toContain('<html lang="cs">');
  });
});
