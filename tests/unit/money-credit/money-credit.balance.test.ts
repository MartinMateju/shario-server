import { describe, expect, it } from "vitest";

import {
  creditMinorToMajor,
  legacyCreditMajorToMinorUnits,
  resolveCreditBalanceMinor,
} from "@/modules/money-credit/money-credit.balance.js";
import {
  hashCreditMutationRequest,
  sha256CreditValue,
  validateCreditIdempotencyKey,
} from "@/modules/money-credit/money-credit.direct-idempotency.js";
import { inspectCreditMutationIdempotency } from "@/modules/money-credit/money-credit.idempotency.js";

describe("money credit minor-unit storage", () => {
  it("repairs historic floating-point artifacts while migrating", () => {
    expect(legacyCreditMajorToMinorUnits(0.3 - 0.1, "EUR")).toBe(20);
    expect(
      resolveCreditBalanceMinor({ moneyCredits: 0.3, currency: "EUR" }),
    ).toBe(30);
    expect(creditMinorToMajor(30, "EUR")).toBe(0.3);
  });

  it("uses the authoritative minor snapshot when one exists", () => {
    expect(
      resolveCreditBalanceMinor({
        moneyCreditsMinor: 19,
        moneyCredits: 999,
        currency: "EUR",
      }),
    ).toBe(19);
  });

  it("supports zero-decimal currencies", () => {
    expect(legacyCreditMajorToMinorUnits(125, "JPY")).toBe(125);
    expect(creditMinorToMajor(125, "JPY")).toBe(125);
  });

  it("does not silently round a materially fractional minor unit", () => {
    expect(() => legacyCreditMajorToMinorUnits(0.005, "EUR")).toThrow(
      "unsupported precision",
    );
  });
});

describe("direct credit idempotency primitives", () => {
  it("requires a bounded URL-safe key", () => {
    expect(() => validateCreditIdempotencyKey(undefined)).toThrowError(
      expect.objectContaining({ code: "CREDIT_IDEMPOTENCY_KEY_REQUIRED" }),
    );
    expect(validateCreditIdempotencyKey("credit.retry_123")).toBe(
      "credit.retry_123",
    );
  });

  it("canonicalizes request objects before hashing", () => {
    expect(hashCreditMutationRequest({ b: 2, a: 1 })).toBe(
      hashCreditMutationRequest({ a: 1, b: 2 }),
    );
  });

  it("stores a digest rather than the raw client key", () => {
    const raw = "customer-visible-retry-key";
    const digest = sha256CreditValue(raw);

    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(raw);
  });

  it("keeps legacy major-unit idempotency snapshots readable", () => {
    expect(
      inspectCreditMutationIdempotency({
        transactions: [
          {
            idempotencyKey: "legacy-credit-key",
            type: "used",
            amount: 0.2,
            amountMinor: null,
            currency: "EUR",
          },
        ],
        idempotencyKey: "legacy-credit-key",
        type: "used",
        amount: -0.2,
        amountMinor: -20,
        currency: "EUR",
      }),
    ).toBe("match");
  });
});
