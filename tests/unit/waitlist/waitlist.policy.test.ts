import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertWaitlistTokenConfiguration,
  countActiveReservations,
  countActiveWaitlistHolds,
  deriveWaitlistToken,
  getPublicWaitlistAvailability,
  getWaitlistCapacity,
  hashWaitlistEmail,
  hashWaitlistToken,
  resolveWaitlistOfferExpiry,
  resolveWaitlistSettings,
  snapshotWaitlistProductDefaults,
  waitlistEntryDto,
} from "@/modules/waitlist/waitlist.policy.js";

const NOW = new Date("2026-08-07T10:00:00.000Z");

describe("course waitlist policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps legacy sessions disabled instead of dynamically inheriting enabled product defaults", () => {
    expect(
      resolveWaitlistSettings(null, {
        enabled: true,
        autoPromote: false,
        offerWindowHours: 72,
        cutoffHours: 8,
      }),
    ).toEqual({
      enabled: false,
      autoPromote: true,
      offerWindowHours: 24,
      cutoffHours: 2,
    });

    expect(
      snapshotWaitlistProductDefaults({
        enabled: true,
        autoPromote: false,
        offerWindowHours: 72.9,
        cutoffHours: 8.7,
      }),
    ).toEqual({
      enabled: true,
      autoPromote: false,
      offerWindowHours: 72,
      cutoffHours: 8,
    });
  });

  it("counts confirmed seats, checkout reservations and one-seat offer holds without expired rows", () => {
    const session = {
      numberOfGuests: 2,
      capacityReservations: [
        { quantity: 2, expiresAt: "2026-08-07T11:00:00.000Z" },
        { quantity: 9, expiresAt: "2026-08-07T09:00:00.000Z" },
      ],
      waitlistCapacityHolds: [
        { expiresAt: "2026-08-07T10:30:00.000Z" },
        { expiresAt: "2026-08-07T09:30:00.000Z" },
      ],
    };
    expect(countActiveReservations(session, NOW)).toBe(2);
    expect(countActiveWaitlistHolds(session, NOW)).toBe(1);
    expect(
      getWaitlistCapacity({
        session,
        product: { maxNumberOfParticipants: 5 },
        now: NOW,
      }),
    ).toMatchObject({
      capacity: 5,
      confirmed: 2,
      checkoutReserved: 2,
      waitlistHeld: 1,
      occupied: 5,
      remaining: 0,
      full: true,
    });
  });

  it("accepts joins only for a full opted-in session with a safe checkout window", () => {
    const base = {
      start: new Date("2026-08-07T13:00:00.000Z"),
      numberOfGuests: 8,
      waitlistConfig: {
        enabled: true,
        autoPromote: true,
        offerWindowHours: 24,
        cutoffHours: 2,
      },
    };
    const product = { maxNumberOfParticipants: 8 };
    expect(
      getPublicWaitlistAvailability({ session: base, product, now: NOW }),
    ).toMatchObject({ enabled: true, accepting: true, reason: "available" });

    expect(
      getPublicWaitlistAvailability({
        session: { ...base, start: new Date("2026-08-07T12:20:00.000Z") },
        product,
        now: NOW,
      }),
    ).toMatchObject({ accepting: false, reason: "join_closed" });

    expect(
      getPublicWaitlistAvailability({
        session: { ...base, waitlistConfig: undefined },
        product: { ...product, waitlistDefaults: { enabled: true } },
        now: NOW,
      }),
    ).toMatchObject({ enabled: false, accepting: false, reason: "disabled" });
  });

  it("bounds the offer by the cutoff and refuses a sub-30-minute Stripe start window", () => {
    const settings = {
      enabled: true,
      autoPromote: true,
      offerWindowHours: 24,
      cutoffHours: 2,
    };
    expect(
      resolveWaitlistOfferExpiry({
        now: NOW,
        sessionStart: "2026-08-07T15:00:00.000Z",
        settings,
      }),
    ).toEqual(new Date("2026-08-07T13:00:00.000Z"));
    expect(
      resolveWaitlistOfferExpiry({
        now: NOW,
        sessionStart: "2026-08-07T12:20:00.000Z",
        settings,
      }),
    ).toBeNull();
  });

  it("uses the correct ISO currency exponent in immutable customer DTO prices", () => {
    const base = {
      _id: "entry",
      courseSession: { _id: "session" },
      state: "offered",
      joinedAt: NOW,
      offerExpiresAt: null,
    };
    expect(
      waitlistEntryDto({
        ...base,
        priceSnapshot: { amountMinor: 2500, currency: "JPY", version: "j" },
      }).price,
    ).toEqual({
      amount: 2500,
      amountMinor: 2500,
      currency: "JPY",
      version: "j",
    });
    expect(
      waitlistEntryDto({
        ...base,
        priceSnapshot: { amountMinor: 999, currency: "CLP", version: "c" },
      }).price.amount,
    ).toBe(999);
    expect(
      waitlistEntryDto({
        ...base,
        priceSnapshot: { amountMinor: 2599, currency: "EUR", version: "e" },
      }).price.amount,
    ).toBe(25.99);
  });

  it("exposes only a zero-decimal-safe refund summary for refunded terminal entries", () => {
    const dto = waitlistEntryDto({
      _id: "entry",
      courseSession: "session",
      state: "expired",
      isLive: false,
      joinedAt: NOW,
      offerExpiresAt: null,
      priceSnapshot: { amountMinor: 2500, currency: "JPY", version: "j" },
      refundSnapshot: {
        refundId: "re_private_must_not_leak",
        status: "succeeded",
        amountMinor: 2500,
        currency: "JPY",
        paymentMethod: "card",
        refundedAt: NOW,
      },
    });

    expect(dto.refund).toEqual({
      amount: 2500,
      amountMinor: 2500,
      currency: "JPY",
      refundedAt: NOW,
    });
    expect(dto).not.toHaveProperty("refund.refundId");
    expect(dto).not.toHaveProperty("refund.status");
    expect(dto).not.toHaveProperty("refund.paymentMethod");
    expect(
      waitlistEntryDto({
        ...dto,
        _id: "waiting-entry",
        courseSession: "session",
        state: "waiting",
        priceSnapshot: { amountMinor: 2500, currency: "JPY", version: "j" },
        refundSnapshot: {
          status: "succeeded",
          amountMinor: 2500,
          currency: "JPY",
          refundedAt: NOW,
        },
      }),
    ).not.toHaveProperty("refund");
  });

  it("uses purpose-scoped deterministic bearers and a normalized-email identity bridge", () => {
    vi.stubEnv("WAITLIST_TOKEN_PEPPER", "p".repeat(40));
    const token = deriveWaitlistToken({
      subject: "entry-1",
      purpose: "offer",
      generation: 2,
    });
    expect(token).toBe(
      deriveWaitlistToken({
        subject: "entry-1",
        purpose: "offer",
        generation: 2,
      }),
    );
    expect(
      deriveWaitlistToken({
        subject: "entry-1",
        purpose: "offer",
        generation: 3,
      }),
    ).not.toBe(token);
    expect(hashWaitlistToken(token, "offer")).not.toBe(
      hashWaitlistToken(token, "manage"),
    );
    expect(hashWaitlistEmail(" PERSON@Example.COM ")).toBe(
      hashWaitlistEmail("person@example.com"),
    );
  });

  it("fails startup closed without a dedicated production token pepper and never falls back to JWT_SECRET", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WAITLIST_TOKEN_PEPPER", "");
    vi.stubEnv("JWT_SECRET", "j".repeat(64));
    expect(() => assertWaitlistTokenConfiguration()).toThrow(
      /WAITLIST_TOKEN_PEPPER/,
    );

    vi.stubEnv("WAITLIST_TOKEN_PEPPER", "w".repeat(32));
    expect(assertWaitlistTokenConfiguration()).toBe("w".repeat(32));
  });
});
