import { describe, expect, it, vi } from "vitest";

import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";

describe("card and account-credit checkout separation", () => {
  it("rejects partial credit/card payment before repository or Stripe work", async () => {
    const deleteProcessingRecords = vi.spyOn(
      checkoutRepository,
      "deleteProcessingRecords",
    );

    await expect(
      checkoutService.createStripeCheckout({
        tenantId: "64b000000000000000000001",
        user: { _id: "64b000000000000000000002" },
        cartItems: [],
        originUrl: "https://studio.example.test",
        currency: "EUR",
        creditsToApplyMajor: 1,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PARTIAL_CREDIT_CARD_PAYMENT_UNSUPPORTED",
    });

    expect(deleteProcessingRecords).not.toHaveBeenCalled();
  });
});
