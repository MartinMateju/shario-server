import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGuestCheckoutReturnUrl, createGuestCheckoutAccess, deriveGuestAccessToken,
  deriveGuestCheckoutUserId, verifyGuestCheckoutAccess,
} from "@/modules/checkout/checkout.guest-access.js";
import { parseGuestCourseCheckout, parseGuestCourseVoucherQuote } from "@/modules/checkout/checkout.guest-validation.js";

const tenantId = "507f1f77bcf86cd799439011";
const orderId = "507f1f77bcf86cd799439022";
const key = "8dc8cf7f-bd48-440f-a2f8-7790a82fa840";
const body = () => ({
  cart: [{
    product: { _id: "507f1f77bcf86cd799439033", type: "course", price: 0 },
    bookingCourse: "507f1f77bcf86cd799439044",
    quantity: 1, numberOfGuests: 1, guests: [],
  }],
  guestInfo: { firstName: " Ada ", lastName: "Lovelace", email: "ADA@example.test" },
  locale: "cs", acceptedTerms: true,
});
describe("guest course proof and input boundary", () => {
  beforeEach(() => vi.stubEnv("ACCESS_TOKEN_SECRET", "guest-test-secret-".repeat(4)));
  afterEach(() => vi.unstubAllEnvs());
  it("issues reproducible tenant/order-bound proof without persisting its bearer", () => {
    const access = createGuestCheckoutAccess({ tenantId, orderId, key, locale: "cs" });
    expect(access.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(access.snapshot)).not.toContain(access.accessToken);
    expect(verifyGuestCheckoutAccess(access.accessToken, access.snapshot)).toBe(true);
    expect(deriveGuestAccessToken(tenantId, orderId, access.snapshot.accessNonce)).toBe(access.accessToken);
    expect(deriveGuestAccessToken("507f1f77bcf86cd799439012", orderId, access.snapshot.accessNonce)).not.toBe(access.accessToken);
    expect(deriveGuestAccessToken(tenantId, "507f1f77bcf86cd799439023", access.snapshot.accessNonce)).not.toBe(access.accessToken);
    expect(verifyGuestCheckoutAccess("A".repeat(43), access.snapshot)).toBe(false);
    expect(verifyGuestCheckoutAccess(access.accessToken, access.snapshot, access.snapshot.accessExpiresAt)).toBe(false);
    expect(verifyGuestCheckoutAccess(access.accessToken, { ...access.snapshot, accessTokenHash: "invalid" })).toBe(false);
  });
  it("creates different non-login principals across tenant and new attempts", () => {
    const identity = deriveGuestCheckoutUserId(tenantId, key);
    expect(identity).toMatch(/^[a-f0-9]{24}$/);
    expect(deriveGuestCheckoutUserId(tenantId, key)).toBe(identity);
    expect(deriveGuestCheckoutUserId("507f1f77bcf86cd799439012", key)).not.toBe(identity);
    expect(deriveGuestCheckoutUserId(tenantId, `${key}-new`)).not.toBe(identity);
    vi.stubEnv("ACCESS_TOKEN_SECRET", "rotated-test-secret-".repeat(4));
    expect(deriveGuestCheckoutUserId(tenantId, key)).toBe(identity);
  });
  it("fails before issuing identities/proofs without a sufficiently strong server secret", () => {
    vi.stubEnv("ACCESS_TOKEN_SECRET", "short");
    expect(() => deriveGuestCheckoutUserId(tenantId, key)).toThrowError(expect.objectContaining({ statusCode: 503 }));
  });
  it("keeps proof out of return query/path and includes no guest contact", () => {
    const url = new URL(buildGuestCheckoutReturnUrl({
      origin: "https://studio.shario.io", locale: "cs", path: "checkout/cancel",
      orderId, accessToken: "A".repeat(43),
      context: { productId: "product", courseSessionId: "session", location: "studio", quantity: "2" },
    }));
    expect(url.pathname).toBe("/cs/checkout/cancel");
    expect(url.searchParams.get("orderId")).toBe(orderId);
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(url.hash).toBe(`#access_token=${"A".repeat(43)}`);
  });
  it("normalizes contact and strips client prices", () => {
    const result = parseGuestCourseCheckout(body(), key);
    expect(result.guestInfo).toMatchObject({ firstName: "Ada", email: "ada@example.test" });
    expect(result.cart[0].product).not.toHaveProperty("price");
  });
  it("requires a reviewed voucher quote and normalizes its code without accepting wallet or pricing inputs", () => {
    const expectedVoucherQuote = { currency: "CZK", totalAmountMinor: 50000, voucherAppliedMinor: 20000, remainingToPayMinor: 30000 };
    expect(parseGuestCourseCheckout({ ...body(), promoCode: " abc-1234 ", expectedVoucherQuote }, key).promoCode).toBe("ABC-1234");
    expect(() => parseGuestCourseCheckout({ ...body(), promoCode: "ABC-1234" }, key)).toThrowError(expect.objectContaining({ code: "VOUCHER_QUOTE_REQUIRED" }));
    expect(() => parseGuestCourseCheckout({ ...body(), expectedVoucherQuote }, key)).toThrowError();
    expect(() => parseGuestCourseCheckout({ ...body(), promoCode: "bad\ncode", expectedVoucherQuote }, key)).toThrowError();
    expect(() => parseGuestCourseCheckout({ ...body(), promoCode: "ABC-1234", expectedVoucherQuote: { ...expectedVoucherQuote, remainingToPayMinor: 0 } }, key)).toThrowError();
    const quote = parseGuestCourseVoucherQuote({ cart: body().cart, promoCode: " abc-1234 " });
    expect(quote.promoCode).toBe("ABC-1234");
    expect(quote.cart[0].product).not.toHaveProperty("price");
    expect(() => parseGuestCourseVoucherQuote({ cart: body().cart, promoCode: "ABC-1234", userId: tenantId })).toThrowError();
  });
  it.each(["workshop", "private-workshop", "private-course", "coupon", "credit", "service"])("rejects %s purchases", (type) => {
    const input = body(); input.cart[0].product.type = type;
    expect(() => parseGuestCourseCheckout(input, key)).toThrowError(expect.objectContaining({ code: "GUEST_COURSE_CHECKOUT_INVALID" }));
  });
  it.each(["creditsToApplyMajor", "voucherCode", "waitlistOfferToken", "userId", "successUrl"])("rejects injected %s", (field) => {
    expect(() => parseGuestCourseCheckout({ ...body(), [field]: "untrusted" }, key)).toThrowError();
  });
  it("rejects mixed/multiple carts, mismatched quantities, invalid contact and weak keys", () => {
    const mixed = body(); mixed.cart.push(mixed.cart[0]);
    expect(() => parseGuestCourseCheckout(mixed, key)).toThrowError();
    const quantity = body(); quantity.cart[0].quantity = 2;
    expect(() => parseGuestCourseCheckout(quantity, key)).toThrowError();
    const contact = body(); contact.guestInfo.firstName = "Ada\nBcc:another";
    expect(() => parseGuestCourseCheckout(contact, key)).toThrowError();
    expect(() => parseGuestCourseCheckout(body(), "predictable")).toThrowError();
  });
});
