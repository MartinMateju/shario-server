import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { couponSchema } from "@/modules/coupon/coupon.schema.js";
import { membershipPlanSchema } from "@/modules/membership/membership-plan.schema.js";
import { userMembershipSchema } from "@/modules/membership/user-membership.schema.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";

const read = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

const indexNames = (schema: mongoose.Schema) =>
  schema
    .indexes()
    .map(([, options]) => options.name)
    .filter(Boolean);

describe("Step 3 migration persistence contracts", () => {
  it("keeps membership-plan provenance private and tenant-idempotent", () => {
    expect(membershipPlanSchema.path("importMetadata").options.select).toBe(
      false,
    );
    expect(indexNames(membershipPlanSchema)).toEqual(
      expect.arrayContaining([
        "membership_plan_import_key_unique",
        "membership_plan_import_external_id_unique",
        "membership_plan_import_fingerprint_unique",
      ]),
    );
    const source = read("src/modules/membership/membership-plan.schema.ts");
    expect(source).toContain("partialFilterExpression");
    expect(source).toContain('{ $type: "string" }');
  });

  it("stores customer-membership allowance targets as private import provenance", () => {
    expect(userMembershipSchema.path("importMetadata").options.select).toBe(
      false,
    );
    expect(indexNames(userMembershipSchema)).toEqual(
      expect.arrayContaining([
        "user_membership_import_key_unique",
        "user_membership_import_external_id_unique",
        "user_membership_import_fingerprint_unique",
      ]),
    );
    const source = read("src/modules/membership/user-membership.schema.ts");
    expect(source).toMatch(
      /allowanceTargets:\s*\{\s*type:\s*Map,[\s\S]*?Number\.isSafeInteger/,
    );
    expect(source).toContain("allowanceRevision");
  });

  it("uses a dedicated one-allocation-per-customer model for opening credits", () => {
    const source = read(
      "src/modules/money-credit/credit-import-allocation.model.ts",
    );
    expect(source).toContain("targetAmountMinor");
    expect(source).toContain("revision");
    expect(source).toContain('name: "credit_import_allocation_user_unique"');
    expect(source).toContain(
      'name: "credit_import_allocation_external_id_unique"',
    );
    expect(source).toContain(
      'name: "credit_import_allocation_import_key_unique"',
    );
    expect(source).toContain(
      'name: "credit_import_allocation_fingerprint_unique"',
    );
  });

  it("records credit increases and decreases with distinct ledger types", () => {
    expect(MONEY_CREDIT_TRANSACTION_TYPE.MIGRATION_CREDIT).toBe(
      "migration_credit",
    );
    expect(MONEY_CREDIT_TRANSACTION_TYPE.MIGRATION_DEBIT).toBe(
      "migration_debit",
    );
    expect(MONEY_CREDIT_TRANSACTION_TYPE.MIGRATION_CREDIT).not.toBe(
      MONEY_CREDIT_TRANSACTION_TYPE.MIGRATION_DEBIT,
    );
  });

  it("stores immutable voucher value and currency snapshots as a pair", async () => {
    expect(couponSchema.path("valueMinorSnapshot").options.immutable).toBe(
      true,
    );
    expect(couponSchema.path("currencySnapshot").options.immutable).toBe(true);
    expect(couponSchema.path("importMetadata").options.select).toBe(false);
    expect(indexNames(couponSchema)).toEqual(
      expect.arrayContaining([
        "coupon_import_external_id_unique",
        "coupon_import_key_unique",
        "coupon_import_fingerprint_unique",
      ]),
    );

    const Voucher =
      mongoose.models.Step3VoucherSchemaContract ||
      mongoose.model("Step3VoucherSchemaContract", couponSchema.clone());
    const invalid = new Voucher({
      tenant: new mongoose.Types.ObjectId(),
      product: new mongoose.Types.ObjectId(),
      promoCode: "PAIR-TEST-01",
      valueMinorSnapshot: 10_000,
    });
    await expect(invalid.validate()).rejects.toMatchObject({
      errors: expect.objectContaining({
        valueMinorSnapshot: expect.objectContaining({
          message:
            "Voucher value and currency snapshots must be stored together.",
        }),
      }),
    });

    const valid = new Voucher({
      tenant: new mongoose.Types.ObjectId(),
      product: new mongoose.Types.ObjectId(),
      promoCode: "PAIR-TEST-02",
      valueMinorSnapshot: 10_000,
      currencySnapshot: "CZK",
    });
    await expect(valid.validate()).resolves.toBeUndefined();
  });
});
