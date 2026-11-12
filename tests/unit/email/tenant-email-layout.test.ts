import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ layout: vi.fn(), tenant: vi.fn() }));
vi.mock("@/modules/email-template/email-template.model.js", () => ({
  EmailTemplate: { findOne: mocks.layout },
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findOne: mocks.tenant },
}));
import {
  applyTenantEmailLayout,
  renderTenantEmailFrame,
} from "@/infrastructure/email/tenant-email-layout.service.js";

const query = (value: unknown) => {
  const q: any = { exec: vi.fn().mockResolvedValue(value) };
  for (const method of ["select", "sort", "lean"]) q[method] = vi.fn(() => q);
  return q;
};
const input = {
  tenantId: "studio-a",
  brandName: "Atelier <Klei>",
  replyTo: "info@example.test",
  text: "Door code: <1234>\nPrivate link: https://example.test/?token=test",
};
const layout = {
  tenant: "studio-a",
  category: "layout",
  isDefault: true,
  isActive: true,
  headerHtml:
    '<p style="color:#3367D6">{{studioName}}</p><script>bad()</script>',
  footerHtml: "<p>Reply: {{studioEmail}}</p>",
};

describe("workspace email layout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.layout.mockReturnValue(query(layout));
    mocks.tenant.mockReturnValue(
      query({
        publicSite: { branding: { backgroundColor: "#F7E9DE" } },
        publicSiteEditor: {
          draft: { branding: { backgroundColor: "#000000" } },
          published: { branding: { backgroundColor: "#F6EADE" } },
        },
      }),
    );
  });

  it("brands text-only lifecycle and door emails while escaping secret/user content", async () => {
    const html = await applyTenantEmailLayout(input);
    expect(mocks.layout).toHaveBeenCalledWith({
      tenant: "studio-a",
      category: "layout",
      isDefault: true,
      isActive: true,
    });
    expect(html).toContain("#F6EADE");
    expect(html).not.toContain("#000000");
    expect(html).toContain("Atelier &lt;Klei&gt;");
    expect(html).toContain("&lt;1234&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("max-width:640px");
    expect(input.text).toContain("https://example.test/?token=test");
  });

  it.each([
    null,
    { ...layout, tenant: "studio-b" },
    { ...layout, isActive: false },
  ])(
    "does not borrow another workspace's layout or alter unconfigured messages",
    async (saved) => {
      mocks.layout.mockReturnValue(query(saved));
      expect(
        await applyTenantEmailLayout({ ...input, html: "<p>Original</p>" }),
      ).toBe("<p>Original</p>");
      expect(mocks.tenant).not.toHaveBeenCalled();
    },
  );

  it("preserves secure links and treats preparation failures as definitely not sent", async () => {
    const body =
      '<p><a href="https://example.test/download?token=test&amp;id=1">Download voucher</a></p>';
    expect(await applyTenantEmailLayout({ ...input, html: body })).toContain(
      body,
    );
    mocks.layout.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    await expect(applyTenantEmailLayout(input)).rejects.toMatchObject({
      code: "EMAIL_LAYOUT_PREPARATION_FAILED",
      deliveryOutcome: "not_sent",
    });
  });

  it("embeds a complete document without nesting its head/body or accepting CSS injection", () => {
    const html = renderTenantEmailFrame({
      body: "<!doctype html><html><head><title>Reset</title></head><body><p>OTP 123456</p></body></html>",
      backgroundColor: "red;position:fixed",
    });
    expect(html).toContain("OTP 123456");
    expect(html).not.toContain("<head>");
    expect(html).not.toContain("<body>");
    expect(html).not.toContain("position:fixed");
  });
});
