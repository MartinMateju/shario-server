import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  findUsers: vi.fn(),
  findBookings: vi.fn(),
  resolveCustomerBookingLink: vi.fn(),
}));

vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendEmail,
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    find: mocks.findUsers,
  },
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.findBookings,
  },
}));

vi.mock("@/modules/booking/customer-booking-link.service.js", () => ({
  resolveCustomerBookingLink: mocks.resolveCustomerBookingLink,
}));

import {
  buildAccessCodeEmail,
  sendAccessCodeEmail,
} from "@/modules/access-codes/services/access-code-email.service.js";

const input = {
  tenantId: "507f1f77bcf86cd799439011",
  bookingId: "507f1f77bcf86cd799439012",
  to: "customer@example.test",
  studioName: "Studio Olivka",
  studioAddress: "Clay Street 1, Brno",
  timezone: "Europe/Prague",
  entryCode: "7391",
  bookingStart: new Date("2026-08-01T08:00:00.000Z"),
  bookingEnd: new Date("2026-08-01T10:00:00.000Z"),
};

const query = (result: unknown) => ({
  select: vi.fn().mockReturnThis(),
  populate: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(result),
});

describe("access-code email booking link", () => {
  it("renders an escaped, readable code in HTML without putting it in links", () => {
    const email = buildAccessCodeEmail(
      {
        ...input,
        studioName: "<img src=x onerror=alert(1)>",
        entryCode: "12<34",
      },
      { locale: "cs", url: "https://studio.example/cs/portal" },
    );
    expect(email.html).toContain("12&lt;34");
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("Váš vstupní kód");
    expect(email.html).toContain("https://studio.example/cs/portal");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue({
      provider: "postmark",
      providerMessageId: "managed-1",
    });
    mocks.findUsers.mockReturnValue(
      query([
        {
          _id: "507f1f77bcf86cd799439010",
          tenant: "507f1f77bcf86cd799439011",
        },
      ]),
    );
    mocks.findBookings.mockReturnValue(
      query([
        {
          tenant: "507f1f77bcf86cd799439011",
          createdBy: "507f1f77bcf86cd799439010",
          location: { name: "Studio Olivka" },
        },
      ]),
    );
    mocks.resolveCustomerBookingLink.mockResolvedValue({
      locale: "en",
      url: "https://studio-olivka.shario.io/en/portal?tab=my-bookings",
    });
  });

  it("resolves the exact booking tenant and sends localized manage copy", async () => {
    await sendAccessCodeEmail(input);

    expect(mocks.resolveCustomerBookingLink).toHaveBeenCalledWith(
      "507f1f77bcf86cd799439011",
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "customer@example.test",
        subject: "Studio Olivka | Entry code 🔑",
        text: expect.stringContaining(
          "Manage booking: https://studio-olivka.shario.io/en/portal?tab=my-bookings",
        ),
      }),
    );
    expect(mocks.sendEmail.mock.calls[0]?.[0]?.text).toContain(
      "Your entry code is: 7391",
    );
  });

  it("renders Czech copy and keeps the credential out of the manage URL", () => {
    const email = buildAccessCodeEmail(input, {
      locale: "cs",
      url: "https://studio-olivka.shario.io/cs/portal?tab=my-bookings",
    });
    const manageUrl = email.text
      .split("\n")
      .find((line) => line.startsWith("Spravovat rezervaci: "))
      ?.replace("Spravovat rezervaci: ", "");

    expect(email.subject).toBe("Studio Olivka | Vstupní kód 🔑");
    expect(email.text).toContain("váš vstupní kód je: 7391");
    expect(manageUrl).toBe(
      "https://studio-olivka.shario.io/cs/portal?tab=my-bookings",
    );
    expect(manageUrl).not.toContain("7391");
    expect(new URL(String(manageUrl)).searchParams.has("code")).toBe(false);
  });

  it.each([
    "de",
    "pl",
    "sk",
    "da",
    "fr",
    "es",
    "it",
    "pt-PT",
    "sv",
    "nb",
    "fi",
    "hu",
    "el",
    "tr",
    "nl",
    "ro",
  ] as const)(
    "keeps the %s portal route and falls back to English copy",
    (locale) => {
      const url = `https://studio-olivka.shario.io/${locale}/portal?tab=my-bookings`;
      const email = buildAccessCodeEmail(input, { locale, url });

      expect(email.subject).toBe("Studio Olivka | Entry code 🔑");
      expect(email.text).toContain("Your entry code is: 7391");
      expect(email.text).toContain(`Manage booking: ${url}`);
    },
  );
});
