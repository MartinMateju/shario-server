import crypto from "node:crypto";

import {
  fromCurrencyMinorUnits,
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { PROMO_CODE_ALPHABET } from "./coupon.constants.js";

export const normalizeCouponCurrency = (
  value: unknown,
): StudioCommerceCurrency => normalizeStudioCommerceCurrency(value);

export const couponAmountToMinorUnits = (
  amount: number,
  currency: StudioCommerceCurrency,
): number => toCurrencyMinorUnits(amount, currency);

export type CouponValueSnapshot = Readonly<{
  valueMinorSnapshot: number;
  currencySnapshot: StudioCommerceCurrency;
}>;

export type ResolvedCouponValue = CouponValueSnapshot &
  Readonly<{
    amount: number;
    source: "coupon" | "order" | "product";
  }>;

export class CouponValueSnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CouponValueSnapshotError";
    this.code = code;
  }
}

const isPresent = (value: unknown): boolean =>
  value !== null && value !== undefined && String(value).trim() !== "";

const requirePositiveMinorSnapshot = (
  amountMinor: unknown,
  currency: unknown,
  code: string,
  label: string,
): CouponValueSnapshot => {
  let normalizedCurrency: StudioCommerceCurrency;

  try {
    normalizedCurrency = normalizeCouponCurrency(currency);
  } catch {
    throw new CouponValueSnapshotError(
      code,
      `${label} has an unsupported currency snapshot.`,
    );
  }

  const normalizedAmount = Number(amountMinor);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0) {
    throw new CouponValueSnapshotError(
      code,
      `${label} has an invalid value snapshot.`,
    );
  }

  return {
    valueMinorSnapshot: normalizedAmount,
    currencySnapshot: normalizedCurrency,
  };
};

export const createCouponValueSnapshot = (input: {
  amount: unknown;
  currency: unknown;
  code?: string;
  label?: string;
}): CouponValueSnapshot => {
  const code = input.code ?? "COUPON_VALUE_SNAPSHOT_INVALID";
  const label = input.label ?? "Voucher";
  let currency: StudioCommerceCurrency;

  try {
    currency = normalizeCouponCurrency(input.currency);
  } catch {
    throw new CouponValueSnapshotError(
      code,
      `${label} has an unsupported currency snapshot.`,
    );
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CouponValueSnapshotError(
      code,
      `${label} has an invalid value snapshot.`,
    );
  }

  let valueMinorSnapshot: number;
  try {
    valueMinorSnapshot = couponAmountToMinorUnits(amount, currency);
  } catch {
    throw new CouponValueSnapshotError(
      code,
      `${label} has an invalid value or currency precision.`,
    );
  }
  if (valueMinorSnapshot <= 0) {
    throw new CouponValueSnapshotError(
      code,
      `${label} has an invalid value snapshot.`,
    );
  }

  return { valueMinorSnapshot, currencySnapshot: currency };
};

export const createCouponValueSnapshotFromOrder = (order: {
  unitPriceSnapshot?: unknown;
  currencySnapshot?: unknown;
}): CouponValueSnapshot =>
  createCouponValueSnapshot({
    amount: order.unitPriceSnapshot,
    currency: order.currencySnapshot,
    code: "COUPON_ORDER_VALUE_SNAPSHOT_INVALID",
    label: "Voucher order",
  });

export const createCouponValueSnapshotFromProduct = (product: {
  price?: unknown;
  currency?: unknown;
}): CouponValueSnapshot =>
  createCouponValueSnapshot({
    amount: product.price,
    currency: product.currency,
    code: "COUPON_PRODUCT_VALUE_INVALID",
    label: "Voucher product",
  });

/**
 * Resolve a voucher liability without allowing a newer mutable Product price
 * to replace an immutable issuance snapshot. A referenced but missing/corrupt
 * order is deliberately fail-closed; it may represent the only trustworthy
 * paid-value record for a legacy voucher.
 */
export const resolveCouponRedemptionValue = (input: {
  coupon: {
    valueMinorSnapshot?: unknown;
    currencySnapshot?: unknown;
    order?: unknown;
  };
  orderSnapshot?: {
    unitPriceSnapshot?: unknown;
    currencySnapshot?: unknown;
  } | null;
  product: { price?: unknown; currency?: unknown };
  tenantCurrency?: unknown;
}): ResolvedCouponValue => {
  const hasCouponValue = isPresent(input.coupon.valueMinorSnapshot);
  const hasCouponCurrency = isPresent(input.coupon.currencySnapshot);

  if (hasCouponValue || hasCouponCurrency) {
    if (!hasCouponValue || !hasCouponCurrency) {
      throw new CouponValueSnapshotError(
        "COUPON_VALUE_SNAPSHOT_INCOMPLETE",
        "Voucher value and currency snapshots are incomplete.",
      );
    }
    const snapshot = requirePositiveMinorSnapshot(
      input.coupon.valueMinorSnapshot,
      input.coupon.currencySnapshot,
      "COUPON_VALUE_SNAPSHOT_INVALID",
      "Voucher",
    );
    return {
      ...snapshot,
      amount: fromCurrencyMinorUnits(
        snapshot.valueMinorSnapshot,
        snapshot.currencySnapshot,
      ),
      source: "coupon",
    };
  }

  if (isPresent(input.coupon.order)) {
    if (!input.orderSnapshot) {
      throw new CouponValueSnapshotError(
        "COUPON_ORDER_VALUE_SNAPSHOT_MISSING",
        "Voucher order value snapshot is missing.",
      );
    }
    const hasOrderValue = isPresent(input.orderSnapshot.unitPriceSnapshot);
    const hasOrderCurrency = isPresent(input.orderSnapshot.currencySnapshot);
    if (!hasOrderValue || !hasOrderCurrency) {
      throw new CouponValueSnapshotError(
        "COUPON_ORDER_VALUE_SNAPSHOT_INVALID",
        "Voucher order value and currency snapshots are incomplete.",
      );
    }
    const snapshot = createCouponValueSnapshot({
      amount: input.orderSnapshot.unitPriceSnapshot,
      currency: input.orderSnapshot.currencySnapshot,
      code: "COUPON_ORDER_VALUE_SNAPSHOT_INVALID",
      label: "Voucher order",
    });
    return {
      ...snapshot,
      amount: fromCurrencyMinorUnits(
        snapshot.valueMinorSnapshot,
        snapshot.currencySnapshot,
      ),
      source: "order",
    };
  }

  const snapshot = createCouponValueSnapshot({
    amount: input.product.price,
    currency: input.product.currency || input.tenantCurrency,
    code: "COUPON_PRODUCT_VALUE_INVALID",
    label: "Voucher product",
  });
  return {
    ...snapshot,
    amount: fromCurrencyMinorUnits(
      snapshot.valueMinorSnapshot,
      snapshot.currencySnapshot,
    ),
    source: "product",
  };
};

export const escapeRegex = (value = ""): string => {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

export const generatePromoCode = (): string => {
  const group = (length: number) => {
    let value = "";

    for (let index = 0; index < length; index += 1) {
      value +=
        PROMO_CODE_ALPHABET[crypto.randomInt(0, PROMO_CODE_ALPHABET.length)];
    }

    return value;
  };

  const digits = (length: number) => {
    let value = "";

    for (let index = 0; index < length; index += 1) {
      value += String(crypto.randomInt(0, 10));
    }

    return value;
  };

  return `${group(3)}-${group(3)}-${digits(3)}`;
};

export const getProductNameSnapshot = (name: unknown): string => {
  if (typeof name === "object" && name !== null) {
    const localized = name as { CZ?: string; EN?: string };
    return String(localized.CZ || localized.EN || "").trim();
  }

  return String(name || "").trim();
};

export const safeString = (value: unknown): string => {
  return value === null || value === undefined ? "" : String(value);
};
