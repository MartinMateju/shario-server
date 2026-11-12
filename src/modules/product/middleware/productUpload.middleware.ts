import type { RequestHandler } from "express";
import multer from "multer";

import { AppError } from "@/shared/http/AppError.js";
import {
  COUPON_TEMPLATE_MAX_MB,
  PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES,
  PRODUCT_IMAGE_MEDIA_TYPES,
} from "../product.constants.js";

const invalidUpload = (
  message: string,
  code: string,
  statusCode = 400,
): AppError =>
  new AppError({
    message,
    statusCode,
    code,
  });

const isSupportedProductImage = (mimetype: string): boolean =>
  PRODUCT_IMAGE_MEDIA_TYPES.includes(
    mimetype.trim().toLowerCase() as (typeof PRODUCT_IMAGE_MEDIA_TYPES)[number],
  );

export const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: COUPON_TEMPLATE_MAX_MB * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== "application/pdf") {
      callback(
        invalidUpload(
          "Only PDF files are allowed.",
          "PRODUCT_FILE_TYPE_INVALID",
        ),
      );
      return;
    }

    callback(null, true);
  },
});

const productFilesUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 2,
    fileSize: COUPON_TEMPLATE_MAX_MB * 1024 * 1024,
    fields: 50,
    fieldSize: 256 * 1024,
    parts: 52,
    fieldNameSize: 100,
    headerPairs: 100,
  },
  fileFilter: (_req, file, callback) => {
    const mimetype = file.mimetype.trim().toLowerCase();

    if (file.fieldname === "file") {
      if (mimetype !== "application/pdf") {
        callback(
          invalidUpload(
            "Only PDF files are allowed.",
            "PRODUCT_FILE_TYPE_INVALID",
          ),
        );
        return;
      }

      callback(null, true);
      return;
    }

    if (file.fieldname === "image") {
      if (!isSupportedProductImage(mimetype)) {
        callback(
          invalidUpload(
            "Only JPEG, PNG and WebP images are allowed.",
            "PRODUCT_IMAGE_TYPE_INVALID",
          ),
        );
        return;
      }

      callback(null, true);
      return;
    }

    callback(
      invalidUpload(
        "Invalid product file upload.",
        "PRODUCT_FILE_UPLOAD_INVALID",
      ),
    );
  },
});

const uploadProductFields = productFilesUpload.fields([
  { name: "file", maxCount: 1 },
  { name: "image", maxCount: 1 },
]);

const productImageFromRequest = (
  req: Parameters<RequestHandler>[0],
): Express.Multer.File | undefined => {
  if (!req.files || Array.isArray(req.files)) return undefined;
  return req.files.image?.[0];
};

const mapProductFilesError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE" && error.field === "image") {
      return invalidUpload(
        "Image file is too large. Maximum size is 8MB.",
        "PRODUCT_IMAGE_TOO_LARGE",
        413,
      );
    }

    if (error.code === "LIMIT_FILE_SIZE" && error.field === "file") {
      return invalidUpload(
        `PDF too large. Max ${COUPON_TEMPLATE_MAX_MB}MB.`,
        "PRODUCT_FILE_TOO_LARGE",
      );
    }

    return invalidUpload(
      "Invalid product file upload.",
      "PRODUCT_FILE_UPLOAD_INVALID",
    );
  }

  return invalidUpload(
    "Invalid product file upload.",
    "PRODUCT_FILE_UPLOAD_INVALID",
  );
};

/**
 * Product create/update forms may carry one voucher PDF and one catalog image.
 * The product service performs byte-level image validation after Multer has
 * bounded the multipart body in memory.
 */
export const uploadProductFiles: RequestHandler = (req, res, next) => {
  uploadProductFields(req, res, (error: unknown) => {
    if (error) {
      next(mapProductFilesError(error));
      return;
    }

    const image = productImageFromRequest(req);
    if (
      image &&
      (image.size > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES ||
        image.buffer.byteLength > PRODUCT_IMAGE_MAX_FILE_SIZE_BYTES)
    ) {
      next(
        invalidUpload(
          "Image file is too large. Maximum size is 8MB.",
          "PRODUCT_IMAGE_TOO_LARGE",
          413,
        ),
      );
      return;
    }

    next();
  });
};

/**
 * Multer's limit errors do not carry an HTTP status by default and would be
 * normalized as a 500 by the global error handler. Convert all client upload
 * failures into stable operational 400 responses.
 */
export const uploadSingleProductFile: RequestHandler = (req, res, next) => {
  productUpload.single("file")(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof AppError) {
      next(error);
      return;
    }

    if (error instanceof multer.MulterError) {
      next(
        invalidUpload(
          error.code === "LIMIT_FILE_SIZE"
            ? `PDF too large. Max ${COUPON_TEMPLATE_MAX_MB}MB.`
            : "Invalid product file upload.",
          error.code === "LIMIT_FILE_SIZE"
            ? "PRODUCT_FILE_TOO_LARGE"
            : "PRODUCT_FILE_UPLOAD_INVALID",
        ),
      );
      return;
    }

    next(
      invalidUpload(
        "Invalid product file upload.",
        "PRODUCT_FILE_UPLOAD_INVALID",
      ),
    );
  });
};
