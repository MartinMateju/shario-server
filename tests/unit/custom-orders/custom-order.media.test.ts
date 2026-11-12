import mongoose from "mongoose";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  uploadBufferToR2: storage.upload,
  deleteObjectFromR2: storage.remove,
  getObjectBufferFromR2: storage.get,
}));
import {
  encryptCustomOrderFile,
  decryptCustomOrderFile,
  signedCustomOrderAttachmentUrl,
  validCustomOrderAttachmentSignature,
  storeCustomOrderAttachments,
  cleanupCustomOrderAttachments,
  CUSTOM_ORDER_DOCUMENT_BYTES,
  createCustomOrderUploadStorage,
} from "@/modules/custom-orders/custom-order.media.js";
import type { CustomOrderAttachment } from "@/modules/custom-orders/custom-order.model.js";
const order = {
  _id: new mongoose.Types.ObjectId(),
  tenant: new mongoose.Types.ObjectId(),
  attachments: [] as CustomOrderAttachment[],
};
const file = (
  buffer: Buffer,
  mimetype = "application/pdf",
  originalname = "quote.pdf",
) =>
  ({
    buffer,
    size: buffer.length,
    mimetype,
    originalname,
  }) as Express.Multer.File;
describe("private custom order attachments", () => {
  it("caps aggregate streamed data even when the request has no content length", async () => {
    const storage = createCustomOrderUploadStorage(16);
    const req = {} as any;
    const first = new PassThrough();
    const one = new Promise<any>((resolve, reject) =>
      storage._handleFile(req, { stream: first } as any, (error, info) =>
        error ? reject(error) : resolve(info),
      ),
    );
    first.end(Buffer.alloc(10));
    expect((await one).size).toBe(10);
    const second = new PassThrough();
    const two = new Promise<any>((resolve, reject) =>
      storage._handleFile(req, { stream: second } as any, (error, info) =>
        error ? reject(error) : resolve(info),
      ),
    );
    const rejected = expect(two).rejects.toMatchObject({
      statusCode: 413,
      code: "CUSTOM_ORDER_UPLOAD_TOTAL_SIZE",
    });
    second.write(Buffer.alloc(4));
    second.end(Buffer.alloc(3));
    await rejected;
    const fresh = new PassThrough();
    const nextRequest = new Promise<any>((resolve, reject) =>
      storage._handleFile({} as any, { stream: fresh } as any, (error, info) =>
        error ? reject(error) : resolve(info),
      ),
    );
    fresh.end(Buffer.alloc(16));
    expect((await nextRequest).size).toBe(16);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SERVER_URL = "https://api.shario.test";
    storage.upload.mockResolvedValue({});
    storage.remove.mockResolvedValue({});
  });
  it("encrypts data and authenticates both ciphertext and key", () => {
    const bytes = Buffer.from("private quote");
    const encrypted = encryptCustomOrderFile(bytes, "secret");
    expect(encrypted.includes(bytes)).toBe(false);
    expect(decryptCustomOrderFile(encrypted, "secret")).toEqual(bytes);
    expect(() => decryptCustomOrderFile(encrypted, "other")).toThrow();
    encrypted[30] ^= 1;
    expect(() => decryptCustomOrderFile(encrypted, "secret")).toThrow();
  });
  it("binds read capabilities to tenant, order, attachment and a short expiry", () => {
    const attachment = {
      _id: new mongoose.Types.ObjectId(),
      secret: "secret",
    } as CustomOrderAttachment;
    const now = Date.now();
    const url = new URL(signedCustomOrderAttachmentUrl(order, attachment, now));
    const expires = Number(url.searchParams.get("expires"));
    const token = url.searchParams.get("token")!;
    expect(
      validCustomOrderAttachmentSignature(
        order,
        attachment,
        expires,
        token,
        now,
      ),
    ).toBe(true);
    expect(
      validCustomOrderAttachmentSignature(
        { ...order, tenant: new mongoose.Types.ObjectId() },
        attachment,
        expires,
        token,
        now,
      ),
    ).toBe(false);
    expect(
      validCustomOrderAttachmentSignature(
        order,
        { ...attachment, _id: new mongoose.Types.ObjectId() },
        expires,
        token,
        now,
      ),
    ).toBe(false);
    expect(
      validCustomOrderAttachmentSignature(
        order,
        attachment,
        expires,
        token,
        now + 300001,
      ),
    ).toBe(false);
    expect(
      validCustomOrderAttachmentSignature(
        order,
        attachment,
        expires,
        "00",
        now,
      ),
    ).toBe(false);
  });
  it("validates and stores readable PDFs as private ciphertext", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const result = await storeCustomOrderAttachments(
      [file(bytes, "application/pdf", "../quote.pdf")],
      order,
      String(order.tenant),
    );
    expect(result[0]).toMatchObject({
      kind: "document",
      contentType: "application/pdf",
      name: ".._quote.pdf",
    });
    expect(storage.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "application/octet-stream",
        cacheControl: "private, no-store",
      }),
    );
    expect(
      decryptCustomOrderFile(
        storage.upload.mock.calls[0][0].buffer,
        result[0].secret,
      ),
    ).toEqual(bytes);
  });
  it("decodes and sanitizes real image content before storing", async () => {
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#4466dd" },
    })
      .png()
      .toBuffer();
    const result = await storeCustomOrderAttachments(
      [file(bytes, "image/png", "plate.png")],
      order,
      String(order.tenant),
    );
    expect(result[0]).toMatchObject({
      kind: "image",
      contentType: "image/png",
    });
  });
  it("rejects spoofed documents and image payloads", async () => {
    await expect(
      storeCustomOrderAttachments(
        [file(Buffer.from("<script>"))],
        order,
        String(order.tenant),
      ),
    ).rejects.toThrow();
    await expect(
      storeCustomOrderAttachments(
        [file(Buffer.from("%PDF-invalid"))],
        order,
        String(order.tenant),
      ),
    ).rejects.toThrow();
    await expect(
      storeCustomOrderAttachments(
        [file(Buffer.from("not png"), "image/png")],
        order,
        String(order.tenant),
      ),
    ).rejects.toThrow();
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("enforces aggregate limits across existing and incoming files", async () => {
    const withImages = {
      ...order,
      attachments: Array.from(
        { length: 5 },
        () => ({ kind: "image" }) as CustomOrderAttachment,
      ),
    };
    await expect(
      storeCustomOrderAttachments(
        [file(Buffer.alloc(1), "image/png")],
        withImages,
        String(order.tenant),
      ),
    ).rejects.toMatchObject({ code: "CUSTOM_ORDER_ATTACHMENT_LIMIT" });
    const withDocs = {
      ...order,
      attachments: Array.from(
        { length: 10 },
        () => ({ kind: "document" }) as CustomOrderAttachment,
      ),
    };
    await expect(
      storeCustomOrderAttachments(
        [file(Buffer.alloc(1))],
        withDocs,
        String(order.tenant),
      ),
    ).rejects.toMatchObject({ code: "CUSTOM_ORDER_ATTACHMENT_LIMIT" });
    await expect(
      storeCustomOrderAttachments(
        [{ ...file(Buffer.alloc(1)), size: CUSTOM_ORDER_DOCUMENT_BYTES + 1 }],
        order,
        String(order.tenant),
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it("compensates only newly uploaded objects when storage fails", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    storage.upload.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(
      storeCustomOrderAttachments([file(bytes)], order, String(order.tenant)),
    ).rejects.toThrow("storage unavailable");
    expect(storage.remove).toHaveBeenCalledTimes(1);
    await cleanupCustomOrderAttachments([]);
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });
});
