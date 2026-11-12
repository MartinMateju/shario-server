import mongoose from "mongoose";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import ProductModel from "@/modules/product/product.model.js";
import {
  normalizeProductKindV2,
  resolveLegacyProductTypeV2,
} from "@/modules/product/product-kind-v2.contract.js";
import {
  fromCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import {
  normalizeVoucherImportRow,
  validateVoucherImportRow,
  voucherFileIdentityKeys,
  voucherHasCustomerIdentity,
} from "../adapters/voucher-import.adapter.js";
import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  type DataImportDuplicateStrategy,
} from "../data-import.constants.js";
import type {
  ImportIssue,
  VoucherImportColumnMapping,
} from "../data-import.types.js";
import {
  addImportLookup,
  importError,
  importFingerprint,
  loadImportCustomerIndexes,
  registerImportFileIdentity,
  resolveImportCustomer,
  resolveUniqueImportLookup,
  toImportMinorUnits,
  type ImportLookupRecord,
} from "./import-domain-resolution.service.js";
import { createDataImportSession } from "./data-import.service.js";
import { assertValidVoucherColumnMapping } from "./import-column-mapping.service.js";
import { validateStagedImportSession } from "./staged-import-validation.service.js";
import {
  isRolledBackImportRecord,
  rolledBackImportIssue,
} from "./data-import-rollback-marker.service.js";
export const createVoucherImportSession = (args: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
}) =>
  createDataImportSession({ ...args, entityType: DATA_IMPORT_ENTITY.VOUCHERS });
const kind = (product: ImportLookupRecord) =>
  normalizeProductKindV2(product.kind) ||
  (resolveLegacyProductTypeV2(product.type).status === "mapped"
    ? (resolveLegacyProductTypeV2(product.type) as any).kind
    : "");
const storedStatus = (coupon: any) =>
  coupon.redeemedAt
    ? "redeemed"
    : coupon.expiresAt && new Date(coupon.expiresAt) <= new Date()
      ? "expired"
      : coupon.isActive
        ? "active"
        : "disabled";
const transitionAllowed = (from: string, to: string) =>
  from === to || from === "active";
export const validateVoucherImportSession = (args: {
  tenantId: string;
  sessionId: string;
  mapping: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  tenantCurrency: string;
}) =>
  validateStagedImportSession<VoucherImportColumnMapping>({
    tenantId: args.tenantId,
    sessionId: args.sessionId,
    entityType: DATA_IMPORT_ENTITY.VOUCHERS,
    mappingInput: args.mapping,
    duplicateStrategy: args.duplicateStrategy,
    actorId: args.actorId,
    assertMapping: assertValidVoucherColumnMapping,
    validationContext: { tenantCurrency: args.tenantCurrency },
    prepare: async ({ rows, mapping }) => {
      const [customers, products, coupons] = await Promise.all([
        loadImportCustomerIndexes(args.tenantId),
        ProductModel.find({ tenant: args.tenantId })
          .select("name sku kind type +importMetadata")
          .lean(),
        Coupon.find({ tenant: args.tenantId })
          .select(
            "product promoCode isActive expiresAt reservedAt reservedBy reservedOrder reservedUntil redeemedAt redeemedBy order valueMinorSnapshot currencySnapshot updatedAt +importMetadata",
          )
          .lean(),
      ]);
      const couponIds = (coupons as ImportLookupRecord[]).map(
        (coupon) => coupon._id,
      );
      const credited = couponIds.length
        ? await MoneyCredit.aggregate([
            {
              $match: {
                tenant: new mongoose.Types.ObjectId(args.tenantId),
                transactions: {
                  $elemMatch: { relatedCoupon: { $in: couponIds } },
                },
              },
            },
            { $unwind: "$transactions" },
            { $match: { "transactions.relatedCoupon": { $in: couponIds } } },
            { $group: { _id: "$transactions.relatedCoupon" } },
          ])
        : [];
      const creditedIds = new Set(
        credited.map((record: any) => String(record._id)),
      );
      const productById = new Map(
        (products as ImportLookupRecord[]).map((product) => [
          String(product._id),
          product,
        ]),
      );
      const productExternal = new Map<string, ImportLookupRecord[]>(),
        productSku = new Map<string, ImportLookupRecord[]>(),
        productName = new Map<string, ImportLookupRecord[]>();
      for (const product of products as ImportLookupRecord[]) {
        addImportLookup(
          productExternal,
          String(product.importMetadata?.externalId || "").trim(),
          product,
        );
        addImportLookup(
          productSku,
          String(product.sku || "")
            .trim()
            .toLocaleLowerCase(),
          product,
        );
        addImportLookup(
          productName,
          String(product.name || "")
            .trim()
            .toLocaleLowerCase(),
          product,
        );
      }
      const couponExternal = new Map<string, ImportLookupRecord[]>(),
        couponCode = new Map<string, ImportLookupRecord[]>();
      for (const coupon of coupons as ImportLookupRecord[]) {
        addImportLookup(
          couponExternal,
          String(coupon.importMetadata?.externalId || "").trim(),
          coupon,
        );
        addImportLookup(
          couponCode,
          String(coupon.promoCode || "")
            .trim()
            .toUpperCase(),
          coupon,
        );
      }
      const fileKeys = new Map<string, number>();
      return rows.map((row) => {
        const normalized = normalizeVoucherImportRow(
          row.raw as Record<string, string>,
          mapping,
        );
        normalized.currency ||= args.tenantCurrency;
        const existingMatch = resolveUniqueImportLookup([
          {
            records: normalized.externalId
              ? couponExternal.get(normalized.externalId)
              : undefined,
            kind: "externalId",
          },
          {
            records: normalized.promoCode
              ? couponCode.get(normalized.promoCode)
              : undefined,
            kind: "promoCode",
          },
        ]);
        const existing = existingMatch.record,
          provided = new Set(normalized.providedFields);
        if (existing) {
          if (!provided.has("promoCode"))
            normalized.promoCode = String(existing.promoCode || "");
          if (!provided.has("status"))
            normalized.status = storedStatus(existing);
          if (!provided.has("expiresAt"))
            normalized.expiresAt = existing.expiresAt
              ? new Date(existing.expiresAt).toISOString()
              : "";
          if (!provided.has("redeemedAt"))
            normalized.redeemedAt = existing.redeemedAt
              ? new Date(existing.redeemedAt).toISOString()
              : "";
          if (!provided.has("note"))
            normalized.note = String(existing.importMetadata?.note || "");
          if (!provided.has("currency"))
            normalized.currency = String(
              existing.currencySnapshot || normalized.currency,
            );
          if (
            !provided.has("value") &&
            Number.isSafeInteger(Number(existing.valueMinorSnapshot)) &&
            normalized.currency
          ) {
            normalized.valueMinor = Number(existing.valueMinorSnapshot);
            normalized.value = fromCurrencyMinorUnits(
              Number(existing.valueMinorSnapshot),
              normalized.currency as StudioCommerceCurrency,
            );
          }
          if (
            !provided.has("customerExternalId") &&
            !provided.has("customerEmail") &&
            !provided.has("customerPhone") &&
            existing.redeemedBy
          )
            normalized.customerId = String(existing.redeemedBy);
          const storedProduct = productById.get(String(existing.product));
          if (
            !provided.has("productExternalId") &&
            !provided.has("productSku") &&
            !provided.has("productName") &&
            storedProduct
          )
            normalized.productName = String(storedProduct.name || "");
        }
        const issues: ImportIssue[] = validateVoucherImportRow(normalized);
        if (isRolledBackImportRecord(existing))
          issues.push({ ...rolledBackImportIssue });
        if (existingMatch.ambiguous)
          issues.push(
            importError(
              "VOUCHER_IDENTITY_CONFLICT",
              "Voucher external ID and code match different records.",
            ),
          );
        const product = resolveUniqueImportLookup([
          {
            records: normalized.productExternalId
              ? productExternal.get(normalized.productExternalId)
              : undefined,
            kind: "productExternalId",
          },
          {
            records: normalized.productSku
              ? productSku.get(normalized.productSku.toLocaleLowerCase())
              : undefined,
            kind: "productSku",
          },
          {
            records: normalized.productName
              ? productName.get(normalized.productName.toLocaleLowerCase())
              : undefined,
            kind: "productName",
          },
        ]);
        if (product.ambiguous)
          issues.push(
            importError(
              "VOUCHER_PRODUCT_IDENTITY_CONFLICT",
              "Product identifiers match different records.",
            ),
          );
        else if (!product.record || kind(product.record) !== "voucher")
          issues.push(
            importError(
              "VOUCHER_PRODUCT_NOT_FOUND",
              "A Voucher product could not be resolved.",
            ),
          );
        else normalized.productId = String(product.record._id);
        if (voucherHasCustomerIdentity(normalized)) {
          const customer = resolveImportCustomer(normalized, customers);
          if (customer.ambiguous)
            issues.push(
              importError(
                "VOUCHER_CUSTOMER_IDENTITY_CONFLICT",
                "Customer identifiers match different users.",
              ),
            );
          else if (!customer.record)
            issues.push(
              importError(
                "VOUCHER_CUSTOMER_NOT_FOUND",
                "Redeeming customer could not be resolved.",
              ),
            );
          else normalized.customerId = String(customer.record._id);
        }
        if (normalized.currency !== args.tenantCurrency)
          issues.push(
            importError(
              "VOUCHER_SNAPSHOT_INVALID",
              "Currency must match workspace currency.",
              "currency",
            ),
          );
        const valueMinor =
          existing && !provided.has("value")
            ? (normalized.valueMinor ?? null)
            : normalized.value === null
              ? null
              : toImportMinorUnits(
                  normalized.value,
                  normalized.currency as StudioCommerceCurrency,
                );
        normalized.valueMinor = valueMinor ?? undefined;
        if (!Number.isSafeInteger(valueMinor) || Number(valueMinor) <= 0)
          issues.push(
            importError(
              "VOUCHER_SNAPSHOT_INVALID",
              "Voucher value has invalid currency precision.",
              "value",
            ),
          );
        normalized.fingerprint = importFingerprint(
          "voucher-v1",
          args.tenantId,
          normalized.promoCode,
        );
        if (existing?.updatedAt)
          normalized.expectedUpdatedAt = new Date(
            existing.updatedAt,
          ).toISOString();
        if (existing) {
          const hasValue =
              existing.valueMinorSnapshot !== null &&
              existing.valueMinorSnapshot !== undefined,
            hasCurrency = Boolean(existing.currencySnapshot);
          if (!hasValue || !hasCurrency)
            issues.push(
              importError(
                "VOUCHER_LEGACY_SNAPSHOT_REQUIRED",
                "Run voucher snapshot backfill before importing this legacy voucher.",
              ),
            );
          if (
            String(existing.product) !== normalized.productId ||
            String(existing.promoCode) !== normalized.promoCode ||
            (hasValue && Number(existing.valueMinorSnapshot) !== valueMinor) ||
            (hasCurrency &&
              String(existing.currencySnapshot) !== normalized.currency) ||
            (existing.importMetadata?.externalId &&
              normalized.externalId &&
              String(existing.importMetadata.externalId) !==
                normalized.externalId)
          )
            issues.push(
              importError(
                "VOUCHER_IDENTITY_CONFLICT",
                "Voucher code, product, value, currency, and external identity are immutable.",
              ),
            );
          if (
            args.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.UPDATE &&
            (!existing.importMetadata ||
              existing.reservedAt ||
              existing.reservedBy ||
              existing.reservedOrder ||
              existing.reservedUntil ||
              existing.order ||
              creditedIds.has(String(existing._id)))
          )
            issues.push(
              importError(
                "VOUCHER_UPDATE_PROTECTED",
                "Native, reserved, ordered, or credited vouchers cannot be updated.",
              ),
            );
          if (!transitionAllowed(storedStatus(existing), normalized.status))
            issues.push(
              importError(
                "VOUCHER_RESURRECTION_UNSUPPORTED",
                "Voucher imports only allow Active to terminal transitions.",
                "status",
              ),
            );
        }
        let duplicate: any = existing
          ? {
              kind: existingMatch.kind || "promoCode",
              existingRecordId: existing._id,
            }
          : null;
        const fileDuplicate = registerImportFileIdentity({
          keys: [
            ...(existing
              ? [{ kind: "existingRecord", value: String(existing._id) }]
              : []),
            ...voucherFileIdentityKeys(normalized),
          ],
          rowNumber: row.rowNumber,
          fileKeys,
          issues,
          issueCode: "VOUCHER_DUPLICATE_IN_FILE",
          issueMessage: "This voucher appears earlier in the file.",
        });
        if (fileDuplicate) duplicate = fileDuplicate;
        return { normalized, issues, duplicate };
      });
    },
  });
