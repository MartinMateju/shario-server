import type { Types } from "mongoose";

import type {
  BookingImportField,
  CreditImportField,
  CustomerImportField,
  DataImportDuplicateStrategy,
  MembershipImportField,
  MembershipPlanImportField,
  ProductImportField,
  VoucherImportField,
  VoucherProductImportField,
} from "./data-import.constants.js";

export type ImportColumnMappingFor<Field extends string> = Partial<
  Record<Field, string>
>;
export type ImportColumnMapping = ImportColumnMappingFor<CustomerImportField>;
export type ProductImportColumnMapping =
  ImportColumnMappingFor<ProductImportField>;
export type BookingImportColumnMapping =
  ImportColumnMappingFor<BookingImportField>;
export type MembershipPlanImportColumnMapping =
  ImportColumnMappingFor<MembershipPlanImportField>;
export type MembershipImportColumnMapping =
  ImportColumnMappingFor<MembershipImportField>;
export type CreditImportColumnMapping =
  ImportColumnMappingFor<CreditImportField>;
export type VoucherProductImportColumnMapping =
  ImportColumnMappingFor<VoucherProductImportField>;
export type VoucherImportColumnMapping =
  ImportColumnMappingFor<VoucherImportField>;

export type ParsedImportFile = {
  headers: string[];
  rows: Array<Record<string, string>>;
  sheetName: string | null;
};

export type ImportIssue = {
  code: string;
  field?:
    | CustomerImportField
    | ProductImportField
    | BookingImportField
    | MembershipPlanImportField
    | MembershipImportField
    | CreditImportField
    | VoucherProductImportField
    | VoucherImportField;
  severity: "warning" | "error";
  message: string;
};

export type NormalizedCustomerImportRow = {
  firstname: string;
  lastname: string;
  email?: string;
  phone?: string;
  memberNumber?: number;
  memberNumberProvided?: boolean;
  memberNumberOwnerId?: string;
  memberNumberOwnerUpdatedAt?: string;
  memberNumberResolution?:
    | "requested"
    | "keep_existing"
    | "allocate_collision"
    | "displace_customer";
  externalId?: string;
  passwordHashProvided?: boolean;
};

export type CustomerDuplicate = {
  kind: "externalId" | "email" | "phone" | "file";
  existingUserId?: Types.ObjectId;
  rowNumber?: number;
};

export type ExecuteCustomerImportOptions = {
  duplicateStrategy: DataImportDuplicateStrategy;
};

export type NormalizedProductImportRow = {
  name: string;
  kind: "open-studio" | "class" | "voucher" | "private-studio" | "";
  type: "workshop" | "course" | "coupon" | "blocker" | "";
  description: string;
  sku: string;
  price: number | null;
  extraCharge: number | null;
  currency: string;
  capacity: number | null;
  bookingMode: "public" | "private" | null;
  isActive: boolean | null;
  sortOrder: number | null;
  externalId?: string;
  providedFields: ProductImportField[];
  kindInput: string;
  parseErrors: ProductImportField[];
};

export type NormalizedBookingImportRow = {
  externalId?: string;
  customerExternalId?: string;
  customerEmail?: string;
  customerPhone?: string;
  productExternalId?: string;
  productSku?: string;
  productName?: string;
  locationCode?: string;
  locationSlug?: string;
  locationName?: string;
  start: string;
  end: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  numberOfGuests: number | null;
  numberOfGuestsProvided: boolean;
  status: string;
  language: string;
  plannedActivity: string;
  lecturer: string;
  description: string;
  note: string;
  customerId?: string;
  productId?: string;
  locationId?: string;
  tag?: "open-studio" | "class" | "private-studio";
  productKind?: "open-studio" | "class" | "private-studio";
  bookingMode?: "public" | "private" | null;
  durationHours?: number;
  fingerprint?: string;
  resolvedTimezone?: string;
  providedFields: BookingImportField[];
  parseErrors: BookingImportField[];
};

export type NormalizedMembershipPlanImportRow = {
  externalId?: string;
  name: string;
  description: string;
  terms: string;
  price: number | null;
  currency: string;
  billingType: "fixed" | "recurring" | "";
  billingInterval: "month" | "year" | "";
  intervalCount: number | null;
  durationDays: number | null;
  locationScope: "all" | "selected" | "";
  locationCodes: string[];
  creditAllowance: number | null;
  discountPercent: number | null;
  customPerk: string;
  benefits: unknown[] | null;
  sortOrder: number | null;
  status: "published" | "archived" | "";
  locationIds?: string[];
  fingerprint?: string;
  expectedVersionCounter?: number;
  expectedPublishedVersionId?: string;
  expectedUpdatedAt?: string;
  providedFields: MembershipPlanImportField[];
  parseErrors: MembershipPlanImportField[];
};

export type NormalizedMembershipImportRow = {
  externalId?: string;
  customerExternalId?: string;
  customerEmail?: string;
  customerPhone?: string;
  planExternalId?: string;
  planName: string;
  planVersion: number | null;
  locationCode?: string;
  locationSlug?: string;
  locationName?: string;
  status: string;
  startedAt: string;
  periodStart: string;
  periodEnd: string;
  cancelledAt: string;
  currency: string;
  amount: number | null;
  allowanceBalances: Record<string, number> | null;
  note: string;
  customerId?: string;
  planId?: string;
  planVersionId?: string;
  selectedLocationId?: string;
  fingerprint?: string;
  amountMinor?: number;
  allowanceTargets?: Record<string, number>;
  expectedUpdatedAt?: string;
  providedFields: MembershipImportField[];
  parseErrors: MembershipImportField[];
};

export type NormalizedCreditImportRow = {
  externalId?: string;
  customerExternalId?: string;
  customerEmail?: string;
  customerPhone?: string;
  balance: number | null;
  currency: string;
  note: string;
  customerId?: string;
  fingerprint?: string;
  balanceMinor?: number;
  providedFields: CreditImportField[];
  parseErrors: CreditImportField[];
};

export type NormalizedVoucherProductImportRow = {
  externalId?: string;
  name: string;
  description: string;
  sku: string;
  value: number | null;
  currency: string;
  isActive: boolean | null;
  sortOrder: number | null;
  fingerprint?: string;
  expectedUpdatedAt?: string;
  providedFields: VoucherProductImportField[];
  parseErrors: VoucherProductImportField[];
};

export type NormalizedVoucherImportRow = {
  externalId?: string;
  promoCode: string;
  productExternalId?: string;
  productSku?: string;
  productName?: string;
  status: string;
  value: number | null;
  currency: string;
  expiresAt: string;
  redeemedAt: string;
  customerExternalId?: string;
  customerEmail?: string;
  customerPhone?: string;
  note: string;
  customerId?: string;
  productId?: string;
  fingerprint?: string;
  valueMinor?: number;
  expectedUpdatedAt?: string;
  providedFields: VoucherImportField[];
  parseErrors: VoucherImportField[];
};
