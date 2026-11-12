import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVoucherPurchaseAccessUrl,
  createVoucherPurchaseAccess,
  deriveVoucherPurchaseAccessToken,
  hashVoucherPurchaseAccessToken,
  verifyVoucherPurchaseAccessToken,
} from "@/modules/coupon/voucher-order-access.js";

const tenantId = "507f1f77bcf86cd799439011";
const couponOrderId = "507f1f77bcf86cd799439012";
const now = new Date("2026-09-15T10:00:00.000Z");
beforeEach(() =>
  vi.stubEnv(
    "ACCESS_TOKEN_SECRET",
    "voucher-tests-only-secret-with-at-least-32-bytes",
  ),
);
afterEach(() => vi.unstubAllEnvs());

describe("voucher purchase bearer proof", () => {
  it("issues distinct unguessable proofs, storing only nonce and one-way hash", () => {
    const first = createVoucherPurchaseAccess({ tenantId, couponOrderId, now });
    const second = createVoucherPurchaseAccess({
      tenantId,
      couponOrderId,
      now,
    });
    expect(first.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(first.purchaseAccessNonce).not.toBe(first.accessToken);
    expect(first.purchaseAccessTokenHash).not.toContain(first.accessToken);
    expect(first.purchaseAccessExpiresAt.toISOString()).toBe(
      "2027-09-15T10:00:00.000Z",
    );
    expect(
      verifyVoucherPurchaseAccessToken({
        accessToken: first.accessToken,
        tokenHash: first.purchaseAccessTokenHash,
        expiresAt: first.purchaseAccessExpiresAt,
        now,
      }),
    ).toBe(true);
  });

  it("regenerates recovery links only for the same tenant, order and nonce", () => {
    const access = createVoucherPurchaseAccess({
      tenantId,
      couponOrderId,
      now,
    });
    expect(
      deriveVoucherPurchaseAccessToken({
        tenantId,
        couponOrderId,
        nonce: access.purchaseAccessNonce,
      }),
    ).toBe(access.accessToken);
    for (const context of [
      { tenantId: "507f1f77bcf86cd799439099", couponOrderId },
      { tenantId, couponOrderId: "507f1f77bcf86cd799439099" },
    ]) {
      expect(
        deriveVoucherPurchaseAccessToken({
          ...context,
          nonce: access.purchaseAccessNonce,
        }),
      ).not.toBe(access.accessToken);
    }
  });

  it("rejects altered, malformed and expired proof without throwing parser errors", () => {
    const access = createVoucherPurchaseAccess({
      tenantId,
      couponOrderId,
      now,
    });
    const base = {
      tokenHash: access.purchaseAccessTokenHash,
      expiresAt: access.purchaseAccessExpiresAt,
      now,
    };
    for (const token of [
      "",
      "x".repeat(42),
      "x".repeat(44),
      "!".repeat(43),
      {},
      "a".repeat(43),
    ]) {
      expect(
        verifyVoucherPurchaseAccessToken({ ...base, accessToken: token }),
      ).toBe(false);
    }
    expect(
      verifyVoucherPurchaseAccessToken({
        ...base,
        accessToken: access.accessToken,
        now: access.purchaseAccessExpiresAt,
      }),
    ).toBe(false);
    expect(
      verifyVoucherPurchaseAccessToken({
        ...base,
        accessToken: access.accessToken,
        tokenHash: "not-hex",
      }),
    ).toBe(false);
    expect(
      verifyVoucherPurchaseAccessToken({
        ...base,
        accessToken: access.accessToken,
        expiresAt: "invalid",
      }),
    ).toBe(false);
  });

  it("keeps the proof outside URL paths and queries and uses snapshotted origin/locale", () => {
    const access = createVoucherPurchaseAccess({
      tenantId,
      couponOrderId,
      now,
    });
    const order = {
      _id: couponOrderId,
      tenant: tenantId,
      ...access,
      purchaseOriginSnapshot: "https://studio.example",
      localeSnapshot: "cs",
    };
    const url = new URL(buildVoucherPurchaseAccessUrl(order, now)!);
    expect(url.origin).toBe("https://studio.example");
    expect(url.pathname).toBe("/cs/vouchers/success");
    expect(url.search).toBe(`?couponOrderId=${couponOrderId}`);
    expect(new URLSearchParams(url.hash.slice(1)).get("accessToken")).toBe(
      access.accessToken,
    );
    expect(
      buildVoucherPurchaseAccessUrl(
        {
          ...order,
          purchaseAccessTokenHash: hashVoucherPurchaseAccessToken(
            "a".repeat(43),
          ),
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      buildVoucherPurchaseAccessUrl(order, access.purchaseAccessExpiresAt),
    ).toBeUndefined();
    expect(
      buildVoucherPurchaseAccessUrl(
        { ...order, purchaseAccessNonce: undefined },
        now,
      ),
    ).toBeUndefined();
  });

  it("does not issue bearer links with a weak or missing server secret", () => {
    vi.stubEnv("ACCESS_TOKEN_SECRET", "short");
    expect(() =>
      createVoucherPurchaseAccess({ tenantId, couponOrderId, now }),
    ).toThrowError(/configured authentication secret/);
  });
});
