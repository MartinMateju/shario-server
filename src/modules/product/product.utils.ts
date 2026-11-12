import crypto from "crypto";
import path from "path";
import { serializeCourseContent } from "./product.course-content.js";

import { badRequest } from "../../shared/http/httpErrors.js";
import {
  COUPON_TEMPLATE_MAX_MB,
} from "./product.constants.js";
import {
  normalizeOpenStudioBookingMode,
  normalizeProductOpenStudioBookingMode,
  DEFAULT_OPEN_STUDIO_POLICY,
  normalizeProductKindV2,
  PRODUCT_KIND,
  resolveLegacyProductTypeV2,
  type OpenStudioBookingMode,
  type ProductOpenStudioBookingMode,
  type OpenStudioPolicy,
  type ProductKind,
} from "./product-kind-v2.contract.js";
import type {
  ProductAttributes,
  ProductCatalogDto,
  ProductDocument,
  ProductPublicDto,
  ProductVoucherCatalogDto,
  UploadedFileLike,
} from "./product.types.js";

export const slugify = (value = ""): string => {
  return String(value)
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
};

export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type ProductTaxonomySource = {
  type?: unknown;
  kind?: unknown;
  bookingMode?: unknown;
  openStudioPolicy?: Partial<OpenStudioPolicy> | null;
};

/**
 * Dual-read helper for the additive product taxonomy. Explicit V2 data wins;
 * only unambiguous historical types are projected. Ambiguous legacy products
 * intentionally return null so they stay visible for review/retirement
 * without being silently reclassified.
 */
export const resolveProductKindV2 = (
  product: ProductTaxonomySource,
): ProductKind | null => {
  const explicit = normalizeProductKindV2(product.kind);
  if (explicit) return explicit;

  const legacy = resolveLegacyProductTypeV2(product.type);
  return legacy.status === "mapped" ? legacy.kind : null;
};

/**
 * Returns the configured Open Studio product mode. The persisted V2 field wins;
 * historical public/private workshop types use their one-mode policy and a
 * generic workshop defaults to public. Party size is deliberately absent
 * from this function: adding guests never changes sharing semantics.
 */
export const resolveProductOpenStudioBookingModeV2 = (
  product: ProductTaxonomySource,
): ProductOpenStudioBookingMode | null => {
  if (resolveProductKindV2(product) !== PRODUCT_KIND.OPEN_STUDIO) return null;

  const explicit = normalizeProductOpenStudioBookingMode(product.bookingMode);
  if (explicit) return explicit;

  const legacy = resolveLegacyProductTypeV2(product.type);
  return legacy.status === "mapped"
    ? (legacy.openStudioBookingPolicy?.defaultMode ?? null)
    : null;
};

export const resolveOpenStudioPolicy = (
  policy?: Partial<OpenStudioPolicy> | null,
): OpenStudioPolicy => ({
  publicCapacityMode: policy?.publicCapacityMode ?? DEFAULT_OPEN_STUDIO_POLICY.publicCapacityMode,
  publicCapacityLimit: policy?.publicCapacityMode === "fixed" ? (policy.publicCapacityLimit ?? null) : null,
  privateBookingSurcharge: policy?.privateBookingSurcharge ?? 0,
});

export const isCustomerChoiceOpenStudioProduct = (
  product: ProductTaxonomySource,
): boolean => resolveProductOpenStudioBookingModeV2(product) === "customer-choice";

/** A customer-choice product requires an explicit, valid reservation mode. */
export const resolveRequestedOpenStudioBookingMode = (
  product: ProductTaxonomySource,
  requested?: unknown,
): OpenStudioBookingMode | null => {
  const configured = resolveProductOpenStudioBookingModeV2(product);
  return configured === "customer-choice"
    ? normalizeOpenStudioBookingMode(requested)
    : configured;
};

export const resolveProductPublicCapacityLimit = (
  product: ProductTaxonomySource,
): number | null => {
  if (resolveProductOpenStudioBookingModeV2(product) !== "customer-choice") return null;
  const policy = resolveOpenStudioPolicy(product.openStudioPolicy);
  return policy.publicCapacityMode === "fixed" ? policy.publicCapacityLimit : null;
};

export const resolveProductPrivateBookingSurcharge = (
  product: ProductTaxonomySource,
): number => resolveProductOpenStudioBookingModeV2(product) === "customer-choice"
  ? resolveOpenStudioPolicy(product.openStudioPolicy).privateBookingSurcharge
  : 0;

export const buildCouponTemplateKey = (productName: string): string => {
  const safeName =
    slugify(productName || "coupon-template") || "coupon-template";
  return `coupon-templates/${safeName}-${crypto.randomUUID()}.pdf`;
};

export const assertValidPdfFile = (
  file: UploadedFileLike | undefined,
  maxMb = COUPON_TEMPLATE_MAX_MB,
): UploadedFileLike => {
  if (!file) {
    badRequest("Missing PDF file. Use multipart field name: file.");
  }

  const maxBytes = maxMb * 1024 * 1024;

  if (file.size > maxBytes) {
    badRequest(`PDF too large. Max ${maxMb}MB.`);
  }

  const isPdfMime = file.mimetype === "application/pdf";
  const ext = path.extname(file.originalname || "").toLowerCase();
  const looksPdf = ext === ".pdf";

  const magicOk =
    Buffer.isBuffer(file.buffer) &&
    file.buffer.length >= 4 &&
    file.buffer[0] === 0x25 &&
    file.buffer[1] === 0x50 &&
    file.buffer[2] === 0x44 &&
    file.buffer[3] === 0x46;

  if (!(magicOk && (isPdfMime || looksPdf))) {
    badRequest("Invalid file. Please upload a valid PDF.");
  }

  return file;
};

export const toProductPublicDto = (
  product: ProductDocument,
): ProductPublicDto => {
  const id = String(product._id);
  const kind = resolveProductKindV2(product);

  return {
    id,
    _id: id,
    locationId: product.location ? String(product.location) : null,
    name: product.name,
    description: product.description,
    ...(product.courseContent ? { courseContent: serializeCourseContent(product.courseContent) } : {}),
    classCategory: String(product.classCategory ?? ""),
    sku: product.sku,
    type: product.type,
    kind,
    kindContractVersion: product.kindContractVersion === 2 ? 2 : null,
    bookingMode: resolveProductOpenStudioBookingModeV2(product),
    openStudioPolicy: resolveProductOpenStudioBookingModeV2(product) === "customer-choice"
      ? resolveOpenStudioPolicy(product.openStudioPolicy)
      : null,
    price: product.price,
    extraCharge: product.extraCharge,
    maxNumberOfParticipants: product.maxNumberOfParticipants,
    currency: product.currency,
    imageSrc: product.imageSrc,
    label: product.label,
    voucherTemplate: product.voucherTemplate,
    ...(product.voucherDesign !== undefined ? { voucherDesign: product.voucherDesign ? JSON.parse(JSON.stringify(product.voucherDesign)) : null } : {}),
    couponProduct: product.couponProduct ? String(product.couponProduct) : null,
    ...(product.voucherSettings ? { voucherSettings: {
      version: product.voucherSettings.version,
      type: product.voucherSettings.type,
      validity: JSON.parse(JSON.stringify(product.voucherSettings.validity)),
      physicalDelivery: {
        enabled: product.voucherSettings.physicalDelivery?.enabled === true,
        postageFeeMinor: product.voucherSettings.physicalDelivery?.postageFeeMinor ?? 0,
      },
      experienceProductId: product.voucherSettings.experienceProductId ? String(product.voucherSettings.experienceProductId) : null,
      ...(product.voucherSettings.experienceQuantity !== undefined ? { experienceQuantity: product.voucherSettings.experienceQuantity } : {}),
      ...(product.voucherSettings.eligibleProductIds ? { eligibleProductIds: product.voucherSettings.eligibleProductIds.map(String) } : {}),
    } } : {}),
    isActive: product.isActive,
    isArchived: product.isArchived === true,
    sortOrder: product.sortOrder,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
};

/**
 * The public catalog intentionally excludes operational metadata such as SKU,
 * storage keys and related-product identifiers.
 */
export const toProductCatalogDto = (
  product:
    | ProductDocument
    | ProductPublicDto
    | (Pick<
        ProductAttributes,
        | "name"
        | "courseContent"
        | "location"
        | "description"
        | "classCategory"
        | "type"
        | "kind"
        | "kindContractVersion"
        | "bookingMode"
        | "openStudioPolicy"
        | "price"
        | "extraCharge"
        | "maxNumberOfParticipants"
        | "currency"
        | "imageSrc"
      > & {
        _id: unknown;
      }),
): ProductCatalogDto => {
  const id = String(product._id);

  return {
    id,
    _id: id,
    locationId: "locationId" in product ? product.locationId : product.location ? String(product.location) : null,
    name: product.name,
    description: product.description,
    ...(product.courseContent ? { courseContent: serializeCourseContent(product.courseContent) } : {}),
    classCategory: String(product.classCategory ?? ""),
    type: product.type,
    kind: resolveProductKindV2(product),
    kindContractVersion: product.kindContractVersion === 2 ? 2 : null,
    bookingMode: resolveProductOpenStudioBookingModeV2(product),
    openStudioPolicy: resolveProductOpenStudioBookingModeV2(product) === "customer-choice"
      ? resolveOpenStudioPolicy(product.openStudioPolicy)
      : null,
    price: product.price,
    extraCharge: product.extraCharge,
    maxNumberOfParticipants: product.maxNumberOfParticipants,
    currency: product.currency,
    imageSrc: product.imageSrc,
    isActive: true,
  };
};

export const toProductVoucherCatalogDto = (
  product: ProductPublicDto,
): ProductVoucherCatalogDto => ({
  id: product.id,
  _id: product._id,
  name: product.name,
  description: product.description,
  type: product.type,
  price: product.price,
  currency: product.currency,
  imageSrc: product.imageSrc,
  voucherTemplate: product.voucherTemplate,
  ...(product.voucherDesign ? { hasVoucherDesign: true } : {}),
  ...(product.voucherSettings ? { voucherSettings: product.voucherSettings } : {}),
  isActive: true,
});
