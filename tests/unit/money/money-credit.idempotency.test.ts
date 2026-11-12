import { describe, expect, it } from "vitest";

import { inspectCreditMutationIdempotency } from "@/modules/money-credit/money-credit.idempotency.js";

describe("money-credit transaction idempotency", () => {
  const transaction = {
    idempotencyKey: "checkout-credit-purchase:order-1",
    type: "added",
    amount: 25,
    currency: "EUR",
  };

  it("recognizes an exact replay", () => {
    expect(
      inspectCreditMutationIdempotency({
        transactions: [transaction],
        idempotencyKey: transaction.idempotencyKey,
        type: "added",
        amount: 25,
        currency: "EUR",
      }),
    ).toBe("match");
  });

  it("rejects reuse of a key for a different ledger mutation", () => {
    expect(
      inspectCreditMutationIdempotency({
        transactions: [transaction],
        idempotencyKey: transaction.idempotencyKey,
        type: "used",
        amount: -25,
        currency: "EUR",
      }),
    ).toBe("conflict");
  });

  it("allows a mutation with a new key", () => {
    expect(
      inspectCreditMutationIdempotency({
        transactions: [transaction],
        idempotencyKey: "checkout-credit-purchase:order-2",
        type: "added",
        amount: 25,
        currency: "EUR",
      }),
    ).toBe("missing");
  });
});
