import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveLog: vi.fn(),
  findUser: vi.fn(),
  resolveCustomerBookingLink: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.logError },
}));

vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  enqueueCommunicationEmail: vi.fn(),
}));
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.model.js",
  () => ({
    CommunicationEmailLogModel: class {
      static findOne() {
        return {
          session() {
            return this;
          },
          exec: async () => null,
        };
      }
      constructor(input: unknown) {
        Object.assign(this, input);
      }
      async save() {
        mocks.saveLog(this);
        return this;
      }
    },
  }),
);

vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.findUser },
}));

vi.mock("@/modules/booking/customer-booking-link.service.js", () => ({
  resolveCustomerBookingLink: mocks.resolveCustomerBookingLink,
}));

import { recordCustomerBookingLifecycleEmail } from "@/modules/booking/services/booking.customer-notification.service.js";

const userQuery = (email: string) => ({
  select: vi.fn().mockReturnThis(),
  session: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue({ email }),
});

const input = {
  tenantId: "507f1f77bcf86cd799439011",
  userId: "507f1f77bcf86cd799439010",
  event: "cancelled" as const,
  booking: {
    id: "507f1f77bcf86cd799439012",
    start: new Date("2026-08-01T08:00:00.000Z"),
    end: new Date("2026-08-01T10:00:00.000Z"),
    product: {
      name: { CZ: "Práce v ateliéru", EN: "Studio time" },
    },
    location: {
      name: "Studio Olivka",
      timezone: "Europe/Prague",
    },
  },
};

describe("booking lifecycle notification locale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockReturnValue(userQuery("customer@example.test"));
  });

  it("delivers guest changes to the separate contact and does not require a portal account", async () => {
    mocks.findUser.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      session: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue({
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: false,
        guestContact: { email: "guest@example.test", locale: "en" },
      }),
    });
    mocks.resolveCustomerBookingLink.mockResolvedValue({
      locale: "cs",
      url: "https://studio.shario.io/cs/portal",
    });
    expect(await recordCustomerBookingLifecycleEmail(input)).toBeTruthy();
    expect(mocks.saveLog).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: "guest@example.test",
        subject: "Studio Olivka | Booking cancelled",
        body: expect.stringContaining("contact the studio"),
      }),
    );
    expect(mocks.saveLog.mock.calls[0][0].body).not.toContain("/portal");
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
    "keeps the %s customer route while using English fallback copy",
    async (locale) => {
      const url = `https://studio-olivka.shario.io/${locale}/portal?tab=my-bookings`;
      mocks.resolveCustomerBookingLink.mockResolvedValue({ locale, url });

      await expect(
        recordCustomerBookingLifecycleEmail(input),
      ).resolves.toBeTruthy();

      expect(mocks.resolveCustomerBookingLink).toHaveBeenCalledWith(
        input.tenantId,
        undefined,
      );
      expect(mocks.saveLog).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientEmail: "customer@example.test",
          subject: "Studio Olivka | Booking cancelled",
          body: expect.stringContaining(`Manage bookings: ${url}`),
        }),
      );

      const text = String(mocks.saveLog.mock.calls[0]?.[0]?.body);
      expect(text).toContain("Your booking has been cancelled successfully.");
      expect(text).toContain("Booking: Studio time");
      expect(text).not.toContain("Rezervace zrušena");
    },
  );

  it("continues to use Czech copy for the Czech customer route", async () => {
    const url = "https://studio-olivka.shario.io/cs/portal?tab=my-bookings";
    mocks.resolveCustomerBookingLink.mockResolvedValue({ locale: "cs", url });

    await expect(
      recordCustomerBookingLifecycleEmail(input),
    ).resolves.toBeTruthy();

    expect(mocks.saveLog).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Studio Olivka | Rezervace zrušena",
        body: expect.stringContaining(`Spravovat rezervace: ${url}`),
      }),
    );
  });

  it.each(["en", "cs"])(
    "describes original funding and queued card refunds accurately in %s",
    async (locale) => {
      mocks.resolveCustomerBookingLink.mockResolvedValue({
        locale,
        url: `https://studio.shario.io/${locale}/portal`,
      });
      await recordCustomerBookingLifecycleEmail({
        ...input,
        refundAmount: 100,
        refundCurrency: "CZK",
        refundType: "original_payment",
        refundVoucherAmountMinor: 5000,
        refundCardAmountMinor: 5000,
      });
      const text = mocks.saveLog.mock.calls[0][0].body;
      expect(text).not.toContain("returned as studio credit");
      expect(text).not.toContain("vráceno jako kredit studia");
      expect(text).toContain(
        locale === "cs" ? "se stejnou platností" : "with the same expiry",
      );
      expect(text).toContain(
        locale === "cs"
          ? "pokud už byl poukaz převeden na kredit"
          : "if the voucher had already been converted",
      );
      expect(text).toContain(
        locale === "cs" ? "zařazeno ke zpracování" : "queued for processing",
      );
    },
  );

  it("does not claim a voucher was restored for a card-only line within a mixed-source order", async () => {
    mocks.resolveCustomerBookingLink.mockResolvedValue({
      locale: "en",
      url: "https://studio.shario.io/en/portal",
    });
    await recordCustomerBookingLifecycleEmail({
      ...input,
      refundAmount: 100,
      refundCurrency: "CZK",
      refundType: "original_payment",
      refundVoucherAmountMinor: 0,
      refundCardAmountMinor: 10000,
    });
    const text = mocks.saveLog.mock.calls[0][0].body;
    expect(text).toContain("card-funded refund has been queued");
    expect(text).not.toContain("Voucher-funded value");
  });
});
