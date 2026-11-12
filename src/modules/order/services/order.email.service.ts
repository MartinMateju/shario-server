import type { Types } from "mongoose";

import { sendManagedTenantEmail } from "@/infrastructure/email/managed-email.service.js";
import { PostmarkRequestError } from "@/infrastructure/email/postmark.client.js";
import BookingModel from "@/modules/booking/booking.model.js";
import {
  resolveCustomerBookingLink,
  type CustomerBookingLink,
} from "@/modules/booking/customer-booking-link.service.js";
import { formatLocationAddress } from "@/modules/location/location.utils.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  fromCurrencyMinorUnits,
  getCurrencyExponent,
  normalizeStudioCommerceCurrency,
} from "@/shared/money/currency.js";
import {
  COMMUNICATION_CONTENT_LOCALE,
  getCommunicationIntlLocale,
  resolveCommunicationContentLocale,
  type CommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

type OrderEmailType = "order_confirm";
type OrderEmailLocale = CommunicationContentLocale;

type OrderEmailUser = {
  email?: string | null;
  firstname?: string | null;
  lastname?: string | null;
};

type OrderEmailOrder = {
  guestCourseCheckout?: { version?: number; locale?: string } | null;
  pieceCheckout?: {
    state: string;
    method: string;
    refundedAmountMinor?: number;
    items: Array<{
      name: string;
      registrationNumber: string;
      amountMinor: number;
    }>;
  } | null;
  _id: Types.ObjectId | string;
  tenant?: Types.ObjectId | string;
  currency?: string;
  grossAmountMinor?: number;
  paidAt?: Date | string | null;
  customer?: { firstname?: string | null; lastname?: string | null };
  workshopBookings?: Array<Types.ObjectId | string>;
  courseBookings?: Array<{
    bookingId?: Types.ObjectId | string | null;
    quantity?: number | null;
  }>;
  guestIncreaseBookings?: Array<{
    bookingId?: Types.ObjectId | string | null;
    booking?: Types.ObjectId | string | null;
    addGuests?: number | null;
  }>;
  creditPurchase?: { amount?: number | null };
};

type PieceEmailTenant = {
  name?: string;
  settings?: {
    publicDefaultLanguage?: string;
    defaultLanguage?: string;
    timezone?: string;
  };
};

type SendNotificationEmailParams = {
  type: OrderEmailType;
  order: OrderEmailOrder;
  user: OrderEmailUser;
  beforeSend?: () => Promise<void>;
  deliveryId?: string;
};

type LoadedBooking = {
  _id: Types.ObjectId | string;
  start: Date | string;
  end: Date | string;
  tag?: string | null;
  numberOfGuests?: number | null;
  bookingProduct?: { name?: string | Record<string, string> | null } | null;
  location?: {
    _id: Types.ObjectId | string;
    name?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      postalCode?: string;
      country?: string;
    };
    booking?: { timezone?: string };
  } | null;
};

type GuestIncreaseBooking = LoadedBooking & { addGuests: number };

type OrderEmailData = {
  workshopBookings: LoadedBooking[];
  courseBookings: LoadedBooking[];
  qtyByBookingId: Map<string, number>;
  guestIncreaseBookings: GuestIncreaseBooking[];
};

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const getTimezone = (booking?: LoadedBooking): string =>
  booking?.location?.booking?.timezone || "UTC";

const formatDate = (
  value?: Date | string | null,
  timezone = "UTC",
  locale: OrderEmailLocale = "cs",
): string =>
  value
    ? new Intl.DateTimeFormat(getCommunicationIntlLocale(locale), {
        timeZone: timezone,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(new Date(value))
    : "-";

const formatTime = (
  value?: Date | string | null,
  timezone = "UTC",
  locale: OrderEmailLocale = "cs",
): string =>
  value
    ? new Intl.DateTimeFormat(getCommunicationIntlLocale(locale), {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "-";

const formatRange = (
  booking: LoadedBooking,
  locale: OrderEmailLocale,
): string => {
  const timezone = getTimezone(booking);
  return `${formatTime(booking.start, timezone, locale)}–${formatTime(
    booking.end,
    timezone,
    locale,
  )}`;
};

const getProductName = (
  booking: LoadedBooking,
  locale: OrderEmailLocale = "cs",
): string => {
  const name = booking.bookingProduct?.name;

  if (name && typeof name === "object") {
    return (
      (locale === "en" ? name.EN || name.CZ : name.CZ || name.EN) ||
      (locale === "en" ? "Booking" : "Rezervace")
    );
  }

  return String(name || (locale === "en" ? "Booking" : "Rezervace"));
};

const getLocationLabel = (booking: LoadedBooking): string => {
  const location = booking.location;
  if (!location) return "-";

  const address = formatLocationAddress(location);
  return [location.name, address].filter(Boolean).join(" — ") || "-";
};

const loadBookings = async (
  order: OrderEmailOrder,
  ids: Array<Types.ObjectId | string>,
): Promise<LoadedBooking[]> => {
  if (!ids.length) return [];

  return BookingModel.find({
    _id: { $in: ids },
    ...(order.tenant ? { tenant: order.tenant } : {}),
  })
    .select("_id start end location tag bookingProduct numberOfGuests")
    .populate("bookingProduct", "name")
    .populate("location", "name address booking.timezone")
    .lean<LoadedBooking[]>()
    .exec();
};

const loadOrderEmailData = async (
  order: OrderEmailOrder,
): Promise<OrderEmailData> => {
  const workshopIds = Array.isArray(order.workshopBookings)
    ? order.workshopBookings
    : [];
  const courseSlots = Array.isArray(order.courseBookings)
    ? order.courseBookings
    : [];
  const courseIds = courseSlots
    .map((slot) => slot.bookingId)
    .filter((id): id is Types.ObjectId | string => Boolean(id));
  const qtyByBookingId = new Map<string, number>();

  for (const slot of courseSlots) {
    if (slot.bookingId) {
      qtyByBookingId.set(
        String(slot.bookingId),
        Math.max(1, Number(slot.quantity) || 1),
      );
    }
  }

  const addGuestsByBookingId = new Map<string, number>();

  for (const operation of order.guestIncreaseBookings || []) {
    const bookingId = operation.bookingId || operation.booking;
    const addGuests = Math.floor(Number(operation.addGuests) || 0);

    if (bookingId && addGuests > 0) {
      const key = String(bookingId);
      addGuestsByBookingId.set(
        key,
        (addGuestsByBookingId.get(key) || 0) + addGuests,
      );
    }
  }

  const [workshopBookings, courseBookings, guestBookings] = await Promise.all([
    loadBookings(order, workshopIds),
    loadBookings(order, courseIds),
    loadBookings(order, [...addGuestsByBookingId.keys()]),
  ]);

  return {
    workshopBookings,
    courseBookings,
    qtyByBookingId,
    guestIncreaseBookings: guestBookings.map((booking) => ({
      ...booking,
      addGuests: addGuestsByBookingId.get(String(booking._id)) || 0,
    })),
  };
};

const sortBookings = <T extends LoadedBooking>(bookings: T[]): T[] =>
  [...bookings].sort(
    (left, right) =>
      new Date(left.start).getTime() - new Date(right.start).getTime(),
  );

const bookingRow = (
  booking: LoadedBooking,
  quantity: number,
  locale: OrderEmailLocale,
  note = "",
): string => `
  <tr>
    <td style="padding:6px 0;">${escapeHtml(getProductName(booking, locale))}</td>
    <td style="padding:6px 0;">${escapeHtml(
      formatDate(booking.start, getTimezone(booking), locale),
    )}</td>
    <td style="padding:6px 0;">${escapeHtml(formatRange(booking, locale))}</td>
    <td style="padding:6px 0;">${escapeHtml(getLocationLabel(booking))}</td>
    <td style="padding:6px 0;">${escapeHtml(note || quantity)}</td>
  </tr>`;

const buildBookingsSection = (
  data: OrderEmailData,
  locale: OrderEmailLocale,
): string => {
  const rows = [
    ...sortBookings(data.workshopBookings).map((booking) =>
      bookingRow(
        booking,
        Math.max(1, Number(booking.numberOfGuests) || 1),
        locale,
      ),
    ),
    ...sortBookings(data.courseBookings).map((booking) =>
      bookingRow(
        booking,
        data.qtyByBookingId.get(String(booking._id)) || 1,
        locale,
      ),
    ),
    ...sortBookings(data.guestIncreaseBookings).map((booking) =>
      bookingRow(booking, 0, locale, `+${Math.max(1, booking.addGuests)}`),
    ),
  ].join("");

  if (!rows) return "";

  const labels =
    locale === "en"
      ? {
          heading: "Bookings",
          item: "Item",
          date: "Date",
          time: "Time",
          studio: "Studio",
          quantity: "Quantity",
        }
      : {
          heading: "Rezervace",
          item: "Položka",
          date: "Datum",
          time: "Čas",
          studio: "Studio",
          quantity: "Počet",
        };

  return `
    <h3 style="margin:24px 0 8px;">${labels.heading}</h3>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th align="left">${labels.item}</th><th align="left">${labels.date}</th>
        <th align="left">${labels.time}</th><th align="left">${labels.studio}</th>
        <th align="left">${labels.quantity}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
};

const getBrandName = (data: OrderEmailData): string => {
  const names = new Set(
    [
      ...data.workshopBookings,
      ...data.courseBookings,
      ...data.guestIncreaseBookings,
    ]
      .map((booking) => booking.location?.name)
      .filter(Boolean),
  );

  return names.size === 1 ? String([...names][0]) : "shario.io";
};

const buildManageBookingSection = (
  link: CustomerBookingLink | null,
): { html: string; text: string | null } => {
  if (!link) return { html: "", text: null };

  const isCzech =
    resolveCommunicationContentLocale(link.locale) ===
    COMMUNICATION_CONTENT_LOCALE.CS;
  const label = isCzech ? "Spravovat rezervaci" : "Manage booking";
  const description = isCzech
    ? "Rezervaci si můžete zobrazit, přesunout nebo zrušit v zákaznickém portálu."
    : "View, reschedule or cancel your booking in the customer portal.";
  const safeUrl = escapeHtml(link.url);

  return {
    html: `
      <div style="margin:24px 0;padding:18px;border-radius:14px;background:#f7f5f1;">
        <p style="margin:0 0 12px;">${description}</p>
        <a href="${safeUrl}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#1f35d2;color:#fff;text-decoration:none;font-weight:700;">${label}</a>
      </div>`,
    text: `${label}: ${link.url}`,
  };
};

export const buildOrderConfirmationEmail = ({
  order,
  user,
  data,
  customerBookingLink = null,
}: {
  order: OrderEmailOrder;
  user: OrderEmailUser;
  data: OrderEmailData;
  customerBookingLink?: CustomerBookingLink | null;
}) => {
  const locale = resolveCommunicationContentLocale(
    order.guestCourseCheckout?.locale || customerBookingLink?.locale,
    COMMUNICATION_CONTENT_LOCALE.CS,
  );
  const copy =
    locale === "en"
      ? {
          greeting: "Hello",
          thankYou: "thank you! 🧡",
          paymentReceived: "We received your payment",
          orderConfirmation: "Order confirmation",
          order: "Order",
          paidAt: "Payment received",
          creditsHeading: "Credits",
          creditsAdded: "credits were added to your account.",
          credits: "Credits",
          reply: "If you need anything, simply reply to this email.",
        }
      : {
          greeting: "Dobrý den",
          thankYou: "děkujeme! 🧡",
          paymentReceived: "Platbu jsme přijali",
          orderConfirmation: "Potvrzení objednávky",
          order: "Objednávka",
          paidAt: "Platba přijata",
          creditsHeading: "Kredity",
          creditsAdded: "kreditů jsme připsali na váš účet.",
          credits: "Kredity",
          reply: "Pokud budete cokoliv potřebovat, odpovězte na tento e-mail.",
        };
  const guestHelp =
    locale === "cs"
      ? "Rezervovali jste bez účtu. Pro změnu nebo zrušení rezervace kontaktujte studio a uveďte číslo objednávky."
      : "You booked without an account. To change or cancel your booking, contact the studio and quote your order number.";
  const manageBooking = order.guestCourseCheckout
    ? {
        html: `<p>${guestHelp}</p><p>${copy.order}: ${escapeHtml(order._id)}</p>`,
        text: guestHelp,
      }
    : buildManageBookingSection(customerBookingLink);
  const name =
    [user.firstname, user.lastname].filter(Boolean).join(" ") ||
    [order.customer?.firstname, order.customer?.lastname]
      .filter(Boolean)
      .join(" ") ||
    copy.greeting;
  const brandName = getBrandName(data);
  const bookingsSection = buildBookingsSection(data, locale);
  const creditAmount = Number(order.creditPurchase?.amount || 0);
  const creditsSection = creditAmount
    ? `<h3>${copy.creditsHeading}</h3><p><strong>${escapeHtml(
        creditAmount,
      )}</strong> ${copy.creditsAdded}</p>`
    : "";
  const paidAt = order.paidAt
    ? `${formatDate(order.paidAt, "UTC", locale)} ${formatTime(
        order.paidAt,
        "UTC",
        locale,
      )}`
    : "";

  return {
    subject: `${brandName} | ${copy.orderConfirmation} | ${String(order._id)}`,
    html: `
      <div style="font-family:ui-sans-serif,system-ui;line-height:1.5;color:#111;">
        <p>${escapeHtml(name)}, ${copy.thankYou}</p>
        <p>${copy.paymentReceived}${paidAt ? ` ${escapeHtml(paidAt)}` : ""}.</p>
        ${bookingsSection}${creditsSection}
        ${manageBooking.html}
        <hr style="margin:24px 0;border:none;border-top:1px solid #eee;" />
        <p>${copy.reply}</p>
        <p><strong>${escapeHtml(brandName)}</strong></p>
      </div>`,
    text: [
      `${name}, ${copy.thankYou.replace(" 🧡", "")}`,
      `${copy.order}: ${String(order._id)}`,
      paidAt ? `${copy.paidAt}: ${paidAt}` : `${copy.paymentReceived}.`,
      ...[...data.workshopBookings, ...data.courseBookings].map(
        (booking) =>
          `- ${getProductName(booking, locale)} | ${formatDate(
            booking.start,
            getTimezone(booking),
            locale,
          )} ${formatRange(booking, locale)} | ${getLocationLabel(booking)}`,
      ),
      creditAmount ? `${copy.credits}: +${creditAmount}` : null,
      manageBooking.text,
      brandName,
    ]
      .filter(Boolean)
      .join("\n"),
  };
};

export const buildPiecePaymentConfirmationEmail = ({
  order,
  user,
  tenant,
}: {
  order: OrderEmailOrder;
  user: OrderEmailUser;
  tenant?: PieceEmailTenant | null;
}) => {
  const checkout = order.pieceCheckout;
  if (
    checkout?.state !== "paid" ||
    Number(checkout.refundedAmountMinor || 0) !== 0 ||
    !["card", "credits"].includes(checkout.method) ||
    !checkout.items?.length
  ) {
    throw new Error("A settled piece checkout is required for confirmation.");
  }
  const currency = normalizeStudioCommerceCurrency(order.currency);
  const totalMinor = checkout.items.reduce((total, item) => {
    if (
      !item.name?.trim() ||
      !item.registrationNumber?.trim() ||
      !Number.isSafeInteger(item.amountMinor) ||
      item.amountMinor <= 0
    ) {
      throw new Error(
        "Piece payment confirmation has an invalid item snapshot.",
      );
    }
    return total + item.amountMinor;
  }, 0);
  if (
    !Number.isSafeInteger(totalMinor) ||
    totalMinor !== order.grossAmountMinor
  ) {
    throw new Error(
      "Piece payment confirmation totals do not match the order.",
    );
  }

  const locale = resolveCommunicationContentLocale(
    tenant?.settings?.publicDefaultLanguage ||
      tenant?.settings?.defaultLanguage,
    COMMUNICATION_CONTENT_LOCALE.CS,
  );
  const copy =
    locale === "en"
      ? {
          title: "Piece payment confirmation",
          greeting: "Hello",
          thankYou: "thank you!",
          confirmed: "Your payment for the following pieces is complete.",
          order: "Order",
          paidAt: "Payment completed",
          item: "Piece",
          registration: "Registration number",
          amount: "Amount",
          total: "Total paid",
          card: "Paid by card",
          credits: "Paid with studio credits",
          reply: "If you have any questions, reply to this email.",
        }
      : {
          title: "Potvrzení platby za výrobky",
          greeting: "Dobrý den",
          thankYou: "děkujeme!",
          confirmed: "Platba za následující výrobky byla dokončena.",
          order: "Objednávka",
          paidAt: "Platba dokončena",
          item: "Výrobek",
          registration: "Registrační číslo",
          amount: "Částka",
          total: "Celkem uhrazeno",
          card: "Uhrazeno kartou",
          credits: "Uhrazeno kredity studia",
          reply: "Pokud máte dotazy, odpovězte na tento e-mail.",
        };
  const formatMoney = (minor: number) =>
    new Intl.NumberFormat(getCommunicationIntlLocale(locale), {
      style: "currency",
      currency,
      currencyDisplay: "code",
      minimumFractionDigits: getCurrencyExponent(currency),
      maximumFractionDigits: getCurrencyExponent(currency),
    }).format(fromCurrencyMinorUnits(minor, currency));
  const total = formatMoney(totalMinor);
  const paymentMethod =
    checkout.method === "credits" ? copy.credits : copy.card;
  const brandName = tenant?.name?.trim() || "shario.io";
  const name =
    [user.firstname, user.lastname].filter(Boolean).join(" ") ||
    [order.customer?.firstname, order.customer?.lastname]
      .filter(Boolean)
      .join(" ") ||
    copy.greeting;
  const timezone = tenant?.settings?.timezone || "UTC";
  const paidAt = order.paidAt
    ? `${formatDate(order.paidAt, timezone, locale)} ${formatTime(order.paidAt, timezone, locale)}`
    : "";
  const rows = checkout.items
    .map(
      (item) => `
    <tr>
      <td style="padding:8px 12px 8px 0;">${escapeHtml(item.name)}</td>
      <td style="padding:8px 12px 8px 0;">${escapeHtml(item.registrationNumber)}</td>
      <td style="padding:8px 0;text-align:right;">${escapeHtml(formatMoney(item.amountMinor))}</td>
    </tr>`,
    )
    .join("");

  return {
    subject: `${brandName} | ${copy.title} | ${String(order._id)}`,
    html: `
      <div lang="${locale}" style="font-family:ui-sans-serif,system-ui;line-height:1.5;color:#111;">
        <p>${escapeHtml(name)}, ${copy.thankYou}</p>
        <h2>${copy.title}</h2>
        <p>${copy.confirmed}</p>
        <p>${copy.order}: ${escapeHtml(order._id)}</p>
        ${paidAt ? `<p>${copy.paidAt}: ${escapeHtml(paidAt)}</p>` : ""}
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr>
            <th align="left">${copy.item}</th>
            <th align="left">${copy.registration}</th>
            <th align="right">${copy.amount}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p><strong>${copy.total}: ${escapeHtml(total)}</strong><br />${paymentMethod}</p>
        <p>${copy.reply}</p>
        <p><strong>${escapeHtml(brandName)}</strong></p>
      </div>`,
    text: [
      `${name}, ${copy.thankYou}`,
      copy.title,
      copy.confirmed,
      `${copy.order}: ${String(order._id)}`,
      paidAt ? `${copy.paidAt}: ${paidAt}` : null,
      ...checkout.items.map(
        (item) =>
          `${item.name} | ${copy.registration}: ${item.registrationNumber} | ${formatMoney(item.amountMinor)}`,
      ),
      `${copy.total}: ${total}`,
      paymentMethod,
      copy.reply,
      brandName,
    ]
      .filter(Boolean)
      .join("\n"),
  };
};

export const sendNotificationEmail = async ({
  type,
  order,
  user,
  beforeSend,
  deliveryId,
}: SendNotificationEmailParams): Promise<{
  provider: "postmark" | null;
  providerMessageId: string | null;
  template: string | null;
}> => {
  if (type !== "order_confirm") {
    return { provider: null, providerMessageId: null, template: null };
  }

  const tenantId = String(order.tenant || "");
  let email: { subject: string; html: string; text: string };
  try {
    if (!user.email?.trim())
      throw new Error("Missing confirmation recipient email.");
    if (!tenantId) throw new Error("Missing confirmation workspace.");
    if (order.pieceCheckout) {
      const tenant = await TenantModel.findById(tenantId)
        .select(
          "name settings.publicDefaultLanguage settings.defaultLanguage settings.timezone",
        )
        .lean<PieceEmailTenant>()
        .exec();
      email = buildPiecePaymentConfirmationEmail({ order, user, tenant });
    } else {
      const data = await loadOrderEmailData(order);
      const hasBookings =
        data.workshopBookings.length > 0 ||
        data.courseBookings.length > 0 ||
        data.guestIncreaseBookings.length > 0;
      const customerBookingLink = hasBookings
        ? await resolveCustomerBookingLink(order.tenant)
        : null;
      email = buildOrderConfirmationEmail({
        order,
        user,
        data,
        customerBookingLink,
      });
    }
  } catch (error) {
    // Rendering and source reads happen before contacting the provider. Keep
    // these definite failures distinct from an uncertain dispatched request.
    throw new PostmarkRequestError(
      error instanceof Error
        ? error.message
        : "Could not prepare payment confirmation.",
      {
        code: "ORDER_CONFIRMATION_PREPARATION_FAILED",
        deliveryOutcome: "not_sent",
      },
    );
  }
  const deliveryKey = `order-confirm:${String(order._id)}`;
  const response = await sendManagedTenantEmail({
    tenantId,
    orderId: String(order._id),
    deliveryId,
    to: user.email!,
    ...email,
    idempotencyKey: deliveryKey,
    headers: {
      "Message-ID": `<order-confirm-${String(order._id)}@notify.shario.io>`,
      "X-Shario-Delivery-Key": deliveryKey,
    },
    // The adapter runs this after resolving the managed sender, immediately
    // before provider submission, so the job can fence the actual attempt.
    beforeSend,
  });

  return {
    provider: response.provider,
    providerMessageId: response.providerMessageId,
    template: order.pieceCheckout
      ? "piece-payment-confirm-v1"
      : "order-confirm-location-v3",
  };
};
