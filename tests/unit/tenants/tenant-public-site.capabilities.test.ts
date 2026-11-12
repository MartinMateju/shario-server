import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  productExists: vi.fn(),
  membershipFind: vi.fn(),
  membershipVersionExists: vi.fn(),
  knowledgeExists: vi.fn(),
  getTenantSubscriptionAccess: vi.fn(),
  findTenantPaymentAccountByTenant: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { warn: mocks.loggerWarn },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: { exists: mocks.productExists },
}));
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  default: { find: mocks.membershipFind },
}));
vi.mock("@/modules/membership/membership-plan-version.model.js", () => ({
  default: { exists: mocks.membershipVersionExists },
}));
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationKnowledgeArticleModel: {
    exists: mocks.knowledgeExists,
  },
}));
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);
vi.mock(
  "@/modules/tenant-payments/tenant-payment-account.repository.js",
  () => ({
    findTenantPaymentAccountByTenant: mocks.findTenantPaymentAccountByTenant,
  }),
);

import { derivePublicTenantCapabilities } from "@/modules/tenants/public-site/tenant-public-site.capabilities.js";

const tenant = (modules: Record<string, boolean>) =>
  ({
    _id: "507f1f77bcf86cd799439011",
    modules,
  }) as any;

describe("public tenant capability derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantSubscriptionAccess.mockResolvedValue({
      access: { canUseFeatures: true },
    });
    mocks.findTenantPaymentAccountByTenant.mockResolvedValue({
      stripeAccountId: "acct_ready",
      onboardingStatus: "complete",
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    mocks.membershipFind.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: () =>
            Promise.resolve([
              {
                _id: "membership",
                currentPublishedVersion: "membership-version",
              },
            ]),
        }),
      }),
    });
    mocks.membershipVersionExists.mockResolvedValue({
      _id: "membership-version",
    });
  });

  it("requires module entitlements and matching public content", async () => {
    mocks.productExists
      .mockResolvedValueOnce({ _id: "bookable" })
      .mockResolvedValueOnce({ _id: "course" })
      .mockResolvedValueOnce({ _id: "voucher" });
    mocks.knowledgeExists.mockResolvedValueOnce({ _id: "article" });
    const now = new Date("2026-07-29T08:00:00.000Z");

    await expect(
      derivePublicTenantCapabilities(
        tenant({
          bookings: true,
          courses: true,
          memberships: true,
          vouchers: true,
          communications: true,
          payments: true,
        }),
        now,
      ),
    ).resolves.toEqual({
      bookStudio: true,
      courses: true,
      memberships: true,
      vouchers: true,
      help: true,
      guestCourseCheckout: false,
      registration: true,
    });

    expect(mocks.productExists).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenant: "507f1f77bcf86cd799439011",
        isActive: true,
        maxNumberOfParticipants: { $ne: null },
        type: {
          $in: ["workshop", "service", "public-workshop"],
        },
      }),
    );
    expect(mocks.productExists).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tenant: "507f1f77bcf86cd799439011",
        isActive: true,
        maxNumberOfParticipants: { $ne: null },
        type: {
          $in: ["course", "public-course"],
        },
      }),
    );
    expect(mocks.productExists).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        tenant: "507f1f77bcf86cd799439011",
        type: "coupon",
        isActive: true,
        "voucherSettings.type": { $ne: "experience" },
        $or: [
          {
            voucherTemplate: {
              $exists: true,
              $type: "string",
              $regex: /\S/,
            },
          },
          { "voucherDesign.version": 1, "voucherDesign.layout": "split" },
        ],
        price: { $gt: 0 },
      }),
    );
    expect(mocks.membershipFind).toHaveBeenCalledWith({
      tenant: "507f1f77bcf86cd799439011",
      status: "published",
      currentPublishedVersion: { $ne: null },
    });
    expect(mocks.membershipVersionExists).toHaveBeenCalledWith({
      tenant: "507f1f77bcf86cd799439011",
      status: "published",
      $or: [
        {
          _id: "membership-version",
          plan: "membership",
        },
      ],
    });
    expect(mocks.knowledgeExists).toHaveBeenCalledWith({
      tenantId: "507f1f77bcf86cd799439011",
      audience: "public",
      status: "published",
      deletedAt: null,
      $and: [
        {
          $or: [
            { effectiveFrom: null },
            { effectiveFrom: { $exists: false } },
            { effectiveFrom: { $lte: now } },
          ],
        },
        {
          $or: [
            { effectiveUntil: null },
            { effectiveUntil: { $exists: false } },
            { effectiveUntil: { $gt: now } },
          ],
        },
      ],
    });
  });

  it("exposes vouchers only for a purchasable active public product", async () => {
    mocks.productExists.mockResolvedValueOnce({ _id: "voucher" });

    await expect(
      derivePublicTenantCapabilities(
        tenant({ vouchers: true, payments: true }),
      ),
    ).resolves.toMatchObject({ vouchers: true });

    expect(mocks.productExists).toHaveBeenCalledOnce();
    expect(mocks.findTenantPaymentAccountByTenant).toHaveBeenCalledWith(
      "507f1f77bcf86cd799439011",
    );
    expect(mocks.productExists).toHaveBeenCalledWith({
      tenant: "507f1f77bcf86cd799439011",
      type: "coupon",
      isActive: true,
      "voucherSettings.type": { $ne: "experience" },
      $or: [
        {
          voucherTemplate: {
            $exists: true,
            $type: "string",
            $regex: /\S/,
          },
        },
        { "voucherDesign.version": 1, "voucherDesign.layout": "split" },
      ],
      price: { $gt: 0 },
    });
  });

  it.each<Record<string, boolean>>([
    { memberships: true, payments: false },
    { memberships: true },
    { memberships: false, payments: true },
  ])(
    "hides memberships when the catalog's required modules are unavailable: %o",
    async (modules) => {
      await expect(
        derivePublicTenantCapabilities(tenant(modules)),
      ).resolves.toMatchObject({ memberships: false });
      expect(mocks.membershipFind).not.toHaveBeenCalled();
    },
  );

  it.each(["expired", "canceled", "payment_overdue"])(
    "hides published memberships when subscription access is %s",
    async (reason) => {
      mocks.getTenantSubscriptionAccess.mockResolvedValue({
        access: { canUseFeatures: false, reason },
      });
      await expect(
        derivePublicTenantCapabilities(
          tenant({ memberships: true, payments: true }),
        ),
      ).resolves.toMatchObject({ memberships: false });
    },
  );

  it("hides memberships when subscription lookup fails", async () => {
    mocks.getTenantSubscriptionAccess.mockRejectedValue(
      new Error("unavailable"),
    );
    await expect(
      derivePublicTenantCapabilities(
        tenant({ memberships: true, payments: true }),
      ),
    ).resolves.toMatchObject({ memberships: false });
  });

  it.each<Record<string, boolean>>([
    { courses: true, payments: false },
    { courses: false, payments: true },
    { courses: true },
  ])(
    "does not advertise courses when a required catalog module is disabled: %o",
    async (modules) => {
      await expect(
        derivePublicTenantCapabilities(tenant(modules)),
      ).resolves.toMatchObject({ courses: false, guestCourseCheckout: false });
      expect(mocks.productExists).not.toHaveBeenCalled();
    },
  );

  it("counts only active non-archived courses when exposing anonymous browsing", async () => {
    mocks.productExists.mockResolvedValueOnce({ _id: "course" });
    await expect(
      derivePublicTenantCapabilities(tenant({ courses: true, payments: true })),
    ).resolves.toMatchObject({ courses: true, guestCourseCheckout: false });
    expect(mocks.productExists).toHaveBeenCalledWith({
      tenant: "507f1f77bcf86cd799439011",
      isActive: true,
      isArchived: { $ne: true },
      maxNumberOfParticipants: { $ne: null },
      type: { $in: ["course", "public-course"] },
    });
  });

  it.each([
    { pages: { courses: { visible: false } } },
    { customerPortal: { pages: { courses: { enabled: false } } } },
  ])(
    "uses published course page visibility and keeps draft previews isolated: %o",
    async (hidden) => {
      const workspace = {
        ...tenant({ courses: true, payments: true }),
        publicSite: {},
        publicSiteEditor: { published: hidden, draft: {} },
      };
      await expect(
        derivePublicTenantCapabilities(workspace),
      ).resolves.toMatchObject({ courses: false });
      expect(mocks.productExists).not.toHaveBeenCalled();
      mocks.productExists.mockResolvedValueOnce({ _id: "course" });
      await expect(
        derivePublicTenantCapabilities(workspace, undefined, {
          snapshot: "draft",
        }),
      ).resolves.toMatchObject({ courses: true, guestCourseCheckout: false });
    },
  );

  it("hides vouchers when no purchasable active product exists", async () => {
    mocks.productExists.mockResolvedValueOnce(null);

    await expect(
      derivePublicTenantCapabilities(
        tenant({ vouchers: true, payments: true }),
      ),
    ).resolves.toMatchObject({ vouchers: false });
  });

  it("does not query or expose vouchers when payments or vouchers are disabled", async () => {
    await expect(
      derivePublicTenantCapabilities(tenant({ vouchers: true })),
    ).resolves.toMatchObject({ vouchers: false });
    await expect(
      derivePublicTenantCapabilities(tenant({ payments: true })),
    ).resolves.toMatchObject({ vouchers: false });

    expect(mocks.productExists).not.toHaveBeenCalled();
    expect(mocks.findTenantPaymentAccountByTenant).not.toHaveBeenCalled();
  });

  it("fails an unavailable voucher lookup closed", async () => {
    mocks.productExists.mockRejectedValueOnce(
      new Error("vouchers unavailable"),
    );

    await expect(
      derivePublicTenantCapabilities(
        tenant({ vouchers: true, payments: true }),
      ),
    ).resolves.toMatchObject({ vouchers: false });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "vouchers" }),
      expect.any(String),
    );
  });

  it("hides vouchers when online payments are not checkout-ready", async () => {
    mocks.productExists.mockResolvedValueOnce({ _id: "voucher" });
    mocks.findTenantPaymentAccountByTenant.mockRejectedValueOnce(
      new Error("payments not ready"),
    );

    await expect(
      derivePublicTenantCapabilities(
        tenant({ vouchers: true, payments: true }),
      ),
    ).resolves.toMatchObject({ vouchers: false });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "checkoutPayments" }),
      expect.any(String),
    );
  });

  it("hides vouchers when the stored payment snapshot is not ready", async () => {
    mocks.productExists.mockResolvedValueOnce({ _id: "voucher" });
    mocks.findTenantPaymentAccountByTenant.mockResolvedValueOnce({
      stripeAccountId: "acct_incomplete",
      onboardingStatus: "complete",
      detailsSubmitted: true,
      chargesEnabled: false,
      payoutsEnabled: true,
    });

    await expect(
      derivePublicTenantCapabilities(
        tenant({ vouchers: true, payments: true }),
      ),
    ).resolves.toMatchObject({ vouchers: false });
  });

  it("exposes help from effective public knowledge without communications", async () => {
    mocks.knowledgeExists.mockResolvedValueOnce({ _id: "article" });

    await expect(
      derivePublicTenantCapabilities(tenant({ communications: false })),
    ).resolves.toMatchObject({ help: true });

    expect(mocks.knowledgeExists).toHaveBeenCalledOnce();
  });

  it("hides help when no effective published public article exists", async () => {
    mocks.knowledgeExists.mockResolvedValueOnce(null);

    await expect(
      derivePublicTenantCapabilities(tenant({ communications: true })),
    ).resolves.toMatchObject({ help: false });
  });

  it("fails individual content lookup errors closed", async () => {
    mocks.productExists
      .mockRejectedValueOnce(new Error("products unavailable"))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("vouchers unavailable"));
    mocks.membershipFind.mockReturnValueOnce({
      select: () => ({
        lean: () => ({
          exec: () => Promise.reject(new Error("memberships unavailable")),
        }),
      }),
    });
    mocks.knowledgeExists.mockRejectedValueOnce(
      new Error("knowledge unavailable"),
    );

    await expect(
      derivePublicTenantCapabilities(
        tenant({
          bookings: true,
          courses: true,
          memberships: true,
          vouchers: true,
          communications: true,
          payments: true,
        }),
      ),
    ).resolves.toEqual({
      bookStudio: false,
      courses: false,
      memberships: false,
      vouchers: false,
      help: false,
      guestCourseCheckout: false,
      registration: true,
    });
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });

  it("skips module-backed data for disabled modules but still checks knowledge", async () => {
    await expect(derivePublicTenantCapabilities(tenant({}))).resolves.toEqual({
      bookStudio: false,
      courses: false,
      memberships: false,
      vouchers: false,
      help: false,
      guestCourseCheckout: false,
      registration: true,
    });
    expect(mocks.productExists).not.toHaveBeenCalled();
    expect(mocks.membershipFind).not.toHaveBeenCalled();
    expect(mocks.knowledgeExists).toHaveBeenCalledOnce();
  });

  it("hides subscription-gated catalogs when subscription access is restricted", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce({
      access: { canUseFeatures: false },
    });
    mocks.productExists.mockResolvedValueOnce({ _id: "voucher" });

    await expect(
      derivePublicTenantCapabilities(
        tenant({ vouchers: true, payments: true }),
      ),
    ).resolves.toMatchObject({ vouchers: false });
  });

  it("exposes explicitly published guest checkout only with ready payments and shares the readiness lookup", async () => {
    mocks.productExists.mockResolvedValue({ _id: "available" });
    const workspace = {
      ...tenant({ courses: true, payments: true, vouchers: true }),
      publicSiteEditor: {
        published: {
          customerPortal: { courses: { guestCheckoutEnabled: true } },
        },
      },
    };
    await expect(
      derivePublicTenantCapabilities(workspace),
    ).resolves.toMatchObject({
      courses: true,
      vouchers: true,
      guestCourseCheckout: true,
    });
    expect(
      mocks.findTenantPaymentAccountByTenant,
    ).toHaveBeenCalledExactlyOnceWith(workspace._id);
  });

  it.each([
    { stripeAccountId: "" },
    { onboardingStatus: "pending" },
    { detailsSubmitted: false },
    { chargesEnabled: false },
    { payoutsEnabled: false },
  ])(
    "keeps guest checkout disabled for an incomplete payment snapshot: %o",
    async (unready) => {
      mocks.productExists.mockResolvedValue({ _id: "course" });
      mocks.findTenantPaymentAccountByTenant.mockResolvedValue({
        stripeAccountId: "acct_ready",
        onboardingStatus: "complete",
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        ...unready,
      });
      await expect(
        derivePublicTenantCapabilities({
          ...tenant({ courses: true, payments: true }),
          publicSite: {
            customerPortal: { courses: { guestCheckoutEnabled: true } },
          },
        }),
      ).resolves.toMatchObject({ courses: true, guestCourseCheckout: false });
    },
  );

  it.each(["subscription", "payment", "course"])(
    "fails guest checkout closed when %s lookup fails",
    async (lookup) => {
      mocks.productExists.mockResolvedValue({ _id: "course" });
      if (lookup === "subscription")
        mocks.getTenantSubscriptionAccess.mockRejectedValueOnce(
          new Error("unavailable"),
        );
      if (lookup === "payment")
        mocks.findTenantPaymentAccountByTenant.mockRejectedValueOnce(
          new Error("unavailable"),
        );
      if (lookup === "course")
        mocks.productExists.mockRejectedValueOnce(new Error("unavailable"));
      await expect(
        derivePublicTenantCapabilities({
          ...tenant({ courses: true, payments: true }),
          publicSite: {
            customerPortal: { courses: { guestCheckoutEnabled: true } },
          },
        }),
      ).resolves.toMatchObject({ guestCourseCheckout: false });
    },
  );

  it("does not widen guest checkout from a draft or missing module, subscription or course", async () => {
    mocks.productExists.mockResolvedValue({ _id: "course" });
    const optIn = {
      customerPortal: { courses: { guestCheckoutEnabled: true } },
    };
    await expect(
      derivePublicTenantCapabilities({
        ...tenant({ courses: true, payments: true }),
        publicSiteEditor: { published: {}, draft: optIn },
      }),
    ).resolves.toMatchObject({ courses: true, guestCourseCheckout: false });
    expect(mocks.findTenantPaymentAccountByTenant).not.toHaveBeenCalled();
    for (const modules of [
      { courses: false, payments: true },
      { courses: true, payments: false },
    ]) {
      await expect(
        derivePublicTenantCapabilities({
          ...tenant(modules),
          publicSite: optIn,
        }),
      ).resolves.toMatchObject({ guestCourseCheckout: false });
    }
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce({
      access: { canUseFeatures: false },
    });
    await expect(
      derivePublicTenantCapabilities({
        ...tenant({ courses: true, payments: true }),
        publicSite: optIn,
      }),
    ).resolves.toMatchObject({ guestCourseCheckout: false });
    mocks.productExists.mockResolvedValueOnce(null);
    await expect(
      derivePublicTenantCapabilities({
        ...tenant({ courses: true, payments: true }),
        publicSite: optIn,
      }),
    ).resolves.toMatchObject({ guestCourseCheckout: false });
  });

  it("does not expose booking capabilities from a retired firing entitlement", async () => {
    await expect(
      derivePublicTenantCapabilities(tenant({ firing: true, payments: true })),
    ).resolves.toMatchObject({
      bookStudio: false,
      courses: false,
      vouchers: false,
      guestCourseCheckout: false,
    });
    expect(mocks.productExists).not.toHaveBeenCalled();
  });
});
