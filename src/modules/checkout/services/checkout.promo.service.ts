import mongoose from "mongoose";

import { PROMO_CODE_REGEX, RESERVE_MINUTES } from "../checkout.constants.js";

export const validateGuestPromoCodeService = async ({
  tenantId,
  code,
  repository,
}) => {
  const normalized = String(code || "").trim().toUpperCase();

  if (!normalized) {
    return {
      valid: false,
      reason: "EMPTY",
      message: "Zadejte kód poukazu.",
    };
  }

  if (!PROMO_CODE_REGEX.test(normalized)) {
    return {
      valid: false,
      reason: "FORMAT",
      message: "Neplatný formát. Použijte např. D4T-32S-053",
    };
  }

  const coupon = await repository.findCouponByPromoCode({
    tenantId,
    promoCode: normalized,
  });

  if (!coupon) {
    return {
      valid: false,
      reason: "NOT_FOUND",
      message: "Tento kód neexistuje.",
    };
  }

  if (!coupon.isActive) {
    return {
      valid: false,
      reason: "INACTIVE",
      message: "Tento kód už není aktivní.",
    };
  }

  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) {
    return {
      valid: false,
      reason: "EXPIRED",
      message: "Platnost tohoto kódu již vypršela.",
    };
  }

  if (coupon.singleUse && (!!coupon.redeemedAt || !!coupon.redeemedBy)) {
    return {
      valid: false,
      reason: "ALREADY_REDEEMED",
      message: "Tento kód už byl použit.",
    };
  }

  if (coupon.reservedUntil && new Date(coupon.reservedUntil).getTime() > Date.now()) {
    return {
      valid: false,
      reason: "RESERVED",
      message:
        "Tento poukaz je momentálně rezervovaný. Zkuste to prosím za chvíli znovu.",
    };
  }

  if (!mongoose.Types.ObjectId.isValid(String(coupon.product))) {
    return {
      valid: false,
      reason: "BROKEN_PRODUCT",
      message: "Tento kód je neplatný (produkt).",
    };
  }

  const couponProduct = await repository.findCouponProduct({
    tenantId,
    productId: coupon.product,
  });

  if (!couponProduct || String(couponProduct.type) !== "coupon") {
    return {
      valid: false,
      reason: "BROKEN_PRODUCT_TYPE",
      message: "Tento kód je neplatný (typ poukazu).",
    };
  }

  const value = Number(couponProduct.price);

  if (!Number.isFinite(value) || value <= 0) {
    return {
      valid: false,
      reason: "INVALID_VALUE",
      message: "Tento kód je neplatný (hodnota poukazu).",
    };
  }

  return {
    valid: true,
    code: normalized,
    productId: String(coupon.product),
    value,
    message: "Poukaz je platný.",
  };
};

export const getCouponReservationExpiry = (now = new Date()) =>
  new Date(now.getTime() + RESERVE_MINUTES * 60 * 1000);
