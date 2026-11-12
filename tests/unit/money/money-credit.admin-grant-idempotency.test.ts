import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { adminGrantCreditsSchema } from "@/modules/money-credit/money-credit.validators.js";

const TARGET_USER_ID = "64b000000000000000000203";

describe("admin credit grant idempotency", () => {
  it("accepts and trims an optional caller-provided idempotency key", () => {
    expect(
      adminGrantCreditsSchema.parse({
        targetUserId: TARGET_USER_ID,
        amount: 25,
        reason: "Service recovery",
        idempotencyKey: "  grant-2026-0001  ",
      }),
    ).toMatchObject({
      targetUserId: TARGET_USER_ID,
      amount: 25,
      reason: "Service recovery",
      idempotencyKey: "grant-2026-0001",
    });

    expect(
      adminGrantCreditsSchema.parse({
        targetUserId: TARGET_USER_ID,
        amount: 25,
        reason: "Service recovery",
      }),
    ).not.toHaveProperty("idempotencyKey");
  });

  it("rejects keys too short to be useful for replay protection", () => {
    expect(() =>
      adminGrantCreditsSchema.parse({
        targetUserId: TARGET_USER_ID,
        amount: 25,
        reason: "Service recovery",
        idempotencyKey: "short",
      }),
    ).toThrow();
  });

  it("threads the required grant key through the durable operation and ledger idempotency paths", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/modules/money-credit/services/money-credit.service.ts",
      ),
      "utf8",
    );

    expect(source).toMatch(
      /async adminGrantCredits\([\s\S]*idempotencyKey: string,[\s\S]*return executeDirectCreditMutation\(\{[\s\S]*idempotencyKey,[\s\S]*operation: "admin_grant"/s,
    );
    expect(source).toMatch(
      /const executeDirectCreditMutation[\s\S]*idempotencyKey: buildLedgerIdempotencyKey\(\{/s,
    );
  });
});
