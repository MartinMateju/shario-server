import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOUCHER_DESIGN,
  VOUCHER_DESIGN_FONTS,
  normalizeVoucherDesign,
} from "@/modules/coupon/voucher-design.js";

const fresh = () => structuredClone(DEFAULT_VOUCHER_DESIGN);

describe("voucher design contract", () => {
  it("accepts a separate title color without changing older designs", () => {
    const legacy = fresh();
    expect(normalizeVoucherDesign(legacy)).toEqual(legacy);
    expect(normalizeVoucherDesign(legacy).colors).not.toHaveProperty("title");
    const custom = normalizeVoucherDesign({
      ...legacy,
      colors: { ...legacy.colors, title: "#ab123f" },
    });
    expect(custom.colors).toEqual({ ...legacy.colors, title: "#AB123F" });
  });

  it.each(["", "#fff", "red", "url(https://example.com/a)", null, 123456])(
    "rejects an invalid title color %j",
    (title) => {
      const design = fresh();
      expect(() =>
        normalizeVoucherDesign({
          ...design,
          colors: { ...design.colors, title },
        }),
      ).toThrow();
    },
  );

  it.each(VOUCHER_DESIGN_FONTS)(
    "preserves the saved font identifier %s",
    (font) => {
      const value = fresh();
      value.typography.font = font;
      expect(normalizeVoucherDesign(value).typography.font).toBe(font);
    },
  );

  it("normalizes colors and Unicode without accepting arbitrary style properties", () => {
    const value = fresh();
    value.colors.accent = "#abcdef";
    value.content.title =
      "  Pr\u030ci\u0301lis\u030c z\u030clut\u030couc\u030cky\u0301 ku\u030an\u030c  ";
    const result = normalizeVoucherDesign(value);
    expect(result.colors.accent).toBe("#ABCDEF");
    expect(result.content.title).toBe("Příliš žluťoučký kůň");
    expect(() =>
      normalizeVoucherDesign({ ...value, css: "body{display:none}" }),
    ).toThrow();
    expect(() =>
      normalizeVoucherDesign({
        ...value,
        colors: { ...value.colors, background: "url(https://example.com/a)" },
      }),
    ).toThrow();
  });

  it("rejects hidden financial overrides, external fonts, unknown nested fields and unsupported versions", () => {
    const value = fresh();
    expect(() =>
      normalizeVoucherDesign({
        ...value,
        content: { ...value.content, code: "FREE" },
      }),
    ).toThrow();
    expect(() =>
      normalizeVoucherDesign({
        ...value,
        typography: {
          font: "https://example.com/font.woff",
          titleWeight: "bold",
        },
      }),
    ).toThrow();
    expect(() => normalizeVoucherDesign({ ...value, version: 2 })).toThrow();
    expect(() =>
      normalizeVoucherDesign({
        ...value,
        content: { ...value.content, title: "  " },
      }),
    ).toThrow();
  });

  it("bounds editable content and only permits object keys, never remote asset URLs or traversal", () => {
    const value = fresh();
    expect(() =>
      normalizeVoucherDesign({
        ...value,
        content: { ...value.content, message: "x".repeat(401) },
      }),
    ).toThrow();
    for (const imageKey of [
      "https://example.com/image.png",
      "../secret.png",
      "tenants/id/../secret.png",
      "/absolute.png",
      "data:image/svg+xml,<svg>",
    ]) {
      expect(() =>
        normalizeVoucherDesign({
          ...value,
          assets: { logoKey: null, imageKey },
        }),
      ).toThrow();
    }
    expect(() =>
      normalizeVoucherDesign({
        ...value,
        content: { ...value.content, title: "Hidden\u202Etext" },
      }),
    ).toThrow();
    const imageKey =
      "tenants/012345678901234567890123/voucher-assets/cb5d029f-9fea-4c51-98f9-d44d6a184f87.png";
    expect(
      normalizeVoucherDesign({ ...value, assets: { logoKey: null, imageKey } })
        .assets.imageKey,
    ).toBe(imageKey);
  });
});
