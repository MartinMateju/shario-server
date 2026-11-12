import LocationModel from "@/modules/location/location.model.js";
import MembershipPlanModel from "@/modules/membership/membership-plan.model.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import { createMembershipPlanSchema } from "@/modules/membership/membership.validators.js";
import {
  fromCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import {
  membershipPlanFileIdentityKeys,
  normalizeMembershipPlanImportRow,
  validateMembershipPlanImportRow,
} from "../adapters/membership-plan-import.adapter.js";
import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  type DataImportDuplicateStrategy,
} from "../data-import.constants.js";
import type {
  ImportIssue,
  MembershipPlanImportColumnMapping,
  NormalizedMembershipPlanImportRow,
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
import { assertValidMembershipPlanColumnMapping } from "./import-column-mapping.service.js";
import { validateStagedImportSession } from "./staged-import-validation.service.js";
import {
  isRolledBackImportRecord,
  rolledBackImportIssue,
} from "./data-import-rollback-marker.service.js";

export const createMembershipPlanImportSession = (args: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
}) =>
  createDataImportSession({
    ...args,
    entityType: DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
  });
const actorCanAccessLocation = (membership: any, locationId: string) =>
  membership?.locationAccess?.mode !== "selected" ||
  (membership?.locationAccess?.locationIds || []).some(
    (id: unknown) => String(id) === locationId,
  );
const benefitKey = (benefit: any) => String(benefit?.key || "");
const composeEffectivePlan = (
  normalized: NormalizedMembershipPlanImportRow,
  plan: any | null,
): NormalizedMembershipPlanImportRow => {
  if (!plan?.currentPublishedVersion) return normalized;
  const version = plan.currentPublishedVersion,
    provided = new Set(normalized.providedFields);
  const existingPrice =
    (version.prices || []).find(
      (price: any) =>
        String(price.currency) ===
        (provided.has("currency")
          ? normalized.currency
          : String(version.prices?.[0]?.currency || normalized.currency)),
    ) || version.prices?.[0];
  let benefits = version.benefits || [];
  if (provided.has("benefits")) benefits = normalized.benefits || [];
  else if (
    provided.has("creditAllowance") ||
    provided.has("discountPercent") ||
    provided.has("customPerk")
  ) {
    const replacementKeys = new Set(
      (normalized.benefits || []).map(benefitKey),
    );
    benefits = [
      ...benefits.filter(
        (benefit: any) => !replacementKeys.has(benefitKey(benefit)),
      ),
      ...(normalized.benefits || []),
    ];
  }
  return {
    ...normalized,
    name: provided.has("name") ? normalized.name : String(version.name || ""),
    description: provided.has("description")
      ? normalized.description
      : String(version.description || ""),
    terms: provided.has("terms")
      ? normalized.terms
      : String(version.terms || ""),
    price: provided.has("price")
      ? normalized.price
      : fromCurrencyMinorUnits(
          Number(existingPrice?.amountMinor ?? 0),
          String(
            existingPrice?.currency || normalized.currency,
          ) as StudioCommerceCurrency,
        ),
    currency: provided.has("currency")
      ? normalized.currency
      : String(existingPrice?.currency || normalized.currency),
    billingType: provided.has("billingType")
      ? normalized.billingType
      : version.billing?.type,
    billingInterval: provided.has("billingInterval")
      ? normalized.billingInterval
      : version.billing?.interval || "",
    intervalCount: provided.has("intervalCount")
      ? normalized.intervalCount
      : (version.billing?.intervalCount ?? null),
    durationDays: provided.has("durationDays")
      ? normalized.durationDays
      : (version.billing?.durationDays ?? null),
    locationScope: provided.has("locationScope")
      ? normalized.locationScope
      : version.locationScope?.type,
    locationIds:
      provided.has("locationCodes") || provided.has("locationScope")
        ? undefined
        : (version.locationScope?.locationIds || []).map(String),
    benefits,
    sortOrder: provided.has("sortOrder")
      ? normalized.sortOrder
      : Number(plan.sortOrder || 0),
    status: provided.has("status") ? normalized.status : plan.status,
  };
};

export const validateMembershipPlanImportSession = (args: {
  tenantId: string;
  sessionId: string;
  mapping: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  tenantCurrency: string;
}) =>
  validateStagedImportSession<MembershipPlanImportColumnMapping>({
    tenantId: args.tenantId,
    sessionId: args.sessionId,
    entityType: DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
    mappingInput: args.mapping,
    duplicateStrategy: args.duplicateStrategy,
    actorId: args.actorId,
    assertMapping: assertValidMembershipPlanColumnMapping,
    validationContext: { tenantCurrency: args.tenantCurrency },
    prepare: async ({ rows, mapping }) => {
      const [plans, locations, actorMembership] = await Promise.all([
        MembershipPlanModel.find({ tenant: args.tenantId })
          .select("+importMetadata")
          .populate("currentPublishedVersion")
          .lean(),
        LocationModel.find({ tenant: args.tenantId })
          .select("_id code name slug")
          .lean(),
        TenantMembershipModel.findOne({
          tenant: args.tenantId,
          user: args.actorId,
          status: "active",
        })
          .select("locationAccess")
          .lean(),
      ]);
      if (!actorMembership)
        throw new Error("Active workspace membership is required.");
      const external = new Map<string, ImportLookupRecord[]>(),
        name = new Map<string, ImportLookupRecord[]>();
      for (const plan of plans as ImportLookupRecord[]) {
        addImportLookup(
          external,
          String(plan.importMetadata?.externalId || "").trim(),
          plan,
        );
        addImportLookup(
          name,
          String(plan.currentPublishedVersion?.name || "")
            .trim()
            .toLocaleLowerCase(),
          plan,
        );
      }
      const locationsByCode = new Map<string, ImportLookupRecord[]>();
      for (const location of locations as ImportLookupRecord[])
        if (actorCanAccessLocation(actorMembership, String(location._id)))
          addImportLookup(
            locationsByCode,
            String(location.code || "")
              .trim()
              .toUpperCase(),
            location,
          );
      const fileKeys = new Map<string, number>();
      return rows.map((row) => {
        const source = normalizeMembershipPlanImportRow(
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
            records: source.name
              ? name.get(source.name.toLocaleLowerCase())
              : undefined,
            kind: "name",
          },
        ]);
        const normalized = composeEffectivePlan(source, match.record);
        const issues: ImportIssue[] =
          validateMembershipPlanImportRow(normalized);
        if (isRolledBackImportRecord(match.record))
          issues.push({ ...rolledBackImportIssue });
        if (match.ambiguous)
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_IDENTITY_CONFLICT",
              "Plan identifiers match different or ambiguous records.",
            ),
          );
        if (
          match.record?.importMetadata?.externalId &&
          source.externalId &&
          String(match.record.importMetadata.externalId) !== source.externalId
        )
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_IDENTITY_CONFLICT",
              "The matched plan has another external identity.",
            ),
          );
        if (normalized.currency !== args.tenantCurrency)
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_CURRENCY_MISMATCH",
              "Plan currency must match workspace currency.",
              "currency",
            ),
          );
        const amountMinor =
          normalized.price === null
            ? null
            : toImportMinorUnits(
                normalized.price,
                normalized.currency as StudioCommerceCurrency,
              );
        if (!Number.isSafeInteger(amountMinor) || Number(amountMinor) <= 0)
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_PRICE_PRECISION_INVALID",
              "Plan price has invalid currency precision.",
              "price",
            ),
          );
        const locationIds = normalized.locationIds
          ? [...normalized.locationIds]
          : [];
        if (normalized.locationScope === "all") {
          if (actorMembership.locationAccess?.mode === "selected")
            issues.push(
              importError(
                "MEMBERSHIP_PLAN_LOCATION_OUT_OF_SCOPE",
                "Only an all-location actor may import an all-location plan.",
              ),
            );
        } else if (!normalized.locationIds)
          for (const code of normalized.locationCodes) {
            const candidates = locationsByCode.get(code) || [];
            if (candidates.length !== 1)
              issues.push(
                importError(
                  candidates.length
                    ? "MEMBERSHIP_PLAN_LOCATION_OUT_OF_SCOPE"
                    : "MEMBERSHIP_PLAN_LOCATION_NOT_FOUND",
                  `Location ${code} is missing, ambiguous, or outside your access.`,
                  "locationCodes",
                ),
              );
            else locationIds.push(String(candidates[0]._id));
          }
        if (
          normalized.locationScope === "selected" &&
          locationIds.some((id) => !actorCanAccessLocation(actorMembership, id))
        )
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_LOCATION_OUT_OF_SCOPE",
              "The effective plan contains a location outside your access.",
            ),
          );
        const candidate = {
          name: normalized.name,
          description: normalized.description,
          terms: normalized.terms,
          prices: amountMinor
            ? [{ currency: normalized.currency, amountMinor }]
            : [],
          billing:
            normalized.billingType === "fixed"
              ? { type: "fixed", durationDays: normalized.durationDays }
              : {
                  type: "recurring",
                  interval: normalized.billingInterval,
                  intervalCount: normalized.intervalCount,
                },
          locationScope: { type: normalized.locationScope, locationIds },
          benefits: normalized.benefits || [],
          sortOrder: normalized.sortOrder || 0,
        };
        const parsed = createMembershipPlanSchema.safeParse(candidate);
        if (!parsed.success)
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_BENEFITS_INVALID",
              parsed.error.issues[0]?.message ||
                "Plan configuration is invalid.",
            ),
          );
        if (
          match.record &&
          args.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.UPDATE &&
          (!match.record.importMetadata || match.record.status === "archived")
        )
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_UPDATE_PROTECTED",
              "Only imported, non-archived plans can be updated.",
            ),
          );
        normalized.locationIds = [...new Set(locationIds)];
        normalized.fingerprint = importFingerprint(
          "membership-plan-v1",
          args.tenantId,
          normalized.name,
        );
        if (match.record) {
          normalized.expectedVersionCounter = Number(
            match.record.versionCounter || 0,
          );
          normalized.expectedPublishedVersionId = String(
            match.record.currentPublishedVersion?._id ||
              match.record.currentPublishedVersion ||
              "",
          );
          if (match.record.updatedAt)
            normalized.expectedUpdatedAt = new Date(
              match.record.updatedAt,
            ).toISOString();
        }
        let duplicate: any = match.record
          ? { kind: match.kind || "name", existingRecordId: match.record._id }
          : null;
        const fileDuplicate = registerImportFileIdentity({
          keys: [
            ...(match.record
              ? [{ kind: "existingRecord", value: String(match.record._id) }]
              : []),
            ...membershipPlanFileIdentityKeys(normalized),
          ],
          rowNumber: row.rowNumber,
          fileKeys,
          issues,
          issueCode: "MEMBERSHIP_PLAN_DUPLICATE_IN_FILE",
          issueMessage: "This plan already appears earlier in the file.",
        });
        if (fileDuplicate) duplicate = fileDuplicate;
        return { normalized, issues, duplicate };
      });
    },
  });
