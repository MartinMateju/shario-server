import sharp from "sharp";
import { AppError } from "@/shared/http/AppError.js";
type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";
const IMAGE_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_WIDTH = 12000;
const IMAGE_MAX_HEIGHT = 12000;
const IMAGE_MAX_PIXELS = 40000000;
export type ValidatedImage = {
  buffer: Buffer;
  contentType: ImageMediaType;
  width: number;
  height: number;
};

const sanitizeDecodedImage = async ({
  buffer,
  contentType,
}: {
  buffer: Buffer;
  contentType: ImageMediaType;
}): Promise<ValidatedImage> => {
  try {
    const image = sharp(buffer, {
      failOn: "error",
      limitInputPixels: IMAGE_MAX_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const expectedFormat =
      contentType === "image/jpeg"
        ? "jpeg"
        : contentType === "image/png"
          ? "png"
          : "webp";

    if (metadata.format !== expectedFormat) {
      invalidImage("The decoded image type does not match its container.");
    }
    if (Number(metadata.pages ?? 1) !== 1) {
      invalidImage(
        "Animated or multi-page images are not supported.",
        "IMAGE_ANIMATION_UNSUPPORTED",
      );
    }

    let sanitized = image.rotate();
    if (contentType === "image/jpeg") {
      sanitized = sanitized.jpeg({
        quality: 90,
        progressive: true,
        chromaSubsampling: "4:4:4",
      });
    } else if (contentType === "image/png") {
      sanitized = sanitized.png({
        compressionLevel: 9,
        adaptiveFiltering: true,
      });
    } else {
      sanitized = sanitized.webp({ quality: 90, effort: 4 });
    }

    // toBuffer forces libvips to decode every pixel. Re-encoding strips
    // metadata and any non-image bytes before the object reaches public R2.
    const { data, info } = await sanitized.toBuffer({
      resolveWithObject: true,
    });
    assertSafeDimensions(info.width, info.height);

    if (data.length > IMAGE_MAX_FILE_SIZE_BYTES) {
      throw new AppError({
        statusCode: 413,
        code: "IMAGE_TOO_LARGE",
        message: `The sanitized image must be at most ${IMAGE_MAX_FILE_SIZE_BYTES} bytes.`,
      });
    }

    return {
      buffer: data,
      contentType,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;

    invalidImage(
      "The image payload could not be fully decoded.",
      "IMAGE_DECODE_FAILED",
    );
  }
};

const invalidImage = (
  message: string,
  code = "IMAGE_INVALID",
): never => {
  throw new AppError({
    statusCode: 400,
    code,
    message,
  });
};

const assertSafeDimensions = (width: number, height: number): void => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > IMAGE_MAX_WIDTH ||
    height > IMAGE_MAX_HEIGHT ||
    width * height > IMAGE_MAX_PIXELS
  ) {
    invalidImage(
      `Image dimensions must be between 1x1 and ${IMAGE_MAX_WIDTH}x${IMAGE_MAX_HEIGHT}, with at most ${IMAGE_MAX_PIXELS} pixels.`,
      "IMAGE_DIMENSIONS_INVALID",
    );
  }
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_END = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const detectImageType = (buffer: Buffer): ImageMediaType => {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    if (
      buffer[buffer.length - 2] !== 0xff ||
      buffer[buffer.length - 1] !== 0xd9
    ) {
      invalidImage("The JPEG payload is incomplete or contains trailing data.");
    }
    return "image/jpeg";
  }

  if (
    buffer.length >= PNG_SIGNATURE.length + PNG_END.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    if (!buffer.subarray(-PNG_END.length).equals(PNG_END)) {
      invalidImage("The PNG payload is incomplete or contains trailing data.");
    }
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (buffer.readUInt32LE(4) + 8 !== buffer.length) {
      invalidImage("The WebP payload is incomplete or contains trailing data.");
    }
    return "image/webp";
  }

  invalidImage(
    "Only valid JPEG, PNG, and non-animated WebP images are allowed.",
    "IMAGE_MEDIA_TYPE_UNSUPPORTED",
  );
};
export const validateImage = async (
  file: Express.Multer.File,
): Promise<ValidatedImage> => {
  const buffer = file?.buffer;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    invalidImage("The uploaded image is empty.");
  }

  if (
    buffer.length > IMAGE_MAX_FILE_SIZE_BYTES ||
    file.size > IMAGE_MAX_FILE_SIZE_BYTES
  ) {
    throw new AppError({
      statusCode: 413,
      code: "IMAGE_TOO_LARGE",
      message: `Each image must be at most ${IMAGE_MAX_FILE_SIZE_BYTES} bytes.`,
    });
  }

  const contentType = detectImageType(buffer);
  return sanitizeDecodedImage({ buffer, contentType });
};

