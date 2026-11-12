import crypto from "node:crypto";
import { assertTenantLocationIdsExist } from "@/modules/tenant-access/services/location-scope.service.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import { isR2ConfigurationError } from "@/config/r2-env.js";
import {
  deleteObjectFromR2,
  getR2PublicUrl,
  uploadBufferToR2,
} from "@/infrastructure/storage/r2.client.js";
import {
  PUBLIC_SITE_MEDIA_MAX_BYTES,
  PUBLIC_SITE_MEDIA_SLOT,
  type PublicSiteMediaSlot,
} from "@/modules/tenants/public-site/tenant-public-site.constants.js";
import type { UpdateTenantPublicSiteInput } from "@/modules/tenants/public-site/tenant-public-site.validators.js";
import { AppError } from "@/shared/http/AppError.js";

import {
  updateTenantPublicSiteDraft,
  getTenantPublicSiteEditorState,
  type TenantPublicSiteEditorState,
} from "./tenant-settings.service.js";

type UploadedImage = Pick<Express.Multer.File, "buffer" | "mimetype" | "size">;

const MAX_IMAGE_DIMENSION = 6_000;
const MAX_IMAGE_PIXELS = 24_000_000;

type StorageFailureDetails = {
  reason:
    | "secure_connection_failed"
    | "transport_error"
    | "provider_throttled"
    | "provider_unavailable"
    | "configuration_error"
    | "provider_rejected"
    | "provider_error";
  retryable: boolean;
};

const storageFailureDetails = (cause: unknown): StorageFailureDetails => {
  const chain: Array<Record<string, unknown>> = [];
  let current = cause;

  while (current && typeof current === "object" && chain.length < 5) {
    const source = current as Record<string, unknown>;
    chain.push(source);
    current = source.cause;
  }

  if (chain.some((source) => isR2ConfigurationError(source))) {
    return { reason: "configuration_error", retryable: false };
  }

  const labels = chain
    .flatMap((source) => [source.code, source.name])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toUpperCase());
  const messages = chain
    .map((source) => source.message)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const status = chain
    .map((source) => {
      const metadata = source.$metadata;
      return metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>).httpStatusCode
        : undefined;
    })
    .find((value): value is number => typeof value === "number");

  if (status === 408) {
    return { reason: "transport_error", retryable: true };
  }
  if (status === 429) {
    return { reason: "provider_throttled", retryable: true };
  }
  if (status !== undefined && status >= 500) {
    return { reason: "provider_unavailable", retryable: true };
  }

  const authenticationCodes = new Set([
    "ACCESSDENIED",
    "AUTHORIZATIONERROR",
    "INVALIDACCESSKEYID",
    "INVALIDTOKEN",
    "SIGNATUREDOESNOTMATCH",
  ]);
  if (
    (status !== undefined && status >= 400 && status < 500) ||
    labels.some((label) => authenticationCodes.has(label))
  ) {
    return { reason: "provider_rejected", retryable: false };
  }

  const permanentCertificateCodes = new Set([
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]);
  if (
    labels.some((label) => permanentCertificateCodes.has(label)) ||
    /certificate (?:has )?expired|self[- ]signed certificate|certificate hostname mismatch/i.test(
      messages,
    )
  ) {
    return { reason: "secure_connection_failed", retryable: false };
  }

  const secureConnectionFailure =
    labels.includes("EPROTO") || /ssl|tls|handshake/i.test(messages);
  if (secureConnectionFailure) {
    return { reason: "secure_connection_failed", retryable: true };
  }

  const transportCodes = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "REQUESTTIMEOUT",
    "TIMEOUTERROR",
  ]);
  if (
    labels.some((label) => transportCodes.has(label)) ||
    /timed?\s*out|socket hang up/i.test(messages)
  ) {
    return { reason: "transport_error", retryable: true };
  }

  return { reason: "provider_error", retryable: false };
};

const storageUnavailableError = (cause: unknown): AppError => {
  const details = storageFailureDetails(cause);
  const error = new AppError({
    statusCode: 503,
    code: "PUBLIC_SITE_MEDIA_STORAGE_UNAVAILABLE",
    message: details.retryable
      ? "Image storage is temporarily unavailable. Please try again."
      : "Image storage is unavailable. Please contact support.",
    details,
  });

  Object.defineProperty(error, "cause", {
    value: cause,
    configurable: true,
  });
  return error;
};

const byteSignatureMatches = (file: UploadedImage): boolean => {
  const mime = file.mimetype.trim().toLowerCase();
  const buffer = file.buffer;
  const bytes = (offset: number, expected: readonly number[]) =>
    expected.every((value, index) => buffer[offset + index] === value);

  return (
    (mime === "image/jpeg" &&
      buffer.length >= 3 &&
      bytes(0, [0xff, 0xd8, 0xff])) ||
    (mime === "image/png" &&
      buffer.length >= 24 &&
      bytes(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (mime === "image/webp" &&
      buffer.length >= 30 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP")
  );
};

const readJpegDimensions = (
  buffer: Buffer,
): { width: number; height: number } | null => {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame && length >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
};

const readWebpDimensions = (
  buffer: Buffer,
): { width: number; height: number } | null => {
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (
    kind === "VP8 " &&
    buffer.length >= 30 &&
    buffer[23] === 0x9d &&
    buffer[24] === 0x01 &&
    buffer[25] === 0x2a
  ) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const packed = buffer.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  return null;
};

const readDimensions = (
  file: UploadedImage,
): { width: number; height: number } | null => {
  const mime = file.mimetype.trim().toLowerCase();
  if (mime === "image/png") {
    if (file.buffer.toString("ascii", 12, 16) !== "IHDR") return null;
    return {
      width: file.buffer.readUInt32BE(16),
      height: file.buffer.readUInt32BE(20),
    };
  }
  if (mime === "image/jpeg") return readJpegDimensions(file.buffer);
  return readWebpDimensions(file.buffer);
};

const validateImage = (file: UploadedImage | undefined): UploadedImage => {
  if (!file?.buffer?.length) {
    throw new AppError({
      statusCode: 400,
      code: "PUBLIC_SITE_MEDIA_REQUIRED",
      message: "An image file is required.",
    });
  }
  if (
    file.size > PUBLIC_SITE_MEDIA_MAX_BYTES ||
    file.buffer.byteLength > PUBLIC_SITE_MEDIA_MAX_BYTES
  ) {
    throw new AppError({
      statusCode: 413,
      code: "PUBLIC_SITE_MEDIA_TOO_LARGE",
      message: "Image file is too large. Maximum size is 8MB.",
    });
  }
  if (!byteSignatureMatches(file)) {
    throw new AppError({
      statusCode: 400,
      code: "PUBLIC_SITE_MEDIA_INVALID_CONTENT",
      message: "The uploaded content does not match its image type.",
    });
  }

  const dimensions = readDimensions(file);
  if (!dimensions) {
    throw new AppError({
      statusCode: 400,
      code: "PUBLIC_SITE_MEDIA_INVALID_DIMENSIONS",
      message: "Image dimensions could not be verified.",
    });
  }
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > MAX_IMAGE_DIMENSION ||
    dimensions.height > MAX_IMAGE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw new AppError({
      statusCode: 400,
      code: "PUBLIC_SITE_MEDIA_INVALID_DIMENSIONS",
      message: "Image dimensions must not exceed 6000px or 24 megapixels.",
    });
  }
  return file;
};

const extensionFor = (mime: string): string =>
  mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";

const patchForSlot = (
  slot: PublicSiteMediaSlot,
  url: string,
): UpdateTenantPublicSiteInput => {
  switch (slot) {
    case PUBLIC_SITE_MEDIA_SLOT.LOGO:
      return { branding: { logoUrl: url } };
    case PUBLIC_SITE_MEDIA_SLOT.FAVICON:
      return { branding: { faviconUrl: url } };
    case PUBLIC_SITE_MEDIA_SLOT.COVER:
    case PUBLIC_SITE_MEDIA_SLOT.HOME_HERO:
      return { branding: { coverImageUrl: url } };
    case PUBLIC_SITE_MEDIA_SLOT.LOGIN_BACKGROUND:
      return { login: { backgroundImageUrl: url } };
    case PUBLIC_SITE_MEDIA_SLOT.REGISTER_BACKGROUND:
      return { register: { backgroundImageUrl: url } };
    case PUBLIC_SITE_MEDIA_SLOT.COURSE_HERO:
      throw new Error("Course hero requires a location-specific patch.");
  }
};

export const uploadTenantPublicSiteMedia = async ({
  tenantId,
  slot,
  file,
  revision,
  locationId,
}: {
  tenantId: string;
  slot: PublicSiteMediaSlot;
  file: UploadedImage | undefined;
  revision?: number;
  locationId?: string;
}): Promise<
  TenantPublicSiteEditorState & {
    media: { slot: PublicSiteMediaSlot; url: string };
  }
> => {
  const image = validateImage(file);
  let courseState: TenantPublicSiteEditorState | undefined;
  if (slot === PUBLIC_SITE_MEDIA_SLOT.COURSE_HERO) {
    if (!locationId) badRequest({ code: "COURSE_HERO_LOCATION_REQUIRED", message: "Select a studio location for the course image." });
    await assertTenantLocationIdsExist(tenantId, [locationId]);
    courseState = await getTenantPublicSiteEditorState(tenantId);
    const entries = courseState.draft.customerPortal.courses.locations;
    if (entries.length >= 100 && !entries.some(entry => entry.locationId === locationId.toLowerCase())) {
      badRequest("A maximum of 100 studio course-page overrides is supported.");
    }
  } else if (locationId) {
    badRequest("A studio location is only supported for course images.");
  }
  const mime = image.mimetype.trim().toLowerCase();
  const key = [
    "public-sites",
    tenantId,
    slot,
    `${Date.now()}-${crypto.randomUUID()}.${extensionFor(mime)}`,
  ].join("/");
  let url: string;

  try {
    url = getR2PublicUrl(key);
    await uploadBufferToR2({
      key,
      buffer: image.buffer,
      contentType: mime,
      cacheControl: "public, max-age=31536000, immutable",
    });
  } catch (error) {
    throw storageUnavailableError(error);
  }

  try {
    const courseLocations = courseState?.draft.customerPortal.courses.locations;
    const normalizedLocationId = locationId?.toLowerCase();
    const coursePatch = courseLocations ? {
      customerPortal: { courses: { locations: [
        ...courseLocations.filter(entry => entry.locationId !== normalizedLocationId),
        {
          ...courseLocations.find(entry => entry.locationId === normalizedLocationId),
          locationId: normalizedLocationId!,
          heroImageUrl: url,
        },
      ] } },
    } : null;
    const state = await updateTenantPublicSiteDraft({
      tenantId,
      patch: coursePatch ?? patchForSlot(slot, url),
      revision: revision ?? courseState?.editor.draftRevision,
    });
    return { ...state, media: { slot, url } };
  } catch (error) {
    await deleteObjectFromR2({ key }).catch(() => undefined);
    throw error;
  }
};
