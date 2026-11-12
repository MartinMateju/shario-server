import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  fromCurrencyMinorUnits,
  normalizeStudioCommerceCurrency,
} from "@/shared/money/currency.js";

import {
  DEFAULT_WAITLIST_SETTINGS,
  WAITLIST_CHECKOUT_MINIMUM_WINDOW_MS,
  WAITLIST_SETTINGS_LIMITS,
  WAITLIST_STATE,
} from "./waitlist.constants.js";
import type {
  WaitlistEntryDto,
  WaitlistProductLike,
  WaitlistSessionLike,
  WaitlistSettings,
} from "./waitlist.types.js";

const HOUR_MS = 60 * 60 * 1000;

const finiteNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(finiteNumber(value, fallback))));

export const resolveWaitlistSettings = (
  sessionValue?: Partial<WaitlistSettings> | null,
  _productValue?: Partial<WaitlistSettings> | null,
): WaitlistSettings => {
  // A session without persisted configuration is legacy data and must remain
  // safely disabled. Product defaults are copied only at session creation;
  // they are never inherited dynamically by existing sessions.
  const value = sessionValue ?? {};

  return {
    enabled: value.enabled ?? DEFAULT_WAITLIST_SETTINGS.enabled,
    autoPromote: value.autoPromote ?? DEFAULT_WAITLIST_SETTINGS.autoPromote,
    offerWindowHours: bounded(
      value.offerWindowHours,
      DEFAULT_WAITLIST_SETTINGS.offerWindowHours,
      WAITLIST_SETTINGS_LIMITS.offerWindowHours.min,
      WAITLIST_SETTINGS_LIMITS.offerWindowHours.max,
    ),
    cutoffHours: bounded(
      value.cutoffHours,
      DEFAULT_WAITLIST_SETTINGS.cutoffHours,
      WAITLIST_SETTINGS_LIMITS.cutoffHours.min,
      WAITLIST_SETTINGS_LIMITS.cutoffHours.max,
    ),
  };
};

export const snapshotWaitlistProductDefaults = (
  productValue?: Partial<WaitlistSettings> | null,
): WaitlistSettings => resolveWaitlistSettings(productValue, null);

export const getWaitlistJoinDeadline = (
  sessionStart: Date | string | number,
  settings: WaitlistSettings,
): Date =>
  new Date(new Date(sessionStart).getTime() - settings.cutoffHours * HOUR_MS);

export const resolveWaitlistOfferExpiry = ({
  now,
  sessionStart,
  settings,
}: {
  now: Date;
  sessionStart: Date | string | number;
  settings: WaitlistSettings;
}): Date | null => {
  const deadline = getWaitlistJoinDeadline(sessionStart, settings).getTime();
  const configured = now.getTime() + settings.offerWindowHours * HOUR_MS;
  const expiresAt = Math.min(deadline, configured);

  return expiresAt - now.getTime() >= WAITLIST_CHECKOUT_MINIMUM_WINDOW_MS
    ? new Date(expiresAt)
    : null;
};

export const countActiveReservations = (
  session: WaitlistSessionLike,
  now = new Date(),
): number =>
  (session.capacityReservations ?? []).reduce((total, reservation) => {
    const expiresAt = new Date(reservation.expiresAt ?? 0).getTime();
    const quantity = Math.floor(Number(reservation.quantity));
    return expiresAt > now.getTime() &&
      Number.isSafeInteger(quantity) &&
      quantity > 0
      ? total + quantity
      : total;
  }, 0);

export const countActiveWaitlistHolds = (
  session: WaitlistSessionLike,
  now = new Date(),
): number =>
  (session.waitlistCapacityHolds ?? []).reduce((total, hold) => {
    const expiresAt = new Date(hold.expiresAt ?? 0).getTime();
    return expiresAt > now.getTime() ? total + 1 : total;
  }, 0);

export const getWaitlistCapacity = ({
  session,
  product,
  now = new Date(),
}: {
  session: WaitlistSessionLike;
  product: WaitlistProductLike;
  now?: Date;
}) => {
  const capacity = Math.max(
    0,
    Math.floor(Number(product.maxNumberOfParticipants ?? 0)),
  );
  const confirmed = Math.max(
    0,
    Math.floor(Number(session.numberOfGuests ?? 0)),
  );
  const checkoutReserved = countActiveReservations(session, now);
  const waitlistHeld = countActiveWaitlistHolds(session, now);
  const occupied = confirmed + checkoutReserved + waitlistHeld;

  return {
    capacity,
    confirmed,
    checkoutReserved,
    waitlistHeld,
    occupied,
    remaining: Math.max(0, capacity - occupied),
    full: capacity > 0 && occupied >= capacity,
  };
};

export const getPublicWaitlistAvailability = ({
  session,
  product,
  now = new Date(),
}: {
  session: WaitlistSessionLike;
  product: WaitlistProductLike;
  now?: Date;
}) => {
  const settings = resolveWaitlistSettings(
    session.waitlistConfig,
    product.waitlistDefaults,
  );
  const startsAt = new Date(session.start ?? 0);
  const deadline = getWaitlistJoinDeadline(startsAt, settings);
  const started = !Number.isFinite(startsAt.getTime()) || startsAt <= now;
  const joinClosed = deadline <= now;
  const hasCheckoutWindow =
    resolveWaitlistOfferExpiry({ now, sessionStart: startsAt, settings }) !==
    null;
  const capacity = getWaitlistCapacity({ session, product, now });
  const enabled = settings.enabled === true;
  const accepting =
    enabled && !started && !joinClosed && hasCheckoutWindow && capacity.full;

  return {
    enabled,
    accepting,
    joinDeadline:
      enabled && Number.isFinite(deadline.getTime()) ? deadline : null,
    reason: accepting
      ? "available"
      : !enabled
        ? "disabled"
        : started
          ? "session_started"
          : joinClosed || !hasCheckoutWindow
            ? "join_closed"
            : null,
  } as const;
};

export const normalizeWaitlistEmail = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

export const assertWaitlistTokenConfiguration = (): string => {
  const configured = process.env.WAITLIST_TOKEN_PEPPER || "";
  if (configured.length >= 32) return configured;

  if (["test", "development"].includes(process.env.NODE_ENV || "")) {
    return "waitlist-development-only-pepper-32-bytes";
  }

  throw new Error("WAITLIST_TOKEN_PEPPER must contain at least 32 characters.");
};

const tokenPepper = (): string => assertWaitlistTokenConfiguration();

export const createWaitlistToken = (): string =>
  randomBytes(32).toString("base64url");

export const deriveWaitlistToken = ({
  subject,
  purpose,
  generation,
}: {
  subject: unknown;
  purpose: string;
  generation: number;
}): string =>
  createHmac("sha256", tokenPepper())
    .update(`bearer:${purpose}:${String(subject)}:${generation}`)
    .digest("base64url");

export const hashWaitlistToken = (token: string, purpose: string): string =>
  createHmac("sha256", tokenPepper())
    .update(`${purpose}:${token}`)
    .digest("hex");

export const hashWaitlistEmail = (email: string): string =>
  createHmac("sha256", tokenPepper())
    .update(`identity:${normalizeWaitlistEmail(email)}`)
    .digest("hex");

export const createWaitlistPriceVersion = (
  product: WaitlistProductLike,
  amountMinor: number,
  currency: string,
): string =>
  createHash("sha256")
    .update(
      [
        String(product._id ?? ""),
        String(amountMinor),
        currency.toUpperCase(),
        new Date(product.updatedAt ?? 0).toISOString(),
      ].join(":"),
    )
    .digest("hex");

export const waitlistEntryDto = (entry: any): WaitlistEntryDto => {
  const refundAmountMinor = Number(entry.refundSnapshot?.amountMinor);
  const refundedAt = new Date(entry.refundSnapshot?.refundedAt ?? 0);
  const refundCurrency = String(entry.refundSnapshot?.currency ?? "")
    .trim()
    .toUpperCase();
  const hasSafeRefund =
    [WAITLIST_STATE.EXPIRED, WAITLIST_STATE.CANCELLED].includes(entry.state) &&
    entry.refundSnapshot?.status === "succeeded" &&
    Number.isSafeInteger(refundAmountMinor) &&
    refundAmountMinor >= 0 &&
    Number.isFinite(refundedAt.getTime()) &&
    refundedAt.getTime() > 0 &&
    refundCurrency.length === 3;

  return {
    id: String(entry._id),
    sessionId: String(
      entry.courseSession?._id ??
        entry.courseSession?.id ??
        entry.courseSession ??
        "",
    ),
    state: entry.state,
    joinedAt: new Date(entry.joinedAt),
    offerExpiresAt: entry.offerExpiresAt
      ? new Date(entry.offerExpiresAt)
      : null,
    price: {
      amount: fromCurrencyMinorUnits(
        Number(entry.priceSnapshot?.amountMinor ?? 0),
        normalizeStudioCommerceCurrency(entry.priceSnapshot?.currency),
      ),
      amountMinor: Number(entry.priceSnapshot?.amountMinor ?? 0),
      currency: String(entry.priceSnapshot?.currency ?? "").toUpperCase(),
      version: String(entry.priceSnapshot?.version ?? ""),
    },
    ...(hasSafeRefund
      ? {
          refund: {
            amount: fromCurrencyMinorUnits(
              refundAmountMinor,
              normalizeStudioCommerceCurrency(refundCurrency),
            ),
            amountMinor: refundAmountMinor,
            currency: refundCurrency,
            refundedAt,
          },
        }
      : {}),
  };
};
