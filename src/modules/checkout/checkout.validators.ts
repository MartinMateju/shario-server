import { badRequest } from "@/shared/http/httpErrors.js";

type CheckoutInputError = {
  message: string;
  code: string;
};

export const getUnsupportedCheckoutInput = (
  body: unknown,
): CheckoutInputError | null => {
  if (!body || typeof body !== "object") {
    return null;
  }

  const input = body as Record<string, unknown>;
  const promoCode = input.promoCode;

  if (
    promoCode !== undefined &&
    promoCode !== null &&
    String(promoCode).trim() !== ""
  ) {
    return {
      code: "PROMO_CODE_CHECKOUT_UNSUPPORTED",
      message:
        "Promo codes cannot be applied during checkout. Redeem a voucher to account credits before starting checkout.",
    };
  }

  const rawCredits = input.creditsToApplyMajor;

  if (
    rawCredits !== undefined &&
    rawCredits !== null &&
    String(rawCredits).trim() !== ""
  ) {
    const amount = Number(rawCredits);

    if (!Number.isFinite(amount) || amount !== 0) {
      return {
        code: "PARTIAL_CREDIT_CARD_PAYMENT_UNSUPPORTED",
        message:
          "Combining account credits with a card payment is not supported. Pay fully by card or use the full-credit checkout.",
      };
    }
  }

  return null;
};

export const assertSupportedCheckoutInput = (body: unknown): void => {
  const error = getUnsupportedCheckoutInput(body);

  if (error) {
    badRequest(error);
  }
};
