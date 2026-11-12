import { DEFAULT_STUDIO_COMMERCE_CURRENCY } from "@/shared/money/currency.js";

export const MONEY_CREDIT_TRANSACTION_TYPE = {
  ADDED: "added",
  USED: "used",
  REFUND: "refund",
  ADMIN_GRANTED: "admin_granted",
  COUPON_REDEEMED: "coupon_redeemed",
  PURCHASED: "purchased",
  MIGRATION_CREDIT: "migration_credit",
  MIGRATION_DEBIT: "migration_debit",
  MIGRATION_ROLLBACK_CREDIT: "migration_rollback_credit",
  MIGRATION_ROLLBACK_DEBIT: "migration_rollback_debit",
} as const;

export type MoneyCreditTransactionType =
  (typeof MONEY_CREDIT_TRANSACTION_TYPE)[keyof typeof MONEY_CREDIT_TRANSACTION_TYPE];

export const DEFAULT_CREDIT_CURRENCY = DEFAULT_STUDIO_COMMERCE_CURRENCY;
export const ALLOWED_CREDIT_PURCHASE_AMOUNTS = [500, 1000, 1500, 2000] as const;
export const DEFAULT_CREDIT_PAGE = 1;
export const DEFAULT_CREDIT_LIMIT = 50;
export const MAX_CREDIT_LIMIT = 100;
