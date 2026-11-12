import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(), layout: vi.fn(), memberships: vi.fn(), sender: vi.fn(),
  sendEmail: vi.fn(), accessUrl: vi.fn(),
}));

vi.mock("@/modules/tenants/tenant.model.js", () => ({ default: { findOne: mocks.tenant } }));
vi.mock("@/modules/email-template/email-template.model.js", () => ({ EmailTemplate: { findOne: mocks.layout } }));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({ default: { find: mocks.memberships } }));
vi.mock("@/modules/registered-sender-email/registered-sender-email.model.js", () => ({ RegisteredSenderEmailModel: { findOne: mocks.sender } }));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({ sendManagedTenantEmail: mocks.sendEmail }));
vi.mock("@/modules/coupon/voucher-order-access.js", () => ({ buildVoucherPurchaseAccessUrl: mocks.accessUrl }));

import { couponEmailService } from "@/modules/coupon/coupon-email.service.js";
import { resolveCouponEmailContext } from "@/modules/coupon/coupon-email-context.js";

const tenantId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const otherTenantId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const order = {
  _id: "cccccccccccccccccccccccc", tenant: tenantId,
  email: "buyer@example.test", quantity: 1, sendPost: false,
  firstname: "Ada", lastname: "Nová", productNameSnapshot: "Clay Play",
} as any;

const query = (result: unknown) => {
  const value: any = {};
  for (const method of ["select", "sort", "populate", "lean"]) {
    value[method] = vi.fn(() => value);
  }
  value.exec = vi.fn(async () => result);
  return value;
};

const member = (overrides: Record<string, unknown> = {}) => ({
  tenant: tenantId, status: "active", role: "owner",
  preferences: { notifications: { email: true }, language: "en" },
  user: { email: "owner@example.test", isEmailVerified: true, isAccessGranted: true },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CLIENT_URL", "http://shario.localhost:3000");
  mocks.tenant.mockReturnValue(query({
    _id: tenantId, slug: "current-studio", name: "Atelier Example", settings: { publicDefaultLanguage: "en", adminLanguage: "en" },
    publicSite: { branding: {}, footer: {} },
  }));
  mocks.layout.mockReturnValue(query(null));
  mocks.memberships.mockReturnValue(query([member()]));
  mocks.sender.mockReturnValue(query(null));
  mocks.sendEmail.mockResolvedValue({ messageId: "sent" });
  mocks.accessUrl.mockReturnValue(undefined);
});

describe("voucher email tenant isolation and customization", () => {
  it("includes the digital PDF backup and full destination for a postal purchase", async () => {
    const attachments = [{ filename: "gift.pdf", content: Buffer.from("PDF") }];
    const postalOrder = {
      ...order, sendPost: true, street: "<Main> 12", city: "Brno", postalCode: "602 00", countryCode: "CZ",
    };
    const mail = await couponEmailService.prepareCustomerCouponOrderEmail({ order: postalOrder, attachments });
    expect(mail.attachments).toBe(attachments);
    expect(mail.html).toContain("Keep the digital voucher as a backup");
    expect(mail.html).toContain("same code");
    expect(mail.html).toContain("&lt;Main&gt; 12");
    expect(mail.html).toContain("CZ");
    const admin = await couponEmailService.prepareAdminCouponOrderEmail({
      order: postalOrder, product: { name: "Gift" }, promoCodes: ["GIFT-CODE"], templateKey: "",
    });
    expect(admin?.html).toContain("CZ");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
  it("prepares mail without sending and includes an escaped gift message and secure recovery link", async () => {
    mocks.accessUrl.mockReturnValue("https://studio.shario.io/en/vouchers/success?couponOrderId=123#accessToken=proof");
    const mail = await couponEmailService.prepareCustomerCouponOrderEmail({
      order: { ...order, giftMessageSnapshot: "<b>For Emilka</b>\nWith love", purchaseOriginSnapshot: "https://retired-domain.example" }, attachments: [],
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mail.html).toContain("&lt;b&gt;For Emilka&lt;/b&gt;<br>With love");
    expect(mail.html).toContain("Download your gift vouchers");
    expect(mail.html).toContain("#accessToken=proof");
    expect(mail.text).toContain("https://studio.shario.io/en/vouchers/success?couponOrderId=123#accessToken=proof");
    expect(mocks.accessUrl.mock.calls[0][0].purchaseOriginSnapshot).toBe("http://current-studio.localhost:3000");
  });

  it("omits recovery links if the current tenant has no valid canonical hostname", async () => {
    mocks.tenant.mockReturnValue(query({ _id: tenantId, slug: "invalid/slug", name: "Example" }));
    const attachments = [{ filename: "gift.pdf", content: Buffer.from("PDF") }];
    const mail = await couponEmailService.prepareCustomerCouponOrderEmail({ order: { ...order, purchaseOriginSnapshot: "https://retired-domain.example" }, attachments });
    expect(mocks.accessUrl).not.toHaveBeenCalled();
    expect(mail.html).not.toContain("retired-domain.example");
    expect(mail.attachments).toBe(attachments);
  });

  it.each(["en", "cs"])("uses a secure link instead of oversized attachments in %s", async locale => {
    mocks.tenant.mockReturnValue(query({ _id: tenantId, slug: "current-studio", name: "Example", settings: { publicDefaultLanguage: locale } }));
    mocks.accessUrl.mockReturnValue("https://studio.shario.io/en/vouchers/success?couponOrderId=123#accessToken=proof");
    const mail = await couponEmailService.prepareCustomerCouponOrderEmail({
      order, attachments: [{ filename: "large.pdf", content: Buffer.alloc(6 * 1024 * 1024 + 1) }],
    });
    expect(mail.attachments).toEqual([]);
    expect(mail.html).toContain(locale === "cs" ? "zabezpečeného odkazu" : "secure download link");
    expect(mail.html).not.toContain(locale === "cs" ? "najdete v příloze" : "vouchers are attached");
    expect(mail.text).toContain("https://studio.shario.io/en/vouchers/success?couponOrderId=123#accessToken=proof");
  });

  it("fails preparation when historical oversized PDFs have no valid secure download link", async () => {
    await expect(couponEmailService.prepareCustomerCouponOrderEmail({ order, attachments: [{ filename: "large.pdf", content: Buffer.alloc(7 * 1024 * 1024) }] }))
      .rejects.toMatchObject({ code: "VOUCHER_DELIVERY_ATTACHMENT_LIMIT" });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("uses published branding, a tenant layout, and the verified infrastructure sender", async () => {
    mocks.tenant.mockReturnValue(query({
      _id: tenantId, name: "Stored name", settings: { publicDefaultLanguage: "cs" },
      publicSite: { branding: { displayName: "Legacy name" } },
      publicSiteEditor: {
        draft: { branding: { displayName: "Unpublished name" } },
        published: { branding: { displayName: "Atelier Klei", backgroundColor: "#fafafa" } },
      },
    }));
    mocks.layout.mockReturnValue(query({
      tenant: tenantId, category: "layout", isDefault: true, isActive: true,
      headerHtml: "<h2>{{studioName}}</h2>", footerHtml: "<p>Made by {{studioName}}</p>",
      primaryColor: "#ee4433",
    }));
    mocks.sender.mockReturnValue(query({
      tenant: tenantId, provider: "postmark_managed", isActive: true,
      replyToEmail: "help@atelier.example", replyToVerifiedAt: new Date(),
    }));
    const attachments = [{ filename: "gift.pdf", content: Buffer.from("PDF") }];
    await couponEmailService.sendCustomerCouponOrderEmail({ order, attachments });
    const sent = mocks.sendEmail.mock.calls[0][0];
    expect(sent.tenantId).toBe(tenantId);
    expect(sent.orderId).toBe(String(order._id));
    expect(sent.from).toBeUndefined();
    expect(sent.to).toBe(order.email);
    expect(sent.replyTo).toBeUndefined(); // Resolved by the managed sender, not template context.
    expect(sent.subject).toContain("Atelier Klei | Dárkový poukaz");
    expect(sent.html).toContain("<h2>Atelier Klei</h2>");
    expect(sent.html).toContain("Made by Atelier Klei");
    expect(sent.html).not.toContain("Unpublished name");
    expect(sent.attachments).toBe(attachments);
    expect(mocks.layout.mock.calls[0][0]).toMatchObject({ tenant: tenantId, category: "layout", isActive: true });
    expect(mocks.sender.mock.calls[0][0]).toMatchObject({ tenant: tenantId, replyToVerifiedAt: { $ne: null } });
  });

  it("scopes notification membership queries and prioritizes verified opted-in owners", async () => {
    const memberships = query([
      member({ role: "admin", user: { email: "admin@example.test", isEmailVerified: true } }),
      member({ tenant: otherTenantId, user: { email: "foreign@example.test", isEmailVerified: true } }),
      member(),
    ]);
    mocks.memberships.mockReturnValue(memberships);
    const sent = await couponEmailService.sendAdminCouponOrderEmail({
      order, product: { name: "Updated name" }, promoCodes: [], templateKey: "voucher.pdf",
    });
    expect(sent).toBe(true);
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe("owner@example.test");
    expect(mocks.sendEmail.mock.calls[0][0].html).toContain("Clay Play");
    expect(mocks.memberships.mock.calls[0][0]).toMatchObject({
      tenant: tenantId, status: "active", role: { $in: ["owner", "admin"] },
      "preferences.notifications.email": { $ne: false },
    });
    expect(memberships.populate).toHaveBeenCalledWith(expect.objectContaining({
      match: { isEmailVerified: true, isAccessGranted: { $ne: false } },
    }));
  });

  it("skips admin notifications without eligible recipients and still delivers the customer voucher", async () => {
    vi.stubEnv("ADMIN_EMAIL", "global-admin@shario.io");
    mocks.memberships.mockReturnValue(query([
      member({ preferences: { notifications: { email: false } } }),
      member({ status: "revoked" }),
      member({ user: { email: "unverified@example.test", isEmailVerified: false } }),
      member({ tenant: otherTenantId }),
    ]));
    expect(await couponEmailService.sendAdminCouponOrderEmail({
      order, product: {}, promoCodes: [], templateKey: "voucher.pdf",
    })).toBe(false);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    await couponEmailService.sendCustomerCouponOrderEmail({ order, attachments: [] });
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe(order.email);
    expect(mocks.sendEmail.mock.calls[0][0].replyTo).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("ignores other tenants' templates and unverified reply addresses", async () => {
    mocks.layout.mockReturnValue(query({ tenant: otherTenantId, category: "layout", isDefault: true, isActive: true, headerHtml: "<h1>Foreign studio</h1>" }));
    mocks.sender.mockReturnValue(query({ tenant: tenantId, provider: "postmark_managed", isActive: true, replyToEmail: "unverified@example.test", replyToVerifiedAt: null }));
    await couponEmailService.sendCustomerCouponOrderEmail({ order, attachments: [] });
    expect(mocks.sendEmail.mock.calls[0][0].html).not.toContain("Foreign studio");
    expect(mocks.sendEmail.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("does not accept another tenant's verified sender", async () => {
    mocks.sender.mockReturnValue(query({ tenant: otherTenantId, provider: "postmark_managed", isActive: true, replyToEmail: "foreign@example.test", replyToVerifiedAt: new Date() }));
    expect((await resolveCouponEmailContext(order)).replyTo).toBe("owner@example.test");
  });

  it("escapes customer names, notes and addresses, and sanitizes tenant HTML", async () => {
    const unsafeOrder = { ...order, sendPost: true, firstname: '<img src=x onerror="alert(1)">', note: "<script>alert(2)</script>", street: "<b>Bad street</b>" };
    mocks.layout.mockReturnValue(query({ tenant: tenantId, category: "layout", isDefault: true, isActive: true, headerHtml: "<script>alert(3)</script><p>{{firstName}}</p>" }));
    await couponEmailService.sendAdminCouponOrderEmail({ order: unsafeOrder, product: {}, promoCodes: ["ABC123"], templateKey: "gift.pdf" });
    await couponEmailService.sendCustomerCouponOrderEmail({ order: unsafeOrder, attachments: [] });
    for (const [email] of mocks.sendEmail.mock.calls) {
      expect(email.html).not.toContain("<script>");
      expect(email.html).not.toContain("<img src=x");
      expect(email.html).toContain("&lt;img");
      expect(email.html).toContain("&lt;b&gt;Bad street&lt;/b&gt;");
      expect(email.text).toBeTruthy();
    }
  });

  it("uses a shario.io default layout and English fallback for unsupported content locales", async () => {
    mocks.tenant.mockReturnValue(query({ _id: tenantId, name: "", settings: { publicDefaultLanguage: "de" }, publicSite: { branding: {} } }));
    await couponEmailService.sendCustomerCouponOrderEmail({ order, attachments: [] });
    const sent = mocks.sendEmail.mock.calls[0][0];
    expect(sent.subject).toContain("shario.io | Gift voucher");
    expect(sent.html).toContain("Your gift vouchers are attached");
    expect(sent.html).not.toContain("Dobrý den");
  });

  it("falls back when a historical custom layout has invalid variables or unsafe styling", async () => {
    mocks.tenant.mockReturnValue(query({ _id: tenantId, name: "Example", publicSite: { branding: { logoUrl: "javascript:alert(1)", backgroundColor: '#ffffff;display:none', accentColor: "invalid" } } }));
    mocks.layout.mockReturnValue(query({ tenant: tenantId, category: "layout", isDefault: true, isActive: true, headerHtml: "<h1>{{unsupportedVariable}}</h1>" }));
    await couponEmailService.sendCustomerCouponOrderEmail({ order, attachments: [] });
    const sent = mocks.sendEmail.mock.calls[0][0];
    expect(sent.html).toContain("Example");
    expect(sent.html).not.toContain("javascript:");
    expect(sent.html).not.toContain("display:none");
    expect(sent.html).not.toContain("unsupportedVariable");
  });

  it("rejects missing or unknown tenant context instead of sending a global fallback email", async () => {
    await expect(couponEmailService.sendCustomerCouponOrderEmail({ order: { ...order, tenant: undefined }, attachments: [] })).rejects.toThrow("requires the order's tenant");
    mocks.tenant.mockReturnValue(query(null));
    await expect(couponEmailService.sendCustomerCouponOrderEmail({ order, attachments: [] })).rejects.toThrow("tenant was not found");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "Voucher valid until: 16 September 2027"],
    ["cs", "Platnost poukazu do: 16. září 2027"],
  ])("states the actual issued expiry in the purchased timezone and %s locale", async (locale, label) => {
    mocks.tenant.mockReturnValue(query({
      _id: tenantId, name: "Example", settings: { publicDefaultLanguage: "en", timezone: "America/New_York" },
    }));
    const issuedOrder = {
      ...order, localeSnapshot: locale, validityTimezoneSnapshot: "Europe/Prague",
      expiresAtSnapshot: new Date("2027-09-15T22:30:00Z"),
      voucherSettingsSnapshot: { validity: { mode: "months", months: 12 } },
    };
    await couponEmailService.sendCustomerCouponOrderEmail({ order: issuedOrder, attachments: [] });
    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.html).toContain(label);
    expect(email.text).toContain(label);
    expect(email.html).toContain("(Europe/Prague)");
    expect(email.html).not.toContain("15 September 2027");
    expect(email.html).not.toContain("America/New_York");
  });

  it("states perpetual validity only when the issued policy explicitly has no expiry", async () => {
    await couponEmailService.sendCustomerCouponOrderEmail({
      order: { ...order, expiresAtSnapshot: null, voucherSettingsSnapshot: { validity: { mode: "none" } } }, attachments: [],
    });
    expect(mocks.sendEmail.mock.calls[0][0].html).toContain("This voucher has no expiration date.");
    await couponEmailService.sendCustomerCouponOrderEmail({
      order: { ...order, localeSnapshot: "cs", expiresAtSnapshot: null, voucherSettingsSnapshot: { validity: { mode: "none" } } }, attachments: [],
    });
    expect(mocks.sendEmail.mock.calls[1][0].html).toContain("Poukaz nemá datum expirace.");
    await couponEmailService.sendCustomerCouponOrderEmail({ order, attachments: [] });
    expect(mocks.sendEmail.mock.calls[2][0].html).not.toContain("expiration date");
    expect(mocks.sendEmail.mock.calls[2][0].html).not.toContain("Voucher valid until");
  });

  it("shows expiry in admin notifications and uses safe branding/timezone fallbacks", async () => {
    mocks.tenant.mockReturnValue(query({
      _id: tenantId, name: '<script>foreign()</script>', settings: { timezone: "invalid/timezone" },
      publicSite: { branding: { textColor: "red;display:none", backgroundColor: '" onclick="bad()' } },
    }));
    await couponEmailService.sendAdminCouponOrderEmail({
      order: { ...order, expiresAtSnapshot: new Date("2027-09-15T23:59:59.999Z"), validityTimezoneSnapshot: "bad/timezone" },
      product: {}, promoCodes: [], templateKey: "example.pdf",
    });
    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.html).toContain("Voucher valid until: 15 September 2027");
    expect(email.html).toContain("(UTC)");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("display:none");
    expect(email.html).not.toContain("onclick=");
    expect(email.tenantId).toBe(tenantId);
    expect(email.from).toBeUndefined();
  });
});

afterEach(() => vi.unstubAllEnvs());
