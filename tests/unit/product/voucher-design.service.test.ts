import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getObjectBufferFromR2: vi.fn(),
  getR2PublicUrl: vi.fn(),
  uploadBufferToR2: vi.fn(),
  findTenantById: vi.fn(),
  renderVoucherSvg: vi.fn(),
  renderVoucherPdf: vi.fn(),
}));

vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  getObjectBufferFromR2: mocks.getObjectBufferFromR2,
  getR2PublicUrl: mocks.getR2PublicUrl,
  uploadBufferToR2: mocks.uploadBufferToR2,
}));
vi.mock("@/modules/tenants/tenant.repository.js", () => ({
  findTenantById: mocks.findTenantById,
}));
vi.mock("@/modules/coupon/voucher-design.renderer.js", () => ({
  renderVoucherSvg: mocks.renderVoucherSvg,
  renderVoucherPdf: mocks.renderVoucherPdf,
}));

import { DEFAULT_VOUCHER_DESIGN } from "@/modules/coupon/voucher-design.js";
import {
  assertVoucherAssetOwnership,
  getVoucherDesignDefaults,
  prepareVoucherDesign,
  renderVoucherDesignPreview,
  resolveVoucherDesignAssets,
  uploadVoucherDesignAsset,
} from "@/modules/product/services/voucher-design.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const otherTenant = "507f1f77bcf86cd799439012";
const key = `tenants/${tenantId}/voucher-assets/cf2a9bfd-35ea-4a64-a366-04d8aee39f91.png`;
const designWithKey = (assetKey: string) => ({
  ...DEFAULT_VOUCHER_DESIGN,
  assets: { logoKey: assetKey, imageKey: null },
});
const png = (width = 100, height = 100, alpha = true) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: { r: 12, g: 80, b: 110, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
const imageFile = (buffer: Buffer, mimetype = "image/png") => ({
  originalname: "logo.png",
  mimetype,
  size: buffer.length,
  buffer,
});
const previewInput = () => ({
  design: DEFAULT_VOUCHER_DESIGN,
  amountMinor: 120_000,
  currency: "CZK",
  validity: { mode: "date", date: "2027-03-28" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getR2PublicUrl.mockImplementation(
    (assetKey: string) => `https://media.shario.test/${assetKey}`,
  );
  mocks.uploadBufferToR2.mockResolvedValue(undefined);
  mocks.renderVoucherSvg.mockResolvedValue("<svg>SAMPLE</svg>");
  mocks.renderVoucherPdf.mockResolvedValue(Buffer.from("%PDF sample"));
  mocks.findTenantById.mockResolvedValue({
    _id: tenantId,
    name: "Atelier Klei",
    settings: {
      timezone: "Europe/Prague",
      adminLanguage: "cs",
      currency: "CZK",
    },
  });
});

describe("voucher asset safety", () => {
  it("bounds large transparent images and stores immutable tenant-scoped PNGs without metadata", async () => {
    const buffer = await sharp(await png(3200, 2400))
      .withMetadata()
      .png()
      .toBuffer();
    const result = await uploadVoucherDesignAsset({
      tenantId,
      file: imageFile(buffer),
      purpose: "logo",
    });
    expect(result).toMatchObject({
      width: 1600,
      height: 1200,
      contentType: "image/png",
    });
    expect(() =>
      assertVoucherAssetOwnership(tenantId, result.key),
    ).not.toThrow();
    expect(result.url).toBe(`https://media.shario.test/${result.key}`);
    const uploaded = mocks.uploadBufferToR2.mock.calls[0]![0];
    expect(uploaded).toMatchObject({
      key: result.key,
      cacheControl: "public, max-age=31536000, immutable",
    });
    const metadata = await sharp(uploaded.buffer).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it("normalizes an opaque WebP to a portable JPEG", async () => {
    const buffer = await sharp(await png(200, 150, false))
      .webp()
      .toBuffer();
    const result = await uploadVoucherDesignAsset({
      tenantId,
      file: imageFile(buffer, "image/webp"),
      purpose: "image",
    });
    expect(result).toMatchObject({
      width: 200,
      height: 150,
      contentType: "image/jpeg",
    });
    expect(result.key).toMatch(/\.jpg$/);
  });

  it.each([
    [
      "corrupt bytes",
      "image/png",
      Buffer.from("not an image"),
      "VOUCHER_ASSET_DECODE_FAILED",
    ],
    [
      "SVG",
      "image/svg+xml",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "VOUCHER_ASSET_TYPE_INVALID",
    ],
    [
      "SVG spoofing PNG",
      "image/png",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      ),
      "VOUCHER_ASSET_INVALID_CONTENT",
    ],
  ])("rejects %s before storage", async (_label, mimetype, bytes, code) => {
    await expect(
      uploadVoucherDesignAsset({
        tenantId,
        file: imageFile(bytes as Buffer, mimetype as string),
        purpose: "logo",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code });
    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
  });

  it("rejects real PNG bytes declared as JPEG", async () => {
    await expect(
      uploadVoucherDesignAsset({
        tenantId,
        file: imageFile(await png(), "image/jpeg"),
        purpose: "image",
      }),
    ).rejects.toMatchObject({ code: "VOUCHER_ASSET_INVALID_CONTENT" });
    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
  });

  it("rejects dimensions and byte sizes before storage", async () => {
    await expect(
      uploadVoucherDesignAsset({
        tenantId,
        file: imageFile(await png(6001, 1)),
        purpose: "image",
      }),
    ).rejects.toMatchObject({ code: "VOUCHER_ASSET_DIMENSIONS_INVALID" });
    await expect(
      uploadVoucherDesignAsset({
        tenantId,
        file: imageFile(Buffer.alloc(8 * 1024 * 1024 + 1)),
        purpose: "image",
      }),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "VOUCHER_ASSET_TOO_LARGE",
    });
    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
  });

  it.each([
    key.replace(tenantId, otherTenant),
    key.replace("voucher-assets/", "voucher-assets/../"),
    key.replace("voucher-assets/", "products/"),
    `https://example.org/${key}`,
    key.replace(".png", ".svg"),
  ])(
    "rejects foreign or noncanonical key %s without reading storage",
    async (assetKey) => {
      await expect(
        resolveVoucherDesignAssets(tenantId, designWithKey(assetKey)),
      ).rejects.toThrow();
      expect(mocks.getObjectBufferFromR2).not.toHaveBeenCalled();
    },
  );

  it("checks both ownership references before retrieving the first one", async () => {
    await expect(
      resolveVoucherDesignAssets(tenantId, {
        ...DEFAULT_VOUCHER_DESIGN,
        assets: { logoKey: key, imageKey: key.replace(tenantId, otherTenant) },
      }),
    ).rejects.toMatchObject({ code: "VOUCHER_ASSET_TENANT_MISMATCH" });
    expect(mocks.getObjectBufferFromR2).not.toHaveBeenCalled();
  });

  it("deduplicates an owned image used in both positions and validates stored bytes", async () => {
    const buffer = await png();
    mocks.getObjectBufferFromR2.mockResolvedValue(buffer);
    const result = await resolveVoucherDesignAssets(tenantId, {
      ...DEFAULT_VOUCHER_DESIGN,
      assets: { logoKey: key, imageKey: key },
    });
    expect(result).toEqual({ logo: buffer, image: buffer });
    expect(mocks.getObjectBufferFromR2).toHaveBeenCalledExactlyOnceWith({
      key,
    });
    mocks.getObjectBufferFromR2.mockResolvedValue(
      Buffer.from("invalid stored bytes"),
    );
    await expect(
      resolveVoucherDesignAssets(tenantId, designWithKey(key)),
    ).rejects.toMatchObject({ code: "VOUCHER_ASSET_INVALID_CONTENT" });
  });

  it("returns an operational error for a missing stored asset", async () => {
    mocks.getObjectBufferFromR2.mockRejectedValue(new Error("NoSuchKey"));
    await expect(
      resolveVoucherDesignAssets(tenantId, designWithKey(key)),
    ).rejects.toMatchObject({
      code: "VOUCHER_ASSET_UNAVAILABLE",
      statusCode: 400,
    });
  });
});

describe("voucher editor previews and defaults", () => {
  it("uses published tenant branding and ignores external logos and unpublished changes", async () => {
    mocks.findTenantById.mockResolvedValue({
      _id: tenantId,
      name: "Atelier Klei",
      settings: { adminLanguage: "cs" },
      publicSite: { branding: { displayName: "Legacy" } },
      publicSiteEditor: {
        draft: { branding: { displayName: "Unpublished" } },
        published: {
          branding: {
            displayName: "Published studio",
            accentColor: "#123456",
            backgroundColor: "url(evil)",
            textColor: "#abcdef",
            fontPreset: "warm-serif-v1",
            logoUrl: "https://example.org/logo.png",
          },
        },
      },
    });
    const result = await getVoucherDesignDefaults(tenantId);
    expect(result.content).toMatchObject({
      brandName: "Published studio",
      title: "Dárkový poukaz",
    });
    expect(result.colors).toMatchObject({
      accent: "#123456",
      text: "#ABCDEF",
      background: DEFAULT_VOUCHER_DESIGN.colors.background,
    });
    expect(result.typography.font).toBe("warm-serif-v1");
    expect(result.assets).toEqual({ logoKey: null, imageKey: null });
    expect(mocks.getObjectBufferFromR2).not.toHaveBeenCalled();
  });

  it.each([
    "shario-sans-v1",
    "editorial-serif-v1",
    "warm-serif-v1",
    "modern-condensed-v1",
  ])("inherits the exact website font preset %s", async (fontPreset) => {
    mocks.findTenantById.mockResolvedValue({
      _id: tenantId,
      name: "Atelier Klei",
      publicSite: { branding: { fontPreset } },
    });
    expect((await getVoucherDesignDefaults(tenantId)).typography.font).toBe(
      fontPreset,
    );
  });

  it.each([undefined, "unknown", "warm-serif-custom"])(
    "uses the website default for unavailable font preset %s",
    async (fontPreset) => {
      mocks.findTenantById.mockResolvedValue({
        _id: tenantId,
        publicSite: { branding: { fontPreset } },
      });
      expect((await getVoucherDesignDefaults(tenantId)).typography.font).toBe(
        "shario-sans-v1",
      );
    },
  );

  it("owns the SAMPLE code and expiry timezone while preserving requested amount/currency", async () => {
    await expect(
      renderVoucherDesignPreview({
        tenantId,
        input: previewInput(),
        format: "svg",
      }),
    ).resolves.toBe("<svg>SAMPLE</svg>");
    expect(mocks.renderVoucherSvg).toHaveBeenCalledWith(
      expect.objectContaining({
        sample: true,
        metadata: expect.objectContaining({
          promoCode: "SAMPLE",
          amountMinor: 120_000,
          currency: "CZK",
          timezone: "Europe/Prague",
          locale: "cs",
          expiresAt: new Date("2027-03-28T21:59:59.999Z"),
        }),
      }),
    );
  });

  it.each(["promoCode", "tenantId", "timezone", "expiresAt", "sample"])(
    "rejects caller-supplied %s preview metadata",
    async (field) => {
      await expect(
        renderVoucherDesignPreview({
          tenantId,
          input: { ...previewInput(), [field]: "override" },
          format: "pdf",
        }),
      ).rejects.toThrow();
      expect(mocks.renderVoucherPdf).not.toHaveBeenCalled();
    },
  );

  it.each([
    { amountMinor: -1 },
    { amountMinor: 2.5 },
    { currency: "XXX" },
    { validity: { mode: "months", months: 0 } },
    { validity: { mode: "date", date: "2027-02-30" } },
    { locale: "../../etc/passwd" },
  ])("rejects invalid authoritative preview inputs %o", async (changes) => {
    await expect(
      renderVoucherDesignPreview({
        tenantId,
        input: { ...previewInput(), ...changes },
        format: "svg",
      }),
    ).rejects.toThrow();
    expect(mocks.renderVoucherSvg).not.toHaveBeenCalled();
  });

  it("rejects oversized preview payloads before tenant or renderer work", async () => {
    await expect(
      renderVoucherDesignPreview({
        tenantId,
        input: { ...previewInput(), padding: "x".repeat(33 * 1024) },
        format: "svg",
      }),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "VOUCHER_DESIGN_TOO_LARGE",
    });
    expect(mocks.findTenantById).not.toHaveBeenCalled();
  });

  it("preflights glyph rendering before a product saves a design", async () => {
    const unsupported = new Error("Unsupported glyph");
    mocks.renderVoucherSvg.mockRejectedValueOnce(unsupported);
    await expect(
      prepareVoucherDesign(tenantId, DEFAULT_VOUCHER_DESIGN),
    ).rejects.toBe(unsupported);
    expect(mocks.renderVoucherSvg).toHaveBeenCalledWith(
      expect.objectContaining({
        sample: true,
        metadata: expect.objectContaining({ promoCode: "SAMPLE" }),
      }),
    );
  });

  it("returns only a watermarked sample when generating a PDF", async () => {
    const result = await renderVoucherDesignPreview({
      tenantId,
      input: { ...previewInput(), validity: { mode: "none" } },
      format: "pdf",
    });
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(mocks.renderVoucherPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        sample: true,
        metadata: expect.objectContaining({
          promoCode: "SAMPLE",
          expiresAt: null,
        }),
      }),
    );
  });
});
