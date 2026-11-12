import { sendEmail as sendPlatformEmail } from "@/infrastructure/email/nodemailer.client.js";
import Booking from "@/modules/booking/booking.model.js";
import { resolveCustomerBookingLink } from "@/modules/booking/customer-booking-link.service.js";
import { sendManagedTenantEmail as sendEmail } from "@/infrastructure/email/managed-email.service.js";
import { formatLocationAddress } from "@/modules/location/location.utils.js";
import { withTenant } from "@/modules/tenants/tenant.utils.js";
import {
  COMMUNICATION_CONTENT_LOCALE,
  getCommunicationIntlLocale,
  resolveCommunicationContentLocale,
  type CommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const getProductName = (
  product,
  locale: CommunicationContentLocale,
) => {
  const name = product?.name;

  if (name && typeof name === "object") {
    return locale === COMMUNICATION_CONTENT_LOCALE.CS
      ? name.CZ || name.cs || name.EN || name.en || "Rezervace"
      : name.EN || name.en || name.CZ || name.cs || "Booking";
  }

  return String(
    name ||
      (locale === COMMUNICATION_CONTENT_LOCALE.CS
        ? "Rezervace"
        : "Booking"),
  );
};

const getDateTime = (
  date,
  timezone,
  options,
  locale: CommunicationContentLocale,
) =>
  new Intl.DateTimeFormat(getCommunicationIntlLocale(locale), {
    timeZone: timezone || "UTC",
    ...options,
  }).format(new Date(date));

const getTimeRange = (
  start,
  end,
  timezone,
  locale: CommunicationContentLocale,
) => {
  const options = { hour: "2-digit", minute: "2-digit", hour12: false };
  return `${getDateTime(start, timezone, options, locale)}–${getDateTime(
    end,
    timezone,
    options,
    locale,
  )}`;
};

const getBookingConfirmationCopy = (locale: CommunicationContentLocale) =>
  locale === COMMUNICATION_CONTENT_LOCALE.CS
    ? {
        order: "Objednávka",
        address: "Adresa",
        date: "Datum",
        addedGuests: "Počet přidaných hostů",
        time: "Čas",
        participants: "Počet účastníků",
        confirmation: "Potvrzení objednávky",
        heading: "Vaše rezervace byla úspěšně vytvořena!",
        remainingCredits: "Zbývající kredity",
        important: "Důležité",
        accessCode:
          "vstupní kód zašleme před rezervací podle pravidel vybraného studia.",
        manageLabel: "Spravovat rezervaci",
        manageDescription:
          "Rezervaci si můžete zobrazit, přesunout nebo zrušit v zákaznickém portálu.",
        closing: "Děkujeme a přejeme příjemný den.",
      }
    : {
        order: "Order",
        address: "Address",
        date: "Date",
        addedGuests: "Guests added",
        time: "Time",
        participants: "Participants",
        confirmation: "Order confirmation",
        heading: "Your booking was created successfully!",
        remainingCredits: "Remaining credits",
        important: "Important",
        accessCode:
          "we will send the entry code before the booking according to the selected studio's rules.",
        manageLabel: "Manage booking",
        manageDescription:
          "View, reschedule or cancel your booking in the customer portal.",
        closing: "Thank you and have a nice day.",
      };

export const sendBookingConfirmationEmail = async ({
  tenantId,
  bookingIds,
  orderId,
  user,
  remainingCredits,
  currency,
}) => {
  try {
    if (!bookingIds?.length || !user?.email) return false;

    const bookings = await Booking.find(
      withTenant(tenantId, { _id: { $in: bookingIds } }),
    )
      .populate("bookingProduct")
      .populate("location", "name address contact booking.timezone")
      .exec();

    const bookingsToConfirm = bookings.filter(
      (booking) =>
        booking.paymentStatus === "CONFIRMED" && !booking.confirmationSentAt,
    );

    if (!bookingsToConfirm.length) return true;

    const customerBookingLink = await resolveCustomerBookingLink(tenantId);
    const contentLocale = resolveCommunicationContentLocale(
      customerBookingLink?.locale,
      customerBookingLink
        ? COMMUNICATION_CONTENT_LOCALE.EN
        : COMMUNICATION_CONTENT_LOCALE.CS,
    );
    const copy = getBookingConfirmationCopy(contentLocale);
    const locationNames = new Set<string>();
    let hasWorkshop = false;

    const orderDetails = bookingsToConfirm.map((booking) => {
      const product = booking.bookingProduct as any;
      const location = booking.location as any;
      const locationName = String(location?.name || "Studio");
      const address = formatLocationAddress(location);
      const timezone = location?.booking?.timezone || "UTC";

      locationNames.add(locationName);
      hasWorkshop ||= String(booking.tag).includes("workshop");

      const date = getDateTime(booking.start, timezone, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }, contentLocale);

      return `
        <section style="margin-bottom:20px;">
          <p><b>${copy.order}:</b> ${escapeHtml(getProductName(product, contentLocale))}</p>
          <p><b>Studio:</b> ${escapeHtml(locationName)}</p>
          ${address ? `<p><b>${copy.address}:</b> ${escapeHtml(address)}</p>` : ""}
          <p><b>${copy.date}:</b> ${escapeHtml(date)}</p>
          ${
            booking.tag === "guest-increase"
              ? `<p><b>${copy.addedGuests}:</b> ${booking.numberOfGuests || 0}</p>`
              : `<p><b>${copy.time}:</b> ${escapeHtml(getTimeRange(booking.start, booking.end, timezone, contentLocale))}</p>`
          }
          ${
            booking.tag === "course"
              ? `<p><b>${copy.participants}:</b> ${(booking.numberOfGuests || 0) + 1}</p>`
              : ""
          }
        </section>
      `;
    });

    const brandName =
      locationNames.size === 1 ? [...locationNames][0] : "shario.io";

    await sendEmail({
      tenantId,
      to: user.email,
      subject: `${brandName} | ${copy.confirmation} | ${orderId}`,
      html: `
        <body lang="${contentLocale}" style="font-family:Arial,sans-serif;color:#333;line-height:1.6;">
          <h2>${copy.heading}</h2>
          <div>${orderDetails.join("")}</div>
          ${
            remainingCredits !== undefined && remainingCredits !== null
              ? `<p><strong>${copy.remainingCredits}:</strong> ${remainingCredits} ${escapeHtml(currency || "CZK")}</p>`
              : ""
          }
          ${
            hasWorkshop
              ? `<p><strong>${copy.important}:</strong> ${copy.accessCode}</p>`
              : ""
          }
          ${
            customerBookingLink
              ? `<div style="margin:24px 0;padding:18px;border-radius:14px;background:#f7f5f1;">
                  <p>${copy.manageDescription}</p>
                  <a href="${escapeHtml(customerBookingLink.url)}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#1f35d2;color:#fff;text-decoration:none;font-weight:700;">${copy.manageLabel}</a>
                </div>`
              : ""
          }
          <p>${copy.closing}</p>
          <p><strong>${escapeHtml(brandName)}</strong></p>
        </body>
      `,
    });

    await Booking.updateMany(
      withTenant(tenantId, {
        _id: { $in: bookingsToConfirm.map((booking) => booking._id) },
      }),
      {
        $set: {
          confirmationSentAt: new Date(),
          lastNotificationChannel: "email",
        },
      },
    );

    return true;
  } catch (error) {
    console.error("Failed to send booking confirmation email:", error);
    return false;
  }
};

export const sendAdminWarningEmail = async ({ subject, message }) => {
  try {
    await sendPlatformEmail({
      from: process.env.AUTH_EMAIL || "no-reply@shario.io",
      to: process.env.ADMIN_EMAIL || "support@shario.io",
      subject: `Rezervační systém | Upozornění | ${subject}`,
      html: `
        <div>
          <h1>Důležité upozornění z rezervačního systému</h1>
          <p>${escapeHtml(message)}</p>
        </div>
      `,
    });
  } catch (error) {
    console.error("Failed to send admin warning email:", error);
  }
};
