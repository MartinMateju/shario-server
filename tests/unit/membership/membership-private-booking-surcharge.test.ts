import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ membership: vi.fn(), balance: vi.fn(), updateBalance: vi.fn(), ledger: vi.fn(), createLedger: vi.fn() }));
vi.mock("@/modules/membership/user-membership.model.js", () => ({ default: { findOne: mocks.membership } }));
vi.mock("@/modules/membership/membership-entitlement-balance.schema.js", () => ({ default: { findOne: mocks.balance, findOneAndUpdate: mocks.updateBalance } }));
vi.mock("@/modules/membership/membership-entitlement-ledger.schema.js", () => ({ default: { findOne: mocks.ledger, create: mocks.createLedger } }));
import { redeemMembershipEntitlement } from "@/modules/membership/services/membership-entitlement.service.js";

const query = (value: unknown) => ({ session: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue(value) });
const membershipId = "507f1f77bcf86cd799439011";
const input = {
  tenantId: "507f1f77bcf86cd799439012", userId: "507f1f77bcf86cd799439013",
  benefitKey: "studio", quantity: 17725, requiredMoneyAmountMinor: 17725, requiredMoneyCurrency: "EUR",
  reference: { type: "order", id: "507f1f77bcf86cd799439014" }, idempotencyKey: "private-checkout",
  session: {} as any,
};
const setupBenefit = (unit: string, currency = "EUR") => mocks.membership.mockReturnValue(query({
  _id: membershipId, status: "active", planSnapshot: { locationScope: { type: "all" },
    benefits: [{ key: "studio", type: "allowance", unit, currency }] },
}));

describe("private booking surcharge membership redemption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.balance.mockReturnValue(query({ available: 20000 }));
    mocks.ledger.mockReturnValue(query(null));
    mocks.updateBalance.mockReturnValue(query({ available: 2275, sequence: 1, unit: "money_minor" }));
    mocks.createLedger.mockResolvedValue([{ amount: -17725 }]);
  });

  it.each(["session", "hour", "booking", "visit"])("rejects a %s allowance before debiting when a monetary surcharge applies", async (unit) => {
    setupBenefit(unit);
    await expect(redeemMembershipEntitlement(input)).rejects.toMatchObject({ code: "PRIVATE_BOOKING_SURCHARGE_REQUIRES_MONEY" });
    expect(mocks.updateBalance).not.toHaveBeenCalled();
  });

  it("rejects underpayment and a monetary allowance in another currency", async () => {
    setupBenefit("money_minor");
    await expect(redeemMembershipEntitlement({ ...input, quantity: 1 })).rejects.toMatchObject({ code: "PRIVATE_BOOKING_SURCHARGE_REQUIRES_MONEY" });
    setupBenefit("money_minor", "CZK");
    await expect(redeemMembershipEntitlement(input)).rejects.toMatchObject({ code: "PRIVATE_BOOKING_SURCHARGE_REQUIRES_MONEY" });
    expect(mocks.updateBalance).not.toHaveBeenCalled();
  });

  it("debits the full base price and surcharge from the correct monetary allowance", async () => {
    setupBenefit("money_minor");
    await expect(redeemMembershipEntitlement(input)).resolves.toEqual({ amount: -17725 });
    expect(mocks.updateBalance).toHaveBeenCalledWith(expect.anything(),
      { $inc: { redeemed: 17725, available: -17725, sequence: 1 } }, expect.objectContaining({ session: input.session }));
  });
});
