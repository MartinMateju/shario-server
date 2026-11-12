import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { publicSiteMediaUpload } from "@/modules/tenants/settings/public-site-media.middleware.js";

const app = express();
app.post("/upload", publicSiteMediaUpload, (req, res) => {
  res.status(201).json({
    fieldname: req.file?.fieldname,
    mimetype: req.file?.mimetype,
    size: req.file?.size,
  });
});
app.use(((error, _req, res, _next) => {
  const failure = error as {
    statusCode?: number;
    code?: string;
    message?: string;
  };
  res.status(failure.statusCode ?? 500).json({
    code: failure.code,
    message: failure.message,
  });
}) as ErrorRequestHandler);

describe("public-site media multipart middleware", () => {
  it("accepts one supported image under the expected field", async () => {
    const response = await request(app)
      .post("/upload")
      .attach("image", Buffer.from("image bytes"), {
        filename: "studio.webp",
        contentType: "image/webp",
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      fieldname: "image",
      mimetype: "image/webp",
      size: 11,
    });
  });

  it("rejects an unsupported content type", async () => {
    const response = await request(app)
      .post("/upload")
      .attach("image", Buffer.from("svg"), {
        filename: "studio.svg",
        contentType: "image/svg+xml",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("PUBLIC_SITE_MEDIA_INVALID_TYPE");
  });

  it("rejects the wrong multipart field", async () => {
    const response = await request(app)
      .post("/upload")
      .attach("file", Buffer.from("image"), {
        filename: "studio.png",
        contentType: "image/png",
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("PUBLIC_SITE_MEDIA_UPLOAD_INVALID");
  });

  it("rejects files above eight megabytes", async () => {
    const response = await request(app)
      .post("/upload")
      .attach("image", Buffer.alloc(8 * 1024 * 1024 + 1), {
        filename: "large.jpg",
        contentType: "image/jpeg",
      });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PUBLIC_SITE_MEDIA_TOO_LARGE");
  });
});
