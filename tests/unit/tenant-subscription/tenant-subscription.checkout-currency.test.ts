import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pricesList: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  createCheckout: vi.fn(),
  constructStripe: vi.fn(),
  isNewSaleCurrency: vi.fn(),
}));
vi.mock("stripe", () => ({
  default: class {
    constructor() {
      mocks.constructStripe();
    }
    prices = { list: mocks.pricesList };
    customers = { create: mocks.createCustomer, update: mocks.updateCustomer };
    checkout = { sessions: { create: mocks.createCheckout } };
  },
}));
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.sync.service.js",
  () => ({ syncStripeSubscriptionSnapshot: vi.fn() }),
);
vi.mock(
  "@/modules/tenant-subscription/tenant-subscription.commercial.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/tenant-subscription/tenant-subscription.commercial.js")
    >()),
    isNewSaleCurrency: mocks.isNewSaleCurrency,
  }),
);

import {
  createTenantCheckout,
  getSubscriptionPlanCatalog,
} from "@/modules/tenant-subscription/services/tenant-subscription.stripe.service.js";
import { getCommercialPriceSpec } from "@/modules/tenant-subscription/tenant-subscription.commercial.js";
import {
  buildStripePriceCreateParams,
  buildStripeProductMetadata,
} from "@/modules/tenant-subscription/tenant-subscription.stripe-contract.js";
import type { TenantSubscriptionDocument } from "@/modules/tenant-subscription/tenant-subscription.types.js";

const subscription = (billingCurrency?: "PLN" | "EUR") =>
  ({
    _id: "sub-local",
    tenant: "tenant-test",
    status: "expired",
    stripe: {},
    billingCurrency,
    save: vi.fn().mockResolvedValue(undefined),
  }) as unknown as TenantSubscriptionDocument;
const input = () => ({
  tenantId: "tenant-test",
  tenantName: "Test",
  tenantSlug: "test",
  ownerEmail: "owner@example.com",
  subscription: subscription(),
  plan: "starter" as const,
  billingInterval: "monthly" as const,
  locale: "en",
});

describe("tenant checkout currency selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_KEY", "sk_test_fixture");
    vi.stubEnv("STRIPE_TENANT_BILLING_MODE", "test");
    vi.stubEnv("CLIENT_URL", "https://shario.example.com");
    mocks.isNewSaleCurrency.mockImplementation((currency: string) =>
      ["EUR", "CZK"].includes(currency),
    );
    const spec = getCommercialPriceSpec("starter", "monthly", 3)!;
    const price = {
      ...buildStripePriceCreateParams(spec, "prod-test"),
      id: "price-test",
      livemode: false,
      type: "recurring",
      billing_scheme: "per_unit",
      product: {
        id: "prod-test",
        active: true,
        livemode: false,
        name: `shario.io ${spec.displayName}`,
        metadata: buildStripeProductMetadata(spec),
      },
    } as unknown as Stripe.Price;
    mocks.pricesList.mockResolvedValue({ data: [price] });
    mocks.createCustomer.mockResolvedValue({ id: "cus-test" });
    mocks.createCheckout.mockResolvedValue({
      url: "https://checkout.stripe.com/test",
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("preserves an unpriced saved PLN selection and fails before contacting Stripe", async () => {
    await expect(
      createTenantCheckout({ ...input(), subscription: subscription("PLN") }),
    ).rejects.toThrow(/not configured for PLN/);
    expect(mocks.constructStripe).not.toHaveBeenCalled();
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });

  it("uses USD for an unspecified currency without substituting a priced EUR amount", async () => {
    await expect(createTenantCheckout(input())).rejects.toThrow(
      /not configured for USD/,
    );
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });

  it("uses a saved EUR billing preference and the validated backend price", async () => {
    await createTenantCheckout({
      ...input(),
      subscription: subscription("EUR"),
    });
    expect(mocks.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: "eur",
        line_items: [{ price: "price-test", quantity: 1 }],
      }),
      expect.objectContaining({
        apiVersion: "2025-03-31.basil",
        idempotencyKey: expect.stringContaining("managed-payments-basil"),
      }),
    );
  });

  it("allows an elapsed local trial before reconciliation and binds Checkout to the workspace without extending the trial", async () => {
    const local = subscription("EUR");
    local.status = "trialing";
    local.trialEndsAt = new Date(Date.now() - 1000);
    await createTenantCheckout({ ...input(), subscription: local });
    const payload = mocks.createCheckout.mock.calls[0][0];
    expect(payload.client_reference_id).toBe("tenant-test");
    expect(payload.metadata.tenantId).toBe("tenant-test");
    expect(payload.subscription_data.metadata.tenantId).toBe("tenant-test");
    expect(payload.subscription_data).not.toHaveProperty("trial_end");
  });

  it("still refuses an early charge during the remaining final trial hours", async () => {
    const local = subscription("EUR");
    local.status = "trialing";
    local.trialEndsAt = new Date(Date.now() + 60 * 60 * 1000);
    await expect(
      createTenantCheckout({ ...input(), subscription: local }),
    ).rejects.toThrow(/final 48 hours/);
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });

  it("does not start a paid replacement when legacy billing chronology cannot safely authorize its activation", async () => {
    const local = subscription("EUR");
    local.stripe.subscriptionId = "sub_legacy";
    await expect(
      createTenantCheckout({ ...input(), subscription: local }),
    ).rejects.toThrow(/billing history must be reconciled/);
    expect(mocks.pricesList).not.toHaveBeenCalled();
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });

  it("reuses retries for one subscription generation but starts a fresh Checkout after its replacement ends", async () => {
    const local = subscription("EUR");
    local.stripe = {
      customerId: "cus-test",
      subscriptionId: "sub_first",
      subscriptionCreatedAt: 1700000000,
    };
    await createTenantCheckout({ ...input(), subscription: local });
    await createTenantCheckout({ ...input(), subscription: local });
    local.stripe.subscriptionId = "sub_replacement";
    await createTenantCheckout({ ...input(), subscription: local });
    const keys = mocks.createCheckout.mock.calls.map(
      ([, options]) => options.idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain(":sub_first:");
    expect(keys[2]).toContain(":sub_replacement:");
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("does not advertise a provider currency while another required plan price is unavailable", async () => {
    mocks.isNewSaleCurrency.mockImplementation(
      (currency: string) => currency === "CZK",
    );
    const catalog = await getSubscriptionPlanCatalog();
    const starter = catalog.find(({ id }) => id === "starter")!;
    expect(starter.prices.monthly.configured).toBe(true);
    expect(starter.prices.monthly.currencyOptions).toHaveProperty("CZK");
    expect(starter.prices.monthly.currencyOptions).not.toHaveProperty("EUR");
  });
});
