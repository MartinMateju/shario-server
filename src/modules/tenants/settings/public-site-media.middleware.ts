import type { NextFunction, Request, Response } from "express";
import multer from "multer";

import { PUBLIC_SITE_MEDIA_MAX_BYTES } from "@/modules/tenants/public-site/tenant-public-site.constants.js";
import { AppError } from "@/shared/http/AppError.js";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: PUBLIC_SITE_MEDIA_MAX_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype.trim().toLowerCase())) {
      callback(
        new AppError({
          statusCode: 400,
          code: "PUBLIC_SITE_MEDIA_INVALID_TYPE",
          message: "Only JPEG, PNG and WebP images are allowed.",
        }),
      );
      return;
    }
    callback(null, true);
  },
});

const singleImage = upload.single("image");

export const publicSiteMediaUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  singleImage(req, res, (error: unknown) => {
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
        new AppError({
          statusCode: error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
          code:
            error.code === "LIMIT_FILE_SIZE"
              ? "PUBLIC_SITE_MEDIA_TOO_LARGE"
              : "PUBLIC_SITE_MEDIA_UPLOAD_INVALID",
          message:
            error.code === "LIMIT_FILE_SIZE"
              ? "Image file is too large. Maximum size is 8MB."
              : "The image upload is invalid.",
          details: { multerCode: error.code },
        }),
      );
      return;
    }

    next(error);
  });
};
