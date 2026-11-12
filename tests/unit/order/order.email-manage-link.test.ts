import { describe, expect, it } from "vitest";

import { buildOrderConfirmationEmail } from "@/modules/order/services/order.email.service.js";

const booking = {
  _id: "507f1f77bcf86cd799439020",
  start: new Date("2026-08-01T08:00:00.000Z"),
  end: new Date("2026-08-01T10:00:00.000Z"),
  tag: "workshop",
  numberOfGuests: 1,
  bookingProduct: { name: { CZ: "Práce v ateliéru", EN: "Studio time" } },
  location: {
    _id: "507f1f77bcf86cd799439021",
    name: "Studio Olivka",
    booking: { timezone: "Europe/Prague" },
  },
};

const render = (
  locale:
    | "en"
    | "cs"
    | "de"
    | "pl"
    | "sk"
    | "da"
    | "fr"
    | "es"
    | "it"
    | "pt-PT"
    | "sv"
    | "nb"
    | "fi"
    | "hu"
    | "el"
    | "tr"
    | "nl"
    | "ro",
) =>
  buildOrderConfirmationEmail({
    order: {
      _id: "507f1f77bcf86cd799439022",
      tenant: "507f1f77bcf86cd799439023",
      paidAt: new Date("2026-07-30T12:00:00.000Z"),
    },
    user: {
      email: "customer@example.test",
      firstname: "Ada",
      lastname: "Lovelace",
    },
    data: {
      workshopBookings: [booking],
      courseBookings: [],
      qtyByBookingId: new Map(),
      guestIncreaseBookings: [],
    },
    customerBookingLink: {
      locale,
      url: `https://studio-olivka.shario.io/${locale}/portal?tab=my-bookings`,
    },
  });

describe("order confirmation manage-booking link", () => {
  it.each(["en", "cs"])("gives guests booking details without an account-only link in %s", (locale) => {
    const email = buildOrderConfirmationEmail({
      order: {
        _id: "507f1f77bcf86cd799439022",
        guestCourseCheckout: { version: 1, locale },
      },
      user: { firstname: "Guest" },
      data: {
        workshopBookings: [],
        courseBookings: [booking],
        guestIncreaseBookings: [],
        qtyByBookingId: new Map([[String(booking._id), 2]]),
      },
      customerBookingLink: {
        locale: locale === "cs" ? "en" : "cs",
        url: "https://studio.shario.io/en/portal",
      },
    });
    expect(email.subject).toContain(locale === "cs" ? "Potvrzení objednávky" : "Order confirmation");
    expect(email.html).toContain(locale === "cs" ? "Rezervovali jste bez účtu" : "You booked without an account");
    expect(email.text).toContain("507f1f77bcf86cd799439022");
    expect(email.html).not.toContain("/portal");
    expect(email.text).not.toContain("/portal");
    expect(email.html).toContain(locale === "cs" ? "Práce v ateliéru" : "Studio time");
  });

  it("adds localized English portal copy to HTML and text", () => {
    const email = render("en");

    expect(email.subject).toContain("Order confirmation");
    expect(email.html).toContain("We received your payment");
    expect(email.html).toContain("Manage booking");
    expect(email.html).toContain(
      "https://studio-olivka.shario.io/en/portal?tab=my-bookings",
    );
    expect(email.text).toContain(
      "Manage booking: https://studio-olivka.shario.io/en/portal?tab=my-bookings",
    );
  });

  it("adds localized Czech portal copy and no access credential", () => {
    const email = render("cs");

    expect(email.subject).toContain("Potvrzení objednávky");
    expect(email.html).toContain("Platbu jsme přijali");
    expect(email.html).toContain("Spravovat rezervaci");
    expect(email.text).toContain(
      "Spravovat rezervaci: https://studio-olivka.shario.io/cs/portal?tab=my-bookings",
    );
    expect(`${email.html}\n${email.text}`).not.toMatch(
      /entryCode|accessCode|[?&](?:code|token)=/i,
    );
  });

  it.each(["de", "pl", "sk", "da", "fr", "es", "it", "pt-PT",
    "sv",
    "nb",
    "fi",
    "hu",
    "el",
    "tr",
    "nl",
    "ro",
  ] as const)(
    "keeps the %s portal route and uses English fallback copy",
    (locale) => {
      const email = render(locale);

      expect(email.subject).toContain("Order confirmation");
      expect(email.html).toContain("We received your payment");
      expect(email.text).toContain(
        `Manage booking: https://studio-olivka.shario.io/${locale}/portal?tab=my-bookings`,
      );
    },
  );
});

