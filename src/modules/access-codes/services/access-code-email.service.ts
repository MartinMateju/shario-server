import { sendManagedTenantEmail } from "@/infrastructure/email/managed-email.service.js";
import { escapeEmailHtml } from "@/modules/email-template/email-template.rendering.js";
import {
  resolveCustomerBookingLink,
  type CustomerBookingLink,
} from "@/modules/booking/customer-booking-link.service.js";
import {
  COMMUNICATION_CONTENT_LOCALE,
  resolveCommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

import { formatDateTimeRange } from "../access-code.utils.js";

type SendAccessCodeEmailInput = {
  to: string;
  tenantId?: string;
  bookingId?: string;
  deliveryId?: string;
  studioName: string;
  studioAddress?: string;
  timezone: string;
  entryCode: string;
  bookingStart: Date;
  bookingEnd: Date;
  beforeSend?: () => Promise<void>;
};

type EmailMeta = {
  provider?: string;
  providerMessageId?: string;
};

export const buildAccessCodeEmail = (
  input: SendAccessCodeEmailInput,
  customerBookingLink: CustomerBookingLink | null,
): { subject: string; text: string; html: string } => {
  const locale = resolveCommunicationContentLocale(
    customerBookingLink?.locale,
    customerBookingLink
      ? COMMUNICATION_CONTENT_LOCALE.EN
      : COMMUNICATION_CONTENT_LOCALE.CS,
  );
  const dateTime = formatDateTimeRange(
    input.bookingStart,
    input.bookingEnd,
    input.timezone,
    locale,
  );
  const english = locale === "en";
  const html = `<h1 style="margin:0 0 20px;font-size:28px;line-height:1.3;color:inherit;">${english ? "Your studio entry code" : "Váš vstupní kód do ateliéru"}</h1>
<p>${english ? "Your booking starts soon. Here is your code for" : "Vaše rezervace brzy začíná. Zde je váš kód pro"} <strong>${escapeEmailHtml(input.studioName)}</strong>.</p>
<div style="margin:24px 0;padding:24px;border:1px solid #d8d4cb;border-radius:12px;text-align:center;">
<p style="margin:0 0 10px;font-size:13px;">${english ? "DOOR ACCESS CODE" : "VSTUPNÍ KÓD"}</p>
<p style="margin:0;font-family:monospace;font-size:34px;font-weight:bold;letter-spacing:4px;overflow-wrap:anywhere;">${escapeEmailHtml(input.entryCode)}</p></div>
<p><strong>${english ? "Booking" : "Rezervace"}:</strong> ${escapeEmailHtml(dateTime)}</p>
${input.studioAddress ? `<p><strong>${english ? "Address" : "Adresa"}:</strong> ${escapeEmailHtml(input.studioAddress)}</p>` : ""}
<p>${english ? "Please keep this code private and use it only for your booked studio visit." : "Kód prosím nesdílejte a používejte jej pouze při své rezervované návštěvě ateliéru."}</p>
${customerBookingLink ? `<p><a href="${escapeEmailHtml(customerBookingLink.url)}">${english ? "Manage booking" : "Spravovat rezervaci"}</a></p>` : ""}`;

  if (locale === "en") {
    return {
      subject: `${input.studioName} | Entry code 🔑`,
      html,
      text: [
        "Hello,",
        "",
        `Your entry code is: ${input.entryCode}`,
        "",
        `Studio: ${input.studioName}`,
        input.studioAddress ? `Address: ${input.studioAddress}` : null,
        `Booking: ${dateTime}`,
        customerBookingLink
          ? `Manage booking: ${customerBookingLink.url}`
          : null,
        "",
        "This email was sent automatically.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    subject: `${input.studioName} | Vstupní kód 🔑`,
    html,
    text: [
      "Dobrý den,",
      "",
      `váš vstupní kód je: ${input.entryCode}`,
      "",
      `Studio: ${input.studioName}`,
      input.studioAddress ? `Adresa: ${input.studioAddress}` : null,
      `Rezervace: ${dateTime}`,
      customerBookingLink
        ? `Spravovat rezervaci: ${customerBookingLink.url}`
        : null,
      "",
      "Tento e-mail byl odeslán automaticky.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
};

export async function sendAccessCodeEmail(
  input: SendAccessCodeEmailInput,
): Promise<EmailMeta> {
  if (!input.tenantId || !input.bookingId) {
    throw new Error(
      "Access-code delivery requires an explicit tenant and booking.",
    );
  }
  const customerBookingLink = await resolveCustomerBookingLink(input.tenantId);
  const email = buildAccessCodeEmail(input, customerBookingLink);
  const messageId = `<access-code-${input.tenantId}-${input.bookingId}-${input.bookingStart.getTime()}@shario.io>`;

  const result = await sendManagedTenantEmail({
    tenantId: input.tenantId,
    accessCodeBookingId: input.bookingId,
    deliveryId: input.deliveryId,
    beforeSend: input.beforeSend,
    to: input.to,
    ...email,
    messageId,
    headers: {
      "Message-ID": messageId,
      "X-Shario-Notification": "booking-access-code",
    },
  });

  return result;
}
