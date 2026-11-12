import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  uploadProductFiles,
  uploadSingleProductFile,
} from "@/modules/product/middleware/productUpload.middleware.js";

const app = express();
app.post("/upload", uploadSingleProductFile, (_req, res) => {
  res.status(204).end();
});
app.post("/product-upload", uploadProductFiles, (req, res) => {
  const files: Partial<Record<"file" | "image", Express.Multer.File[]>> =
    Array.isArray(req.files) ? {} : (req.files ?? {});
  res.status(201).json({
    file: files.file?.[0]?.mimetype,
    image: files.image?.[0]?.mimetype,
  });
});
app.use(((error, _req, res, _next) => {
  const candidate = error as {
    statusCode?: number;
    message?: string;
    code?: string;
  };
  res.status(candidate.statusCode ?? 500).json({
    message: candidate.message,
    code: candidate.code,
  });
}) satisfies ErrorRequestHandler);

describe("product file upload middleware", () => {
  it("accepts a PDF coupon template", async () => {
    await request(app)
      .post("/upload")
      .attach("file", Buffer.from("%PDF-1.7\n"), {
        filename: "voucher.pdf",
        contentType: "application/pdf",
      })
      .expect(204);
  });

  it("returns an operational 400 for a non-PDF file", async () => {
    const response = await request(app)
      .post("/upload")
      .attach("file", Buffer.from("not a PDF"), {
        filename: "voucher.txt",
        contentType: "text/plain",
      })
      .expect(400);

    expect(response.body).toEqual({
      message: "Only PDF files are allowed.",
      code: "PRODUCT_FILE_TYPE_INVALID",
    });
  });

  it("accepts a catalog image alongside a voucher PDF", async () => {
    const response = await request(app)
      .post("/product-upload")
      .attach("image", Buffer.from("image bytes"), {
        filename: "class.webp",
        contentType: "image/webp",
      })
      .attach("file", Buffer.from("%PDF-1.7\n"), {
        filename: "voucher.pdf",
        contentType: "application/pdf",
      })
      .expect(201);

    expect(response.body).toEqual({
      file: "application/pdf",
      image: "image/webp",
    });
  });

  it("accepts an image-only class product form", async () => {
    const response = await request(app)
      .post("/product-upload")
      .attach("image", Buffer.from("image bytes"), {
        filename: "class.png",
        contentType: "image/png",
      })
      .expect(201);

    expect(response.body).toEqual({ image: "image/png" });
  });

  it("rejects an unsupported product image type", async () => {
    const response = await request(app)
      .post("/product-upload")
      .attach("image", Buffer.from("<svg />"), {
        filename: "class.svg",
        contentType: "image/svg+xml",
      })
      .expect(400);

    expect(response.body).toEqual({
      message: "Only JPEG, PNG and WebP images are allowed.",
      code: "PRODUCT_IMAGE_TYPE_INVALID",
    });
  });

  it("rejects product images above eight megabytes", async () => {
    const response = await request(app)
      .post("/product-upload")
      .attach("image", Buffer.alloc(8 * 1024 * 1024 + 1), {
        filename: "large.jpg",
        contentType: "image/jpeg",
      })
      .expect(413);

    expect(response.body).toEqual({
      message: "Image file is too large. Maximum size is 8MB.",
      code: "PRODUCT_IMAGE_TOO_LARGE",
    });
  });

  it("rejects unknown multipart fields", async () => {
    const response = await request(app)
      .post("/product-upload")
      .attach("thumbnail", Buffer.from("image"), {
        filename: "class.png",
        contentType: "image/png",
      })
      .expect(400);

    expect(response.body.code).toBe("PRODUCT_FILE_UPLOAD_INVALID");
  });

  it("rejects duplicate image fields", async () => {
    const response = await request(app)
      .post("/product-upload")
      .attach("image", Buffer.from("first"), {
        filename: "first.png",
        contentType: "image/png",
      })
      .attach("image", Buffer.from("second"), {
        filename: "second.png",
        contentType: "image/png",
      })
      .expect(400);

    expect(response.body.code).toBe("PRODUCT_FILE_UPLOAD_INVALID");
  });
});
