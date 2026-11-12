import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteObjectFromR2: vi.fn(),
  getR2PublicUrl: vi.fn(),
  uploadBufferToR2: vi.fn(),
}));

vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  deleteObjectFromR2: mocks.deleteObjectFromR2,
  getR2PublicUrl: mocks.getR2PublicUrl,
  uploadBufferToR2: mocks.uploadBufferToR2,
}));

import {
  deleteUploadedProductImage,
  uploadProductImage,
} from "@/modules/product/services/product-image.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const png = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 51, g: 103, b: 214 },
    },
  })
    .png()
    .toBuffer();

const imageFile = (buffer: Buffer, mimetype = "image/png") => ({
  originalname: "class.png",
  mimetype,
  size: buffer.byteLength,
  buffer,
});

describe("product image service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getR2PublicUrl.mockImplementation(
      (key: string) => `https://media.shario.test/${key}`,
    );
    mocks.uploadBufferToR2.mockResolvedValue(undefined);
    mocks.deleteObjectFromR2.mockResolvedValue(undefined);
  });

  it("sanitizes and uploads an immutable tenant-scoped product image", async () => {
    const result = await uploadProductImage({
      tenantId,
      file: imageFile(await png(1_200, 800)),
    });

    expect(result.key).toMatch(
      new RegExp(`^tenants/${tenantId}/products/[0-9]+-[0-9a-f-]+\\.png$`),
    );
    expect(result.url).toBe(`https://media.shario.test/${result.key}`);
    expect(mocks.uploadBufferToR2).toHaveBeenCalledWith({
      key: result.key,
      buffer: expect.any(Buffer),
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    });
  });

  it("rejects declared image content that cannot be decoded", async () => {
    await expect(
      uploadProductImage({
        tenantId,
        file: imageFile(Buffer.from("not a png")),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PRODUCT_IMAGE_DECODE_FAILED",
    });

    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
  });

  it("rejects a decoded image whose bytes do not match its declared type", async () => {
    await expect(
      uploadProductImage({
        tenantId,
        file: imageFile(await png(320, 240), "image/jpeg"),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PRODUCT_IMAGE_INVALID_CONTENT",
    });

    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
  });

  it("rejects excessive decoded image dimensions", async () => {
    await expect(
      uploadProductImage({
        tenantId,
        file: imageFile(await png(6_001, 1)),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PRODUCT_IMAGE_DIMENSIONS_INVALID",
    });

    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
  });

  it("compensates a provider failure without changing the original error", async () => {
    const providerError = new Error("storage unavailable");
    mocks.uploadBufferToR2.mockRejectedValueOnce(providerError);

    await expect(
      uploadProductImage({
        tenantId,
        file: imageFile(await png(320, 240)),
      }),
    ).rejects.toBe(providerError);

    const key = mocks.uploadBufferToR2.mock.calls[0]![0].key;
    expect(mocks.deleteObjectFromR2).toHaveBeenCalledWith({ key });
  });

  it("deletes a known uncommitted upload by its generated key", async () => {
    const key = `tenants/${tenantId}/products/uncommitted.webp`;

    await expect(deleteUploadedProductImage({ key })).resolves.toBe(true);
    expect(mocks.deleteObjectFromR2).toHaveBeenCalledWith({ key });
  });

  it("does not hide a mutation failure when rollback cleanup also fails", async () => {
    mocks.deleteObjectFromR2.mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    await expect(
      deleteUploadedProductImage({
        key: `tenants/${tenantId}/products/uncommitted.png`,
      }),
    ).resolves.toBe(false);
  });
});
