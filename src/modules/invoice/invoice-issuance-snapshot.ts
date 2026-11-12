import type {
  InvoiceDocumentType,
  InvoiceLocale,
} from "./invoice.constants.js";
import type {
  InvoicePartySnapshot,
  InvoiceIssuanceSnapshot,
} from "./invoice.types.js";

const plainValue = (value: any): any =>
  value?.toObject ? value.toObject({ depopulate: true }) : value;

const snapshotAddress = (source: any) => ({
  line1: String(source?.line1 || ""),
  line2: String(source?.line2 || ""),
  city: String(source?.city || ""),
  postalCode: String(source?.postalCode || ""),
  country: String(source?.country || ""),
  countryCode: String(source?.countryCode || ""),
});

const snapshotBank = (source: any) => ({
  accountName: String(source?.accountName || ""),
  accountNumber: String(source?.accountNumber || ""),
  iban: String(source?.iban || ""),
  bic: String(source?.bic || ""),
});

const snapshotParty = (source: any): InvoicePartySnapshot => ({
  legalName: String(source?.legalName || ""),
  tradingName: String(source?.tradingName || ""),
  firstname: String(source?.firstname || ""),
  lastname: String(source?.lastname || ""),
  email: String(source?.email || ""),
  phone: String(source?.phone || ""),
  registrationNumber: String(source?.registrationNumber || ""),
  taxId: String(source?.taxId || ""),
  vatId: String(source?.vatId || ""),
  address: snapshotAddress(source?.address),
  bank: snapshotBank(source?.bank),
});

/**
 * Captures every value that is permitted to affect the legal invoice PDF.
 * Settlement, credit, delivery and provider fields are deliberately absent:
 * those fields continue changing after issue and must never rewrite the
 * document that was issued to the customer.
 */
export const buildInvoiceIssuanceSnapshot = (
  invoice: any,
): InvoiceIssuanceSnapshot => {
  const value = plainValue(invoice) ?? {};

  return {
    documentType: value.documentType as InvoiceDocumentType,
    number: String(value.number || ""),
    originalInvoiceNumber: String(value.originalInvoiceNumber || ""),
    creditReason: String(value.creditReason || ""),
    locale: value.locale as InvoiceLocale,
    timezone: String(value.timezone || "UTC"),
    currency: value.currency,
    sellerSnapshot: snapshotParty(value.sellerSnapshot),
    customerSnapshot: snapshotParty(value.customerSnapshot),
    lineItems: (value.lineItems ?? []).map((line: any) => ({
      description: String(line.description || ""),
      quantity: Number(line.quantity),
      grossAmountMinor: Number(line.grossAmountMinor),
      taxRateBps: Number(line.taxRateBps),
    })),
    netAmountMinor: Number(value.netAmountMinor),
    taxAmountMinor: Number(value.taxAmountMinor),
    totalAmountMinor: Number(value.totalAmountMinor),
    issueDate: value.issueDate ? new Date(value.issueDate) : null,
    dueDate: value.dueDate ? new Date(value.dueDate) : null,
    taxableSupplyDate: value.taxableSupplyDate
      ? new Date(value.taxableSupplyDate)
      : null,
  };
};

/**
 * New documents always have an immutable issuance snapshot. The fallback is
 * intentionally an explicit legal projection for documents issued before the
 * snapshot field existed; it still excludes mutable settlement state.
 */
export const resolveInvoiceIssuanceSnapshot = (
  invoice: any,
): InvoiceIssuanceSnapshot => {
  const value = plainValue(invoice) ?? {};

  return buildInvoiceIssuanceSnapshot(value.issuanceSnapshot ?? value);
};
