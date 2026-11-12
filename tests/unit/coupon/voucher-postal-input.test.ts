import { describe, expect, it } from "vitest";
import { couponCheckoutSchema, couponOrderFilterSchema } from "@/modules/coupon/coupon.validators.js";

const input = {
  productId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  email: "buyer@example.test",
  sendPost: true,
  firstname: "Anna",
  lastname: "Novak",
  street: "Studio Street 1",
  city: "Brno",
  postalCode: "60200",
  countryCode: "CZ",
};

describe("voucher postal checkout input", () => {
  it("defaults to digital without needing a postal address", () => {
    expect(couponCheckoutSchema.parse({ productId: input.productId, email: input.email }))
      .toMatchObject({ sendPost: false });
  });

  it.each(["false", "true", 0, 1, null])("does not coerce sendPost=%j into a postal purchase", (sendPost) => {
    expect(couponCheckoutSchema.safeParse({ ...input, sendPost }).success).toBe(false);
  });

  it.each(["firstname", "lastname", "street", "city", "postalCode", "countryCode"])(
    "requires %s when physical delivery is selected",
    (field) => {
      const result = couponCheckoutSchema.safeParse({ ...input, [field]: "" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.some(issue => issue.path.includes(field))).toBe(true);
    },
  );

  it.each(["ZZ", "CZE", "1A", "<CZ>"])("rejects invalid country %s", (countryCode) => {
    expect(couponCheckoutSchema.safeParse({ ...input, countryCode }).success).toBe(false);
  });

  it("normalizes valid ISO countries and rejects caller-supplied prices", () => {
    expect(couponCheckoutSchema.parse({ ...input, countryCode: " gb " }).countryCode).toBe("GB");
    expect(couponCheckoutSchema.safeParse({ ...input, shippingFee: 0 }).success).toBe(false);
    expect(couponCheckoutSchema.safeParse({ ...input, postageFeeMinor: 0 }).success).toBe(false);
  });
});

describe("voucher order delivery filters", () => {
  it.each([
    [true, true], [false, false], ["true", true], ["false", false], ["all", "all"], [undefined, "all"],
  ])("parses sendPost=%j without turning digital-only into physical-only", (sendPost, expected) => {
    expect(couponOrderFilterSchema.parse({ sendPost }).sendPost).toBe(expected);
  });

  it.each(["0", "yes", "FALSE", 0, 1, null])("rejects invalid sendPost filter %j", (sendPost) => {
    expect(couponOrderFilterSchema.safeParse({ sendPost }).success).toBe(false);
  });

  it("validates product scope and dispatch status independently", () => {
    expect(couponOrderFilterSchema.parse({
      productId: input.productId, physicalStatus: "awaiting_dispatch",
    })).toMatchObject({ productId: input.productId, physicalStatus: "awaiting_dispatch", sendPost: "all" });
    expect(couponOrderFilterSchema.safeParse({ productId: "not-an-id" }).success).toBe(false);
    expect(couponOrderFilterSchema.safeParse({ physicalStatus: "sent_email" }).success).toBe(false);
  });
});
