import type { PasswordResetEmailPayload } from "../password-reset.types.js";

type SendEmailFn = (input: {
  tenantId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<unknown>;

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const COPY = {
  cs: {
    eyebrow: "Bezpečnost účtu",
    greeting: "Dobrý den,",
    heading: "Obnovení hesla",
    intro: (studioName: string) =>
      `Tento kód použijte pro nastavení nového hesla ve studiu ${studioName}.`,
    expiry: (minutes: number) =>
      `Kód je platný ${minutes} minut a lze ho použít pouze jednou.`,
    ignore:
      "Pokud jste o změnu hesla nežádali, tento e-mail můžete bezpečně ignorovat.",
    subject: (studioName: string) => `${studioName}: obnovení hesla`,
  },
  en: {
    eyebrow: "Account security",
    greeting: "Hello,",
    heading: "Reset your password",
    intro: (studioName: string) =>
      `Use this code to choose a new password for your ${studioName} account.`,
    expiry: (minutes: number) =>
      `The code expires in ${minutes} minutes and can only be used once.`,
    ignore:
      "If you did not request a password reset, you can safely ignore this email.",
    subject: (studioName: string) => `${studioName}: password reset`,
  },
} as const;

export const createPasswordResetEmailService = (sendEmail: SendEmailFn) => {
  return {
    async sendOtpEmail(payload: PasswordResetEmailPayload): Promise<void> {
      const studioName =
        String(payload.studioName ?? "")
          .replace(/[\u0000-\u001f\u007f]+/g, " ")
          .trim()
          .slice(0, 160) || "shario.io";
      const locale = payload.locale === "en" ? "en" : "cs";
      const copy = COPY[locale];
      const expiresInMinutes = Math.max(
        1,
        Math.round(Number(payload.expiresInMinutes) || 15),
      );
      const safeStudioName = escapeHtml(studioName);
      const safeOtp = escapeHtml(payload.otp);

      await sendEmail({
        tenantId: payload.tenantId,
        to: payload.to,
        subject: copy.subject(studioName),
        text: [
          copy.greeting,
          copy.intro(studioName),
          payload.otp,
          copy.expiry(expiresInMinutes),
          copy.ignore,
          `${studioName} · shario.io`,
        ].join("\n\n"),
        html: `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background:#F7F5F2;color:#1F1F1F;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#F7F5F2;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;border:1px solid #E3DED5;border-radius:24px;background:#FFFFFF;box-shadow:0 20px 55px rgba(31,31,31,.08);">
            <tr>
              <td style="padding:36px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                <p style="margin:0 0 14px;color:#B45B46;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;">${copy.eyebrow}</p>
                <h1 style="margin:0;color:#1F1F1F;font-size:30px;line-height:1.08;letter-spacing:-.04em;">${copy.heading}</h1>
                <p style="margin:24px 0 0;color:#5F5F59;font-size:16px;line-height:1.65;">${copy.greeting}</p>
                <p style="margin:8px 0 0;color:#5F5F59;font-size:16px;line-height:1.65;">${escapeHtml(copy.intro(studioName))}</p>
                <div style="margin:28px 0;border:1px solid #DDE2F8;border-radius:18px;background:#F3F5FF;padding:22px;text-align:center;">
                  <span style="color:#4056D6;font-size:34px;font-weight:700;letter-spacing:.22em;line-height:1;">${safeOtp}</span>
                </div>
                <p style="margin:0;color:#5F5F59;font-size:14px;line-height:1.6;">${copy.expiry(expiresInMinutes)}</p>
                <p style="margin:12px 0 0;color:#777771;font-size:13px;line-height:1.6;">${copy.ignore}</p>
                <div style="margin-top:28px;border-top:1px solid #ECE8E0;padding-top:20px;color:#777771;font-size:12px;line-height:1.5;">
                  <strong style="color:#1F1F1F;">${safeStudioName}</strong><br />Powered by shario.io
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
      });
    },
  };
};
