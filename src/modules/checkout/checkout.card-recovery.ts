import type Stripe from "stripe";

import { conflict } from "@/shared/http/httpErrors.js";

type RecoverableCardOrder = {
  _id: unknown;
  currency?: string;
  expectedAmountMinor?: number;
  appliedDiscount?: unknown;
  stripe?: {
    connectedAccountId?: string;
    sessionId?: string;
    livemode?: boolean | null;
  };
};

type CardSessionIdentity = {
  tenantId: string;
  orderId: string;
  connectedAccountId: string;
  currency: string;
  expectedAmountMinor: number;
  livemode: boolean;
};

const recoveryConflict = (message: string, code: string): never =>
  conflict({ message, code });

const unwrapDocument = (value: unknown): unknown => {
  if (
    value &&
    typeof value === "object" &&
    "toObject" in value &&
    typeof (value as { toObject?: unknown }).toObject === "function"
  ) {
    return (value as { toObject: (options?: unknown) => unknown }).toObject({
      depopulate: true,
      getters: false,
      virtuals: false,
      versionKey: false,
    });
  }

  return value;
};

const normalizeScalar = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();

  if (
    value &&
    typeof value === "object" &&
    "toHexString" in value &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  ) {
    return (value as { toHexString: () => string }).toHexString();
  }

  return value;
};

const projectToExpectedShape = (
  actual: unknown,
  expected: unknown,
): unknown => {
  const unwrappedActual = unwrapDocument(actual);
  const unwrappedExpected = unwrapDocument(expected);
  const normalizedExpected = normalizeScalar(unwrappedExpected);

  if (Array.isArray(normalizedExpected)) {
    if (
      !Array.isArray(unwrappedActual) ||
      unwrappedActual.length !== normalizedExpected.length
    ) {
      return unwrappedActual;
    }

    return normalizedExpected.map((item, index) =>
      projectToExpectedShape(unwrappedActual[index], item),
    );
  }

  if (
    normalizedExpected &&
    typeof normalizedExpected === "object" &&
    !Array.isArray(normalizedExpected)
  ) {
    const actualRecord =
      unwrappedActual && typeof unwrappedActual === "object"
        ? (unwrappedActual as Record<string, unknown>)
        : {};
    const expectedRecord = normalizedExpected as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(expectedRecord)
        .filter((key) => expectedRecord[key] !== undefined)
        .sort()
        .map((key) => [
          key,
          projectToExpectedShape(actualRecord[key], expectedRecord[key]),
        ]),
    );
  }

  return normalizeScalar(unwrappedActual);
};

const canonicalize = (value: unknown): unknown => {
  const normalized = normalizeScalar(unwrapDocument(value));

  if (Array.isArray(normalized)) return normalized.map(canonicalize);

  if (normalized && typeof normalized === "object") {
    const record = normalized as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }

  return normalized;
};

const assertPersistedSnapshot = (
  persistedOrder: unknown,
  expectedOrder: Record<string, unknown>,
  message: string,
): void => {
  const actualProjection = canonicalize(
    projectToExpectedShape(persistedOrder, expectedOrder),
  );
  const expectedProjection = canonicalize(expectedOrder);

  if (
    !persistedOrder ||
    JSON.stringify(actualProjection) !== JSON.stringify(expectedProjection)
  ) {
    recoveryConflict(message, "CHECKOUT_PERSISTED_SNAPSHOT_CONFLICT");
  }
};

export const assertPersistedCardOrderSnapshot = (
  persistedOrder: unknown,
  expectedOrder: Record<string, unknown>,
): void =>
  assertPersistedSnapshot(
    persistedOrder,
    expectedOrder,
    "The persisted checkout order does not match this payment attempt.",
  );

export const assertPersistedCardCartSnapshot = (
  persistedCart: unknown,
  expectedCart: Record<string, unknown>,
): void =>
  assertPersistedSnapshot(
    persistedCart,
    expectedCart,
    "The persisted checkout cart does not match this payment attempt.",
  );

export const assertPersistedWorkshopBookingSnapshot = (
  persistedBooking: unknown,
  expectedBooking: Record<string, unknown>,
): void => {
  const {
    createdAt: _createdAt,
    paymentExpiresAt: _paymentExpiresAt,
    paymentConfirmedAt: _paymentConfirmedAt,
    ...stableExpectedBooking
  } = expectedBooking;

  assertPersistedSnapshot(
    persistedBooking,
    stableExpectedBooking,
    "A persisted Open Studio booking does not match this payment attempt.",
  );
};

export const assertReusablePendingWorkshopBooking = (
  booking: {
    status?: unknown;
    paymentStatus?: unknown;
    paymentExpiresAt?: unknown;
  },
  now = new Date(),
  expectedPaymentExpiresAt?: unknown,
): void => {
  const paymentExpiresAt = new Date(booking?.paymentExpiresAt as never);
  const requiredPaymentExpiresAt = new Date(expectedPaymentExpiresAt as never);

  if (
    booking?.status !== "pending" ||
    booking?.paymentStatus !== "PENDING_PAYMENT" ||
    !Number.isFinite(paymentExpiresAt.getTime()) ||
    paymentExpiresAt <= now ||
    !Number.isFinite(requiredPaymentExpiresAt.getTime()) ||
    paymentExpiresAt < requiredPaymentExpiresAt
  ) {
    recoveryConflict(
      "A persisted Open Studio payment reservation is no longer reusable. Start a new checkout after the stale reservation is cleaned up.",
      "CHECKOUT_WORKSHOP_RESERVATION_NOT_REUSABLE",
    );
  }
};

export const assertNoUnattachedCardOrder = (order: unknown): void => {
  if (!order) return;

  recoveryConflict(
    "This checkout stopped after persisting payment records but before attaching Stripe. Start a new checkout with a new Idempotency-Key.",
    "CHECKOUT_PERSISTED_SNAPSHOT_UNATTACHED",
  );
};

const buildIdentity = ({
  tenantId,
  order,
  connectedAccountId,
}: {
  tenantId: string;
  order: RecoverableCardOrder;
  connectedAccountId: string;
}): CardSessionIdentity => {
  const orderId = String(order._id || "");
  const orderConnectedAccountId = String(
    order.stripe?.connectedAccountId || "",
  );
  const currency = String(order.currency || "")
    .trim()
    .toLowerCase();
  const expectedAmountMinor = Number(order.expectedAmountMinor);
  const livemode = order.stripe?.livemode;

  if (
    !orderId ||
    !orderConnectedAccountId ||
    orderConnectedAccountId !== connectedAccountId ||
    !currency ||
    !Number.isSafeInteger(expectedAmountMinor) ||
    expectedAmountMinor < 0 ||
    typeof livemode !== "boolean"
  ) {
    recoveryConflict(
      "The persisted card checkout cannot be safely recovered.",
      "CHECKOUT_SESSION_RECOVERY_MISMATCH",
    );
  }

  return {
    tenantId,
    orderId,
    connectedAccountId: orderConnectedAccountId,
    currency,
    expectedAmountMinor,
    livemode,
  };
};

export const assertStripeCheckoutSessionIdentity = (
  session: Stripe.Checkout.Session,
  identity: CardSessionIdentity,
): void => {
  const metadata = session.metadata || {};
  const metadataAmount = Number(metadata.expectedAmountMinor);

  if (
    session.client_reference_id !== identity.orderId ||
    metadata.sharioManaged !== "true" ||
    metadata.sharioFlow !== "order" ||
    metadata.tenantId !== identity.tenantId ||
    metadata.orderId !== identity.orderId ||
    !Number.isSafeInteger(metadataAmount) ||
    metadataAmount !== identity.expectedAmountMinor ||
    String(session.currency || "").toLowerCase() !== identity.currency ||
    session.amount_total !== identity.expectedAmountMinor ||
    session.livemode !== identity.livemode
  ) {
    recoveryConflict(
      "The Stripe Checkout Session does not match its persisted order.",
      "CHECKOUT_SESSION_RECOVERY_MISMATCH",
    );
  }
};

export const assertStripeCheckoutSessionIsAttachable = (
  session: Stripe.Checkout.Session,
): void => {
  if (session.status === "expired") {
    recoveryConflict(
      "The deterministic Stripe Checkout Session has expired and cannot be attached.",
      "CHECKOUT_SESSION_EXPIRED",
    );
  }

  if (session.status !== "open" || !session.url) {
    recoveryConflict(
      "The Stripe Checkout Session can no longer be attached to this order.",
      "CHECKOUT_SESSION_NOT_ATTACHABLE",
    );
  }
};

export const recoverAttachedCardCheckout = async ({
  tenantId,
  connectedAccountId,
  order,
  retrieveSession,
}: {
  tenantId: string;
  connectedAccountId: string;
  order: RecoverableCardOrder | null;
  retrieveSession: (sessionId: string) => Promise<Stripe.Checkout.Session>;
}): Promise<{
  url: string;
  orderId: unknown;
  sessionId: string;
  appliedDiscount: unknown;
} | null> => {
  const sessionId = String(order?.stripe?.sessionId || "").trim();
  if (!order || !sessionId) return null;

  const identity = buildIdentity({ tenantId, order, connectedAccountId });
  const session = await retrieveSession(sessionId);

  if (session.id !== sessionId) {
    recoveryConflict(
      "Stripe returned a different Checkout Session than the persisted order references.",
      "CHECKOUT_SESSION_RECOVERY_MISMATCH",
    );
  }

  assertStripeCheckoutSessionIdentity(session, identity);

  if (session.status === "expired") {
    recoveryConflict(
      "The persisted Stripe Checkout Session has expired.",
      "CHECKOUT_SESSION_EXPIRED",
    );
  }

  if (!session.url) {
    recoveryConflict(
      "The persisted Stripe Checkout Session is no longer available.",
      "CHECKOUT_SESSION_RECOVERY_UNAVAILABLE",
    );
  }

  return {
    url: session.url,
    orderId: order._id,
    sessionId,
    appliedDiscount: order.appliedDiscount ?? null,
  };
};
