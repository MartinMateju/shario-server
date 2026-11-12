import { Readable } from "node:stream";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { validateImage } from "@/modules/media/image-validation.service.js";
const IMAGE_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const JPEG_2X3 = await sharp({
  create: {
    width: 2,
    height: 3,
    channels: 3,
    background: { r: 120, g: 80, b: 40 },
  },
})
  .jpeg()
  .toBuffer();
const WEBP_4X5 = await sharp({
  create: {
    width: 4,
    height: 5,
    channels: 3,
    background: { r: 120, g: 80, b: 40 },
  },
})
  .webp()
  .toBuffer();

const multerFile = ({
  buffer,
  fieldname = "file",
  mimetype = "image/png",
  originalname = "attachment.png",
}: {
  buffer: Buffer;
  fieldname?: string;
  mimetype?: string;
  originalname?: string;
}): Express.Multer.File => ({
  fieldname,
  originalname,
  encoding: "7bit",
  mimetype,
  size: buffer.length,
  buffer,
  stream: Readable.from(buffer),
  destination: "",
  filename: "",
  path: "",
});

const structuralJpeg = (width = 2, height = 3): Buffer =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x01,
    0xff,
    0xd9,
  ]);

const structuralWebp = (width = 4, height = 5): Buffer => {
  const payload = Buffer.from([
    0x00,
    0x00,
    0x00,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    (width >>> 8) & 0x3f,
    height & 0xff,
    (height >>> 8) & 0x3f,
  ]);
  const buffer = Buffer.alloc(12 + 8 + payload.length);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8 ", 12, "ascii");
  buffer.writeUInt32LE(payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
};

const withEmbeddedJpegEndMarker = (jpeg: Buffer): Buffer => {
  const appPayload = Buffer.from([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xd9, 0x01,
  ]);
  const appSegment = Buffer.alloc(appPayload.length + 4);
  appSegment[0] = 0xff;
  appSegment[1] = 0xe1;
  appSegment.writeUInt16BE(appPayload.length + 2, 2);
  appPayload.copy(appSegment, 4);

  return Buffer.concat([jpeg.subarray(0, 2), appSegment, jpeg.subarray(2)]);
};

describe("attachment image validation", () => {
  it("fully decodes and sanitizes valid JPEG, PNG, and WebP images", async () => {
    await expect(
      validateImage(
        multerFile({
          buffer: JPEG_2X3,
          mimetype: "application/octet-stream",
          originalname: "untrusted.svg",
        }),
      ),
    ).resolves.toMatchObject({
      contentType: "image/jpeg",
      width: 2,
      height: 3,
    });

    await expect(
      validateImage(multerFile({ buffer: PNG_1X1 })),
    ).resolves.toMatchObject({
      contentType: "image/png",
      width: 1,
      height: 1,
    });

    await expect(
      validateImage(
        multerFile({ buffer: WEBP_4X5, mimetype: "image/jpeg" }),
      ),
    ).resolves.toMatchObject({
      contentType: "image/webp",
      width: 4,
      height: 5,
    });
  });

  it("accepts camera metadata containing an embedded JPEG end marker", async () => {
    await expect(
      validateImage(
        multerFile({
          buffer: withEmbeddedJpegEndMarker(JPEG_2X3),
          mimetype: "image/jpeg",
        }),
      ),
    ).resolves.toMatchObject({
      contentType: "image/jpeg",
      width: 2,
      height: 3,
    });
  });

  it("rejects SVG and MIME-spoofed payloads before storage", async () => {
    const spoof = multerFile({
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      mimetype: "image/png",
      originalname: "attachment.png",
    });

    await expect(validateImage(spoof)).rejects.toMatchObject(
      expect.objectContaining({
        statusCode: 400,
        code: "IMAGE_MEDIA_TYPE_UNSUPPORTED",
      }),
    );
  });

  it("rejects a valid image with an appended polyglot payload", async () => {
    const polyglot = Buffer.concat([
      PNG_1X1,
      Buffer.from("<script>alert(1)</script>"),
    ]);

    await expect(
      validateImage(multerFile({ buffer: polyglot })),
    ).rejects.toMatchObject(
      expect.objectContaining({
        statusCode: 400,
        code: "IMAGE_INVALID",
      }),
    );

    const jpegPolyglot = Buffer.concat([
      JPEG_2X3,
      Buffer.from("<svg/onload=alert(1)>"),
      Buffer.from([0xff, 0xd9]),
    ]);
    const sanitizedJpeg = await validateImage(
      multerFile({ buffer: jpegPolyglot, mimetype: "image/jpeg" }),
    );
    expect(sanitizedJpeg.buffer.includes(Buffer.from("<svg"))).toBe(false);
    await expect(sharp(sanitizedJpeg.buffer).metadata()).resolves.toMatchObject(
      {
        format: "jpeg",
        width: 2,
        height: 3,
      },
    );
  });

  it("rejects structurally plausible but undecodable image bodies", async () => {
    await expect(
      validateImage(
        multerFile({ buffer: structuralJpeg(), mimetype: "image/jpeg" }),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "IMAGE_DECODE_FAILED",
    });
    await expect(
      validateImage(
        multerFile({ buffer: structuralWebp(), mimetype: "image/webp" }),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "IMAGE_DECODE_FAILED",
    });
  });

  it("rejects oversized files and excessive dimensions with operational 4xx errors", async () => {
    const oversized = Buffer.alloc(IMAGE_MAX_FILE_SIZE_BYTES + 1);

    await expect(
      validateImage(multerFile({ buffer: oversized })),
    ).rejects.toMatchObject(
      expect.objectContaining({
        statusCode: 413,
        code: "IMAGE_TOO_LARGE",
      }),
    );

    const excessiveDimensions = await sharp({
      create: {
        width: 12_001,
        height: 1,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .webp()
      .toBuffer();
    await expect(
      validateImage(multerFile({ buffer: excessiveDimensions })),
    ).rejects.toMatchObject(
      expect.objectContaining({
        statusCode: 400,
        code: "IMAGE_DIMENSIONS_INVALID",
      }),
    );
  });
});

