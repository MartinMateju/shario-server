import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("voucher customer notification producer", () => {
  it("publishes only after the redemption transaction completes", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/modules/coupon/coupon.service.ts"),
      "utf8",
    );
    const transactionStart = source.indexOf("await session.withTransaction");
    const transactionEnd = source.indexOf(
      "if (redeemedCouponId && redeemedCurrency)",
    );
    const publish = source.indexOf(
      "await publishCustomerVoucherRedeemedNotificationSafely",
    );

    expect(transactionStart).toBeGreaterThan(-1);
    expect(transactionEnd).toBeGreaterThan(transactionStart);
    expect(publish).toBeGreaterThan(transactionEnd);
    expect(source).toContain("recipientUserId: params.userId");
    expect(source).toContain("couponId: redeemedCouponId");
  });
});
