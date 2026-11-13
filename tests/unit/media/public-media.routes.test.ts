import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ metadata: vi.fn(), sign: vi.fn() }));
vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  getR2ObjectMetadata: storage.metadata,
  getPresignedR2Url: storage.sign,
}));
import publicMediaRouter, {
  publicMediaLimiter,
} from "@/modules/media/public-media.routes.js";

const tenant = "507f1f77bcf86cd799439011";
const uuid = "29eb94bb-b647-4c50-bceb-da211609b643";
const filename = `1794567890123-${uuid}`;
const key = `tenants/${tenant}/products/${filename}.png`;
const publicUrl = (value: string) => `/media/public/${value}`;
const signedUrl =
  "https://private-storage.example/image?X-Amz-Expires=300&X-Amz-Signature=test";
const app = express();
app.use("/media/public", publicMediaRouter);
app.use((error: any, _req: any, res: any, _next: any) => {
  res
    .status(error.statusCode || 500)
    .json({ code: error.code, message: error.message });
});

describe("private-bucket public image delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicMediaLimiter.resetKey("::ffff:127.0.0.1");
    storage.metadata.mockResolvedValue({
      contentType: "image/png",
      contentLength: 1024,
    });
    storage.sign.mockResolvedValue(signedUrl);
  });

  it.each([
    ...[
      "logo",
      "favicon",
      "cover",
      "homeHero",
      "loginBackground",
      "registerBackground",
      "courseHero",
    ].flatMap((slot) =>
      ["jpg", "png", "webp"].map(
        (extension) =>
          `public-sites/${tenant}/${slot}/${filename}.${extension}`,
      ),
    ),
    ...["jpg", "png", "webp"].map(
      (extension) => `tenants/${tenant}/products/${filename}.${extension}`,
    ),
    ...["jpg", "png"].map(
      (extension) => `tenants/${tenant}/voucher-assets/${uuid}.${extension}`,
    ),
  ])("redirects only generated public image key %s", async (imageKey) => {
    const mime = imageKey.endsWith(".jpg")
      ? "image/jpeg"
      : imageKey.endsWith(".webp")
        ? "image/webp"
        : "image/png";
    storage.metadata.mockResolvedValue({
      contentType: mime,
      contentLength: 1024,
    });
    const result = await request(app).get(publicUrl(imageKey));
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(signedUrl);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(storage.metadata).toHaveBeenCalledExactlyOnceWith({ key: imageKey });
    expect(storage.sign).toHaveBeenCalledExactlyOnceWith({
      key: imageKey,
      expiresInSeconds: 300,
      responseContentType: mime,
      responseContentDisposition: "inline",
      responseCacheControl: "no-store",
    });
  });

  it("answers HEAD with metadata, no body and no mismatched GET signature", async () => {
    const result = await request(app).head(publicUrl(key));
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-length"]).toBe("1024");
    expect(result.headers["content-disposition"]).toBe("inline");
    expect(result.headers.location).toBeUndefined();
    expect(result.text).toBeUndefined();
    expect(storage.sign).not.toHaveBeenCalled();
  });

  it.each([
    `tenants/${tenant}/communications/conversation/media/${uuid}.png`,
    `tenants/${tenant}/communications/conversation/voice/${uuid}.ogg`,
    `tenants/${tenant}/custom-orders/order/${uuid}.bin`,
    `tenants/${tenant}/custom-orders/order/${uuid}.png`,
    `coupon-templates/template-${uuid}.pdf`,
    `tenants/${tenant}/products/${filename}.svg`,
    `tenants/${tenant}/products/${filename}.html`,
    `tenants/${tenant}/products/${filename}.pdf`,
    `tenants/${tenant}/voucher-assets/${uuid}.webp`,
    `tenants/${tenant}/products/photo.png`,
    `tenants/${tenant}/products/${filename}.png/extra`,
    `tenants/${tenant}/products/${filename}.png%00`,
    `tenants/${tenant}/products/${filename}.png%0a`,
    `tenants/${tenant}/products/%2e%2e%2fcommunications%2fsecret.png`,
    `tenants/${tenant}/products/%252e%252e%252fsecret.png`,
    `tenants%2f${tenant}%2fproducts%2f${filename}.png`,
    `tenants/${tenant}/products%5c${filename}.png`,
    `tenants/${tenant}/products//${filename}.png`,
    `public-sites/${tenant}/unknown/${filename}.png`,
    `public-sites/not-a-tenant/logo/${filename}.png`,
    `tenants/${tenant}/voucher-assets/29eb94bb-b647-1c50-bceb-da211609b643.png`,
    `unknown/${key}`,
    "",
  ])(
    "rejects private, malformed or nonimage path without storage I/O: %s",
    async (invalidKey) => {
      const result = await request(app).get(publicUrl(invalidKey));
      expect(result.status).toBe(404);
      expect(result.headers.location).toBeUndefined();
      expect(storage.metadata).not.toHaveBeenCalled();
      expect(storage.sign).not.toHaveBeenCalled();
    },
  );

  it.each(["post", "put", "patch", "delete"] as const)(
    "rejects %s without storage I/O",
    async (method) => {
      const result = await request(app)[method](publicUrl(key));
      expect(result.status).toBe(405);
      expect(result.headers.allow).toBe("GET, HEAD");
      expect(storage.metadata).not.toHaveBeenCalled();
    },
  );

  it.each([
    { contentType: "text/html", contentLength: 10 },
    { contentType: "image/svg+xml", contentLength: 10 },
    { contentType: "application/pdf", contentLength: 10 },
    { contentType: "image/jpeg", contentLength: 10 },
    { contentType: undefined, contentLength: 10 },
    { contentType: "image/png", contentLength: undefined },
    { contentType: "image/png", contentLength: 0 },
    { contentType: "image/png", contentLength: -1 },
    { contentType: "image/png", contentLength: 1.5 },
    { contentType: "image/png", contentLength: 8 * 1024 * 1024 + 1 },
  ])("rejects unexpected stored metadata %j", async (metadata) => {
    storage.metadata.mockResolvedValue(metadata);
    expect((await request(app).get(publicUrl(key))).status).toBe(404);
    expect(storage.sign).not.toHaveBeenCalled();
  });

  it("accepts the upload size boundary without reading image bytes", async () => {
    storage.metadata.mockResolvedValue({
      contentType: "image/png",
      contentLength: 8 * 1024 * 1024,
    });
    expect((await request(app).get(publicUrl(key))).status).toBe(302);
  });

  it("never uses query input to choose or sign an object", async () => {
    await request(app)
      .get(publicUrl(key))
      .query({
        key: `tenants/${tenant}/communications/private.png`,
        expires: 99999,
      });
    expect(storage.metadata).toHaveBeenCalledExactlyOnceWith({ key });
    expect(storage.sign).toHaveBeenCalledWith(
      expect.objectContaining({ key, expiresInSeconds: 300 }),
    );
  });

  it.each([
    { name: "NotFound" },
    { name: "NoSuchKey" },
    { $metadata: { httpStatusCode: 404 } },
  ])("returns 404 for a missing object", async (error) => {
    storage.metadata.mockRejectedValue(error);
    const result = await request(app).get(publicUrl(key));
    expect(result.status).toBe(404);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(storage.sign).not.toHaveBeenCalled();
  });

  it.each(["metadata", "sign"] as const)(
    "does not leak provider errors from %s",
    async (operation) => {
      storage[operation].mockRejectedValue(
        new Error("private-bucket secret-provider-detail"),
      );
      const result = await request(app).get(publicUrl(key));
      expect(result.status).toBe(503);
      expect(result.body.code).toBe("PUBLIC_MEDIA_UNAVAILABLE");
      expect(JSON.stringify(result.body)).not.toContain(
        "secret-provider-detail",
      );
      expect(result.headers.location).toBeUndefined();
    },
  );

  it("bounds anonymous metadata lookups, including misses, before storage I/O", async () => {
    storage.metadata.mockRejectedValue({ name: "NotFound" });
    for (let index = 0; index < 600; index += 1) {
      expect((await request(app).get(publicUrl(key))).status).toBe(404);
    }
    const result = await request(app).get(publicUrl(key));
    expect(result.status).toBe(429);
    expect(result.body.code).toBe("PUBLIC_MEDIA_RATE_LIMITED");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(storage.metadata).toHaveBeenCalledTimes(600);
    expect(storage.sign).not.toHaveBeenCalled();
  });
});
