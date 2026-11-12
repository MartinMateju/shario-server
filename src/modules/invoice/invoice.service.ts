import { randomUUID } from "node:crypto";

import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import OrderModel from "@/modules/order/order.model.js";
import { Product } from "@/modules/product/product.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { TENANT_ROLE } from "@/modules/user/user.constants.js";
import UserModel from "@/modules/user/user.model.js";
import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationsWithinWorkspaceScope,
  type AllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/services/location-scope.service.js";
import {
  badRequest,
  conflict,
  notFound,
} from "@/shared/http/httpErrors.js";
import {
  normalizeStudioCommerceCurrency,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

import InvoiceSettingsModel from "./invoice-settings.schema.js";
import InvoiceModel from "./invoice.schema.js";
import {
  assertNativeInvoicingEnabled,
  isNativeInvoicingEnabled,
} from "./invoice.feature.js";
import {
  buildActionableAutomaticInvoiceFilter,
  buildActionablePaidOrderInvoiceFilter,
  buildInvoiceAutomationFailureState,
} from "./invoice.automation.js";
import {
  assertInvoiceLocationAccess,
  buildInvoiceLocationScopeFilter,
} from "./invoice.access.js";
import {
  INVOICE_DOCUMENT_STATUS,
  INVOICE_DOCUMENT_TYPE,
  INVOICE_PAYMENT_METHOD,
  INVOICE_PAYMENT_STATUS,
  INVOICE_SEND_CLAIM_TTL_MS,
  INVOICE_SOURCE_KIND,
  MANUAL_INVOICE_PAYMENT_METHODS,
} from "./invoice.constants.js";
import {
  addInvoiceCalendarDays,
  buildInvoiceIssueDateRange,
  resolveInvoiceDateInput,
} from "./invoice.date.js";
import type { InvoiceLocale } from "./invoice.constants.js";
import { sendInvoiceEmail } from "./invoice.email.service.js";
import { buildInvoiceIssuanceSnapshot } from "./invoice-issuance-snapshot.js";
import {
  assertMinorAmount,
  assertTaxRateBps,
  calculateCreditTaxSlice,
  calculateInclusiveTax,
  majorToMinor,
  sumInvoiceLineTotals,
} from "./invoice.money.js";
import {
  allocateInvoiceNumber,
  runNumberedInvoiceTransaction,
} from "./invoice-numbering.service.js";
import { calculateInvoicePaymentState } from "./invoice.payment.js";
import { buildOrderInvoicePaymentAllocations } from "./order-invoice-snapshot.service.js";
import {
  assertSupportedInvoiceLineTaxMode,
  assertSupportedInvoiceTaxMode,
  assertValidInvoiceAutomationSettings,
  buildSellerSnapshot,
  ensureInvoiceSettings,
} from "./invoice-settings.service.js";
import type {
  CreateManualInvoiceInput,
  CreditNoteInput,
  InvoiceListInput,
  RecordInvoicePaymentInput,
  ReverseInvoicePaymentInput,
  UpdateDraftInvoiceInput,
} from "./invoice.validators.js";

const objectId = (value: unknown): mongoose.Types.ObjectId => {
  if (!mongoose.isValidObjectId(String(value ?? ""))) {
    badRequest("Invalid identifier.");
  }
  return new mongoose.Types.ObjectId(String(value));
};

const uniqueIds = (values: readonly unknown[]): mongoose.Types.ObjectId[] =>
  [...new Set(values.map(String).filter(mongoose.isValidObjectId))].map(
    (value) => new mongoose.Types.ObjectId(value),
  );

const assertDateOrder = (
  issueDate: Date | null | undefined,
  dueDate: Date | null | undefined,
): void => {
  if (issueDate && dueDate && dueDate.getTime() < issueDate.getTime()) {
    badRequest({
      message: "Due date cannot be before the issue date.",
      code: "INVOICE_DATE_ORDER_INVALID",
    });
  }
};

const hasCustomerIdentity = (customer: any): boolean =>
  Boolean(
    String(
      customer?.legalName ||
        customer?.tradingName ||
        [customer?.firstname, customer?.lastname].filter(Boolean).join(" "),
    ).trim(),
  );

const assertCustomerIdentity = (customer: any): void => {
  if (!hasCustomerIdentity(customer)) {
    badRequest({
      message: "Customer name or legal name is required before finalization.",
      code: "INVOICE_CUSTOMER_IDENTITY_REQUIRED",
    });
  }
};

const assertInvoiceLineArithmeticIntegrity = (line: any) => {
  const quantity = Number(line.quantity);
  const unitGrossMinor = assertMinorAmount(line.unitGrossMinor, "Unit amount");
  const grossAmountMinor = assertMinorAmount(line.grossAmountMinor, "Line total");
  const netAmountMinor = assertMinorAmount(line.netAmountMinor, "Line net amount");
  const taxAmountMinor = assertMinorAmount(line.taxAmountMinor, "Line tax amount");
  const taxRateBps = assertTaxRateBps(line.taxRateBps);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    badRequest("Invoice line quantity must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(unitGrossMinor * quantity) ||
    unitGrossMinor * quantity !== grossAmountMinor ||
    netAmountMinor + taxAmountMinor !== grossAmountMinor
  ) {
    conflict({
      message: "Invoice line snapshot totals are inconsistent.",
      code: "INVOICE_LINE_SNAPSHOT_INVALID",
    });
  }

  return {
    grossAmountMinor,
    netAmountMinor,
    taxAmountMinor,
    taxRateBps,
  };
};

export const assertInvoiceLineIntegrity = (line: any): void => {
  const {
    grossAmountMinor,
    netAmountMinor,
    taxAmountMinor,
    taxRateBps,
  } = assertInvoiceLineArithmeticIntegrity(line);

  const expectedTax = calculateInclusiveTax({ grossAmountMinor, taxRateBps });
  if (
    netAmountMinor !== expectedTax.netAmountMinor ||
    taxAmountMinor !== expectedTax.taxAmountMinor
  ) {
    conflict({
      message:
        "Invoice line net and tax amounts do not match its tax-inclusive gross amount and rate.",
      code: "INVOICE_LINE_TAX_SNAPSHOT_INVALID",
    });
  }
};

const assertInvoiceLinesMatchTaxMode = (
  lineItems: readonly any[],
  settings: { pricesIncludeTax: boolean; defaultTaxRateBps: number },
): void => {
  for (const line of lineItems) {
    assertSupportedInvoiceLineTaxMode(settings, line.taxRateBps);
  }
};

const assertInvoiceIntegrity = (invoice: any): void => {
  if (!invoice.lineItems?.length) {
    badRequest("Invoice must contain at least one line item.");
  }
  for (const line of invoice.lineItems) {
    // Credit notes allocate rounding residuals proportionally across partial
    // corrections. Their net/tax still must add to gross, but recalculating
    // each slice independently from the nominal rate would corrupt that exact
    // residual allocation.
    if (invoice.documentType === INVOICE_DOCUMENT_TYPE.CREDIT_NOTE) {
      assertInvoiceLineArithmeticIntegrity(line);
    } else {
      assertInvoiceLineIntegrity(line);
    }
  }
  const totals = sumInvoiceLineTotals(invoice.lineItems);
  if (
    totals.netAmountMinor !== Number(invoice.netAmountMinor) ||
    totals.taxAmountMinor !== Number(invoice.taxAmountMinor) ||
    totals.totalAmountMinor !== Number(invoice.totalAmountMinor)
  ) {
    conflict({
      message: "Invoice totals do not match its immutable line snapshots.",
      code: "INVOICE_TOTAL_SNAPSHOT_INVALID",
    });
  }
  const amountPaidMinor = assertMinorAmount(invoice.amountPaidMinor, "Paid amount");
  const amountDueMinor = assertMinorAmount(invoice.amountDueMinor, "Amount due");
  if (
    amountPaidMinor > totals.totalAmountMinor ||
    amountDueMinor !== totals.totalAmountMinor - amountPaidMinor
  ) {
    conflict({
      message: "Invoice paid and due amounts do not match its total.",
      code: "INVOICE_PAYMENT_TOTAL_INVALID",
    });
  }
  const expectedPaymentStatus =
    amountPaidMinor === 0
      ? INVOICE_PAYMENT_STATUS.UNPAID
      : amountPaidMinor === totals.totalAmountMinor
        ? INVOICE_PAYMENT_STATUS.PAID
        : INVOICE_PAYMENT_STATUS.PARTIALLY_PAID;
  if (invoice.paymentStatus !== expectedPaymentStatus) {
    conflict({
      message: "Invoice payment status does not match its paid amount.",
      code: "INVOICE_PAYMENT_STATUS_INVALID",
    });
  }
  const allocationTotal = (invoice.paymentAllocations ?? []).reduce(
    (sum: number, allocation: any) =>
      sum + assertMinorAmount(allocation.amountMinor, "Payment allocation"),
    0,
  );
  if (
    !Number.isSafeInteger(allocationTotal) ||
    allocationTotal !== Number(invoice.amountPaidMinor)
  ) {
    conflict({
      message: "Payment allocations do not match the paid amount.",
      code: "INVOICE_PAYMENT_ALLOCATION_INVALID",
    });
  }
};

const recomputeInvoicePaymentState = (invoice: any) => {
  const state = calculateInvoicePaymentState({
    totalAmountMinor: Number(invoice.totalAmountMinor),
    creditedAmountMinor: Number(invoice.creditedAmountMinor || 0),
    allocations: invoice.paymentAllocations ?? [],
  });
  invoice.amountPaidMinor = state.amountPaidMinor;
  invoice.amountDueMinor = state.amountDueMinor;
  invoice.paymentStatus = state.paymentStatus;
  return state;
};

export const assertIssuedInvoicePaymentTarget = (invoice: any): void => {
  if (invoice.documentType === INVOICE_DOCUMENT_TYPE.CREDIT_NOTE) {
    conflict({
      message: "Payments cannot be recorded against a credit note.",
      code: "CREDIT_NOTE_PAYMENT_NOT_ALLOWED",
    });
  }
  if (invoice.documentStatus !== INVOICE_DOCUMENT_STATUS.ISSUED) {
    conflict({
      message: "Payments can only be managed on an issued invoice.",
      code: "INVOICE_NOT_ISSUED",
    });
  }
};

export const assertManualInvoicePaymentReversible = (method: unknown): void => {
  if (method === "voucher") {
    conflict({
      message:
        "Voucher payments must be restored through the booking refund workflow.",
      code: "INVOICE_PAYMENT_PROVIDER_REVERSAL_NOT_ALLOWED",
    });
  }
  if (!MANUAL_INVOICE_PAYMENT_METHODS.includes(method as any)) {
    conflict({
      message:
        "Provider-managed payments cannot be reversed here. Use the provider refund workflow.",
      code: "INVOICE_PAYMENT_PROVIDER_REVERSAL_NOT_ALLOWED",
    });
  }
};

const validateManualProducts = async (
  tenantId: string,
  lines: Array<{ productId?: string }>,
): Promise<void> => {
  const ids = [...new Set(lines.map((line) => line.productId).filter(Boolean))] as string[];
  if (!ids.length) return;
  const count = await Product.countDocuments({ tenant: tenantId, _id: { $in: ids } }).exec();
  if (count !== ids.length) {
    badRequest({
      message: "One or more invoice products do not belong to this workspace.",
      code: "INVOICE_PRODUCT_SCOPE_INVALID",
    });
  }
};

const sanitizeOrderProductReferences = async (
  tenantId: string,
  lines: any[],
): Promise<void> => {
  const ids = [
    ...new Set(
      lines
        .map((line) => String(line.product?._id ?? line.product ?? ""))
        .filter(mongoose.isValidObjectId),
    ),
  ];
  if (!ids.length) return;
  const products = await Product.find({ tenant: tenantId, _id: { $in: ids } })
    .select("_id")
    .lean()
    .exec();
  const allowed = new Set(products.map((product) => String(product._id)));
  for (const line of lines) {
    const id = String(line.product?._id ?? line.product ?? "");
    if (id && !allowed.has(id)) line.product = null;
  }
};

const serializeLine = (line: any) => ({
  id: String(line._id),
  originalLineId: line.originalLineId ? String(line.originalLineId) : null,
  productId: line.product ? String(line.product) : null,
  description: line.description,
  sku: line.sku,
  quantity: line.quantity,
  unitGrossMinor: line.unitGrossMinor,
  grossAmountMinor: line.grossAmountMinor,
  netAmountMinor: line.netAmountMinor,
  taxAmountMinor: line.taxAmountMinor,
  taxRateBps: line.taxRateBps,
  creditedAmountMinor: Number(line.creditedAmountMinor || 0),
  remainingCreditAmountMinor: Math.max(
    0,
    Number(line.grossAmountMinor || 0) - Number(line.creditedAmountMinor || 0),
  ),
  locationIds: (line.locationIds ?? []).map(String),
});

export const serializePaymentAllocation = (allocation: any) => ({
  id: allocation?._id ? String(allocation._id) : null,
  method: allocation?.method,
  amountMinor: Number(allocation?.amountMinor || 0),
  reference: MANUAL_INVOICE_PAYMENT_METHODS.includes(allocation?.method)
    ? allocation?.providerReference || ""
    : "",
  paidAt: allocation?.paidAt ?? null,
  recordedAt: allocation?.recordedAt ?? null,
  recordedBy: allocation?.recordedBy ? String(allocation.recordedBy) : null,
  reversedAt: allocation?.reversedAt ?? null,
  reversedBy: allocation?.reversedBy ? String(allocation.reversedBy) : null,
  reversalReason: allocation?.reversalReason || "",
  active: !allocation?.reversedAt,
});

export const serializeInvoice = (
  invoice: any,
  options: { includePaymentAudit?: boolean } = {},
) => {
  const value = invoice?.toObject ? invoice.toObject() : invoice;
  return {
    id: String(value._id),
    tenantId: String(value.tenant),
    source: {
      kind: value.source?.kind,
      id: value.source?.id ? String(value.source.id) : null,
    },
    documentType: value.documentType,
    documentStatus: value.documentStatus,
    paymentStatus: value.paymentStatus,
    customerUserId: value.customerUser ? String(value.customerUser) : null,
    originalInvoiceId: value.originalInvoice
      ? String(value.originalInvoice)
      : null,
    originalInvoiceNumber: value.originalInvoiceNumber || "",
    creditReason: value.creditReason,
    number: value.number,
    series: value.series,
    sequence: value.sequence,
    locale: value.locale,
    timezone: value.timezone || "UTC",
    currency: value.currency,
    sellerSnapshot: value.sellerSnapshot,
    customerSnapshot: value.customerSnapshot,
    lineItems: (value.lineItems ?? []).map(serializeLine),
    locationIds: (value.locationIds ?? []).map(String),
    netAmountMinor: value.netAmountMinor,
    taxAmountMinor: value.taxAmountMinor,
    totalAmountMinor: value.totalAmountMinor,
    amountPaidMinor: value.amountPaidMinor,
    amountDueMinor: value.amountDueMinor,
    creditedAmountMinor: value.creditedAmountMinor ?? 0,
    creditStatus:
      value.documentType === INVOICE_DOCUMENT_TYPE.CREDIT_NOTE
        ? "not_applicable"
        : Number(value.creditedAmountMinor || 0) <= 0
          ? "none"
          : Number(value.creditedAmountMinor || 0) >= Number(value.totalAmountMinor || 0)
            ? "full"
            : "partial",
    ...(options.includePaymentAudit
      ? {
          paymentAllocations: (value.paymentAllocations ?? []).map(
            serializePaymentAllocation,
          ),
        }
      : {}),
    issueDate: value.issueDate,
    dueDate: value.dueDate,
    taxableSupplyDate: value.taxableSupplyDate,
    finalizedAt: value.finalizedAt,
    sentAt: value.sentAt,
    automatic: value.automatic,
    requiresReview: Boolean(value.requiresReview),
    issuanceAttempts: value.issuanceAttempts ?? 0,
    issuanceError: value.issuanceError ?? "",
    automationAttempts: value.automationAttempts ?? 0,
    automationLastAttemptAt: value.automationLastAttemptAt ?? null,
    automationNextAttemptAt: value.automationNextAttemptAt ?? null,
    automationError: value.automationError ?? "",
    deliveryLog: value.deliveryLog ?? [],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

export const serializeCustomerInvoice = (invoice: any) => {
  const value = serializeInvoice(invoice);
  return {
    id: value.id,
    documentType: value.documentType,
    documentStatus: value.documentStatus,
    paymentStatus: value.paymentStatus,
    creditStatus: value.creditStatus,
    originalInvoiceId: value.originalInvoiceId,
    originalInvoiceNumber: value.originalInvoiceNumber,
    creditReason: value.creditReason,
    number: value.number,
    locale: value.locale,
    timezone: value.timezone,
    currency: value.currency,
    sellerSnapshot: value.sellerSnapshot,
    customerSnapshot: value.customerSnapshot,
    lineItems: value.lineItems,
    netAmountMinor: value.netAmountMinor,
    taxAmountMinor: value.taxAmountMinor,
    totalAmountMinor: value.totalAmountMinor,
    amountPaidMinor: value.amountPaidMinor,
    amountDueMinor: value.amountDueMinor,
    creditedAmountMinor: value.creditedAmountMinor,
    issueDate: value.issueDate,
    dueDate: value.dueDate,
    taxableSupplyDate: value.taxableSupplyDate,
    finalizedAt: value.finalizedAt,
    createdAt: value.createdAt,
  };
};

export const normalizeCustomerSnapshot = (source: any, user?: any) => ({
  legalName: source?.legalName || source?.billing?.legalName || "",
  tradingName: source?.tradingName || "",
  firstname: source?.firstname || user?.firstname || "",
  lastname: source?.lastname || user?.lastname || "",
  email: source?.email || user?.email || "",
  phone: source?.phone || user?.phone || "",
  registrationNumber:
    source?.registrationNumber || source?.billing?.registrationNumber || "",
  taxId: source?.taxId || source?.billing?.taxId || "",
  vatId: source?.vatId || source?.billing?.vatId || "",
  address: source?.address || source?.billing?.address || {},
});

/**
 * A linked customer account is the authority for personal identity and contact
 * fields. Invoice-specific business billing fields remain editable, but a
 * caller cannot attach user A to a snapshot containing user B's name, email or
 * phone and thereby expose that snapshot through user A's customer portal.
 */
export const normalizeLinkedCustomerSnapshot = (source: any, user: any) => ({
  ...normalizeCustomerSnapshot(source),
  firstname: String(user?.firstname ?? "").trim(),
  lastname: String(user?.lastname ?? "").trim(),
  email: String(user?.email ?? "").trim().toLowerCase(),
  phone: String(user?.phone ?? "").trim(),
});

export const buildLinkableInvoiceCustomerFilter = ({
  tenantId,
  userId,
}: {
  tenantId: string;
  userId: unknown;
}) => ({
  tenant: tenantId,
  _id: userId,
  tenantRole: TENANT_ROLE.CUSTOMER,
});

const loadLinkableInvoiceCustomer = async ({
  tenantId,
  userId,
  session,
}: {
  tenantId: string;
  userId: unknown;
  session?: mongoose.ClientSession;
}) => {
  const query = UserModel.findOne(
    buildLinkableInvoiceCustomerFilter({ tenantId, userId }),
  )
    .select("_id firstname lastname email phone")
    .lean();

  if (session) query.session(session);

  const customer = await query.exec();
  if (!customer) notFound("Customer not found.");
  return customer;
};

const buildManualLines = ({
  lines,
  defaultTaxRateBps,
  pricesIncludeTax,
}: {
  lines: CreateManualInvoiceInput["lines"];
  defaultTaxRateBps: number;
  pricesIncludeTax: boolean;
}) =>
  lines.map((line) => {
    const quantity = Number(line.quantity);
    const unitGrossMinor = assertMinorAmount(line.unitGrossMinor, "Unit amount");
    const grossAmountMinor = unitGrossMinor * quantity;
    if (!Number.isSafeInteger(grossAmountMinor)) {
      badRequest("Invoice line total exceeds the supported amount range.");
    }
    const taxRateBps = assertSupportedInvoiceLineTaxMode(
      { pricesIncludeTax, defaultTaxRateBps },
      line.taxRateBps ?? defaultTaxRateBps,
    );
    const tax = calculateInclusiveTax({ grossAmountMinor, taxRateBps });
    return {
      product: line.productId ? objectId(line.productId) : null,
      description: line.description,
      sku: line.sku,
      quantity,
      unitGrossMinor,
      grossAmountMinor,
      netAmountMinor: tax.netAmountMinor,
      taxAmountMinor: tax.taxAmountMinor,
      taxRateBps,
      locationIds: uniqueIds(line.locationIds),
    };
  });

const getTenantTimezone = async (tenantId: string, session?: mongoose.ClientSession) => {
  const query = TenantModel.findById(tenantId).select("settings.timezone").lean();
  if (session) query.session(session);
  const tenant = await query.exec();
  if (!tenant) notFound("Tenant not found.");
  return tenant.settings?.timezone || "UTC";
};

const loadInvoiceOrThrow = async (tenantId: string, invoiceId: string) => {
  if (!mongoose.isValidObjectId(invoiceId)) notFound("Invoice not found.");
  const invoice = await InvoiceModel.findOne({ tenant: tenantId, _id: invoiceId }).exec();
  if (!invoice) notFound("Invoice not found.");
  return invoice;
};

export const getInvoiceById = async ({
  tenantId,
  invoiceId,
  allowedLocationIds,
}: {
  tenantId: string;
  invoiceId: string;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  const invoice = await loadInvoiceOrThrow(tenantId, invoiceId);
  assertInvoiceLocationAccess(invoice.locationIds ?? [], allowedLocationIds);
  return invoice;
};

export const getCustomerInvoiceById = async ({
  tenantId,
  invoiceId,
  userId,
}: {
  tenantId: string;
  invoiceId: string;
  userId: string;
}) => {
  assertNativeInvoicingEnabled();
  if (!mongoose.isValidObjectId(invoiceId)) notFound("Invoice not found.");
  const invoice = await InvoiceModel.findOne({
    tenant: tenantId,
    _id: invoiceId,
    customerUser: userId,
    documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
  }).exec();
  if (!invoice) notFound("Invoice not found.");
  return invoice;
};

export const listInvoices = async ({
  tenantId,
  input,
  allowedLocationIds,
  customerUserId,
}: {
  tenantId: string;
  input: InvoiceListInput;
  allowedLocationIds: AllowedWorkspaceLocationIds;
  customerUserId?: string;
}) => {
  assertNativeInvoicingEnabled();
  const filter: Record<string, any> = {
    tenant: tenantId,
    ...buildInvoiceLocationScopeFilter(allowedLocationIds),
  };
  if (customerUserId) {
    filter.customerUser = customerUserId;
    filter.documentStatus = INVOICE_DOCUMENT_STATUS.ISSUED;
  }
  if (input.documentType) filter.documentType = input.documentType;
  if (input.documentStatus && !customerUserId) {
    filter.documentStatus = input.documentStatus;
  }
  if (input.paymentStatus) filter.paymentStatus = input.paymentStatus;
  if (input.customerUserId && !customerUserId) {
    filter.customerUser = input.customerUserId;
  }
  if (input.orderId) {
    filter["source.kind"] = INVOICE_SOURCE_KIND.ORDER;
    filter["source.id"] = input.orderId;
  }
  if (input.locationId) {
    assertLocationIdsWithinWorkspaceScope(
      [input.locationId],
      allowedLocationIds,
    );
    filter.$and = [
      ...(Array.isArray(filter.$and) ? filter.$and : []),
      { locationIds: input.locationId },
    ];
  }
  if (input.dateFrom || input.dateTo) {
    const timezone = await getTenantTimezone(tenantId);
    filter.issueDate = buildInvoiceIssueDateRange({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      timezone,
    });
  }
  if (input.search) {
    const escaped = input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { number: { $regex: escaped, $options: "i" } },
      { "customerSnapshot.email": { $regex: escaped, $options: "i" } },
      { "customerSnapshot.legalName": { $regex: escaped, $options: "i" } },
      { "customerSnapshot.firstname": { $regex: escaped, $options: "i" } },
      { "customerSnapshot.lastname": { $regex: escaped, $options: "i" } },
    ];
  }

  const skip = (input.page - 1) * input.limit;
  const [invoices, total] = await Promise.all([
    InvoiceModel.find(filter).sort({ issueDate: -1, createdAt: -1 }).skip(skip).limit(input.limit).lean().exec(),
    InvoiceModel.countDocuments(filter).exec(),
  ]);

  return {
    invoices: invoices.map((invoice) =>
      customerUserId
        ? serializeCustomerInvoice(invoice)
        : serializeInvoice(invoice),
    ),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.ceil(total / input.limit),
    },
  };
};

export const createManualInvoice = async ({
  tenantId,
  userId,
  input,
  allowedLocationIds,
}: {
  tenantId: string;
  userId: string;
  input: CreateManualInvoiceInput;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  const settings = await ensureInvoiceSettings(tenantId, userId);
  assertSupportedInvoiceTaxMode(settings);
  await validateManualProducts(tenantId, input.lines);
  const timezone = await getTenantTimezone(tenantId);
  const issueDate = resolveInvoiceDateInput(input.issueDate, timezone);
  const dueDate = resolveInvoiceDateInput(input.dueDate, timezone);
  const taxableSupplyDate = resolveInvoiceDateInput(
    input.taxableSupplyDate,
    timezone,
  );
  assertDateOrder(issueDate, dueDate);

  const sourceKey = input.idempotencyKey
    ? `manual:idempotency:${input.idempotencyKey}`
    : null;
  if (sourceKey) {
    const existing = await InvoiceModel.findOne({
      tenant: tenantId,
      documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
      "source.key": sourceKey,
    }).exec();
    if (existing) {
      assertInvoiceLocationAccess(existing.locationIds ?? [], allowedLocationIds);
      return serializeInvoice(existing);
    }
  }
  const allLocationIds = uniqueIds([
    ...input.locationIds,
    ...input.lines.flatMap((line) => line.locationIds),
  ]);
  if (!allLocationIds.length) {
    assertCanAccessAllWorkspaceLocations(allowedLocationIds);
  }
  await assertTenantLocationsWithinWorkspaceScope({
    tenantId,
    locationIds: allLocationIds,
    allowedLocationIds,
  });
  let customerUser = null;
  if (input.customerUserId) {
    customerUser = await loadLinkableInvoiceCustomer({
      tenantId,
      userId: input.customerUserId,
    });
  }
  const lines = buildManualLines({
    lines: input.lines,
    defaultTaxRateBps: settings.defaultTaxRateBps,
    pricesIncludeTax: settings.pricesIncludeTax,
  });
  const totals = sumInvoiceLineTotals(lines);
  const id = new mongoose.Types.ObjectId();
  let invoice: any;
  try {
    invoice = await InvoiceModel.create({
      _id: id,
      tenant: tenantId,
      source: {
        kind: INVOICE_SOURCE_KIND.MANUAL,
        id: null,
        key: sourceKey ?? `manual:${id}`,
      },
      customerUser: customerUser?._id ?? null,
      currency: normalizeStudioCommerceCurrency(input.currency),
      sellerSnapshot: buildSellerSnapshot(settings),
      customerSnapshot: customerUser
        ? normalizeLinkedCustomerSnapshot(input.customer, customerUser)
        : normalizeCustomerSnapshot(input.customer),
      lineItems: lines,
      locationIds: allLocationIds,
      ...totals,
      amountPaidMinor: 0,
      amountDueMinor: totals.totalAmountMinor,
      paymentStatus: INVOICE_PAYMENT_STATUS.UNPAID,
      paymentAllocations: [],
      issueDate: issueDate ?? null,
      dueDate: dueDate ?? null,
      taxableSupplyDate: taxableSupplyDate ?? null,
      locale: (input.locale ?? settings.locale) as InvoiceLocale,
      timezone,
      createdBy: userId,
    });
  } catch (error: any) {
    if (error?.code !== 11000 || !sourceKey) throw error;
    invoice = await InvoiceModel.findOne({
      tenant: tenantId,
      documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
      "source.key": sourceKey,
    }).exec();
    if (!invoice) throw error;
    assertInvoiceLocationAccess(invoice.locationIds ?? [], allowedLocationIds);
  }
  return serializeInvoice(invoice);
};

const legacyOrderLines = (order: any, defaultTaxRateBps: number) => {
  const items = order.cart?.cartItems ?? [];
  return items.map((item: any) => {
    const product = item.product ?? {};
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const unitGrossMinor = majorToMinor(
      Number(item.basePrice || 0) + Number(item.extraCharge || 0),
      order.currency,
    );
    const grossAmountMinor = unitGrossMinor * quantity;
    const tax = calculateInclusiveTax({ grossAmountMinor, taxRateBps: defaultTaxRateBps });
    return {
      product: product?._id ?? item.product ?? null,
      description: product?.name || "Order item",
      sku: product?.sku || "",
      quantity,
      unitGrossMinor,
      grossAmountMinor,
      netAmountMinor: tax.netAmountMinor,
      taxAmountMinor: tax.taxAmountMinor,
      taxRateBps: defaultTaxRateBps,
      locationIds: order.locationIds ?? [],
    };
  });
};

const assertTrustedOrderSnapshot = (
  order: any,
  lines: any[],
  totals: ReturnType<typeof sumInvoiceLineTotals>,
): void => {
  for (const line of lines) assertInvoiceLineIntegrity(line);
  const grossAmountMinor = assertMinorAmount(
    order.grossAmountMinor,
    "Order gross amount",
  );
  if (grossAmountMinor !== totals.totalAmountMinor) {
    conflict({
      message: "Order line snapshots do not match the stored order total.",
      code: "ORDER_INVOICE_TOTAL_MISMATCH",
    });
  }
  if (order.isPaid) {
    const allocations = order.paymentAllocations ?? [];
    const allocated = allocations.reduce(
      (sum: number, allocation: any) =>
        sum + assertMinorAmount(allocation.amountMinor, "Payment allocation"),
      0,
    );
    if (!Number.isSafeInteger(allocated) || allocated !== totals.totalAmountMinor) {
      conflict({
        message: "Paid order allocations do not match the order total.",
        code: "ORDER_PAYMENT_ALLOCATION_MISMATCH",
      });
    }
  }
};

const reconcileIssuedOrderInvoicePayment = async ({
  tenantId,
  invoiceId,
  orderId,
  totalAmountMinor,
  currency,
  allocations,
  stripe,
}: {
  tenantId: string;
  invoiceId: string;
  orderId: string;
  totalAmountMinor: number;
  currency: string;
  allocations: any[];
  stripe: { checkoutSessionId: string; paymentIntentId: string };
}) => {
  const session = await mongoose.startSession();
  let result: any;
  try {
    await session.withTransaction(async () => {
      const current = await InvoiceModel.findOne({
        tenant: tenantId,
        _id: invoiceId,
        documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
        "source.kind": INVOICE_SOURCE_KIND.ORDER,
        "source.id": orderId,
      })
        .session(session)
        .exec();
      if (!current) notFound("Invoice not found.");
      if (current.documentStatus !== INVOICE_DOCUMENT_STATUS.ISSUED) {
        result = current;
        return;
      }
      if (
        current.currency !== currency ||
        Number(current.totalAmountMinor) !== totalAmountMinor
      ) {
        conflict({
          message:
            "The issued invoice does not match the paid order snapshot and requires manual review.",
          code: "ORDER_ISSUED_INVOICE_PAYMENT_MISMATCH",
        });
      }

      const activeAllocations = (current.paymentAllocations as any[]).filter(
        (allocation) => !allocation.reversedAt,
      );
      const alreadyContainsOrderPayment = allocations.every((expected) =>
        activeAllocations.some(
          (actual) =>
            (actual.idempotencyKey === expected.idempotencyKey ||
              (!actual.idempotencyKey &&
                actual.method === expected.method &&
                Number(actual.amountMinor) === Number(expected.amountMinor) &&
                String(actual.providerReference || "") ===
                  String(expected.providerReference || ""))) &&
            Number(actual.amountMinor) === Number(expected.amountMinor),
        ),
      );

      if (!alreadyContainsOrderPayment) {
        const currentState = recomputeInvoicePaymentState(current);
        if (currentState.amountPaidMinor !== 0 || activeAllocations.length > 0) {
          conflict({
            message:
              "The issued invoice already has other payments. Reconcile the paid order manually.",
            code: "ORDER_ISSUED_INVOICE_PAYMENT_CONFLICT",
          });
        }
        current.paymentAllocations = allocations as any;
      }

      current.stripe = stripe;
      recomputeInvoicePaymentState(current);
      if (Number(current.amountPaidMinor) !== totalAmountMinor) {
        conflict({
          message: "Paid order allocations do not settle the issued invoice.",
          code: "ORDER_ISSUED_INVOICE_PAYMENT_INCOMPLETE",
        });
      }
      await current.save({ session });
      result = current;
    });
  } catch (error) {
    if (error instanceof mongoose.Error.VersionError) {
      conflict({
        message: "Invoice payment state changed during order reconciliation.",
        code: "INVOICE_PAYMENT_VERSION_CONFLICT",
      });
    }

    const permanentReviewCodes = new Set([
      "ORDER_ISSUED_INVOICE_PAYMENT_MISMATCH",
      "ORDER_ISSUED_INVOICE_PAYMENT_CONFLICT",
      "ORDER_ISSUED_INVOICE_PAYMENT_INCOMPLETE",
    ]);
    if (permanentReviewCodes.has(String((error as any)?.code || ""))) {
      try {
        await InvoiceModel.updateOne(
          { tenant: tenantId, _id: invoiceId },
          {
            $set: {
              requiresReview: true,
              issuanceError: String(
                error instanceof Error
                  ? error.message
                  : "Paid order reconciliation requires manual review.",
              ).slice(0, 2000),
            },
          },
        ).exec();
      } catch (reviewStateError) {
        logger.warn(
          {
            err: reviewStateError,
            tenantId,
            orderId,
            invoiceId,
          },
          "Issued invoice manual-review state could not be persisted.",
        );
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return result;
};

export const createInvoiceFromOrder = async ({
  tenantId,
  orderId,
  actorUserId = null,
  automatic = false,
  finalizePaid = true,
  allowedLocationIds = null,
}: {
  tenantId: string;
  orderId: string;
  actorUserId?: string | null;
  automatic?: boolean;
  finalizePaid?: boolean;
  allowedLocationIds?: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  if (!mongoose.isValidObjectId(orderId)) notFound("Order not found.");
  const sourceKey = `order:${orderId}`;
  const order = await OrderModel.findOne({ tenant: tenantId, _id: orderId })
    .populate({
      path: "createdBy",
      match: { tenant: tenantId },
      select: "firstname lastname email phone",
    })
    .populate({
      path: "cart",
      match: { tenant: tenantId },
      populate: {
        path: "cartItems.product",
        match: { tenant: tenantId },
        select: "name sku",
      },
    })
    .exec();
  if (!order) notFound("Order not found.");
  assertInvoiceLocationAccess(order.locationIds ?? [], allowedLocationIds);
  const settings = await ensureInvoiceSettings(tenantId, actorUserId);
  assertSupportedInvoiceTaxMode(settings);
  let lines = (order.lineItems ?? []).map((line: any) =>
    line.toObject ? line.toObject() : line,
  );
  const hasTrustedSnapshot = lines.length > 0 && !order.legacyOrder;
  if (!hasTrustedSnapshot) lines = legacyOrderLines(order, settings.defaultTaxRateBps);
  if (!lines.length && Number(order.creditPurchase?.amount || 0) > 0) {
    const grossAmountMinor =
      Number(order.grossAmountMinor || 0) ||
      Number(order.expectedAmountMinor || 0) ||
      majorToMinor(order.creditPurchase.amount, order.currency);
    const tax = calculateInclusiveTax({
      grossAmountMinor,
      taxRateBps: settings.defaultTaxRateBps,
    });
    lines = [
      {
        product: null,
        description: "Studio credits",
        sku: "",
        quantity: 1,
        unitGrossMinor: grossAmountMinor,
        grossAmountMinor,
        netAmountMinor: tax.netAmountMinor,
        taxAmountMinor: tax.taxAmountMinor,
        taxRateBps: settings.defaultTaxRateBps,
        locationIds: [],
      },
    ];
  }
  if (!lines.length) conflict("Order does not contain trustworthy invoice lines.");
  await sanitizeOrderProductReferences(tenantId, lines);
  const totals = sumInvoiceLineTotals(lines);
  if (hasTrustedSnapshot) assertTrustedOrderSnapshot(order, lines, totals);
  const locationIds = uniqueIds([
    ...(order.locationIds ?? []),
    ...lines.flatMap((line: any) => line.locationIds ?? []),
  ]);
  const user = order.createdBy as any;
  const paid = Boolean(order.isPaid);
  const requiresReview = !hasTrustedSnapshot;
  const allocations =
    paid && hasTrustedSnapshot
      ? buildOrderInvoicePaymentAllocations({
          orderId: order._id,
          allocations: order.paymentAllocations ?? [],
          paidAt: order.paidAt,
        })
      : [];
  const issueDate = order.paidAt ?? new Date();
  const timezone = await getTenantTimezone(tenantId);

  const existing = await InvoiceModel.findOne({
    tenant: tenantId,
    documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
    "source.key": sourceKey,
  }).exec();
  if (existing) {
    assertInvoiceLocationAccess(existing.locationIds ?? [], allowedLocationIds);
    await OrderModel.updateOne(
      { tenant: tenantId, _id: orderId },
      { $set: { invoice: existing._id } },
    ).exec();
    if (
      paid &&
      hasTrustedSnapshot &&
      existing.documentStatus === INVOICE_DOCUMENT_STATUS.ISSUED
    ) {
      const reconciled = await reconcileIssuedOrderInvoicePayment({
        tenantId,
        invoiceId: String(existing._id),
        orderId,
        totalAmountMinor: totals.totalAmountMinor,
        currency: String(order.currency),
        allocations,
        stripe: {
          checkoutSessionId: order.stripe?.sessionId || "",
          paymentIntentId: order.stripe?.paymentIntentId || "",
        },
      });
      return serializeInvoice(reconciled);
    }
    if (
      paid &&
      hasTrustedSnapshot &&
      existing.documentStatus === INVOICE_DOCUMENT_STATUS.DRAFT &&
      Number(existing.totalAmountMinor) === totals.totalAmountMinor
    ) {
      existing.amountPaidMinor = totals.totalAmountMinor;
      existing.amountDueMinor = 0;
      existing.paymentStatus = INVOICE_PAYMENT_STATUS.PAID;
      existing.paymentAllocations = allocations as any;
      existing.stripe = {
        checkoutSessionId: order.stripe?.sessionId || "",
        paymentIntentId: order.stripe?.paymentIntentId || "",
      };
      await existing.save();
    } else if (
      paid &&
      hasTrustedSnapshot &&
      Number(existing.totalAmountMinor) !== totals.totalAmountMinor &&
      existing.documentStatus === INVOICE_DOCUMENT_STATUS.DRAFT
    ) {
      existing.requiresReview = true;
      existing.issuanceError =
        "Draft total differs from the paid order snapshot and requires review.";
      await existing.save();
    }
    if (
      paid &&
      finalizePaid &&
      !existing.requiresReview &&
      existing.documentStatus === INVOICE_DOCUMENT_STATUS.DRAFT
    ) {
      return finalizeInvoice({
        tenantId,
        invoiceId: String(existing._id),
        userId: actorUserId,
        allowedLocationIds,
      });
    }
    return serializeInvoice(existing);
  }

  let invoice: any;
  try {
    invoice = await InvoiceModel.create({
      tenant: tenantId,
      source: { kind: INVOICE_SOURCE_KIND.ORDER, id: order._id, key: sourceKey },
      customerUser: user?._id ?? order.createdBy,
      currency: order.currency,
      sellerSnapshot: buildSellerSnapshot(settings),
      customerSnapshot: normalizeCustomerSnapshot(order.customer, user),
      lineItems: lines,
      locationIds,
      ...totals,
      amountPaidMinor: paid && hasTrustedSnapshot ? totals.totalAmountMinor : 0,
      amountDueMinor: paid && hasTrustedSnapshot ? 0 : totals.totalAmountMinor,
      paymentStatus:
        paid && hasTrustedSnapshot
          ? INVOICE_PAYMENT_STATUS.PAID
          : INVOICE_PAYMENT_STATUS.UNPAID,
      paymentAllocations: allocations,
      stripe: {
        checkoutSessionId: order.stripe?.sessionId || "",
        paymentIntentId: order.stripe?.paymentIntentId || "",
      },
      issueDate,
      dueDate: paid
        ? issueDate
        : addInvoiceCalendarDays(issueDate, settings.defaultDueDays, timezone),
      taxableSupplyDate: issueDate,
      locale: settings.locale,
      timezone,
      automatic,
      requiresReview,
      issuanceError: requiresReview
        ? "Legacy order snapshot requires manual line and payment review."
        : "",
      createdBy: actorUserId,
    });
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    invoice = await InvoiceModel.findOne({
      tenant: tenantId,
      documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
      "source.key": sourceKey,
    }).exec();
    if (!invoice) throw error;
  }
  await OrderModel.updateOne(
    { tenant: tenantId, _id: orderId },
    { $set: { invoice: invoice._id } },
  ).exec();

  if (paid && finalizePaid && !requiresReview) {
    return finalizeInvoice({
      tenantId,
      invoiceId: String(invoice._id),
      userId: actorUserId,
      allowedLocationIds,
    });
  }
  return serializeInvoice(invoice);
};

export const updateDraftInvoice = async ({
  tenantId,
  invoiceId,
  userId,
  input,
  allowedLocationIds,
}: {
  tenantId: string;
  invoiceId: string;
  userId: string;
  input: UpdateDraftInvoiceInput;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  const invoice = await loadInvoiceOrThrow(tenantId, invoiceId);
  assertInvoiceLocationAccess(invoice.locationIds ?? [], allowedLocationIds);
  if (invoice.documentStatus !== INVOICE_DOCUMENT_STATUS.DRAFT) {
    conflict("Issued invoices are immutable. Create a credit note instead.");
  }
  const settings = await ensureInvoiceSettings(tenantId);
  assertSupportedInvoiceTaxMode(settings);
  const timezone = await getTenantTimezone(tenantId);
  if (input.lines) await validateManualProducts(tenantId, input.lines);
  const nextCustomerUserId =
    input.customerUserId === undefined
      ? invoice.customerUser
      : input.customerUserId;
  const isRelinkingCustomer =
    input.customerUserId !== undefined &&
    String(input.customerUserId ?? "") !== String(invoice.customerUser ?? "");
  const linkedCustomer = nextCustomerUserId
    ? await loadLinkableInvoiceCustomer({
        tenantId,
        userId: nextCustomerUserId,
      })
    : null;

  if (input.customerUserId !== undefined) {
    invoice.customerUser = linkedCustomer?._id ?? null;
  }

  if (linkedCustomer) {
    invoice.customerSnapshot = normalizeLinkedCustomerSnapshot(
      // Never carry an unrelated party's business snapshot across a relink
      // unless the caller explicitly submits the new party's billing fields.
      input.customer ?? (isRelinkingCustomer ? {} : invoice.customerSnapshot),
      linkedCustomer,
    ) as any;
  } else if (input.customer) {
    // A null customerUser intentionally represents a manual invoice for an
    // external natural person or legal party without a workspace account.
    invoice.customerSnapshot = normalizeCustomerSnapshot(input.customer) as any;
  }
  const nextLines = input.lines
    ? buildManualLines({
      lines: input.lines,
      defaultTaxRateBps: settings.defaultTaxRateBps,
      pricesIncludeTax: settings.pricesIncludeTax,
    })
    : (invoice.lineItems as any[]);
  const requestedDocumentLocations =
    input.locationIds ?? (input.lines ? [] : (invoice.locationIds as any[]));
  const nextLocationIds = uniqueIds([
    ...requestedDocumentLocations,
    ...nextLines.flatMap((line: any) => line.locationIds ?? []),
  ]);
  if (!nextLocationIds.length) {
    assertCanAccessAllWorkspaceLocations(allowedLocationIds);
  }
  await assertTenantLocationsWithinWorkspaceScope({
    tenantId,
    locationIds: nextLocationIds,
    allowedLocationIds,
  });
  invoice.lineItems = nextLines as any;
  invoice.locationIds = nextLocationIds as any;
  if (input.issueDate !== undefined) {
    invoice.issueDate = resolveInvoiceDateInput(input.issueDate, timezone);
  }
  if (input.dueDate !== undefined) {
    invoice.dueDate = resolveInvoiceDateInput(input.dueDate, timezone);
  }
  if (input.taxableSupplyDate !== undefined) {
    invoice.taxableSupplyDate = resolveInvoiceDateInput(
      input.taxableSupplyDate,
      timezone,
    );
  }
  assertDateOrder(invoice.issueDate, invoice.dueDate);
  if (input.locale !== undefined) invoice.locale = input.locale as InvoiceLocale;
  const totals = sumInvoiceLineTotals(invoice.lineItems as any);
  invoice.netAmountMinor = totals.netAmountMinor;
  invoice.taxAmountMinor = totals.taxAmountMinor;
  invoice.totalAmountMinor = totals.totalAmountMinor;
  recomputeInvoicePaymentState(invoice);
  if (input.lines) {
    invoice.requiresReview = false;
    invoice.issuanceError = "";
  }
  try {
    await invoice.save();
  } catch (error) {
    if (error instanceof mongoose.Error.VersionError) {
      conflict({
        message: "Invoice changed while it was being edited. Reload and try again.",
        code: "INVOICE_VERSION_CONFLICT",
      });
    }
    throw error;
  }
  return serializeInvoice(invoice);
};

export const finalizeInvoice = async ({
  tenantId,
  invoiceId,
  userId,
  allowedLocationIds,
}: {
  tenantId: string;
  invoiceId: string;
  userId?: string | null;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  const before = await loadInvoiceOrThrow(tenantId, invoiceId);
  assertInvoiceLocationAccess(before.locationIds ?? [], allowedLocationIds);
  if (before.documentStatus === INVOICE_DOCUMENT_STATUS.ISSUED) {
    return serializeInvoice(before);
  }
  if (before.documentStatus !== INVOICE_DOCUMENT_STATUS.DRAFT) {
    conflict("Only a draft invoice can be finalized.");
  }
  const settings = await ensureInvoiceSettings(tenantId, userId);
  assertSupportedInvoiceTaxMode(settings);
  if (
    !settings.legalName ||
    !settings.address?.line1 ||
    !settings.address?.city ||
    !settings.address?.country
  ) {
    conflict({
      message: "Complete the legal name and country in invoice settings first.",
      code: "INVOICE_PROFILE_INCOMPLETE",
    });
  }
  const timezone = await getTenantTimezone(tenantId);
  const session = await mongoose.startSession();
  let result: any;
  try {
    await runNumberedInvoiceTransaction(session, async () => {
      const current = await InvoiceModel.findOne({
        tenant: tenantId,
        _id: invoiceId,
      })
        .session(session)
        .exec();
      if (!current) notFound("Invoice not found.");
      if (current.documentStatus === INVOICE_DOCUMENT_STATUS.ISSUED) {
        result = current;
        return;
      }
      if (current.documentStatus !== INVOICE_DOCUMENT_STATUS.DRAFT) {
        conflict("Only a draft invoice can be finalized.");
      }
      assertInvoiceLocationAccess(current.locationIds ?? [], allowedLocationIds);
      if (current.requiresReview) {
        conflict({
          message: "Review and replace the legacy order lines before finalization.",
          code: "INVOICE_REVIEW_REQUIRED",
        });
      }
      assertInvoiceLinesMatchTaxMode(
        current.lineItems as any[],
        settings,
      );
      if (current.customerUser) {
        const linkedCustomer = await loadLinkableInvoiceCustomer({
          tenantId,
          userId: current.customerUser,
          session,
        });
        current.customerSnapshot = normalizeLinkedCustomerSnapshot(
          current.customerSnapshot,
          linkedCustomer,
        ) as any;
      }
      assertInvoiceIntegrity(current);
      assertCustomerIdentity(current.customerSnapshot);
      if (current.totalAmountMinor <= 0) {
        badRequest("Invoice total must be positive.");
      }
      const issueDate = current.issueDate ?? new Date();
      const dueDate =
        current.dueDate ??
        addInvoiceCalendarDays(issueDate, settings.defaultDueDays, timezone);
      assertDateOrder(issueDate, dueDate);
      const prefix =
        current.documentType === INVOICE_DOCUMENT_TYPE.CREDIT_NOTE
          ? settings.creditNotePrefix
          : settings.invoicePrefix;
      const numbering = await allocateInvoiceNumber({
        tenantId,
        documentType: current.documentType,
        prefix,
        issueDate,
        timezone,
        session,
      });
      current.number = numbering.number;
      current.series = numbering.series;
      current.sequence = numbering.sequence;
      current.issueDate = issueDate;
      current.taxableSupplyDate = current.taxableSupplyDate ?? issueDate;
      current.dueDate = dueDate;
      current.timezone = timezone;
      current.sellerSnapshot = buildSellerSnapshot(settings) as any;
      current.documentStatus = INVOICE_DOCUMENT_STATUS.ISSUED;
      current.finalizedAt = new Date();
      current.finalizedBy = userId ? objectId(userId) : null;
      current.issuanceAttempts = Number(current.issuanceAttempts || 0) + 1;
      current.issuanceError = "";
      current.set(
        "issuanceSnapshot",
        buildInvoiceIssuanceSnapshot(current),
        { overwriteImmutable: true },
      );
      await current.save({ session });
      result = current;
    });
  } catch (error) {
    await InvoiceModel.updateOne(
      { tenant: tenantId, _id: invoiceId, documentStatus: INVOICE_DOCUMENT_STATUS.DRAFT },
      {
        $inc: { issuanceAttempts: 1 },
        $set: {
          issuanceError:
            error instanceof Error ? error.message.slice(0, 2000) : "Invoice finalization failed.",
        },
      },
    ).exec();
    if (error instanceof mongoose.Error.VersionError) {
      conflict({
        message: "Invoice changed during finalization. Reload and try again.",
        code: "INVOICE_VERSION_CONFLICT",
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }
  return serializeInvoice(result);
};

export const sendInvoice = async ({
  tenantId,
  invoiceId,
  userId,
  recipient,
  allowedLocationIds,
}: {
  tenantId: string;
  invoiceId: string;
  userId?: string | null;
  recipient?: string;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  const invoice = await getInvoiceById({ tenantId, invoiceId, allowedLocationIds });
  if (invoice.documentStatus !== INVOICE_DOCUMENT_STATUS.ISSUED) {
    conflict("Finalize the invoice before sending it.");
  }
  const to = String(recipient || invoice.customerSnapshot?.email || "").trim().toLowerCase();
  if (!to) badRequest("Invoice recipient email is required.");
  const now = new Date();
  const claimToken = randomUUID();
  const claimed = await InvoiceModel.findOneAndUpdate(
    {
      tenant: tenantId,
      _id: invoiceId,
      documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
      $or: [
        { sendClaimExpiresAt: null },
        { sendClaimExpiresAt: { $exists: false } },
        { sendClaimExpiresAt: { $lt: now } },
      ],
    },
    {
      $set: {
        sendClaimToken: claimToken,
        sendClaimExpiresAt: new Date(now.getTime() + INVOICE_SEND_CLAIM_TTL_MS),
      },
    },
    { returnDocument: "after", runValidators: true },
  ).exec();
  if (!claimed) {
    conflict({
      message: "This invoice is already being sent. Try again shortly.",
      code: "INVOICE_SEND_IN_PROGRESS",
    });
  }
  try {
    const response = await sendInvoiceEmail({ invoice: claimed, recipient: to });
    const sentAt = new Date();
    const updated = await InvoiceModel.findOneAndUpdate(
      { tenant: tenantId, _id: invoiceId, sendClaimToken: claimToken },
      {
        $set: { sentAt },
        $push: {
          deliveryLog: {
            status: "sent",
            recipient: to,
            sentAt,
            providerMessageId: response.providerMessageId || "",
            sentBy: userId ? objectId(userId) : null,
          },
        },
        $unset: { sendClaimToken: 1, sendClaimExpiresAt: 1 },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
    if (!updated) {
      throw new Error("Invoice email was sent but its delivery state could not be recorded.");
    }
    return serializeInvoice(updated);
  } catch (error) {
    await InvoiceModel.updateOne(
      { tenant: tenantId, _id: invoiceId, sendClaimToken: claimToken },
      {
        $push: {
          deliveryLog: {
            status: "failed",
            recipient: to,
            sentAt: new Date(),
            error:
              error instanceof Error ? error.message.slice(0, 2000) : "Email failed.",
            sentBy: userId ? objectId(userId) : null,
          },
        },
        $unset: { sendClaimToken: 1, sendClaimExpiresAt: 1 },
      },
    ).exec();
    throw error;
  }
};

export const recordInvoicePayment = async ({
  tenantId,
  invoiceId,
  userId,
  input,
  allowedLocationIds,
}: {
  tenantId: string;
  invoiceId: string;
  userId: string;
  input: RecordInvoicePaymentInput;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  const before = await getInvoiceById({
    tenantId,
    invoiceId,
    allowedLocationIds,
  });
  assertIssuedInvoicePaymentTarget(before);
  const paidAt =
    resolveInvoiceDateInput(input.paidAt, before.timezone || "UTC") ??
    undefined;
  if (paidAt && paidAt.getTime() > Date.now() + 5 * 60 * 1000) {
    badRequest("Payment date cannot be in the future.");
  }

  const session = await mongoose.startSession();
  const newPaymentId = new mongoose.Types.ObjectId();
  let result: any;
  let payment: any;
  try {
    await session.withTransaction(async () => {
      const current = await InvoiceModel.findOne({
        tenant: tenantId,
        _id: invoiceId,
      })
        .session(session)
        .exec();
      if (!current) notFound("Invoice not found.");
      assertInvoiceLocationAccess(current.locationIds ?? [], allowedLocationIds);
      assertIssuedInvoicePaymentTarget(current);

      const existing = (current.paymentAllocations as any[]).find(
        (allocation) => allocation.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        const sameRequest =
          Number(existing.amountMinor) === Number(input.amountMinor) &&
          existing.method === input.method &&
          String(existing.providerReference || "") === input.reference &&
          (!paidAt ||
            new Date(existing.paidAt).getTime() === paidAt.getTime());
        if (!sameRequest) {
          conflict({
            message: "This idempotency key was already used for another payment.",
            code: "INVOICE_PAYMENT_IDEMPOTENCY_CONFLICT",
          });
        }
        payment = existing;
        result = current;
        return;
      }

      const currentState = recomputeInvoicePaymentState(current);
      if (input.amountMinor > currentState.amountDueMinor) {
        conflict({
          message: "Payment amount exceeds the outstanding invoice balance.",
          code: "INVOICE_PAYMENT_EXCEEDS_DUE",
          details: {
            amountMinor: input.amountMinor,
            amountDueMinor: currentState.amountDueMinor,
          },
        });
      }

      const now = new Date();
      const allocation = {
        _id: newPaymentId,
        method: input.method,
        amountMinor: input.amountMinor,
        providerReference: input.reference,
        idempotencyKey: input.idempotencyKey,
        paidAt: paidAt ?? now,
        recordedAt: now,
        recordedBy: objectId(userId),
        reversedAt: null,
        reversedBy: null,
        reversalReason: "",
        reversalIdempotencyKey: "",
      };
      current.paymentAllocations.push(allocation as any);
      recomputeInvoicePaymentState(current);
      await current.save({ session });
      payment = (current.paymentAllocations as any[]).find(
        (item) => String(item._id) === String(newPaymentId),
      );
      result = current;
    });
  } catch (error) {
    if (error instanceof mongoose.Error.VersionError) {
      conflict({
        message: "Invoice payment state changed. Reload and try again.",
        code: "INVOICE_PAYMENT_VERSION_CONFLICT",
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return {
    invoice: serializeInvoice(result, { includePaymentAudit: true }),
    payment: serializePaymentAllocation(payment),
  };
};

export const reverseInvoicePayment = async ({
  tenantId,
  invoiceId,
  paymentId,
  userId,
  input,
  allowedLocationIds,
}: {
  tenantId: string;
  invoiceId: string;
  paymentId: string;
  userId: string;
  input: ReverseInvoicePaymentInput;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  if (!mongoose.isValidObjectId(paymentId)) {
    notFound({
      message: "Invoice payment not found.",
      code: "INVOICE_PAYMENT_NOT_FOUND",
    });
  }
  const before = await getInvoiceById({
    tenantId,
    invoiceId,
    allowedLocationIds,
  });
  assertIssuedInvoicePaymentTarget(before);

  const session = await mongoose.startSession();
  let result: any;
  let payment: any;
  try {
    await session.withTransaction(async () => {
      const current = await InvoiceModel.findOne({
        tenant: tenantId,
        _id: invoiceId,
      })
        .session(session)
        .exec();
      if (!current) notFound("Invoice not found.");
      assertInvoiceLocationAccess(current.locationIds ?? [], allowedLocationIds);
      assertIssuedInvoicePaymentTarget(current);

      const allocation = (current.paymentAllocations as any[]).find(
        (item) => String(item._id) === paymentId,
      );
      if (!allocation) {
        notFound({
          message: "Invoice payment not found.",
          code: "INVOICE_PAYMENT_NOT_FOUND",
        });
      }
      assertManualInvoicePaymentReversible(allocation.method);
      if (allocation.reversedAt) {
        if (
          allocation.reversalIdempotencyKey === input.idempotencyKey &&
          allocation.reversalReason === input.reason
        ) {
          result = current;
          payment = allocation;
          return;
        }
        conflict({
          message: "This invoice payment has already been reversed.",
          code: "INVOICE_PAYMENT_ALREADY_REVERSED",
        });
      }

      allocation.reversedAt = new Date();
      allocation.reversedBy = objectId(userId);
      allocation.reversalReason = input.reason;
      allocation.reversalIdempotencyKey = input.idempotencyKey;
      recomputeInvoicePaymentState(current);
      await current.save({ session });
      result = current;
      payment = allocation;
    });
  } catch (error) {
    if (error instanceof mongoose.Error.VersionError) {
      conflict({
        message: "Invoice payment state changed. Reload and try again.",
        code: "INVOICE_PAYMENT_VERSION_CONFLICT",
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return {
    invoice: serializeInvoice(result, { includePaymentAudit: true }),
    payment: serializePaymentAllocation(payment),
  };
};

export const createCreditNote = async ({
  tenantId,
  invoiceId,
  userId,
  input,
  allowedLocationIds,
}: {
  tenantId: string;
  invoiceId: string;
  userId: string;
  input: CreditNoteInput;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  assertNativeInvoicingEnabled();
  const original = await getInvoiceById({ tenantId, invoiceId, allowedLocationIds });
  if (
    original.documentType !== INVOICE_DOCUMENT_TYPE.INVOICE ||
    original.documentStatus !== INVOICE_DOCUMENT_STATUS.ISSUED
  ) {
    conflict("Credit notes can only reference an issued invoice.");
  }
  const settings = await ensureInvoiceSettings(tenantId, userId);
  assertSupportedInvoiceTaxMode(settings);
  if (
    !settings.legalName ||
    !settings.address?.line1 ||
    !settings.address?.city ||
    !settings.address?.country
  ) {
    conflict({
      message: "Complete invoice settings before issuing a credit note.",
      code: "INVOICE_PROFILE_INCOMPLETE",
    });
  }
  const requested = new Map(
    (input.lines ?? []).map((line) => [line.lineItemId, line.grossAmountMinor]),
  );
  const timezone = await getTenantTimezone(tenantId);
  const issueDate = new Date();
  const creditId = new mongoose.Types.ObjectId();
  const sourceKey = input.idempotencyKey
    ? `credit:${original._id}:idempotency:${input.idempotencyKey}`
    : `credit:${original._id}:${creditId}`;
  const session = await mongoose.startSession();
  let creditNote: any;
  try {
    await runNumberedInvoiceTransaction(session, async () => {
      if (input.idempotencyKey) {
        const existing = await InvoiceModel.findOne({
          tenant: tenantId,
          documentType: INVOICE_DOCUMENT_TYPE.CREDIT_NOTE,
          "source.key": sourceKey,
        })
          .session(session)
          .exec();
        if (existing) {
          creditNote = existing;
          return;
        }
      }

      const current = await InvoiceModel.findOne({
        tenant: tenantId,
        _id: original._id,
        documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
        documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
      })
        .session(session)
        .exec();
      if (!current) conflict("Credit notes can only reference an issued invoice.");
      assertInvoiceLocationAccess(current.locationIds ?? [], allowedLocationIds);

      // Read already-issued notes inside the same transaction. This also
      // repairs counters for invoices created before per-line counters existed.
      const issuedCredits = await InvoiceModel.find({
        tenant: tenantId,
        documentType: INVOICE_DOCUMENT_TYPE.CREDIT_NOTE,
        documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
        originalInvoice: current._id,
      })
        .select("lineItems")
        .session(session)
        .lean()
        .exec();
      const historyGross = new Map<string, number>();
      const historyTax = new Map<string, number>();
      for (const credit of issuedCredits) {
        for (const line of credit.lineItems ?? []) {
          const key = String(line.originalLineId || "");
          if (!key) continue;
          historyGross.set(
            key,
            (historyGross.get(key) || 0) + Number(line.grossAmountMinor || 0),
          );
          historyTax.set(
            key,
            (historyTax.get(key) || 0) + Number(line.taxAmountMinor || 0),
          );
        }
      }

      const creditLines: any[] = [];
      for (const line of current.lineItems as any[]) {
        const lineId = String(line._id);
        const alreadyGross = Math.max(
          Number(line.creditedAmountMinor || 0),
          historyGross.get(lineId) || 0,
        );
        const alreadyTax = Math.max(
          Number(line.creditedTaxAmountMinor || 0),
          historyTax.get(lineId) || 0,
        );
        const remainingGross = Math.max(0, Number(line.grossAmountMinor) - alreadyGross);
        const amount = input.lines ? requested.get(lineId) ?? 0 : remainingGross;
        if (amount === 0) continue;
        if (amount > remainingGross) {
          conflict("Credit note exceeds the remaining line amount.");
        }
        const taxAmountMinor = calculateCreditTaxSlice({
          originalGrossMinor: Number(line.grossAmountMinor),
          originalTaxMinor: Number(line.taxAmountMinor),
          creditedGrossMinor: alreadyGross,
          creditedTaxMinor: alreadyTax,
          creditGrossMinor: amount,
        });
        line.creditedAmountMinor = alreadyGross + amount;
        line.creditedTaxAmountMinor = alreadyTax + taxAmountMinor;
        creditLines.push({
          originalLineId: line._id,
          product: line.product,
          description: line.description,
          sku: line.sku,
          quantity: 1,
          unitGrossMinor: amount,
          grossAmountMinor: amount,
          netAmountMinor: amount - taxAmountMinor,
          taxAmountMinor,
          taxRateBps: line.taxRateBps,
          locationIds: line.locationIds,
        });
      }
      if (requested.size && creditLines.length !== requested.size) {
        badRequest("One or more credit-note lines do not belong to this invoice.");
      }
      if (!creditLines.length) {
        conflict("This invoice has no remaining amount to credit.");
      }
      const totals = sumInvoiceLineTotals(creditLines);
      const totalCredited = (current.lineItems as any[]).reduce(
        (sum, line) => sum + Number(line.creditedAmountMinor || 0),
        0,
      );
      if (
        !Number.isSafeInteger(totalCredited) ||
        totalCredited > Number(current.totalAmountMinor)
      ) {
        conflict("Credit note exceeds the remaining invoice amount.");
      }
      current.creditedAmountMinor = totalCredited;
      recomputeInvoicePaymentState(current);
      await current.save({ session });

      const numbering = await allocateInvoiceNumber({
        tenantId,
        documentType: INVOICE_DOCUMENT_TYPE.CREDIT_NOTE,
        prefix: settings.creditNotePrefix,
        issueDate,
        timezone,
        session,
      });
      const creditDocument = {
        _id: creditId,
        tenant: tenantId,
        source: {
          kind: INVOICE_SOURCE_KIND.MANUAL,
          id: current._id,
          key: sourceKey,
        },
        documentType: INVOICE_DOCUMENT_TYPE.CREDIT_NOTE,
        documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
        paymentStatus: INVOICE_PAYMENT_STATUS.NOT_APPLICABLE,
        customerUser: current.customerUser,
        originalInvoice: current._id,
        originalInvoiceNumber: current.number || "",
        creditReason: input.reason,
        number: numbering.number,
        series: numbering.series,
        sequence: numbering.sequence,
        locale: current.locale,
        timezone: current.timezone || timezone,
        currency: current.currency,
        sellerSnapshot: buildSellerSnapshot(settings),
        customerSnapshot: current.customerSnapshot,
        lineItems: creditLines,
        locationIds: current.locationIds,
        ...totals,
        amountPaidMinor: 0,
        amountDueMinor: 0,
        issueDate,
        dueDate: issueDate,
        taxableSupplyDate: issueDate,
        finalizedAt: issueDate,
        createdBy: userId,
        finalizedBy: userId,
        issuanceAttempts: 1,
      };
      const [created] = await InvoiceModel.create(
        [
          {
            ...creditDocument,
            issuanceSnapshot: buildInvoiceIssuanceSnapshot(creditDocument),
          },
        ],
        { session },
      );
      creditNote = created;
    });
  } finally {
    await session.endSession();
  }
  let delivery:
    | { status: "not_requested" | "sent" | "failed"; error?: string }
    | undefined;
  if (input.send) {
    if (creditNote.sentAt) {
      return {
        invoice: serializeInvoice(creditNote),
        delivery: { status: "sent" as const },
      };
    }
    try {
      const sent = await sendInvoice({
        tenantId,
        invoiceId: String(creditNote._id),
        userId,
        allowedLocationIds,
      });
      return { invoice: sent, delivery: { status: "sent" as const } };
    } catch (error) {
      const refreshed = await loadInvoiceOrThrow(tenantId, String(creditNote._id));
      delivery = {
        status: "failed",
        error: error instanceof Error ? error.message : "Invoice email failed.",
      };
      return { invoice: serializeInvoice(refreshed), delivery };
    }
  }
  return {
    invoice: serializeInvoice(creditNote),
    delivery: { status: "not_requested" as const },
  };
};

const logAutomationStateWriteFailures = (
  results: PromiseSettledResult<unknown>[],
  context: { tenantId: string; orderId: string },
): void => {
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (!failures.length) return;

  logger.warn(
    {
      ...context,
      errors: failures.map((failure) => failure.reason),
    },
    "Invoice automation state could not be fully persisted.",
  );
};

const clearInvoiceAutomationState = async ({
  tenantId,
  orderId,
  invoiceId,
}: {
  tenantId: string;
  orderId: string;
  invoiceId: string;
}): Promise<void> => {
  const now = new Date();
  const results = await Promise.allSettled([
    OrderModel.updateOne(
      { tenant: tenantId, _id: orderId },
      {
        $set: {
          "invoiceAutomation.attempts": 0,
          "invoiceAutomation.lastAttemptAt": now,
          "invoiceAutomation.nextAttemptAt": null,
          "invoiceAutomation.lastError": "",
        },
      },
    ).exec(),
    InvoiceModel.updateOne(
      {
        tenant: tenantId,
        _id: invoiceId,
        automatic: true,
        "source.kind": INVOICE_SOURCE_KIND.ORDER,
        "source.id": orderId,
      },
      {
        $set: {
          automationAttempts: 0,
          automationLastAttemptAt: now,
          automationNextAttemptAt: null,
          automationError: "",
        },
      },
    ).exec(),
  ]);

  logAutomationStateWriteFailures(results, { tenantId, orderId });
};

const recordInvoiceAutomationFailure = async ({
  tenantId,
  orderId,
  error,
}: {
  tenantId: string;
  orderId: string;
  error: unknown;
}): Promise<void> => {
  const state = buildInvoiceAutomationFailureState(error);
  const results = await Promise.allSettled([
    OrderModel.updateOne(
      { tenant: tenantId, _id: orderId },
      {
        $inc: { "invoiceAutomation.attempts": 1 },
        $set: {
          "invoiceAutomation.lastAttemptAt": state.lastAttemptAt,
          "invoiceAutomation.nextAttemptAt": state.nextAttemptAt,
          "invoiceAutomation.lastError": state.lastError,
        },
      },
    ).exec(),
    InvoiceModel.updateOne(
      {
        tenant: tenantId,
        automatic: true,
        "source.kind": INVOICE_SOURCE_KIND.ORDER,
        "source.id": orderId,
      },
      {
        $inc: { automationAttempts: 1 },
        $set: {
          automationLastAttemptAt: state.lastAttemptAt,
          automationNextAttemptAt: state.nextAttemptAt,
          automationError: state.lastError,
        },
      },
    ).exec(),
  ]);

  logAutomationStateWriteFailures(results, { tenantId, orderId });
};

export const ensurePaidOrderInvoice = async ({
  tenantId,
  orderId,
}: {
  tenantId: string;
  orderId: string;
}): Promise<{
  status:
    | "disabled"
    | "review_required"
    | "draft"
    | "issued"
    | "sent"
    | "failed";
  invoiceId?: string;
  error?: string;
}> => {
  if (!isNativeInvoicingEnabled()) return { status: "disabled" };

  try {
    const settings = await ensureInvoiceSettings(tenantId);
    assertValidInvoiceAutomationSettings(settings);
    if (!settings.autoCreatePaidOrderInvoices) return { status: "disabled" };
    const invoice = await createInvoiceFromOrder({
      tenantId,
      orderId,
      automatic: true,
      finalizePaid: Boolean(settings.autoFinalizePaidOrderInvoices),
      allowedLocationIds: null,
    });
    if (invoice.requiresReview) {
      await clearInvoiceAutomationState({
        tenantId,
        orderId,
        invoiceId: invoice.id,
      });
      return { status: "review_required", invoiceId: invoice.id };
    }
    if (
      settings.autoSendPaidOrderInvoices &&
      invoice.documentStatus === INVOICE_DOCUMENT_STATUS.ISSUED &&
      !invoice.sentAt
    ) {
      await sendInvoice({
        tenantId,
        invoiceId: invoice.id,
        allowedLocationIds: null,
      });
      await clearInvoiceAutomationState({
        tenantId,
        orderId,
        invoiceId: invoice.id,
      });
      return { status: "sent", invoiceId: invoice.id };
    }
    await clearInvoiceAutomationState({
      tenantId,
      orderId,
      invoiceId: invoice.id,
    });
    return {
      status:
        invoice.documentStatus === INVOICE_DOCUMENT_STATUS.ISSUED
          ? "issued"
          : "draft",
      invoiceId: invoice.id,
    };
  } catch (error) {
    await recordInvoiceAutomationFailure({
      tenantId,
      orderId,
      error,
    });
    logger.error(
      { err: error, tenantId, orderId },
      "Automatic customer invoice issuance failed; payment fulfillment remains complete.",
    );
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Invoice issuance failed.",
    };
  }
};

export const reconcilePaidOrderInvoices = async (limit = 50) => {
  if (!isNativeInvoicingEnabled()) {
    return { scanned: 0, completed: 0, failed: 0, skipped: 0 };
  }
  const batchSize = Math.max(1, Math.min(limit, 500));
  const now = new Date();
  const [disabledTenantIds, finalizeTenantIds, sendTenantIds] =
    await Promise.all([
      InvoiceSettingsModel.find({ autoCreatePaidOrderInvoices: false })
        .distinct("tenant")
        .exec(),
      InvoiceSettingsModel.find({
        autoCreatePaidOrderInvoices: true,
        autoFinalizePaidOrderInvoices: true,
      })
        .distinct("tenant")
        .exec(),
      InvoiceSettingsModel.find({
        autoCreatePaidOrderInvoices: true,
        autoFinalizePaidOrderInvoices: true,
        autoSendPaidOrderInvoices: true,
      })
        .distinct("tenant")
        .exec(),
    ]);

  const orders = await OrderModel.find(
    buildActionablePaidOrderInvoiceFilter({
      now,
      disabledTenantIds: disabledTenantIds.map(String),
    }),
  )
    .select("_id tenant")
    .sort({ paidAt: 1 })
    .limit(batchSize)
    .lean()
    .exec();
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  for (const order of orders) {
    try {
      const outcome = await ensurePaidOrderInvoice({
        tenantId: String(order.tenant),
        orderId: String(order._id),
      });
      if (outcome.status === "failed") failed += 1;
      else if (
        outcome.status === "disabled" ||
        outcome.status === "review_required" ||
        outcome.status === "draft"
      ) skipped += 1;
      else completed += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ err: error, orderId: String(order._id) }, "Invoice reconciliation failed for order.");
    }
  }
  const automaticInvoiceFilter = buildActionableAutomaticInvoiceFilter({
    now,
    finalizeTenantIds: finalizeTenantIds.map(String),
    sendTenantIds: sendTenantIds.map(String),
  });
  const automaticInvoices = automaticInvoiceFilter
    ? await InvoiceModel.find(automaticInvoiceFilter)
        .select("tenant source.id documentStatus")
        .sort({ createdAt: 1 })
        .limit(batchSize)
        .lean()
        .exec()
    : [];
  for (const invoice of automaticInvoices) {
    if (!invoice.source?.id) continue;
    try {
      const outcome = await ensurePaidOrderInvoice({
        tenantId: String(invoice.tenant),
        orderId: String(invoice.source.id),
      });
      if (outcome.status === "failed") failed += 1;
      else if (
        outcome.status === "disabled" ||
        outcome.status === "review_required" ||
        outcome.status === "draft"
      ) skipped += 1;
      else completed += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    scanned: orders.length + automaticInvoices.length,
    completed,
    failed,
    skipped,
  };
};
