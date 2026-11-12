export const DATA_IMPORT_ENTITY = {
  CUSTOMERS: "customers",
  PRODUCTS: "products",
  BOOKINGS: "bookings",
  MEMBERSHIP_PLANS: "membership-plans",
  MEMBERSHIPS: "memberships",
  CREDITS: "credits",
  VOUCHER_PRODUCTS: "voucher-products",
  VOUCHERS: "vouchers",
} as const;

export type DataImportEntity =
  (typeof DATA_IMPORT_ENTITY)[keyof typeof DATA_IMPORT_ENTITY];

export const DATA_IMPORT_STATUS = {
  UPLOADED: "uploaded",
  VALIDATING: "validating",
  VALIDATED: "validated",
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export const DATA_IMPORT_ROW_STATUS = {
  PENDING: "pending",
  VALID: "valid",
  INVALID: "invalid",
  PROCESSING: "processing",
  CREATED: "created",
  UPDATED: "updated",
  SKIPPED: "skipped",
  FAILED: "failed",
} as const;

export const DATA_IMPORT_ROLLBACK_STATUS = {
  UNAVAILABLE: "unavailable",
  AVAILABLE: "available",
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  PARTIAL: "partial",
  BLOCKED: "blocked",
  FAILED: "failed",
} as const;

export type DataImportRollbackStatus =
  (typeof DATA_IMPORT_ROLLBACK_STATUS)[keyof typeof DATA_IMPORT_ROLLBACK_STATUS];

export const DATA_IMPORT_MUTATION_OPERATION = {
  CREATE: "create",
  UPDATE: "update",
  DELTA: "delta",
} as const;

export const DATA_IMPORT_MUTATION_ROLLBACK_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPENSATED: "compensated",
  BLOCKED: "blocked",
  FAILED: "failed",
} as const;

export const DATA_IMPORT_ROLLBACK_REASON = {
  LEGACY_MANIFEST_MISSING: "legacy_manifest_missing",
  IMPORT_NOT_COMPLETED: "import_not_completed",
  RECORD_MISSING: "record_missing",
  RECORD_CHANGED: "record_changed",
  DEPENDENT_ACTIVITY: "dependent_activity",
  TERMINAL_STATE: "terminal_state",
  INSUFFICIENT_BALANCE: "insufficient_balance",
  UNIQUE_CONFLICT: "unique_conflict",
  RETRYABLE_FAILURE: "retryable_failure",
  RETENTION_EXPIRED: "retention_expired",
  ALREADY_COMPENSATED: "already_compensated",
  MANIFEST_INCONSISTENT: "manifest_inconsistent",
  MANIFEST_COUNT_MISMATCH: "manifest_count_mismatch",
  NO_IMPORTED_MUTATIONS: "no_imported_mutations",
} as const;

export const DATA_IMPORT_DUPLICATE_STRATEGY = {
  SKIP: "skip",
  UPDATE: "update",
} as const;

export type DataImportDuplicateStrategy =
  (typeof DATA_IMPORT_DUPLICATE_STRATEGY)[keyof typeof DATA_IMPORT_DUPLICATE_STRATEGY];

export const CUSTOMER_IMPORT_FIELDS = [
  "fullName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "memberNumber",
  "externalId",
  "passwordHash",
] as const;

export type CustomerImportField = (typeof CUSTOMER_IMPORT_FIELDS)[number];

export const PRODUCT_IMPORT_FIELDS = [
  "name",
  "kind",
  "description",
  "sku",
  "price",
  "extraCharge",
  "currency",
  "capacity",
  "bookingMode",
  "isActive",
  "sortOrder",
  "externalId",
] as const;

export type ProductImportField = (typeof PRODUCT_IMPORT_FIELDS)[number];

export const BOOKING_IMPORT_FIELDS = [
  "externalId",
  "customerExternalId",
  "customerEmail",
  "customerPhone",
  "productExternalId",
  "productSku",
  "productName",
  "locationCode",
  "locationSlug",
  "locationName",
  "start",
  "end",
  "date",
  "startTime",
  "endTime",
  "numberOfGuests",
  "status",
  "language",
  "plannedActivity",
  "lecturer",
  "description",
  "note",
] as const;

export type BookingImportField = (typeof BOOKING_IMPORT_FIELDS)[number];

export const MEMBERSHIP_PLAN_IMPORT_FIELDS = [
  "externalId",
  "name",
  "description",
  "terms",
  "price",
  "currency",
  "billingType",
  "billingInterval",
  "intervalCount",
  "durationDays",
  "locationScope",
  "locationCodes",
  "creditAllowance",
  "discountPercent",
  "customPerk",
  "benefits",
  "status",
  "sortOrder",
] as const;
export type MembershipPlanImportField =
  (typeof MEMBERSHIP_PLAN_IMPORT_FIELDS)[number];

export const MEMBERSHIP_IMPORT_FIELDS = [
  "externalId",
  "customerExternalId",
  "customerEmail",
  "customerPhone",
  "planExternalId",
  "planName",
  "planVersion",
  "locationCode",
  "locationSlug",
  "locationName",
  "status",
  "startedAt",
  "periodStart",
  "periodEnd",
  "cancelledAt",
  "currency",
  "amount",
  "allowanceBalances",
  "note",
] as const;
export type MembershipImportField = (typeof MEMBERSHIP_IMPORT_FIELDS)[number];

export const CREDIT_IMPORT_FIELDS = [
  "externalId",
  "customerExternalId",
  "customerEmail",
  "customerPhone",
  "balance",
  "currency",
  "note",
] as const;
export type CreditImportField = (typeof CREDIT_IMPORT_FIELDS)[number];

export const VOUCHER_PRODUCT_IMPORT_FIELDS = [
  "externalId",
  "name",
  "description",
  "sku",
  "value",
  "currency",
  "isActive",
  "sortOrder",
] as const;
export type VoucherProductImportField =
  (typeof VOUCHER_PRODUCT_IMPORT_FIELDS)[number];

export const VOUCHER_IMPORT_FIELDS = [
  "externalId",
  "promoCode",
  "productExternalId",
  "productSku",
  "productName",
  "value",
  "currency",
  "status",
  "expiresAt",
  "redeemedAt",
  "customerExternalId",
  "customerEmail",
  "customerPhone",
  "note",
] as const;
export type VoucherImportField = (typeof VOUCHER_IMPORT_FIELDS)[number];

export const DATA_IMPORT_LIMITS = Object.freeze({
  MAX_FILE_BYTES: 5 * 1024 * 1024,
  MAX_ROWS: 10_000,
  MAX_COLUMNS: 100,
  MAX_CELL_LENGTH: 2_000,
  MAX_HEADER_LENGTH: 120,
  PREVIEW_ROWS: 50,
  ROW_RETENTION_DAYS: 90,
});

export const DATA_IMPORT_ALLOWED_MIME_TYPES = Object.freeze([
  "text/csv",
  "text/plain",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);
