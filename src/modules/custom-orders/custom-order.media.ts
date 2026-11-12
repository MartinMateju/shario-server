import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import {
  uploadBufferToR2,
  getObjectBufferFromR2,
  deleteObjectFromR2,
} from "@/infrastructure/storage/r2.client.js";
import { validateImage } from "@/modules/media/image-validation.service.js";
import { AppError, badRequest, notFound } from "@/shared/http/httpErrors.js";
import {
  CustomOrder,
  type CustomOrderAttachment,
  type CustomOrderRecord,
} from "./custom-order.model.js";

export const CUSTOM_ORDER_IMAGE_LIMIT = 5;
export const CUSTOM_ORDER_DOCUMENT_LIMIT = 10;
export const CUSTOM_ORDER_IMAGE_BYTES = 8 * 1024 * 1024;
export const CUSTOM_ORDER_DOCUMENT_BYTES = 15 * 1024 * 1024;
export const CUSTOM_ORDER_UPLOAD_BYTES = 40 * 1024 * 1024;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const fileTypes = new Set([...imageTypes, "application/pdf"]);
const uploadSizeError = () =>
  new AppError({
    statusCode: 413,
    code: "CUSTOM_ORDER_UPLOAD_TOTAL_SIZE",
    message:
      "Upload at most 40 MB at a time. Add the remaining files in another upload.",
  });
export const createCustomOrderUploadStorage = (
  maximumBytes = CUSTOM_ORDER_UPLOAD_BYTES,
): multer.StorageEngine => {
  const requests = new WeakMap<Request, { bytes: number; rejected: boolean }>();
  return {
    _handleFile(req, file, callback) {
      let state = requests.get(req);
      if (!state) {
        state = { bytes: 0, rejected: false };
        requests.set(req, state);
      }
      const budget = state;
      const chunks: Buffer[] = [];
      let size = 0;
      let completed = false;
      const fail = (error: Error) => {
        chunks.length = 0;
        if (!completed) {
          completed = true;
          callback(error);
        }
      };
      file.stream.on("data", (chunk: Buffer) => {
        if (completed) return;
        budget.bytes += chunk.length;
        if (budget.rejected || budget.bytes > maximumBytes) {
          budget.rejected = true;
          fail(uploadSizeError());
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
      });
      file.stream.once("error", fail);
      file.stream.once("end", () => {
        if (!completed) {
          completed = true;
          callback(null, { buffer: Buffer.concat(chunks, size), size });
        }
        chunks.length = 0;
      });
    },
    _removeFile(_req, file, callback) {
      delete file.buffer;
      callback(null);
    },
  };
};
const upload = multer({
  storage: createCustomOrderUploadStorage(),
  limits: {
    files: 15,
    fileSize: CUSTOM_ORDER_DOCUMENT_BYTES,
    fields: 1,
    fieldSize: 40,
    parts: 16,
  },
  fileFilter: (_req, file, callback) => {
    if (!fileTypes.has(file.mimetype.toLowerCase()))
      return callback(
        new AppError({
          statusCode: 415,
          code: "CUSTOM_ORDER_ATTACHMENT_TYPE",
          message: "Upload JPEG, PNG, WebP or PDF files.",
        }),
      );
    callback(null, true);
  },
}).array("files", 15);
export const customOrderUpload: RequestHandler = (req, res, next) => {
  const declaredSize = Number(req.headers["content-length"]);
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > CUSTOM_ORDER_UPLOAD_BYTES + 65536
  )
    return next(uploadSizeError());
  upload(req, res, (error) => {
    if (!error) return next();
    next(
      error instanceof AppError
        ? error
        : new AppError({
            statusCode: error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
            code: "CUSTOM_ORDER_ATTACHMENT_INVALID",
            message:
              "Upload up to five images (8 MB each) and ten PDF documents (15 MB each).",
          }),
    );
  });
};
const secretKey = (secret: string) =>
  crypto.createHash("sha256").update(`custom-order:${secret}`).digest();
export const encryptCustomOrderFile = (bytes: Buffer, secret: string) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(secret), iv);
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
};
export const decryptCustomOrderFile = (bytes: Buffer, secret: string) => {
  if (bytes.length < 29) throw new Error("Invalid attachment data.");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    secretKey(secret),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
};
export const cleanupCustomOrderAttachments = async (
  files: Pick<CustomOrderAttachment, "key">[],
) => {
  await Promise.allSettled(
    files.map((file) => deleteObjectFromR2({ key: file.key })),
  );
};
const safeName = (name: string) =>
  name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 180) || "attachment";
export const storeCustomOrderAttachments = async (
  files: Express.Multer.File[],
  order: Pick<CustomOrderRecord, "_id" | "attachments">,
  tenantId: string,
) => {
  if (!files.length) badRequest("Choose a file to upload.");
  const images = files.filter((file) =>
    imageTypes.has(file.mimetype.toLowerCase()),
  );
  const docs = files.filter(
    (file) => file.mimetype.toLowerCase() === "application/pdf",
  );
  if (images.length + docs.length !== files.length)
    badRequest({
      code: "CUSTOM_ORDER_ATTACHMENT_TYPE",
      message: "Upload JPEG, PNG, WebP or PDF files.",
    });
  if (
    order.attachments.filter((file) => file.kind === "image").length +
      images.length >
      CUSTOM_ORDER_IMAGE_LIMIT ||
    order.attachments.filter((file) => file.kind === "document").length +
      docs.length >
      CUSTOM_ORDER_DOCUMENT_LIMIT
  )
    badRequest({
      code: "CUSTOM_ORDER_ATTACHMENT_LIMIT",
      message: "An order can have at most five images and ten PDF documents.",
    });
  const stored: CustomOrderAttachment[] = [];
  try {
    for (const file of files) {
      const image = imageTypes.has(file.mimetype.toLowerCase());
      const maximum = image
        ? CUSTOM_ORDER_IMAGE_BYTES
        : CUSTOM_ORDER_DOCUMENT_BYTES;
      if (file.size > maximum || file.buffer.length > maximum)
        throw new AppError({
          statusCode: 413,
          code: "CUSTOM_ORDER_ATTACHMENT_SIZE",
          message: image
            ? "Images must be at most 8 MB."
            : "PDFs must be at most 15 MB.",
        });
      let contentType = file.mimetype.toLowerCase();
      let bytes = file.buffer;
      if (image) {
        const validated = await validateImage(file);
        bytes = validated.buffer;
        contentType = validated.contentType;
      } else {
        if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
          badRequest({
            code: "CUSTOM_ORDER_ATTACHMENT_TYPE",
            message: "The document is not a valid PDF.",
          });
        try {
          await PDFDocument.load(bytes, { ignoreEncryption: false });
        } catch {
          badRequest({
            code: "CUSTOM_ORDER_ATTACHMENT_TYPE",
            message: "Upload a readable, unencrypted PDF document.",
          });
        }
      }
      if (bytes.length > maximum)
        badRequest("The processed attachment is too large.");
      const attachment = {
        _id: new mongoose.Types.ObjectId(),
        name: safeName(file.originalname),
        kind: image ? "image" : "document",
        contentType,
        size: bytes.length,
        secret: crypto.randomBytes(32).toString("hex"),
        key: `tenants/${tenantId}/custom-orders/${order._id}/${crypto.randomUUID()}.bin`,
        createdAt: new Date(),
      } as CustomOrderAttachment;
      stored.push(attachment);
      // The configured storage bucket may have a public domain. Store only authenticated ciphertext.
      await uploadBufferToR2({
        key: attachment.key,
        buffer: encryptCustomOrderFile(bytes, attachment.secret),
        contentType: "application/octet-stream",
        cacheControl: "private, no-store",
      });
    }
    return stored;
  } catch (error) {
    await cleanupCustomOrderAttachments(stored);
    throw error;
  }
};
const sign = (
  order: Pick<CustomOrderRecord, "_id" | "tenant">,
  attachment: CustomOrderAttachment,
  expires: number,
) =>
  crypto
    .createHmac("sha256", attachment.secret)
    .update(
      `custom-order:${order.tenant}:${order._id}:${attachment._id}:${expires}`,
    )
    .digest("hex");
export const signedCustomOrderAttachmentUrl = (
  order: Pick<CustomOrderRecord, "_id" | "tenant">,
  attachment: CustomOrderAttachment,
  now = Date.now(),
) => {
  const expires = Math.floor(now / 1000) + 300;
  const base = (process.env.SERVER_URL || "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(base))
    throw new Error(
      "SERVER_URL is required for private custom order attachments.",
    );
  return `${base}/custom-orders/media/${order._id}/${attachment._id}?expires=${expires}&token=${sign(order, attachment, expires)}`;
};
export const validCustomOrderAttachmentSignature = (
  order: Pick<CustomOrderRecord, "_id" | "tenant">,
  attachment: CustomOrderAttachment,
  expires: number,
  token: string,
  now = Date.now(),
) =>
  Number.isSafeInteger(expires) &&
  expires > now / 1000 &&
  expires <= now / 1000 + 300 &&
  /^[a-f\d]{64}$/.test(token) &&
  crypto.timingSafeEqual(
    Buffer.from(token, "hex"),
    Buffer.from(sign(order, attachment, expires), "hex"),
  );
export const readCustomOrderAttachment: RequestHandler = async (
  req,
  res,
  next,
) => {
  try {
    if (
      !mongoose.isValidObjectId(req.params.id) ||
      !mongoose.isValidObjectId(req.params.attachmentId)
    )
      notFound("Attachment not found.");
    const order = await CustomOrder.findById(String(req.params.id))
      .select({
        tenant: 1,
        attachments: {
          $elemMatch: {
            _id: new mongoose.Types.ObjectId(String(req.params.attachmentId)),
          },
        },
      })
      .lean();
    const attachment = order?.attachments?.find(
      (file) => String(file._id) === String(req.params.attachmentId),
    );
    if (
      !order ||
      !attachment ||
      !validCustomOrderAttachmentSignature(
        order,
        attachment,
        Number(req.query.expires),
        String(req.query.token || ""),
      )
    )
      notFound("Attachment link expired or invalid.");
    const bytes = decryptCustomOrderFile(
      await getObjectBufferFromR2({ key: attachment.key }),
      attachment.secret,
    );
    res
      .set({
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Content-Type": attachment.contentType,
        "Content-Disposition": `${attachment.kind === "document" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/'/g, "%27")}`,
      })
      .send(bytes);
  } catch (error) {
    next(error);
  }
};
