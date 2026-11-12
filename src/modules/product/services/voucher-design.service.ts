import { randomUUID } from "node:crypto";

import sharp from "sharp";
import { z } from "zod";

import {
  getObjectBufferFromR2,
  getR2PublicUrl,
  uploadBufferToR2,
} from "@/infrastructure/storage/r2.client.js";
import {
  DEFAULT_VOUCHER_DESIGN,
  normalizeVoucherDesign,
  voucherDesignSchema,
  type VoucherDesign,
} from "@/modules/coupon/voucher-design.js";
import {
  renderVoucherPdf,
  renderVoucherSvg,
} from "@/modules/coupon/voucher-design.renderer.js";
import {
  calculateVoucherExpiry,
  normalizeVoucherTimezone,
  parseVoucherCalendarDate,
} from "@/modules/coupon/voucher-policy.js";
import { findTenantById } from "@/modules/tenants/tenant.repository.js";
import { PUBLIC_SITE_FONT_PRESETS } from "@/modules/tenants/public-site/tenant-public-site.constants.js";
import { AppError } from "@/shared/http/AppError.js";
import { notFound } from "@/shared/http/httpErrors.js";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

import {
  PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES,
  PRODUCT_IMAGE_MAX_HEIGHT,
  PRODUCT_IMAGE_MAX_PIXELS,
  PRODUCT_IMAGE_MAX_WIDTH,
  PRODUCT_IMAGE_MEDIA_TYPES,
} from "../product.constants.js";
import type { UploadedFileLike } from "../product.types.js";

export const VOUCHER_ASSET_MAX_EDGE = 1_600;
export const VOUCHER_DESIGN_PREVIEW_MAX_BODY_BYTES = 32 * 1024;

const invalidAsset = (
  message: string,
  code = "VOUCHER_ASSET_INVALID",
  statusCode = 400,
): never => {
  throw new AppError({ message, code, statusCode });
};

const tenantAssetPrefix = (tenantId: string): string => {
  if (!/^[a-f0-9]{24}$/i.test(tenantId)) {
    invalidAsset(
      "A valid workspace is required.",
      "VOUCHER_ASSET_TENANT_INVALID",
    );
  }
  return `tenants/${tenantId}/voucher-assets/`;
};

/** Asset keys are opaque service-owned references, never URLs or generic R2 paths. */
export const assertVoucherAssetOwnership = (
  tenantId: string,
  key: string,
): void => {
  const prefix = tenantAssetPrefix(tenantId);
  if (
    !key.startsWith(prefix) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(png|jpg)$/.test(
      key.slice(prefix.length),
    )
  ) {
    invalidAsset(
      "Voucher images must belong to this workspace.",
      "VOUCHER_ASSET_TENANT_MISMATCH",
    );
  }
};

const validateImageDimensions = (width: number, height: number): void => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > PRODUCT_IMAGE_MAX_WIDTH ||
    height > PRODUCT_IMAGE_MAX_HEIGHT ||
    width * height > PRODUCT_IMAGE_MAX_PIXELS
  ) {
    invalidAsset(
      "Images must not exceed 6000 pixels per side or 24 million pixels.",
      "VOUCHER_ASSET_DIMENSIONS_INVALID",
    );
  }
};

const sanitizeVoucherAsset = async (file: UploadedFileLike) => {
  if (!Buffer.isBuffer(file?.buffer) || !file.buffer.byteLength) {
    invalidAsset("The uploaded image is empty.");
  }
  if (
    file.size > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES ||
    file.buffer.byteLength > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES
  ) {
    invalidAsset(
      "Image file is too large. Maximum size is 8MB.",
      "VOUCHER_ASSET_TOO_LARGE",
      413,
    );
  }
  const contentType = String(file.mimetype ?? "")
    .trim()
    .toLowerCase();
  if (
    !PRODUCT_IMAGE_MEDIA_TYPES.includes(
      contentType as (typeof PRODUCT_IMAGE_MEDIA_TYPES)[number],
    )
  ) {
    invalidAsset(
      "Only JPEG, PNG and WebP images are allowed.",
      "VOUCHER_ASSET_TYPE_INVALID",
    );
  }

  try {
    const image = sharp(file.buffer, {
      animated: true,
      failOn: "error",
      limitInputPixels: PRODUCT_IMAGE_MAX_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const expectedFormat =
      contentType === "image/jpeg"
        ? "jpeg"
        : contentType === "image/png"
          ? "png"
          : "webp";
    if (metadata.format !== expectedFormat) {
      invalidAsset(
        "The image bytes do not match their declared type.",
        "VOUCHER_ASSET_INVALID_CONTENT",
      );
    }
    validateImageDimensions(Number(metadata.width), Number(metadata.height));
    if (Number(metadata.pages ?? 1) !== 1) {
      invalidAsset(
        "Animated and multi-page images are not supported.",
        "VOUCHER_ASSET_ANIMATION_UNSUPPORTED",
      );
    }

    // Decode every pixel, normalize orientation and strip metadata before storage.
    // Keep transparency for logos; other images become portable, bounded JPEGs.
    const resized = image.rotate().resize({
      width: VOUCHER_ASSET_MAX_EDGE,
      height: VOUCHER_ASSET_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });
    const outputType = metadata.hasAlpha ? "image/png" : "image/jpeg";
    const encoded = metadata.hasAlpha
      ? resized.png({ compressionLevel: 9, adaptiveFiltering: true })
      : resized.jpeg({ quality: 90, chromaSubsampling: "4:4:4" });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    if (data.byteLength > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES) {
      invalidAsset(
        "The processed image exceeds 8MB.",
        "VOUCHER_ASSET_TOO_LARGE",
        413,
      );
    }
    return {
      buffer: data,
      width: info.width,
      height: info.height,
      contentType: outputType,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalidAsset(
      "The image payload could not be fully decoded.",
      "VOUCHER_ASSET_DECODE_FAILED",
    );
  }
};

export const voucherAssetUploadBodySchema = z
  .object({
    purpose: z.enum(["logo", "image"]),
  })
  .strict();

export const uploadVoucherDesignAsset = async ({
  tenantId,
  file,
  purpose,
}: {
  tenantId: string;
  file: UploadedFileLike;
  purpose: "logo" | "image";
}) => {
  voucherAssetUploadBodySchema.parse({ purpose });
  const prefix = tenantAssetPrefix(tenantId);
  const asset = await sanitizeVoucherAsset(file);
  const key = `${prefix}${randomUUID()}.${asset.contentType === "image/png" ? "png" : "jpg"}`;
  const url = getR2PublicUrl(key);
  await uploadBufferToR2({
    key,
    buffer: asset.buffer,
    contentType: asset.contentType,
    cacheControl: "public, max-age=31536000, immutable",
  });
  // Immutable assets are retained: issued vouchers may still reference them.
  return {
    key,
    url,
    width: asset.width,
    height: asset.height,
    contentType: asset.contentType,
  };
};

export const resolveVoucherDesignAssets = async (
  tenantId: string,
  input: VoucherDesign,
): Promise<{ logo?: Buffer; image?: Buffer }> => {
  const design = normalizeVoucherDesign(input);
  const keys = [design.assets.logoKey, design.assets.imageKey].filter(
    (key): key is string => Boolean(key),
  );
  // Validate every key before any I/O, even if a previous asset was valid.
  for (const key of keys) assertVoucherAssetOwnership(tenantId, key);
  const resolved = new Map<string, Buffer>();
  await Promise.all(
    [...new Set(keys)].map(async (key) => {
      const buffer = await getObjectBufferFromR2({ key }).catch(() =>
        invalidAsset(
          "A voucher image is unavailable. Upload it again before saving.",
          "VOUCHER_ASSET_UNAVAILABLE",
        ),
      );
      if (
        !buffer.byteLength ||
        buffer.byteLength > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES
      ) {
        invalidAsset(
          "The stored voucher image is invalid.",
          "VOUCHER_ASSET_INVALID_CONTENT",
        );
      }
      try {
        const decoder = sharp(buffer, {
          failOn: "error",
          limitInputPixels: VOUCHER_ASSET_MAX_EDGE ** 2,
        });
        const metadata = await decoder.metadata();
        const expected = key.endsWith(".png") ? "png" : "jpeg";
        if (
          metadata.format !== expected ||
          Number(metadata.pages ?? 1) !== 1 ||
          !metadata.width ||
          !metadata.height ||
          metadata.width > VOUCHER_ASSET_MAX_EDGE ||
          metadata.height > VOUCHER_ASSET_MAX_EDGE
        ) {
          invalidAsset(
            "The stored voucher image is invalid.",
            "VOUCHER_ASSET_INVALID_CONTENT",
          );
        }
        // Metadata alone does not guarantee the full image is decodable.
        await decoder.raw().toBuffer();
      } catch (error) {
        if (error instanceof AppError) throw error;
        invalidAsset(
          "The stored voucher image cannot be decoded.",
          "VOUCHER_ASSET_INVALID_CONTENT",
        );
      }
      resolved.set(key, buffer);
    }),
  );
  return {
    ...(design.assets.logoKey
      ? { logo: resolved.get(design.assets.logoKey)! }
      : {}),
    ...(design.assets.imageKey
      ? { image: resolved.get(design.assets.imageKey)! }
      : {}),
  };
};

const sampleMetadata = {
  promoCode: "SAMPLE",
  amountMinor: 100_000,
  currency: "CZK",
  expiresAt: null,
  timezone: "UTC",
  locale: "en",
};

/** Validate assets and typography before committing a design to a sellable offering. */
export const prepareVoucherDesign = async (
  tenantId: string,
  input: unknown,
): Promise<VoucherDesign> => {
  const design = normalizeVoucherDesign(input);
  const assets = await resolveVoucherDesignAssets(tenantId, design);
  await renderVoucherSvg({
    design,
    assets,
    metadata: sampleMetadata,
    sample: true,
  });
  return design;
};

const calendarDateSchema = z.string().refine((value) => {
  try {
    parseVoucherCalendarDate(value);
    return true;
  } catch {
    return false;
  }
}, "Use a valid YYYY-MM-DD expiry date.");

export const voucherDesignPreviewSchema = z
  .object({
    design: voucherDesignSchema,
    productName: z.string().trim().max(160).optional(),
    amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.enum(STUDIO_COMMERCE_CURRENCIES),
    validity: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("months"),
          months: z.number().int().min(1).max(120),
        })
        .strict(),
      z.object({ mode: z.literal("date"), date: calendarDateSchema }).strict(),
      z.object({ mode: z.literal("none") }).strict(),
    ]),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .refine((value) => {
        try {
          return Intl.getCanonicalLocales(value).length === 1;
        } catch {
          return false;
        }
      }, "Use a valid locale.")
      .optional(),
  })
  .strict();

const readTenant = async (tenantId: string) => {
  const tenant = await findTenantById(tenantId);
  if (!tenant || String(tenant._id) !== tenantId)
    notFound("Workspace not found.");
  return tenant;
};

const safeColor = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value) ? value : fallback;

export const getVoucherDesignDefaults = async (
  tenantId: string,
): Promise<VoucherDesign> => {
  const tenant = await readTenant(tenantId);
  const branding = (tenant.publicSiteEditor?.published || tenant.publicSite)
    ?.branding;
  const locale =
    tenant.settings?.adminLanguage ||
    tenant.settings?.publicDefaultLanguage ||
    tenant.settings?.defaultLanguage ||
    "en";
  return normalizeVoucherDesign({
    ...DEFAULT_VOUCHER_DESIGN,
    colors: {
      background: safeColor(
        branding?.backgroundColor,
        DEFAULT_VOUCHER_DESIGN.colors.background,
      ),
      text: safeColor(branding?.textColor, DEFAULT_VOUCHER_DESIGN.colors.text),
      accent: safeColor(
        branding?.accentColor,
        DEFAULT_VOUCHER_DESIGN.colors.accent,
      ),
    },
    typography: {
      ...DEFAULT_VOUCHER_DESIGN.typography,
      font: PUBLIC_SITE_FONT_PRESETS.includes(branding?.fontPreset)
        ? branding.fontPreset
        : DEFAULT_VOUCHER_DESIGN.typography.font,
    },
    content: {
      ...DEFAULT_VOUCHER_DESIGN.content,
      brandName: String(branding?.displayName || tenant.name || "shario.io")
        .trim()
        .slice(0, 60),
      ...(locale.startsWith("cs")
        ? {
            title: "Dárkový poukaz",
            subtitle: "Chvíle pro vlastní tvorbu.",
            message: "Darujte prostor a čas vytvořit něco vlastního.",
          }
        : {}),
    },
    // External public-site logo URLs are deliberately not fetched by the renderer.
    assets: { logoKey: null, imageKey: null },
  });
};

export const renderVoucherDesignPreview = async ({
  tenantId,
  input,
  format,
}: {
  tenantId: string;
  input: unknown;
  format: "svg" | "pdf";
}): Promise<string | Buffer> => {
  if (
    Buffer.byteLength(JSON.stringify(input) ?? "") >
    VOUCHER_DESIGN_PREVIEW_MAX_BODY_BYTES
  ) {
    throw new AppError({
      statusCode: 413,
      code: "VOUCHER_DESIGN_TOO_LARGE",
      message: "Voucher design is too large.",
    });
  }
  const body = voucherDesignPreviewSchema.parse(input);
  const tenant = await readTenant(tenantId);
  const timezone = normalizeVoucherTimezone(tenant.settings?.timezone);
  const assets = await resolveVoucherDesignAssets(tenantId, body.design);
  const params = {
    design: body.design,
    assets,
    metadata: {
      promoCode: "SAMPLE",
      productName: body.productName,
      amountMinor: body.amountMinor,
      currency: body.currency,
      expiresAt: calculateVoucherExpiry({
        validity: body.validity,
        issuedAt: new Date(),
        timezone,
      }),
      timezone,
      locale:
        body.locale ||
        tenant.settings?.adminLanguage ||
        tenant.settings?.defaultLanguage ||
        "en",
    },
    sample: true,
  };
  return format === "pdf" ? renderVoucherPdf(params) : renderVoucherSvg(params);
};
