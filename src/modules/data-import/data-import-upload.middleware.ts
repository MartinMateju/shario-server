import path from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";

import { AppError } from "@/shared/http/httpErrors.js";

import {
  DATA_IMPORT_ALLOWED_MIME_TYPES,
  DATA_IMPORT_LIMITS,
} from "./data-import.constants.js";

const allowedMimeTypes = new Set<string>(DATA_IMPORT_ALLOWED_MIME_TYPES);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: DATA_IMPORT_LIMITS.MAX_FILE_BYTES,
    fields: 0,
    // Busboy counts the multipart envelope separately from the file payload.
    // Two parts still permits exactly one file because fields/files remain 0/1.
    parts: 2,
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLocaleLowerCase();
    if (![".csv", ".xlsx"].includes(extension)) {
      callback(
        new AppError({
          statusCode: 400,
          message: "Only .csv and .xlsx files are supported.",
          code: "IMPORT_FILE_TYPE_INVALID",
        }),
      );
      return;
    }
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(
        new AppError({
          statusCode: 400,
          message: "The uploaded file content type is not supported.",
          code: "IMPORT_FILE_TYPE_INVALID",
        }),
      );
      return;
    }
    callback(null, true);
  },
});

const normalizeUploadError = (error: unknown): Error => {
  if (error instanceof AppError) return error;
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return new AppError({
      statusCode: tooLarge ? 413 : 400,
      message: tooLarge
        ? "The import file exceeds the 5 MB limit."
        : "The import upload is invalid.",
      code: tooLarge ? "IMPORT_FILE_TOO_LARGE" : "IMPORT_UPLOAD_INVALID",
    });
  }
  return error instanceof Error ? error : new Error("Import upload failed.");
};

export const dataImportUpload: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  upload.single("file")(req, res, (error?: unknown) => {
    if (error) {
      next(normalizeUploadError(error));
      return;
    }
    if (!req.file) {
      next(
        new AppError({
          statusCode: 400,
          message: "Select a CSV or XLSX file.",
          code: "IMPORT_FILE_REQUIRED",
        }),
      );
      return;
    }
    next();
  });
};
