import type { HydratedDocument, Model, Types } from "mongoose";
import type { VoucherDesign } from "@/modules/coupon/voucher-design.js";
import type { CourseContent } from "./product.course-content.js";

import type {
  ProductCurrency,
  ProductType,
} from "./product.constants.js";
import type {
  ProductOpenStudioBookingMode,
  OpenStudioPolicy,
  ProductKind,
} from "./product-kind-v2.contract.js";

export type ProductId = string;

export type VoucherValidity =
  | { mode: "months"; months: number }
  | { mode: "date"; date: string }
  | { mode: "none" };

export type VoucherSettings = {
  version: 1;
  type: "value" | "experience";
  validity: VoucherValidity;
  experienceProductId?: Types.ObjectId | string | null;
  experienceQuantity?: number;
  eligibleProductIds?: Array<Types.ObjectId | string>;
  /** Optional postal fulfilment by the studio; the fee is charged once per order. */
  physicalDelivery?: {
    enabled: boolean;
    postageFeeMinor: number;
  };
};

export type VoucherSettingsDto = Omit<VoucherSettings, "experienceProductId" | "eligibleProductIds"> & {
  experienceProductId?: string | null;
  eligibleProductIds?: string[];
};

export type ProductAttributes = {
  courseContent?: CourseContent;
  tenant: Types.ObjectId;
  createdBy: Types.ObjectId;
  /** Absent/null on legacy products until explicitly assigned. */
  location?: Types.ObjectId | null;
  name: string;
  description: string;
  /** Missing on historical records created before class categories. */
  classCategory?: string;
  sku: string;
  type: ProductType;
  /** Missing on historical records until the additive V2 backfill runs. */
  kind?: ProductKind;
  kindContractVersion?: 2;
  bookingMode?: ProductOpenStudioBookingMode | null;
  openStudioPolicy?: OpenStudioPolicy | null;
  price: number;
  extraCharge: number;
  maxNumberOfParticipants: number | null;
  waitlistDefaults?: {
    enabled: boolean;
    autoPromote: boolean;
    offerWindowHours: number;
    cutoffHours: number;
  };
  currency: ProductCurrency;
  imageSrc: string;
  label: string;
  stripeProductId: string;
  stripePriceId: string;
  voucherTemplate: string;
  couponProduct: Types.ObjectId | null;
  /** Absent on historical offerings; only new issuance resolves the 12-month default. */
  voucherSettings?: VoucherSettings;
  voucherDesign?: VoucherDesign | null;
  importMetadata?: {
    source: "csv" | "xlsx";
    importId: string;
    importKey: string;
    externalId?: string;
    fingerprint?: string;
    lastMutationKey?: string;
    importedAt: Date;
    importedBy: Types.ObjectId;
  };
  isActive: boolean;
  isArchived?: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductDocument = HydratedDocument<ProductAttributes>;
export type ProductModel = Model<ProductAttributes>;

export type ProductListFilters = {
  tenantId: string;
  locationId?: string;
  allowedLocationIds?: readonly string[] | null;
  includeUnassigned?: boolean;
  assignedStudioOnly?: boolean;
  coursePublicationLocationId?: string;
  type?: ProductType;
  types?: readonly ProductType[];
  isActive?: boolean;
  search?: string;
  page?: number;
  limit?: number;
};

export type UploadedFileLike = {
  fieldname?: string;
  originalname?: string;
  mimetype?: string;
  size: number;
  buffer: Buffer;
};

export type ProductPublicDto = {
  courseContent?: CourseContent;
  id: string;
  locationId: string | null;
  /**
   * Temporary compatibility alias for older booking and coupon screens.
   * New clients should use `id`.
   */
  _id: string;
  name: string;
  description: string;
  classCategory: string;
  sku: string;
  type: ProductType;
  kind: ProductKind | null;
  kindContractVersion: 2 | null;
  bookingMode: ProductOpenStudioBookingMode | null;
  openStudioPolicy: OpenStudioPolicy | null;
  price: number;
  extraCharge: number;
  maxNumberOfParticipants: number | null;
  currency: ProductCurrency;
  imageSrc: string;
  label: string;
  voucherTemplate: string;
  couponProduct: string | null;
  voucherSettings?: VoucherSettingsDto;
  voucherDesign?: VoucherDesign | null;

  isActive: boolean;
  isArchived?: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductCatalogDto = Pick<
  ProductPublicDto,
  | "courseContent"
  | "id"
  | "_id"
  | "name"
  | "description"
  | "locationId"
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
  isActive: true;
};

export type ProductVoucherCatalogDto = Pick<
  ProductPublicDto,
  | "id"
  | "_id"
  | "name"
  | "description"
  | "type"
  | "price"
  | "currency"
  | "imageSrc"
  | "voucherTemplate"
  | "voucherSettings"
> & {
  isActive: true;
  hasVoucherDesign?: boolean;
};
