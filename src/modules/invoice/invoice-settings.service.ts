import InvoiceSettingsModel from "./invoice-settings.schema.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { badRequest, notFound } from "@/shared/http/httpErrors.js";
import {
  COMMUNICATION_CONTENT_LOCALE,
  resolveCommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";
import { Types } from "mongoose";

import type { UpdateInvoiceSettingsInput } from "./invoice.validators.js";
import type { InvoiceSettingsRecord } from "./invoice.types.js";
import { assertTaxRateBps } from "./invoice.money.js";
import { assertNativeInvoicingEnabled } from "./invoice.feature.js";

export const assertSupportedInvoiceTaxMode = (
  settings: Pick<InvoiceSettingsRecord, "pricesIncludeTax" | "defaultTaxRateBps">,
): void => {
  const defaultTaxRateBps = assertTaxRateBps(settings.defaultTaxRateBps);

  if (!settings.pricesIncludeTax && defaultTaxRateBps > 0) {
    badRequest({
      message:
        "Tax-exclusive pricing is not supported yet. Use tax-inclusive prices or set the default tax rate to zero.",
      code: "EXCLUSIVE_TAX_NOT_SUPPORTED",
    });
  }
};

export const assertSupportedInvoiceLineTaxMode = (
  settings: Pick<InvoiceSettingsRecord, "pricesIncludeTax" | "defaultTaxRateBps">,
  taxRateBps: unknown,
): number => {
  assertSupportedInvoiceTaxMode(settings);
  const rate = assertTaxRateBps(taxRateBps);

  if (!settings.pricesIncludeTax && rate > 0) {
    badRequest({
      message:
        "Tax-exclusive pricing is not supported yet. Use tax-inclusive prices or a zero tax rate.",
      code: "EXCLUSIVE_TAX_NOT_SUPPORTED",
    });
  }

  return rate;
};

export const assertValidInvoiceAutomationSettings = (settings: {
  autoCreatePaidOrderInvoices: boolean;
  autoFinalizePaidOrderInvoices: boolean;
  autoSendPaidOrderInvoices: boolean;
}): void => {
  if (
    (settings.autoFinalizePaidOrderInvoices &&
      !settings.autoCreatePaidOrderInvoices) ||
    (settings.autoSendPaidOrderInvoices &&
      (!settings.autoCreatePaidOrderInvoices ||
        !settings.autoFinalizePaidOrderInvoices))
  ) {
    badRequest({
      message:
        "Automatic finalization requires automatic creation, and automatic sending requires both creation and finalization.",
      code: "INVOICE_AUTOMATION_SETTINGS_INVALID",
    });
  }
};

const serializeSettings = (settings: any) => ({
  id: String(settings._id),
  tenant: String(settings.tenant),
  legalName: settings.legalName,
  tradingName: settings.tradingName,
  registrationNumber: settings.registrationNumber,
  taxId: settings.taxId,
  vatId: settings.vatId,
  address: settings.address,
  contact: settings.contact,
  bank: settings.bank,
  locale: settings.locale,
  defaultDueDays: settings.defaultDueDays,
  pricesIncludeTax: settings.pricesIncludeTax,
  defaultTaxRateBps: settings.defaultTaxRateBps,
  invoicePrefix: settings.invoicePrefix,
  creditNotePrefix: settings.creditNotePrefix,
  autoCreatePaidOrderInvoices: settings.autoCreatePaidOrderInvoices,
  autoFinalizePaidOrderInvoices: settings.autoFinalizePaidOrderInvoices,
  autoSendPaidOrderInvoices: settings.autoSendPaidOrderInvoices,
  configured: Boolean(
    settings.legalName &&
      settings.address?.line1 &&
      settings.address?.city &&
      settings.address?.country,
  ),
  updatedAt: settings.updatedAt,
});

// Checkout still needs these settings for immutable tax/price snapshots while
// the native invoice feature is disabled. Keep this internal helper available.
export const ensureInvoiceSettings = async (
  tenantId: string,
  updatedBy?: string | null,
) => {
  const normalizedTenantId =
    typeof tenantId === "string" ? tenantId.trim() : "";

  if (!Types.ObjectId.isValid(normalizedTenantId)) {
    badRequest({
      message: "A valid tenant identifier is required.",
      code: "INVOICE_TENANT_ID_INVALID",
    });
  }

  const tenant = await TenantModel.findById(normalizedTenantId)
    .select("name settings.defaultLanguage onboarding.businessDetails")
    .lean()
    .exec();

  if (!tenant) notFound("Tenant not found.");

  const details = tenant.onboarding?.businessDetails;

  return InvoiceSettingsModel.findOneAndUpdate(
    { tenant: normalizedTenantId },
    {
      $setOnInsert: {
        tenant: normalizedTenantId,
        legalName: tenant.name,
        tradingName: tenant.name,
        address: {
          line1: details?.address ?? "",
          city: details?.city ?? "",
          country: details?.country ?? "",
        },
        contact: { phone: details?.phone ?? "" },
        locale: resolveCommunicationContentLocale(
          tenant.settings?.defaultLanguage,
          COMMUNICATION_CONTENT_LOCALE.CS,
        ),
        updatedBy: updatedBy || null,
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
    },
  ).exec();
};

export const getInvoiceSettings = async (tenantId: string) => {
  assertNativeInvoicingEnabled();
  const settings = await ensureInvoiceSettings(tenantId);
  return serializeSettings(settings);
};

export const updateInvoiceSettings = async ({
  tenantId,
  userId,
  input,
}: {
  tenantId: string;
  userId: string;
  input: UpdateInvoiceSettingsInput;
}) => {
  assertNativeInvoicingEnabled();
  await ensureInvoiceSettings(tenantId, userId);

  const current = await InvoiceSettingsModel.findOne({ tenant: tenantId })
    .lean()
    .exec();
  if (!current) notFound("Invoice settings not found.");

  const nextTaxMode = {
    pricesIncludeTax: input.pricesIncludeTax ?? current.pricesIncludeTax,
    defaultTaxRateBps: input.defaultTaxRateBps ?? current.defaultTaxRateBps,
  };
  assertSupportedInvoiceTaxMode(nextTaxMode);

  const nextInvoicePrefix = input.invoicePrefix ?? current.invoicePrefix;
  const nextCreditPrefix = input.creditNotePrefix ?? current.creditNotePrefix;
  if (nextInvoicePrefix === nextCreditPrefix) {
    badRequest({
      message: "Invoice and credit-note prefixes must be different.",
      code: "INVOICE_PREFIX_CONFLICT",
    });
  }

  const nextAutomation = {
    autoCreatePaidOrderInvoices:
      input.autoCreatePaidOrderInvoices ?? current.autoCreatePaidOrderInvoices,
    autoFinalizePaidOrderInvoices:
      input.autoFinalizePaidOrderInvoices ?? current.autoFinalizePaidOrderInvoices,
    autoSendPaidOrderInvoices:
      input.autoSendPaidOrderInvoices ?? current.autoSendPaidOrderInvoices,
  };
  assertValidInvoiceAutomationSettings(nextAutomation);

  const set: Record<string, unknown> = { updatedBy: userId };

  for (const key of [
    "legalName",
    "tradingName",
    "registrationNumber",
    "taxId",
    "vatId",
    "locale",
    "defaultDueDays",
    "pricesIncludeTax",
    "defaultTaxRateBps",
    "invoicePrefix",
    "creditNotePrefix",
    "autoCreatePaidOrderInvoices",
    "autoFinalizePaidOrderInvoices",
    "autoSendPaidOrderInvoices",
  ] as const) {
    if (input[key] !== undefined) set[key] = input[key];
  }

  for (const [key, value] of Object.entries(input.address ?? {})) {
    set[`address.${key}`] = value;
  }
  for (const [key, value] of Object.entries(input.contact ?? {})) {
    set[`contact.${key}`] = value;
  }
  for (const [key, value] of Object.entries(input.bank ?? {})) {
    set[`bank.${key}`] = value;
  }

  const settings = await InvoiceSettingsModel.findOneAndUpdate(
    { tenant: tenantId, __v: (current as any).__v ?? 0 },
    { $set: set, $inc: { __v: 1 } },
    { returnDocument: "after", runValidators: true },
  ).exec();

  if (!settings) {
    badRequest({
      message: "Invoice settings changed. Reload and try again.",
      code: "INVOICE_SETTINGS_VERSION_CONFLICT",
    });
  }
  return serializeSettings(settings);
};

export const buildSellerSnapshot = (settings: any) => ({
  legalName: settings.legalName || "",
  tradingName: settings.tradingName || "",
  registrationNumber: settings.registrationNumber || "",
  taxId: settings.taxId || "",
  vatId: settings.vatId || "",
  email: settings.contact?.email || "",
  phone: settings.contact?.phone || "",
  address: settings.address?.toObject?.() ?? settings.address ?? {},
  bank: settings.bank?.toObject?.() ?? settings.bank ?? {},
});
