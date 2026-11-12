import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  findBookings: vi.fn(),
  updateBookings: vi.fn(),
  resolveCustomerBookingLink: vi.fn(),
}));

vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendEmail,
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.findBookings,
    updateMany: mocks.updateBookings,
  },
}));

vi.mock("@/modules/booking/customer-booking-link.service.js", () => ({
  resolveCustomerBookingLink: mocks.resolveCustomerBookingLink,
}));

vi.mock("@/modules/location/location.utils.js", () => ({
  formatLocationAddress: () => "Clay Street 1, Brno",
}));

vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  withTenant: (_tenantId: string, query: unknown) => query,
}));

import { sendBookingConfirmationEmail } from "@/modules/checkout/services/checkout.notification.service.js";

const booking = {
  _id: "507f1f77bcf86cd799439020",
  paymentStatus: "CONFIRMED",
  confirmationSentAt: null,
  start: new Date("2026-08-01T08:00:00.000Z"),
  end: new Date("2026-08-01T10:00:00.000Z"),
  tag: "workshop",
  numberOfGuests: 1,
  bookingProduct: { name: { CZ: "Práce v ateliéru", EN: "Studio time" } },
  location: {
    name: "Studio Olivka",
    booking: { timezone: "Europe/Prague" },
  },
};

describe("legacy checkout booking-confirmation locale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findBookings.mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([booking]),
    });
    mocks.updateBookings.mockResolvedValue({ modifiedCount: 1 });
    mocks.sendEmail.mockResolvedValue({ messageId: "smtp-1" });
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
    "keeps the %s portal link and uses English fallback copy",
    async (locale) => {
      const url =
        `https://studio-olivka.shario.io/${locale}/portal?tab=my-bookings`;
      mocks.resolveCustomerBookingLink.mockResolvedValue({ locale, url });

      await expect(
        sendBookingConfirmationEmail({
          tenantId: "507f1f77bcf86cd799439023",
          bookingIds: [booking._id],
          orderId: "507f1f77bcf86cd799439022",
          user: { email: "customer@example.test" },
          remainingCredits: 20,
          currency: "EUR",
        }),
      ).resolves.toBe(true);

      expect(mocks.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining("Order confirmation"),
          html: expect.stringContaining(url),
        }),
      );
      const html = String(mocks.sendEmail.mock.calls[0]?.[0]?.html);
      expect(html).toContain(`lang="en"`);
      expect(html).toContain("Your booking was created successfully!");
      expect(html).not.toContain("Potvrzení objednávky");
    },
  );
});

