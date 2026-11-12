import ProductModel from "@/modules/product/product.model.js";
import { voucherDesignSchema } from "@/modules/coupon/voucher-design.js";
import {
  normalizeProductKindV2,
  resolveLegacyProductTypeV2,
} from "@/modules/product/product-kind-v2.contract.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import {
  normalizeVoucherProductImportRow,
  validateVoucherProductImportRow,
  voucherProductFileIdentityKeys,
} from "../adapters/voucher-product-import.adapter.js";
import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  type DataImportDuplicateStrategy,
} from "../data-import.constants.js";
import type {
  ImportIssue,
  NormalizedVoucherProductImportRow,
  VoucherProductImportColumnMapping,
} from "../data-import.types.js";
import {
  addImportLookup,
  importError,
  importFingerprint,
  registerImportFileIdentity,
  resolveUniqueImportLookup,
  toImportMinorUnits,
  type ImportLookupRecord,
} from "./import-domain-resolution.service.js";
import { createDataImportSession } from "./data-import.service.js";
import { assertValidVoucherProductColumnMapping } from "./import-column-mapping.service.js";
import { validateStagedImportSession } from "./staged-import-validation.service.js";
import {
  isRolledBackImportRecord,
  rolledBackImportIssue,
} from "./data-import-rollback-marker.service.js";
export const createVoucherProductImportSession = (args: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
}) =>
  createDataImportSession({
    ...args,
    entityType: DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS,
  });
const kind = (product: ImportLookupRecord) =>
  normalizeProductKindV2(product.kind) ||
  (resolveLegacyProductTypeV2(product.type).status === "mapped"
    ? (resolveLegacyProductTypeV2(product.type) as any).kind
    : "");
const effectiveVoucherProduct = (
  source: NormalizedVoucherProductImportRow,
  existing: any,
): NormalizedVoucherProductImportRow => {
  if (!existing) return source;
  const provided = new Set(source.providedFields),
    currency = provided.has("currency")
      ? source.currency
      : String(existing.currency || source.currency);
  return {
    ...source,
    name: provided.has("name") ? source.name : String(existing.name || ""),
    description: provided.has("description")
      ? source.description
      : String(existing.description || ""),
    sku: provided.has("sku") ? source.sku : String(existing.sku || ""),
    value: provided.has("value") ? source.value : Number(existing.price || 0),
    currency,
    isActive: provided.has("isActive")
      ? source.isActive
      : Boolean(existing.isActive),
    sortOrder: provided.has("sortOrder")
      ? source.sortOrder
      : Number(existing.sortOrder || 0),
  };
};
export const validateVoucherProductImportSession = (args: {
  tenantId: string;
  sessionId: string;
  mapping: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  tenantCurrency: string;
}) =>
  validateStagedImportSession<VoucherProductImportColumnMapping>({
    tenantId: args.tenantId,
    sessionId: args.sessionId,
    entityType: DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS,
    mappingInput: args.mapping,
    duplicateStrategy: args.duplicateStrategy,
    actorId: args.actorId,
    assertMapping: assertValidVoucherProductColumnMapping,
    validationContext: { tenantCurrency: args.tenantCurrency },
    prepare: async ({ rows, mapping }) => {
      const products = (await ProductModel.find({ tenant: args.tenantId })
        .select(
          "name description sku kind type price currency isActive sortOrder voucherTemplate voucherDesign updatedAt +stripeProductId +stripePriceId +importMetadata",
        )
        .lean()) as ImportLookupRecord[];
      const external = new Map<string, ImportLookupRecord[]>(),
        sku = new Map<string, ImportLookupRecord[]>(),
        name = new Map<string, ImportLookupRecord[]>();
      for (const product of products) {
        addImportLookup(
          external,
          String(product.importMetadata?.externalId || "").trim(),
          product,
        );
        addImportLookup(
          sku,
          String(product.sku || "")
            .trim()
            .toLocaleLowerCase(),
          product,
        );
        addImportLookup(
          name,
          String(product.name || "")
            .trim()
            .toLocaleLowerCase(),
          product,
        );
      }
      const fileKeys = new Map<string, number>();
      return rows.map((row) => {
        const source = normalizeVoucherProductImportRow(
          row.raw as Record<string, string>,
          mapping,
        );
        source.currency ||= args.tenantCurrency;
        const match = resolveUniqueImportLookup([
          {
            records: source.externalId
              ? external.get(source.externalId)
              : undefined,
            kind: "externalId",
          },
          {
            records: source.sku
              ? sku.get(source.sku.toLocaleLowerCase())
              : undefined,
            kind: "sku",
          },
          {
            records: source.name
              ? name.get(source.name.toLocaleLowerCase())
              : undefined,
            kind: "name",
          },
        ]);
        const normalized = effectiveVoucherProduct(source, match.record),
          issues: ImportIssue[] = validateVoucherProductImportRow(normalized);
        if (isRolledBackImportRecord(match.record))
          issues.push({ ...rolledBackImportIssue });
        if (match.ambiguous)
          issues.push(
            importError(
              "VOUCHER_PRODUCT_IDENTITY_CONFLICT",
              "Voucher product identifiers match different or ambiguous records.",
            ),
          );
        if (
          match.record?.importMetadata?.externalId &&
          source.externalId &&
          String(match.record.importMetadata.externalId) !== source.externalId
        )
          issues.push(
            importError(
              "VOUCHER_PRODUCT_IDENTITY_CONFLICT",
              "The matched product has another external identity.",
            ),
          );
        if (match.record && kind(match.record) !== "voucher")
          issues.push(
            importError(
              "VOUCHER_PRODUCT_KIND_CONFLICT",
              "The matched product is not a Voucher product.",
            ),
          );
        if (normalized.currency !== args.tenantCurrency)
          issues.push(
            importError(
              "VOUCHER_PRODUCT_CURRENCY_MISMATCH",
              "Currency must match workspace currency.",
              "currency",
            ),
          );
        const valueMinor =
          normalized.value === null
            ? null
            : toImportMinorUnits(
                normalized.value,
                normalized.currency as StudioCommerceCurrency,
              );
        if (!Number.isSafeInteger(valueMinor) || Number(valueMinor) <= 0)
          issues.push(
            importError(
              "VOUCHER_PRODUCT_VALUE_PRECISION_INVALID",
              "Voucher value has invalid currency precision.",
              "value",
            ),
          );
        if (
          normalized.isActive &&
          (!match.record ||
            args.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.UPDATE) &&
          !String(match.record?.voucherTemplate || "").trim() &&
          !voucherDesignSchema.safeParse(match.record?.voucherDesign).success
        )
          issues.push(
            importError(
              "VOUCHER_PRODUCT_TEMPLATE_REQUIRED",
              "Configure a voucher design or PDF template before activating this voucher product.",
              "isActive",
            ),
          );
        if (
          match.record &&
          args.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.UPDATE &&
          !match.record.importMetadata
        )
          issues.push(
            importError(
              "VOUCHER_PRODUCT_UPDATE_PROTECTED",
              "Only import-owned voucher products can be updated.",
            ),
          );
        if (
          match.record &&
          args.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.UPDATE &&
          (match.record.stripeProductId || match.record.stripePriceId) &&
          ((source.providedFields.includes("value") &&
            Number(match.record.price) !== Number(normalized.value)) ||
            (source.providedFields.includes("currency") &&
              String(match.record.currency) !== normalized.currency))
        )
          issues.push(
            importError(
              "VOUCHER_PRODUCT_STRIPE_UPDATE_PROTECTED",
              "Stripe-linked commercial value or currency cannot be changed.",
            ),
          );
        normalized.fingerprint = importFingerprint(
          "voucher-product-v1",
          args.tenantId,
          normalized.name,
        );
        if (match.record?.updatedAt)
          normalized.expectedUpdatedAt = new Date(
            match.record.updatedAt,
          ).toISOString();
        let duplicate: any = match.record
          ? { kind: match.kind || "name", existingRecordId: match.record._id }
          : null;
        const fileDuplicate = registerImportFileIdentity({
          keys: [
            ...(match.record
              ? [{ kind: "existingRecord", value: String(match.record._id) }]
              : []),
            ...voucherProductFileIdentityKeys(normalized),
          ],
          rowNumber: row.rowNumber,
          fileKeys,
          issues,
          issueCode: "VOUCHER_PRODUCT_DUPLICATE_IN_FILE",
          issueMessage: "This voucher product appears earlier in the file.",
        });
        if (fileDuplicate) duplicate = fileDuplicate;
        return { normalized, issues, duplicate };
      });
    },
  });
