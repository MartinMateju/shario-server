import { z } from "zod";
import { AppError } from "@/shared/http/AppError.js";

export const VOUCHER_GIFT_MESSAGE_LIMIT = 240;

/** Personal copy belongs to the purchase, never to the tenant's saved design. */
export const voucherGiftMessageSchema = z
  .string()
  .refine(
    (value) =>
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u.test(
        value,
      ),
    "Gift message contains unsupported control or invisible characters.",
  )
  .transform((value) => value.normalize("NFC").replace(/\r\n?/g, "\n").trim())
  .pipe(z.string().max(VOUCHER_GIFT_MESSAGE_LIMIT));

export function normalizeVoucherGiftMessage(input?: unknown): string {
  const result = voucherGiftMessageSchema.safeParse(input ?? "");
  if (!result.success) {
    throw new AppError({
      code: "VOUCHER_GIFT_MESSAGE_INVALID",
      message:
        "Gift message must contain at most 240 characters and cannot include control or invisible characters.",
      statusCode: 400,
    });
  }
  return result.data;
}
