import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tenant: {} as any }));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: async () => mocks.tenant,
}));
vi.mock("@/modules/product/product-plan-entitlements.js", () => ({
  assertProductsEntitledForTenant: vi.fn(),
}));
vi.mock("@/modules/invoice/invoice-settings.service.js", () => ({
  ensureInvoiceSettings: async () => ({ defaultTaxRateBps: 0, pricesIncludeTax: true }),
}));
vi.mock("@/modules/invoice/invoice.service.js", () => ({ ensurePaidOrderInvoice: vi.fn() }));
vi.mock("@/modules/workspace-notifications/workspace-notification.business-events.js", () => ({
  emitBookingCreatedNotificationsForOrderSafely: vi.fn(),
}));
import Booking from "@/modules/booking/booking.model.js";
import Product from "@/modules/product/product.model.js";
import Location from "@/modules/location/location.model.js";
import User from "@/modules/user/user.model.js";
import Order from "@/modules/order/order.model.js";
import Cart from "@/modules/cart/cart.model.js";
import Membership from "@/modules/membership/user-membership.model.js";
import Balance from "@/modules/membership/membership-entitlement-balance.schema.js";
import Ledger from "@/modules/membership/membership-entitlement-ledger.schema.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";

const ids = Object.fromEntries(["tenant", "member", "product", "location", "membership", "plan", "version"].map((key) => [key, new mongoose.Types.ObjectId()]));
const tenantId = String(ids.tenant);
const models = [Booking, Product, Location, User, Order, Cart, Membership, Balance, Ledger, CheckoutOperationModel];
let db: MongoMemoryReplSet;
let cartItems: any[];
let user: any;

const checkout = (overrides: Record<string, unknown> = {}) => checkoutService.checkoutWithCredits({
  tenantId, user, cartItems, originUrl: "https://studio.example", locale: "cs",
  paymentSource: "membership_credits", membershipBenefitKey: "studio_hours",
  idempotencyKey: "membership-cart-visit", ...overrides,
});

describe("membership hours in customer cart checkout", () => {
  beforeAll(async () => {
    db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(db.getUri());
    await Promise.all(models.map((model: any) => model.init()));
  }, 60000);
  afterAll(async () => { await mongoose.disconnect(); await db?.stop(); });
  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
    const periodStart = new Date(Date.now() - 86400000);
    const periodEnd = new Date(Date.now() + 30 * 86400000);
    const start = new Date(Date.now() + 2 * 86400000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 90 * 60000);
    mocks.tenant = {
      _id: ids.tenant, slug: "studio", settings: { currency: "CZK" },
      modules: { bookings: true, payments: true, memberships: true, credits: false },
    };
    user = {
      _id: ids.member, tenant: ids.tenant, firstname: "Ada", lastname: "Clay",
      email: "member@example.test", customId: "M-01", moneyCreditsMinor: 12300,
      moneyCredits: 123, isAccessGranted: true, isEmailVerified: true,
      tenantRole: "customer", platformRole: "none",
    };
    await User.collection.insertOne(user);
    await Location.collection.insertOne({
      _id: ids.location, tenant: ids.tenant, name: "Studio", isActive: true,
      booking: { enabled: true, globalCapacity: 8, allowPublicOverlap: true, maxConcurrentOpenStudioBookings: 8 },
    } as any);
    await Product.collection.insertOne({
      _id: ids.product, tenant: ids.tenant, createdBy: ids.member,
      name: "Open Studio", description: "Shared studio", isActive: true, isArchived: false,
      type: "public-workshop", kind: "open-studio", bookingMode: "public",
      location: ids.location, price: 300, currency: "CZK", maxNumberOfParticipants: 8,
    } as any);
    await Membership.collection.insertOne({
      _id: ids.membership, tenant: ids.tenant, user: ids.member,
      plan: ids.plan, planVersion: ids.version, status: "active", isOpen: true,
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd,
      planSnapshot: { version: 1, name: "Studio member", locationScope: { type: "all", locationIds: [] }, benefits: [{
        key: "studio_hours", label: "Included hours", type: "allowance", unit: "minute",
        quantity: 720, usageScope: "open_studio", memberOnly: true,
      }] },
    } as any);
    await Balance.collection.insertOne({
      tenant: ids.tenant, user: ids.member, membership: ids.membership,
      benefitKey: "studio_hours", unit: "minute", granted: 720, redeemed: 0,
      adjusted: 0, expired: 0, available: 720, sequence: 0, expiresAt: periodEnd,
      timeBucketVersion: 1, timeBuckets: [{ key: "current", periodKey: "current", kind: "period", available: 720, expiresAt: periodEnd }],
    } as any);
    cartItems = [{
      product: { _id: String(ids.product), type: "public-workshop", kind: "open-studio" },
      locationId: String(ids.location), start: start.toISOString(), end: end.toISOString(),
      numberOfGuests: 1, plannedActivity: "UNDEFINED", quantity: 1.5,
    }];
  });

  it("quotes and spends the actual visit minutes without money credits or a client quantity; replay does not spend twice", async () => {
    const quote = await checkoutService.quoteCart({ tenantId, user, cartItems });
    expect(quote.paymentOptions).toContainEqual(expect.objectContaining({
      method: "membership_credits", benefitKey: "studio_hours", required: 90, available: 720, coversTotal: true,
    }));
    expect(quote.paymentOptions.some((option) => option.method === "money_credits")).toBe(false);
    const first = await checkout();
    const replay = await checkout();
    expect(first).toMatchObject({ success: true, status: "confirmed", membershipRedemption: { benefitKey: "studio_hours", quantity: 90 } });
    expect(String(replay.orderId)).toBe(String(first.orderId));
    expect((await Balance.findOne({ membership: ids.membership }))?.available).toBe(630);
    expect(await Ledger.countDocuments({ membership: ids.membership, type: "redemption" })).toBe(1);
    expect(await Booking.countDocuments({ tenant: ids.tenant })).toBe(1);
    expect(await Order.countDocuments({ tenant: ids.tenant, isPaid: true })).toBe(1);
    expect((await User.findById(ids.member))?.moneyCreditsMinor).toBe(12300);
    const order = await Order.findById(first.orderId).lean();
    expect(order?.paymentAllocations[0]).toMatchObject({ method: "membership_credit" });
    expect(order?.credits?.appliedMajor).toBe(0);
    expect(order?.expectedAmountMinor).toBe(0);
  });

  it("derives the debit from the visit even when a caller supplies a smaller membership quantity", async () => {
    const result = await checkout({ membershipQuantity: 1 });
    expect(result.membershipRedemption.quantity).toBe(90);
    expect((await Balance.findOne({ membership: ids.membership }))?.available).toBe(630);
  });

  it("rechecks the balance at payment and rolls back booking, cart and order when the quoted hours were spent elsewhere", async () => {
    expect((await checkoutService.quoteCart({ tenantId, user, cartItems })).paymentOptions)
      .toContainEqual(expect.objectContaining({ method: "membership_credits", coversTotal: true }));
    await Balance.updateOne({ membership: ids.membership }, { $set: { available: 30, "timeBuckets.0.available": 30 } });
    await expect(checkout()).rejects.toMatchObject({ code: "MEMBERSHIP_ENTITLEMENT_INSUFFICIENT" });
    expect(await Booking.countDocuments({ tenant: ids.tenant })).toBe(0);
    expect(await Cart.countDocuments({ tenant: ids.tenant })).toBe(0);
    expect(await Order.countDocuments({ tenant: ids.tenant })).toBe(0);
    expect(await Ledger.countDocuments({ membership: ids.membership })).toBe(0);
    expect((await Balance.findOne({ membership: ids.membership }))?.available).toBe(30);
    expect((await User.findById(ids.member))?.moneyCreditsMinor).toBe(12300);
  });
});
