import { describe, expect, it } from "vitest";
import { purchaseCreditsSchema } from "@/modules/money-credit/money-credit.validators.js";

describe("credit purchase request validation", () => {
  it.each([undefined, null, "", false, true, 0, -500, 499, 500.01, 2500, Infinity, NaN])(
    "rejects an unsupported purchase amount %s",
    (amount) => {
      expect(purchaseCreditsSchema.safeParse({ amount }).success).toBe(false);
    },
  );

  it.each(["vaclavska", "studio-2", "64b000000000000000000001"])(
    "accepts the return location reference %s",
    (locationReference) => {
      expect(purchaseCreditsSchema.parse({ amount: "500", locationReference: ` ${locationReference} ` }))
        .toMatchObject({ amount: 500, locationReference });
    },
  );

  it.each(["", "x".repeat(161), "../other", "studio&orderId=other", "https://evil.example", "studio room"])(
    "rejects a malformed return location %s",
    (locationReference) => {
      expect(purchaseCreditsSchema.safeParse({ amount: 500, locationReference }).success).toBe(false);
    },
  );

  it("keeps existing clients compatible and ignores identity overrides", () => {
    expect(purchaseCreditsSchema.parse({
      amount: 500, currency: " czk ", tenantId: "other-tenant", userId: "other-user",
    })).toEqual({ amount: 500, currency: "CZK" });
  });
});
