import {
  COMMUNICATION_CONTENT_LOCALE,
  type CommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";
import { formatUserMemberNumber } from "@/modules/user/user-member-number.service.js";

import {
  DEFAULT_REGISTRATION_VIDEO_URL,
  DEFAULT_STUDIO_RULES_URL,
  DEFAULT_VERIFICATION_FROM_EMAIL,
} from "./user-verification.constants.js";

const escapeHtml = (value: unknown): string => {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

export const buildVerificationEmail = ({
  email,
  verificationUrl,
  studioName = "shario.io",
  from = DEFAULT_VERIFICATION_FROM_EMAIL,
  locale = COMMUNICATION_CONTENT_LOCALE.CS,
}: {
  email: string;
  verificationUrl: string;
  studioName?: string;
  from?: string;
  locale?: CommunicationContentLocale;
}) => {
  const safeStudioName =
    escapeHtml(studioName);
  const safeVerificationUrl =
    escapeHtml(verificationUrl);

  if (
    locale ===
    COMMUNICATION_CONTENT_LOCALE.EN
  ) {
    return {
      from,
      to: email,
      subject: `${studioName}: verify your email`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">
          <p>Verify your email address for <strong>${safeStudioName}</strong> to finish registration and sign in to your account.</p>
          <p>This link expires in <strong>6 hours</strong>.</p>
          <p>
            To verify your account, please click
            <a href="${safeVerificationUrl}">here</a>.
          </p>
        </div>
      `,
      text: `Verify your email address for ${studioName}: ${verificationUrl}\n\nThis link expires in 6 hours.`,
    };
  }

  return {
    from,
    to: email,
    subject: `${studioName}: ověřte svůj email`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">
        <p>Ověřte svou e-mailovou adresu pro studio <strong>${safeStudioName}</strong>, abyste dokončili registraci a mohli se přihlásit ke svému účtu.</p>
        <p>Platnost tohoto odkazu vyprší za <strong>6 hodin</strong>.</p>
        <p>
          Pro ověření účtu klikněte prosím
          <a href="${safeVerificationUrl}">zde</a>.
        </p>
      </div>
    `,
    text: `Ověřte svou e-mailovou adresu pro studio ${studioName}: ${verificationUrl}\n\nPlatnost odkazu vyprší za 6 hodin.`,
  };
};

export const buildRegistrationConfirmationEmail = ({
  email,
  customId,
  memberNumber = null,
  firstname = "",
  from = DEFAULT_VERIFICATION_FROM_EMAIL,
}: {
  email: string;
  customId: string;
  memberNumber?: number | null;
  firstname?: string;
  from?: string;
}) => {
  const memberId = formatUserMemberNumber(memberNumber) ?? customId;
  const greeting = firstname
    ? `Dobrý den, ${escapeHtml(firstname)},`
    : "Dobrý den,";

  return {
    from,
    to: email,
    subject: "Vítejte ve shario.io",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">
        <h3>Vítáme vás ve shario.io</h3>
        <p>${greeting}</p>
        <p>po přihlášení si můžete rezervovat keramické studio nebo kurzy přes rezervační portál.</p>
        <p>
          <strong>Důležité:</strong> Vaše členské ID je
          <strong>${escapeHtml(memberId)}</strong>. Pod tímto kódem si prosím podepisujte svoje výrobky
          (více v pravidlech nebo ve
          <a href="${DEFAULT_REGISTRATION_VIDEO_URL}">videu</a>).
        </p>
        <p>
          Jakékoliv další informace najdete v
          <a href="${DEFAULT_STUDIO_RULES_URL}">pravidlech dílny</a>
          nebo nás neváhejte kontaktovat.
        </p>
        <p>Budeme se moc těšit na vaše výrobky :-)</p>
        <p>S přáním hezkého dne,<br />shario.io</p>
      </div>
    `,
    text: `Vítejte ve shario.io. Vaše členské ID je ${memberId}. Pravidla: ${DEFAULT_STUDIO_RULES_URL}`,
  };
};

