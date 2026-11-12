import type { Types } from "mongoose";

import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

import type {
  InvoiceDeliveryStatus,
  InvoiceDocumentStatus,
  InvoiceDocumentType,
  InvoiceLocale,
  InvoicePaymentMethod,
  InvoicePaymentStatus,
  InvoiceSourceKind,
} from "./invoice.constants.js";

export interface InvoiceAddressSnapshot {
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
  country: string;
  countryCode: string;
}

export interface InvoiceBankSnapshot {
  accountName: string;
  accountNumber: string;
  iban: string;
  bic: string;
}

export interface InvoicePartySnapshot {
  legalName: string;
  tradingName: string;
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  registrationNumber: string;
  taxId: string;
  vatId: string;
  address: InvoiceAddressSnapshot;
  bank: InvoiceBankSnapshot;
}

export interface InvoiceLineItem {
  _id?: Types.ObjectId;
  originalLineId: Types.ObjectId | null;
  product: Types.ObjectId | null;
  description: string;
  sku: string;
  quantity: number;
  unitGrossMinor: number;
  grossAmountMinor: number;
  netAmountMinor: number;
  taxAmountMinor: number;
  taxRateBps: number;
  creditedAmountMinor: number;
  creditedTaxAmountMinor: number;
  locationIds: Types.ObjectId[];
}

export interface InvoicePaymentAllocation {
  _id?: Types.ObjectId;
  method: InvoicePaymentMethod;
  amountMinor: number;
  providerReference: string;
  idempotencyKey: string;
  paidAt: Date;
  recordedAt: Date;
  recordedBy: Types.ObjectId | null;
  reversedAt: Date | null;
  reversedBy: Types.ObjectId | null;
  reversalReason: string;
  reversalIdempotencyKey: string;
}

export interface InvoiceDeliveryEvent {
  status: InvoiceDeliveryStatus;
  recipient: string;
  sentAt: Date;
  providerMessageId: string;
  error: string;
  sentBy: Types.ObjectId | null;
}

export interface InvoiceIssuanceSnapshot {
  documentType: InvoiceDocumentType;
  number: string;
  originalInvoiceNumber: string;
  creditReason: string;
  locale: InvoiceLocale;
  timezone: string;
  currency: StudioCommerceCurrency;
  sellerSnapshot: InvoicePartySnapshot;
  customerSnapshot: InvoicePartySnapshot;
  lineItems: Array<{
    description: string;
    quantity: number;
    grossAmountMinor: number;
    taxRateBps: number;
  }>;
  netAmountMinor: number;
  taxAmountMinor: number;
  totalAmountMinor: number;
  issueDate: Date | null;
  dueDate: Date | null;
  taxableSupplyDate: Date | null;
}

export interface InvoiceRecord {
  tenant: Types.ObjectId;
  source: {
    kind: InvoiceSourceKind;
    id: Types.ObjectId | null;
    key: string;
  };
  documentType: InvoiceDocumentType;
  documentStatus: InvoiceDocumentStatus;
  paymentStatus: InvoicePaymentStatus;
  customerUser: Types.ObjectId | null;
  originalInvoice: Types.ObjectId | null;
  originalInvoiceNumber: string;
  creditReason: string;
  number: string | null;
  series: string | null;
  sequence: number | null;
  locale: InvoiceLocale;
  timezone: string;
  currency: StudioCommerceCurrency;
  sellerSnapshot: InvoicePartySnapshot;
  customerSnapshot: InvoicePartySnapshot;
  lineItems: InvoiceLineItem[];
  locationIds: Types.ObjectId[];
  netAmountMinor: number;
  taxAmountMinor: number;
  totalAmountMinor: number;
  amountPaidMinor: number;
  amountDueMinor: number;
  creditedAmountMinor: number;
  issuanceSnapshot: InvoiceIssuanceSnapshot | null;
  paymentAllocations: InvoicePaymentAllocation[];
  stripe: {
    checkoutSessionId: string;
    paymentIntentId: string;
  };
  issueDate: Date | null;
  dueDate: Date | null;
  taxableSupplyDate: Date | null;
  finalizedAt: Date | null;
  sentAt: Date | null;
  automatic: boolean;
  requiresReview: boolean;
  issuanceAttempts: number;
  issuanceError: string;
  automationAttempts: number;
  automationLastAttemptAt: Date | null;
  automationNextAttemptAt: Date | null;
  automationError: string;
  createdBy: Types.ObjectId | null;
  finalizedBy: Types.ObjectId | null;
  deliveryLog: InvoiceDeliveryEvent[];
  sendClaimToken: string;
  sendClaimExpiresAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface InvoiceSettingsRecord {
  tenant: Types.ObjectId;
  legalName: string;
  tradingName: string;
  registrationNumber: string;
  taxId: string;
  vatId: string;
  address: InvoiceAddressSnapshot;
  contact: {
    email: string;
    phone: string;
  };
  bank: InvoiceBankSnapshot;
  locale: InvoiceLocale;
  defaultDueDays: number;
  pricesIncludeTax: boolean;
  defaultTaxRateBps: number;
  invoicePrefix: string;
  creditNotePrefix: string;
  autoCreatePaidOrderInvoices: boolean;
  autoFinalizePaidOrderInvoices: boolean;
  autoSendPaidOrderInvoices: boolean;
  updatedBy: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface InvoiceCounterRecord {
  tenant: Types.ObjectId;
  documentType: InvoiceDocumentType;
  series: string;
  sequence: number;
  createdAt?: Date;
  updatedAt?: Date;
}
