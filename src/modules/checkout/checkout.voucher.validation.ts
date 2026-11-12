import { z } from "zod";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import { AppError } from "@/shared/http/AppError.js";

export const voucherQuoteExpectationSchema = z
  .object({
    currency: z.enum(STUDIO_COMMERCE_CURRENCIES),
    totalAmountMinor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    voucherAppliedMinor: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    remainingToPayMinor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (value) =>
      value.voucherAppliedMinor + value.remainingToPayMinor ===
      value.totalAmountMinor,
    "Voucher quote total is inconsistent.",
  );
export type VoucherQuoteExpectation = z.infer<
  typeof voucherQuoteExpectationSchema
>;
export function assertExpectedVoucherQuote(
  expected: VoucherQuoteExpectation | undefined,
  actual: VoucherQuoteExpectation,
) {
  if (!expected) return;
  const parsed = voucherQuoteExpectationSchema.safeParse(expected);
  if (
    !parsed.success ||
    [
      "currency",
      "totalAmountMinor",
      "voucherAppliedMinor",
      "remainingToPayMinor",
    ].some((key) => parsed.data[key] !== actual[key])
  )
    throw new AppError({
      statusCode: 409,
      code: "VOUCHER_QUOTE_CHANGED",
      message:
        "The booking price or available voucher balance changed. Review the payment amounts again.",
    });
}
export function requireExpectedVoucherQuote(
  value: unknown,
): VoucherQuoteExpectation {
  const parsed = voucherQuoteExpectationSchema.safeParse(value);
  if (!parsed.success)
    throw new AppError({
      statusCode: 400,
      code: "VOUCHER_QUOTE_REQUIRED",
      message: "Check the voucher payment amounts before confirming.",
    });
  return parsed.data;
}
