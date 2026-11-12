import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";

import { AppError } from "@/shared/http/AppError.js";

import {
  PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES,
  PRODUCT_IMAGE_MEDIA_TYPES,
} from "../product.constants.js";

const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES,
    fields: 1,
    fieldSize: 32,
    // Busboy emits partsLimit as it reaches the boundary; one extra slot lets
    // the final legitimate file complete. The file/field limits stay exact.
    parts: 3,
    fieldNameSize: 40,
    headerPairs: 100,
  },
  fileFilter: (_req, file, callback) => {
    if (
      !PRODUCT_IMAGE_MEDIA_TYPES.includes(
        file.mimetype
          .trim()
          .toLowerCase() as (typeof PRODUCT_IMAGE_MEDIA_TYPES)[number],
      )
    ) {
      callback(
        new AppError({
          statusCode: 400,
          code: "VOUCHER_ASSET_TYPE_INVALID",
          message: "Only JPEG, PNG and WebP images are allowed.",
        }),
      );
      return;
    }
    callback(null, true);
  },
}).single("file");

export const uploadVoucherAssetFile: RequestHandler = (req, res, next) => {
  assetUpload(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof AppError) return next(error);
    const tooLarge =
      error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    next(
      new AppError({
        statusCode: tooLarge ? 413 : 400,
        code: tooLarge
          ? "VOUCHER_ASSET_TOO_LARGE"
          : "VOUCHER_ASSET_UPLOAD_INVALID",
        message: tooLarge
          ? "Image file is too large. Maximum size is 8MB."
          : "Upload one image with its purpose (logo or image).",
      }),
    );
  });
};

const editorLimiter = (limit: number) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      code: "VOUCHER_EDITOR_RATE_LIMITED",
      message: "Too many voucher editor requests. Please wait one minute.",
    },
  });

export const voucherAssetUploadLimiter = editorLimiter(12);
export const voucherPreviewLimiter = editorLimiter(120);
export const voucherPdfLimiter = editorLimiter(10);
