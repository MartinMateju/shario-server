import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_WAITLIST_SETTINGS,
  WAITLIST_CHECKOUT_MINIMUM_WINDOW_MS,
} from "@/modules/waitlist/waitlist.constants.js";
import {
  assertWaitlistTokenConfiguration,
  countActiveReservations,
  countActiveWaitlistHolds,
  createWaitlistPriceVersion,
  createWaitlistToken,
  deriveWaitlistToken,
  getPublicWaitlistAvailability,
  getWaitlistCapacity,
  getWaitlistJoinDeadline,
  hashWaitlistEmail,
  hashWaitlistToken,
  normalizeWaitlistEmail,
  resolveWaitlistOfferExpiry,
  resolveWaitlistSettings,
  snapshotWaitlistProductDefaults,
  waitlistEntryDto,
} from "@/modules/waitlist/waitlist.policy.js";
import {
  guestWaitlistCheckoutSchema,
  guestWaitlistRequestSchema,
  joinCustomerWaitlistSchema,
  waitlistAdminActionSchema,
  waitlistAdminRemovalSchema,
  waitlistSettingsPatchSchema,
  waitlistTokenSchema,
} from "@/modules/waitlist/waitlist.validators.js";

const originalPepper = process.env.WAITLIST_TOKEN_PEPPER;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalPepper === undefined) delete process.env.WAITLIST_TOKEN_PEPPER;
  else process.env.WAITLIST_TOKEN_PEPPER = originalPepper;
  process.env.NODE_ENV = originalNodeEnv;
});

describe("course waitlist policy", () => {
  it("keeps legacy sessions safely disabled and snapshots bounded product defaults", () => {
    expect(resolveWaitlistSettings(null, { enabled: true })).toEqual(
      DEFAULT_WAITLIST_SETTINGS,
    );
    expect(
      snapshotWaitlistProductDefaults({
        enabled: true,
        autoPromote: false,
        offerWindowHours: 999,
        cutoffHours: -4,
      }),
    ).toEqual({
      enabled: true,
      autoPromote: false,
      offerWindowHours: 168,
      cutoffHours: 0,
    });
  });

  it("closes joins at the cutoff and refuses offers shorter than the payment minimum", () => {
    const start = new Date("2026-08-10T12:00:00.000Z");
    const settings = {
      enabled: true,
      autoPromote: true,
      offerWindowHours: 24,
      cutoffHours: 2,
    };
    expect(getWaitlistJoinDeadline(start, settings)).toEqual(
      new Date("2026-08-10T10:00:00.000Z"),
    );
    expect(
      resolveWaitlistOfferExpiry({
        now: new Date("2026-08-09T09:00:00.000Z"),
        sessionStart: start,
        settings,
      }),
    ).toEqual(new Date("2026-08-10T09:00:00.000Z"));
    expect(
      resolveWaitlistOfferExpiry({
        now: new Date(
          new Date("2026-08-10T10:00:00.000Z").getTime() -
            WAITLIST_CHECKOUT_MINIMUM_WINDOW_MS +
            1,
        ),
        sessionStart: start,
        settings,
      }),
    ).toBeNull();
  });

  it("counts only live positive reservations and holds when deciding fullness", () => {
    const now = new Date("2026-08-07T10:00:00.000Z");
    const session = {
      numberOfGuests: 2,
      capacityReservations: [
        { quantity: 2, expiresAt: new Date("2026-08-07T11:00:00.000Z") },
        { quantity: 9, expiresAt: new Date("2026-08-07T09:00:00.000Z") },
        { quantity: -1, expiresAt: new Date("2026-08-07T11:00:00.000Z") },
      ],
      waitlistCapacityHolds: [
        { expiresAt: new Date("2026-08-07T11:00:00.000Z") },
        { expiresAt: new Date("2026-08-07T09:00:00.000Z") },
      ],
    };
    expect(countActiveReservations(session, now)).toBe(2);
    expect(countActiveWaitlistHolds(session, now)).toBe(1);
    expect(
      getWaitlistCapacity({
        session,
        product: { maxNumberOfParticipants: 5 },
        now,
      }),
    ).toEqual({
      capacity: 5,
      confirmed: 2,
      checkoutReserved: 2,
      waitlistHeld: 1,
      occupied: 5,
      remaining: 0,
      full: true,
    });
  });

  it("advertises a waitlist only for a full, enabled, future session with a checkout window", () => {
    const now = new Date("2026-08-07T10:00:00.000Z");
    const product = { maxNumberOfParticipants: 2 };
    const session = {
      start: new Date("2026-08-08T12:00:00.000Z"),
      numberOfGuests: 2,
      waitlistConfig: {
        enabled: true,
        autoPromote: true,
        offerWindowHours: 24,
        cutoffHours: 2,
      },
    };
    expect(
      getPublicWaitlistAvailability({ session, product, now }),
    ).toMatchObject({ enabled: true, accepting: true, reason: "available" });
    expect(
      getPublicWaitlistAvailability({
        session: { ...session, numberOfGuests: 1 },
        product,
        now,
      }),
    ).toMatchObject({ enabled: true, accepting: false, reason: null });
    expect(
      getPublicWaitlistAvailability({
        session: { ...session, waitlistConfig: undefined },
        product,
        now,
      }),
    ).toMatchObject({ enabled: false, accepting: false, reason: "disabled" });
  });
});

describe("waitlist bearer tokens and price snapshots", () => {
  it("fails closed in production without a strong pepper and permits a fixed local fallback", () => {
    delete process.env.WAITLIST_TOKEN_PEPPER;
    process.env.NODE_ENV = "production";
    expect(() => assertWaitlistTokenConfiguration()).toThrow(
      /WAITLIST_TOKEN_PEPPER/,
    );

    process.env.NODE_ENV = "test";
    expect(assertWaitlistTokenConfiguration()).toHaveLength(41);
  });

  it("derives purpose- and generation-bound tokens and hashes normalized identity", () => {
    process.env.WAITLIST_TOKEN_PEPPER = "x".repeat(32);
    const first = deriveWaitlistToken({
      subject: "entry-1",
      purpose: "manage",
      generation: 1,
    });
    expect(first).toHaveLength(43);
    expect(
      deriveWaitlistToken({
        subject: "entry-1",
        purpose: "manage",
        generation: 1,
      }),
    ).toBe(first);
    expect(
      deriveWaitlistToken({
        subject: "entry-1",
        purpose: "offer",
        generation: 1,
      }),
    ).not.toBe(first);
    expect(
      deriveWaitlistToken({
        subject: "entry-1",
        purpose: "manage",
        generation: 2,
      }),
    ).not.toBe(first);
    expect(hashWaitlistToken(first, "manage")).not.toBe(
      hashWaitlistToken(first, "offer"),
    );
    expect(normalizeWaitlistEmail("  PERSON@Example.COM ")).toBe(
      "person@example.com",
    );
    expect(hashWaitlistEmail("PERSON@example.com")).toBe(
      hashWaitlistEmail(" person@EXAMPLE.com "),
    );
    expect(createWaitlistToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("freezes product, amount, currency, and version and renders zero-decimal DTOs correctly", () => {
    const product = {
      _id: "507f1f77bcf86cd799439012",
      updatedAt: new Date("2026-08-07T10:00:00.000Z"),
    };
    const version = createWaitlistPriceVersion(product, 500, "JPY");
    expect(version).toHaveLength(64);
    expect(createWaitlistPriceVersion(product, 501, "JPY")).not.toBe(version);
    expect(createWaitlistPriceVersion(product, 500, "CZK")).not.toBe(version);

    expect(
      waitlistEntryDto({
        _id: "507f1f77bcf86cd799439013",
        courseSession: "507f1f77bcf86cd799439014",
        state: "waiting",
        joinedAt: new Date("2026-08-07T10:00:00.000Z"),
        priceSnapshot: {
          amountMinor: 500,
          currency: "JPY",
          version,
        },
      }).price,
    ).toEqual({ amount: 500, amountMinor: 500, currency: "JPY", version });
  });
});

describe("waitlist validators", () => {
  const sessionId = "507f1f77bcf86cd799439011";
  const token = "t".repeat(32);

  it("accepts strict customer and verified guest payloads only", () => {
    expect(joinCustomerWaitlistSchema.parse({ sessionId })).toEqual({
      sessionId,
      locale: "en",
    });
    expect(
      guestWaitlistRequestSchema.parse({
        sessionId,
        email: "person@example.test",
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    ).toMatchObject({ sessionId, locale: "en" });
    expect(() =>
      joinCustomerWaitlistSchema.parse({ sessionId, tenantId: sessionId }),
    ).toThrow();
    expect(() => waitlistTokenSchema.parse({ token: "too-short" })).toThrow();
    expect(
      guestWaitlistCheckoutSchema.parse({
        token,
        email: "person@example.test",
      }),
    ).toEqual({ token, email: "person@example.test", checkout: {} });
  });

  it("bounds settings and requires an explicit reason for FIFO override/removal", () => {
    expect(() => waitlistSettingsPatchSchema.parse({})).toThrow();
    expect(() =>
      waitlistSettingsPatchSchema.parse({ offerWindowHours: 0 }),
    ).toThrow();
    expect(waitlistSettingsPatchSchema.parse({ cutoffHours: 0 })).toEqual({
      cutoffHours: 0,
    });
    expect(() =>
      waitlistAdminActionSchema.parse({ overrideFifo: true }),
    ).toThrow(/reason/i);
    expect(
      waitlistAdminActionSchema.parse({
        overrideFifo: true,
        reason: "Customer accessibility exception",
      }),
    ).toMatchObject({ overrideFifo: true });
    expect(() => waitlistAdminRemovalSchema.parse({ reason: " " })).toThrow();
  });
});
