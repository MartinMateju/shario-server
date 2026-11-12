import mongoose, { type ClientSession } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createOrder: vi.fn() }));

vi.mock("@/modules/product/product.model.js", () => ({ default: {} }));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: {},
  CouponOrder: { create: mocks.createOrder },
}));

import { couponRepository } from "@/modules/coupon/coupon.repository.js";
import { DEFAULT_VOUCHER_DESIGN } from "@/modules/coupon/voucher-design.js";

const tenantId = "507f1f77bcf86cd799439011";
const productId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439012");
const session = { snapshotTest: true } as unknown as ClientSession;
const checkout = {
  productId: String(productId),
  quantity: 1,
  email: "buyer@example.test",
  sendPost: false,
  firstname: "",
  lastname: "",
  street: "",
  city: "",
  postalCode: "",
  note: "",
};
const offering = () => ({
  _id: productId,
  name: "Gift voucher",
  price: 1200,
  currency: "CZK",
  voucherTemplate: "",
  voucherDesign: structuredClone(DEFAULT_VOUCHER_DESIGN),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createOrder.mockImplementation(async (input) => input);
});

describe("voucher design purchase snapshots", () => {
  it("captures nested artwork independently of later offering edits and subsequent purchases", async () => {
    const product = offering();
    product.voucherDesign.colors.title = "#AB123F";
    product.voucherDesign.assets.imageKey = `tenants/${tenantId}/voucher-assets/5a615b33-f96f-4923-a0ea-758a8ae9520e.jpg`;
    await couponRepository.createCouponOrderFromCheckout(
      tenantId,
      checkout,
      product,
      0,
      { connectedAccountId: "acct_studio", expectedAmountMinor: 120_000 },
      {
        session,
        validityTimezoneSnapshot: "Europe/Prague",
        localeSnapshot: "cs",
      },
    );
    const first = mocks.createOrder.mock.calls[0]![0][0];
    expect(mocks.createOrder.mock.calls[0]![1]).toEqual({ session });
    expect(first.tenant.toString()).toBe(tenantId);

    product.voucherDesign.content.title = "A new offering title";
    product.voucherDesign.colors.background = "#123456";
    product.voucherDesign.colors.title = "#654321";
    product.voucherDesign.assets.imageKey = null;
    await couponRepository.createCouponOrderFromCheckout(
      tenantId,
      checkout,
      product,
    );
    const second = mocks.createOrder.mock.calls[1]![0];

    expect(first.designSnapshot.content.title).toBe(
      DEFAULT_VOUCHER_DESIGN.content.title,
    );
    expect(first.designSnapshot.colors.background).toBe(
      DEFAULT_VOUCHER_DESIGN.colors.background,
    );
    expect(first.designSnapshot.colors.title).toBe("#AB123F");
    expect(second.designSnapshot.colors.title).toBe("#654321");
    expect(first.designSnapshot.assets.imageKey).toContain(
      "5a615b33-f96f-4923-a0ea-758a8ae9520e.jpg",
    );
    expect(second.designSnapshot.content.title).toBe("A new offering title");
    expect(first.designSnapshot).not.toBe(second.designSnapshot);
    expect(first.designSnapshot.assets).not.toBe(product.voucherDesign.assets);
    second.designSnapshot.content.title = "Changed detached order object";
    expect(product.voucherDesign.content.title).toBe("A new offering title");
    expect(first.designSnapshot.content.title).toBe(
      DEFAULT_VOUCHER_DESIGN.content.title,
    );
  });

  it("also detaches nested offering artwork when creating a manual order", async () => {
    const product = offering();
    await couponRepository.createManualCouponOrder({
      tenantId,
      product,
      email: checkout.email,
      couponId: new mongoose.Types.ObjectId(),
      promoCode: "MANUAL-CODE",
      session,
    });
    const captured = mocks.createOrder.mock.calls[0]![0][0];
    product.voucherDesign.content.message = "Changed after the issue request";
    product.voucherDesign.typography.font = "serif";
    expect(captured.designSnapshot.content.message).toBe(
      DEFAULT_VOUCHER_DESIGN.content.message,
    );
    expect(captured.designSnapshot.typography.font).toBe(
      DEFAULT_VOUCHER_DESIGN.typography.font,
    );
    expect(captured.tenant.toString()).toBe(tenantId);
  });

  it("retains a legacy PDF snapshot without silently assigning the default editor artwork", async () => {
    await couponRepository.createCouponOrderFromCheckout(tenantId, checkout, {
      _id: productId,
      name: "Legacy gift",
      price: 1000,
      currency: "CZK",
      voucherTemplate: "legacy-vouchers/original-layout.pdf",
    });
    const captured = mocks.createOrder.mock.calls[0]![0];
    expect(captured.designSnapshot).toBeUndefined();
    expect(captured.voucherTemplateKeySnapshot).toBe(
      "legacy-vouchers/original-layout.pdf",
    );
  });
});
