import { z } from "zod";
import { AppError } from "@/shared/http/AppError.js";
import { PROMO_CODE_REGEX } from "@/modules/coupon/coupon.constants.js";
import { requireExpectedVoucherQuote, voucherQuoteExpectationSchema } from "./checkout.voucher.validation.js";

const id = z.string().regex(/^[a-f0-9]{24}$/i);
const contactText = z.string().trim().min(1).max(80).refine((value) => !/[\r\n\x00-\x1f]/.test(value));
const courseProduct = z.object({
  _id: id,
  type: z.enum(["course", "public-course"]),
  kind: z.literal("class").optional(),
}).strip();
const cartItem = z.object({
  product: courseProduct,
  bookingCourse: id,
  quantity: z.number().int().min(1).max(20),
  numberOfGuests: z.number().int().min(1).max(20),
  guests: z.array(z.unknown()).max(19),
  locationId: id.optional(),
}).strip().superRefine((item, ctx) => {
  if (item.quantity !== item.numberOfGuests || item.quantity !== item.guests.length + 1)
    ctx.addIssue({ code: "custom", message: "The participant count is inconsistent." });
});
const promoCode = z.string().trim().toUpperCase().max(64).refine(
  (value) => value === "" || PROMO_CODE_REGEX.test(value),
);
const requestSchema = z.object({
  cart: z.array(cartItem).length(1),
  guestInfo: z.object({
    firstName: contactText,
    lastName: contactText,
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().max(40).refine((v) => !/[\r\n\x00-\x1f]/.test(v)).optional(),
  }).strict(),
  locale: z.string().max(12).optional(),
  origin: z.string().max(2048).optional(),
  acceptedTerms: z.literal(true).optional(),
  promoCode: promoCode.optional(),
  expectedVoucherQuote: voucherQuoteExpectationSchema.optional(),
}).strict();
const quoteSchema = z.object({
  cart: z.array(cartItem).length(1),
  promoCode: promoCode.refine((value) => value.length > 0),
  locale: z.string().max(12).optional(),
}).strict();

export const parseGuestCourseVoucherQuote = (body: unknown) => {
  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) throw new AppError({
    statusCode: 400, code: "GUEST_COURSE_CHECKOUT_INVALID",
    message: "Provide a voucher code and one course with a valid participant count.",
  });
  return { ...parsed.data, cart: parsed.data.cart.map((item) => ({
    ...item, guests: Array.from({ length: item.quantity - 1 }, () => ({})),
  })) };
};

export const parseGuestCourseCheckout = (body: unknown, idempotencyKey: unknown) => {
  const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key))
    throw new AppError({ statusCode: 400, code: "CHECKOUT_IDEMPOTENCY_KEY_REQUIRED",
      message: "A random UUID Idempotency-Key is required." });
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) throw new AppError({
    statusCode: 400, code: "GUEST_COURSE_CHECKOUT_INVALID",
    message: "Provide your contact details and one course with a valid participant count.",
  });
  if (parsed.data.promoCode) requireExpectedVoucherQuote(parsed.data.expectedVoucherQuote);
  else if (parsed.data.expectedVoucherQuote) throw new AppError({
    statusCode: 400, code: "GUEST_COURSE_CHECKOUT_INVALID",
    message: "A voucher quote requires a voucher code.",
  });
  // Extra attendee metadata is not an identity or a price authority.
  return { ...parsed.data, key, cart: parsed.data.cart.map((item) => ({
    ...item, guests: Array.from({ length: item.quantity - 1 }, () => ({})),
  })) };
};
