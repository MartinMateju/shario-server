import crypto from "node:crypto";

import sharp from "sharp";

import {
  deleteObjectFromR2,
  getR2PublicUrl,
  uploadBufferToR2,
} from "@/infrastructure/storage/r2.client.js";
import { AppError } from "@/shared/http/AppError.js";

import {
  PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES,
  PRODUCT_IMAGE_MAX_HEIGHT,
  PRODUCT_IMAGE_MAX_PIXELS,
  PRODUCT_IMAGE_MAX_WIDTH,
  PRODUCT_IMAGE_MEDIA_TYPES,
  type ProductImageMediaType,
} from "../product.constants.js";
import type { UploadedFileLike } from "../product.types.js";

export type UploadedProductImage = {
  key: string;
  url: string;
};

type SanitizedProductImage = {
  buffer: Buffer;
  contentType: ProductImageMediaType;
};

const invalidImage = (
  message: string,
  code = "PRODUCT_IMAGE_INVALID",
  statusCode = 400,
): never => {
  throw new AppError({ statusCode, code, message });
};

const assertSafeDimensions = (width: number, height: number): void => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > PRODUCT_IMAGE_MAX_WIDTH ||
    height > PRODUCT_IMAGE_MAX_HEIGHT ||
    width * height > PRODUCT_IMAGE_MAX_PIXELS
  ) {
    invalidImage(
      `Image dimensions must not exceed ${PRODUCT_IMAGE_MAX_WIDTH}x${PRODUCT_IMAGE_MAX_HEIGHT} or ${PRODUCT_IMAGE_MAX_PIXELS} pixels.`,
      "PRODUCT_IMAGE_DIMENSIONS_INVALID",
    );
  }
};

const sanitizeProductImage = async (
  file: UploadedFileLike,
): Promise<SanitizedProductImage> => {
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) {
    invalidImage("The uploaded image is empty.");
  }

  if (
    file.size > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES ||
    file.buffer.byteLength > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES
  ) {
    invalidImage(
      "Image file is too large. Maximum size is 8MB.",
      "PRODUCT_IMAGE_TOO_LARGE",
      413,
    );
  }

  const contentType = String(file.mimetype ?? "")
    .trim()
    .toLowerCase() as ProductImageMediaType;
  if (!PRODUCT_IMAGE_MEDIA_TYPES.includes(contentType)) {
    invalidImage(
      "Only JPEG, PNG and WebP images are allowed.",
      "PRODUCT_IMAGE_TYPE_INVALID",
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
      invalidImage(
        "The decoded image type does not match its declared type.",
        "PRODUCT_IMAGE_INVALID_CONTENT",
      );
    }
    assertSafeDimensions(Number(metadata.width), Number(metadata.height));
    if (Number(metadata.pages ?? 1) !== 1) {
      invalidImage(
        "Animated or multi-page images are not supported.",
        "PRODUCT_IMAGE_ANIMATION_UNSUPPORTED",
      );
    }

    let sanitized = image.rotate();
    if (contentType === "image/jpeg") {
      sanitized = sanitized.jpeg({
        quality: 90,
        progressive: true,
        chromaSubsampling: "4:4:4",
      });
    } else if (contentType === "image/png") {
      sanitized = sanitized.png({
        compressionLevel: 9,
        adaptiveFiltering: true,
      });
    } else {
      sanitized = sanitized.webp({ quality: 90, effort: 4 });
    }

    // Decoding and re-encoding validates every pixel, normalizes orientation,
    // strips metadata, and discards any non-image bytes before public storage.
    const { data, info } = await sanitized.toBuffer({
      resolveWithObject: true,
    });
    assertSafeDimensions(info.width, info.height);

    if (data.byteLength > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES) {
      invalidImage(
        "The sanitized image is too large. Maximum size is 8MB.",
        "PRODUCT_IMAGE_TOO_LARGE",
        413,
      );
    }

    return { buffer: data, contentType };
  } catch (error) {
    if (error instanceof AppError) throw error;

    invalidImage(
      "The image payload could not be fully decoded.",
      "PRODUCT_IMAGE_DECODE_FAILED",
    );
  }
};

const extensionFor = (contentType: ProductImageMediaType): string =>
  contentType === "image/png"
    ? "png"
    : contentType === "image/webp"
      ? "webp"
      : "jpg";

const safeTenantSegment = (tenantId: string): string => {
  const value = String(tenantId ?? "").trim();
  if (
    !value ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error("Product image upload requires a valid tenant id.");
  }
  return value;
};

const productImagePrefix = (tenantId: string): string =>
  `tenants/${safeTenantSegment(tenantId)}/products/`;

const buildProductImageKey = ({
  tenantId,
  contentType,
}: {
  tenantId: string;
  contentType: ProductImageMediaType;
}): string =>
  `${productImagePrefix(tenantId)}${Date.now()}-${crypto.randomUUID()}.${extensionFor(contentType)}`;

export const uploadProductImage = async ({
  tenantId,
  file,
}: {
  tenantId: string;
  file: UploadedFileLike;
}): Promise<UploadedProductImage> => {
  const image = await sanitizeProductImage(file);
  const key = buildProductImageKey({
    tenantId,
    contentType: image.contentType,
  });
  const url = getR2PublicUrl(key);

  try {
    await uploadBufferToR2({
      key,
      buffer: image.buffer,
      contentType: image.contentType,
      cacheControl: "public, max-age=31536000, immutable",
    });
  } catch (error) {
    // A timed-out object write may have reached storage. Compensate without
    // hiding the original provider error.
    await deleteObjectFromR2({ key }).catch(() => undefined);
    throw error;
  }

  return { key, url };
};

/**
 * Roll back only an upload returned by this service and not yet committed to a
 * product. A product image URL remains a compatible free-form value, so that
 * URL alone cannot prove that one product exclusively owns the stored object.
 */
export const deleteUploadedProductImage = async ({
  key,
}: {
  key: string;
}): Promise<boolean> => {
  try {
    await deleteObjectFromR2({ key });
    return true;
  } catch {
    return false;
  }
};
