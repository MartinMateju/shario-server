import {
  getCommunicationIntlLocale,
  resolveCommunicationContentLocale,
  type CommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

import { TENANT_BILLING_EMAIL_TYPE } from "./tenant-subscription.email.constants.js";
import type {
  TenantBillingEmailLocale,
  TenantBillingEmailPayload,
  TenantBillingEmailType,
} from "./tenant-subscription.email.types.js";

export type TenantBillingEmailContent = {
  subject: string;
  text: string;
  html: string;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const getSafeBillingUrl = (value: string): string => {
  const url = new URL(value);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Tenant billing email URL must use HTTP or HTTPS.");
  }

  return url.toString();
};

const formatDateTime = (
  value: string | undefined,
  locale: CommunicationContentLocale,
  timezone: string,
): string | null => {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  try {
    return new Intl.DateTimeFormat(getCommunicationIntlLocale(locale), {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(getCommunicationIntlLocale(locale), {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date);
  }
};

type TemplateCopy = {
  subject: string;
  eyebrow: string;
  heading: string;
  greeting: string;
  paragraphs: string[];
  button: string;
  footer: string;
};

const buildEnglishCopy = (
  type: TenantBillingEmailType,
  payload: TenantBillingEmailPayload,
): TemplateCopy => {
  const trialEnd = formatDateTime(payload.trialEndsAt, "en", payload.timezone);
  const graceEnd = formatDateTime(payload.graceEndsAt, "en", payload.timezone);
  const nextAttempt = formatDateTime(
    payload.nextPaymentAttemptAt,
    "en",
    payload.timezone,
  );
  const common = {
    eyebrow: "shario.io billing",
    greeting: `Hello ${payload.recipientName},`,
    button: "Open billing settings",
    footer:
      "This transactional billing notice was sent to the owner of this shario.io workspace.",
  };

  switch (type) {
    case TENANT_BILLING_EMAIL_TYPE.TRIAL_ENDING:
      return {
        ...common,
        subject: `Your ${payload.tenantName} trial ends soon`,
        heading: "Your free trial is ending soon",
        paragraphs: [
          `${payload.tenantName}'s Professional trial ends${trialEnd ? ` on ${trialEnd}` : " soon"}.`,
          "Choose a subscription plan before then to keep the workspace running without interruption. No payment is taken until you confirm a plan in Stripe.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.PAYMENT_FAILED:
      return {
        ...common,
        subject: `Payment failed for ${payload.tenantName}`,
        heading: "We couldn't collect your subscription payment",
        paragraphs: [
          nextAttempt
            ? `Stripe will automatically try the payment again on ${nextAttempt}.`
            : "Stripe has not scheduled another automatic payment attempt yet.",
          graceEnd
            ? `Your workspace remains available until ${graceEnd}. Update the payment method before then to avoid restricted access.`
            : "Update the payment method in your billing settings to restore or protect workspace access.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.PAYMENT_ACTION_REQUIRED:
      return {
        ...common,
        subject: `Payment authentication required for ${payload.tenantName}`,
        heading: "Your bank needs you to confirm the payment",
        paragraphs: [
          "The subscription payment requires an additional security step, such as 3D Secure authentication.",
          "Open billing settings and follow the outstanding invoice or update the payment method to complete payment.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.PAYMENT_RECOVERED:
      return {
        ...common,
        subject: `Payment recovered for ${payload.tenantName}`,
        heading: "Your subscription payment is now complete",
        paragraphs: [
          "Stripe successfully collected the outstanding payment.",
          "The payment warning has been removed and your workspace access reflects the active subscription again.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.PAYMENT_RECOVERY_ENDED:
      return {
        ...common,
        subject: `Payment recovery ended for ${payload.tenantName}`,
        heading: "Automatic payment recovery has ended",
        paragraphs: [
          "Stripe has stopped automatically retrying the outstanding payment.",
          "Update the payment method and review the unpaid invoice in billing settings. Your workspace data remains safe even if feature access is restricted.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.INVOICE_FINALIZATION_FAILED:
      return {
        ...common,
        subject: `Billing details need attention for ${payload.tenantName}`,
        heading: "Stripe couldn't finalize your invoice",
        paragraphs: [
          "This can happen when billing address or tax information is incomplete.",
          "Review the workspace billing details in the secure Stripe portal so the invoice can be issued and collected.",
        ],
      };
  }
};

const buildCzechCopy = (
  type: TenantBillingEmailType,
  payload: TenantBillingEmailPayload,
): TemplateCopy => {
  const trialEnd = formatDateTime(payload.trialEndsAt, "cs", payload.timezone);
  const graceEnd = formatDateTime(payload.graceEndsAt, "cs", payload.timezone);
  const nextAttempt = formatDateTime(
    payload.nextPaymentAttemptAt,
    "cs",
    payload.timezone,
  );
  const common = {
    eyebrow: "Fakturace shario.io",
    greeting: `Dobrý den, ${payload.recipientName},`,
    button: "Otevřít nastavení fakturace",
    footer:
      "Toto transakční upozornění bylo zasláno vlastníkovi pracovního prostoru shario.io.",
  };

  switch (type) {
    case TENANT_BILLING_EMAIL_TYPE.TRIAL_ENDING:
      return {
        ...common,
        subject: `Zkušební období ${payload.tenantName} brzy skončí`,
        heading: "Vaše bezplatné zkušební období brzy skončí",
        paragraphs: [
          `Zkušební tarif Professional pro ${payload.tenantName} skončí${trialEnd ? ` ${trialEnd}` : " již brzy"}.`,
          "Vyberte si předplatné, aby pracovní prostor pokračoval bez přerušení. K platbě dojde až po potvrzení tarifu ve Stripe.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.PAYMENT_FAILED:
      return {
        ...common,
        subject: `Platba za ${payload.tenantName} se nezdařila`,
        heading: "Platbu za předplatné se nepodařilo zpracovat",
        paragraphs: [
          nextAttempt
            ? `Stripe se automaticky pokusí platbu zopakovat ${nextAttempt}.`
            : "Stripe zatím nenaplánoval další automatický pokus o platbu.",
          graceEnd
            ? `Pracovní prostor zůstává dostupný do ${graceEnd}. Do té doby aktualizujte platební metodu, aby nedošlo k omezení přístupu.`
            : "Aktualizujte platební metodu v nastavení fakturace a obnovte nebo zachovejte přístup.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.PAYMENT_ACTION_REQUIRED:
      return {
        ...common,
        subject: `Platbu za ${payload.tenantName} je nutné ověřit`,
        heading: "Vaše banka vyžaduje potvrzení platby",
        paragraphs: [
          "Platba za předplatné vyžaduje další bezpečnostní krok, například ověření 3D Secure.",
          "Otevřete nastavení fakturace a dokončete platbu přes nezaplacenou fakturu nebo aktualizujte platební metodu.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.PAYMENT_RECOVERED:
      return {
        ...common,
        subject: `Platba za ${payload.tenantName} byla úspěšně dokončena`,
        heading: "Platba za předplatné je nyní dokončena",
        paragraphs: [
          "Stripe úspěšně zpracoval dlužnou platbu.",
          "Upozornění na platbu bylo odstraněno a přístup k pracovnímu prostoru opět odpovídá aktivnímu předplatnému.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.PAYMENT_RECOVERY_ENDED:
      return {
        ...common,
        subject: `Opakování platby za ${payload.tenantName} skončilo`,
        heading: "Automatické opakování platby skončilo",
        paragraphs: [
          "Stripe již nebude automaticky opakovat pokus o dlužnou platbu.",
          "Aktualizujte platební metodu a zkontrolujte nezaplacenou fakturu. Data pracovního prostoru zůstávají v bezpečí i při omezení přístupu k funkcím.",
        ],
      };

    case TENANT_BILLING_EMAIL_TYPE.INVOICE_FINALIZATION_FAILED:
      return {
        ...common,
        subject: `Fakturační údaje ${payload.tenantName} vyžadují kontrolu`,
        heading: "Stripe nemohl dokončit vystavení faktury",
        paragraphs: [
          "Příčinou mohou být neúplné fakturační, adresní nebo daňové údaje.",
          "Zkontrolujte fakturační údaje pracovního prostoru v zabezpečeném portálu Stripe, aby bylo možné fakturu vystavit a zaplatit.",
        ],
      };
  }
};

export const buildTenantBillingEmail = ({
  type,
  locale,
  payload,
}: {
  type: TenantBillingEmailType;
  locale: TenantBillingEmailLocale;
  payload: TenantBillingEmailPayload;
}): TenantBillingEmailContent => {
  const contentLocale = resolveCommunicationContentLocale(locale);
  const copy =
    contentLocale === "cs"
      ? buildCzechCopy(type, payload)
      : buildEnglishCopy(type, payload);
  const billingUrl = getSafeBillingUrl(payload.billingUrl);
  const escapedUrl = escapeHtml(billingUrl);
  const paragraphsHtml = copy.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.7">${escapeHtml(paragraph)}</p>`,
    )
    .join("");
  const text = [
    copy.heading,
    "",
    copy.greeting,
    "",
    ...copy.paragraphs,
    "",
    `${copy.button}: ${billingUrl}`,
    "",
    copy.footer,
  ].join("\n");

  return {
    subject: copy.subject,
    text,
    html: `<!doctype html>
<html lang="${contentLocale}">
  <body style="margin:0;background:#f5f3ef;font-family:Arial,sans-serif;color:#172033">
    <div style="display:none;max-height:0;overflow:hidden">${escapeHtml(copy.heading)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f3ef;padding:32px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e7e2d9;border-radius:24px;overflow:hidden">
          <tr><td style="padding:32px">
            <p style="margin:0 0 12px;color:#cb6547;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">${escapeHtml(copy.eyebrow)}</p>
            <h1 style="margin:0 0 24px;color:#172033;font-size:28px;line-height:1.25">${escapeHtml(copy.heading)}</h1>
            <p style="margin:0 0 16px;color:#172033;font-size:15px;line-height:1.7">${escapeHtml(copy.greeting)}</p>
            ${paragraphsHtml}
            <p style="margin:28px 0">
              <a href="${escapedUrl}" style="display:inline-block;border-radius:12px;background:#3156d3;color:#ffffff;padding:13px 20px;text-decoration:none;font-size:14px;font-weight:700">${escapeHtml(copy.button)}</a>
            </p>
            <p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #eeeae3;color:#8a8f9b;font-size:12px;line-height:1.6">${escapeHtml(copy.footer)}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
  };
};
