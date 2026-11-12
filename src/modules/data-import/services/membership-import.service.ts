import LocationModel from "@/modules/location/location.model.js";
import MembershipEntitlementBalanceModel from "@/modules/membership/membership-entitlement-balance.schema.js";
import MembershipEntitlementLedgerModel from "@/modules/membership/membership-entitlement-ledger.schema.js";
import MembershipInvoiceModel from "@/modules/membership/membership-invoice.schema.js";
import MembershipPlanModel from "@/modules/membership/membership-plan.model.js";
import MembershipPlanVersionModel from "@/modules/membership/membership-plan-version.model.js";
import UserMembershipModel from "@/modules/membership/user-membership.model.js";
import OrderModel from "@/modules/order/order.model.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import {
  membershipFileIdentityKeys,
  normalizeMembershipImportRow,
  validateMembershipImportRow,
} from "../adapters/membership-import.adapter.js";
import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  type DataImportDuplicateStrategy,
} from "../data-import.constants.js";
import type {
  ImportIssue,
  MembershipImportColumnMapping,
  NormalizedMembershipImportRow,
} from "../data-import.types.js";
import {
  addImportLookup,
  importError,
  importFingerprint,
  importWarning,
  loadImportCustomerIndexes,
  registerImportFileIdentity,
  resolveImportCustomer,
  resolveUniqueImportLookup,
  toImportMinorUnits,
  type ImportLookupRecord,
} from "./import-domain-resolution.service.js";
import { createDataImportSession } from "./data-import.service.js";
import { assertValidMembershipColumnMapping } from "./import-column-mapping.service.js";
import { validateStagedImportSession } from "./staged-import-validation.service.js";
import {
  isRolledBackImportRecord,
  rolledBackImportIssue,
} from "./data-import-rollback-marker.service.js";

export const createMembershipImportSession = (args: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
}) =>
  createDataImportSession({
    ...args,
    entityType: DATA_IMPORT_ENTITY.MEMBERSHIPS,
  });
const isOpenStatus = (status: unknown) =>
  ["active", "cancel_scheduled"].includes(String(status));
const transitionAllowed = (from: string, to: string) =>
  from === to ||
  (from === "active" &&
    ["cancel_scheduled", "cancelled", "expired"].includes(to)) ||
  (from === "cancel_scheduled" && ["cancelled", "expired"].includes(to));
const actorCanAccessLocation = (membership: any, id: string) =>
  membership?.locationAccess?.mode !== "selected" ||
  (membership?.locationAccess?.locationIds || []).some(
    (value: unknown) => String(value) === id,
  );
const naturalFingerprint = (
  tenantId: string,
  row: Pick<
    NormalizedMembershipImportRow,
    "customerId" | "planId" | "startedAt"
  >,
) =>
  importFingerprint(
    "membership-v1",
    tenantId,
    row.customerId,
    row.planId,
    row.startedAt,
  );
const targetsObject = (membership: any): Record<string, number> => {
  const value = membership?.importMetadata?.allowanceTargets;
  if (!value) return {};
  if (value instanceof Map)
    return Object.fromEntries(
      [...value].map(([key, amount]) => [String(key), Number(amount)]),
    );
  return Object.fromEntries(
    Object.entries(value).map(([key, amount]) => [key, Number(amount)]),
  );
};
const iso = (value: unknown) =>
  value ? new Date(value as string | Date).toISOString() : "";
const snapshotJson = (value: any) =>
  JSON.stringify(value?.toObject?.() || value || null);
const versionSnapshot = (version: any) => ({
  version: Number(version.version),
  name: version.name,
  description: version.description || "",
  terms: version.terms || "",
  prices: version.prices || [],
  billing: version.billing,
  locationScope: version.locationScope,
  benefits: version.benefits || [],
});

export const validateMembershipImportSession = (args: {
  tenantId: string;
  sessionId: string;
  mapping: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  tenantCurrency: string;
}) =>
  validateStagedImportSession<MembershipImportColumnMapping>({
    tenantId: args.tenantId,
    sessionId: args.sessionId,
    entityType: DATA_IMPORT_ENTITY.MEMBERSHIPS,
    mappingInput: args.mapping,
    duplicateStrategy: args.duplicateStrategy,
    actorId: args.actorId,
    assertMapping: assertValidMembershipColumnMapping,
    validationContext: { tenantCurrency: args.tenantCurrency },
    prepare: async ({ rows, mapping }) => {
      const [
        customers,
        plans,
        versions,
        locations,
        memberships,
        actorMembership,
      ] = await Promise.all([
        loadImportCustomerIndexes(args.tenantId),
        MembershipPlanModel.find({
          tenant: args.tenantId,
          status: { $in: ["published", "archived"] },
        })
          .select("+importMetadata")
          .lean(),
        MembershipPlanVersionModel.find({
          tenant: args.tenantId,
          status: "published",
        }).lean(),
        LocationModel.find({ tenant: args.tenantId })
          .select("_id code slug name")
          .lean(),
        UserMembershipModel.find({ tenant: args.tenantId })
          .select(
            "+importMetadata +stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId user plan planVersion planSnapshot selectedLocation currency amountMinor status isOpen startedAt currentPeriodStart currentPeriodEnd cancelledAt assignmentNote updatedAt",
          )
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
      const versionById = new Map(
        (versions as ImportLookupRecord[]).map((version) => [
          String(version._id),
          version,
        ]),
      );
      const versionsByPlan = new Map<string, ImportLookupRecord[]>();
      for (const version of versions as ImportLookupRecord[])
        addImportLookup(versionsByPlan, String(version.plan), version);
      const planExternal = new Map<string, ImportLookupRecord[]>(),
        planName = new Map<string, ImportLookupRecord[]>();
      for (const plan of plans as ImportLookupRecord[]) {
        addImportLookup(
          planExternal,
          String(plan.importMetadata?.externalId || "").trim(),
          plan,
        );
        const current = versionById.get(
          String(plan.currentPublishedVersion || ""),
        );
        addImportLookup(
          planName,
          String(current?.name || "")
            .trim()
            .toLocaleLowerCase(),
          plan,
        );
      }
      const accessible = (locations as ImportLookupRecord[]).filter(
        (location) =>
          actorCanAccessLocation(actorMembership, String(location._id)),
      );
      const locationCode = new Map<string, ImportLookupRecord[]>(),
        locationSlug = new Map<string, ImportLookupRecord[]>(),
        locationName = new Map<string, ImportLookupRecord[]>();
      for (const location of accessible) {
        addImportLookup(
          locationCode,
          String(location.code || "")
            .trim()
            .toUpperCase(),
          location,
        );
        addImportLookup(
          locationSlug,
          String(location.slug || "")
            .trim()
            .toLocaleLowerCase(),
          location,
        );
        addImportLookup(
          locationName,
          String(location.name || "")
            .trim()
            .toLocaleLowerCase(),
          location,
        );
      }
      const existingExternal = new Map<string, ImportLookupRecord[]>(),
        existingNatural = new Map<string, ImportLookupRecord[]>();
      for (const membership of memberships as ImportLookupRecord[]) {
        addImportLookup(
          existingExternal,
          String(membership.importMetadata?.externalId || "").trim(),
          membership,
        );
        if (membership.startedAt)
          addImportLookup(
            existingNatural,
            importFingerprint(
              "membership-v1",
              args.tenantId,
              membership.user,
              membership.plan,
              iso(membership.startedAt),
            ),
            membership,
          );
      }
      const membershipIds = (memberships as ImportLookupRecord[]).map(
        (membership) => membership._id,
      );
      const [invoices, balances, ledgers, orders] = await Promise.all([
        MembershipInvoiceModel.find({ membership: { $in: membershipIds } })
          .select("membership")
          .lean(),
        MembershipEntitlementBalanceModel.find({
          membership: { $in: membershipIds },
        })
          .select(
            "membership benefitKey unit granted redeemed adjusted expired available sequence",
          )
          .lean(),
        membershipIds.length
          ? MembershipEntitlementLedgerModel.find({
              membership: { $in: membershipIds },
            })
              .sort({ sequence: 1 })
              .select("membership benefitKey sequence balanceAfter")
              .lean()
          : Promise.resolve([]),
        OrderModel.find({
          tenant: args.tenantId,
          $or: [
            {
              "appliedDiscount.membership.membershipId": { $in: membershipIds },
            },
            { "membershipRedemption.membershipId": { $in: membershipIds } },
          ],
        })
          .select(
            "appliedDiscount.membership.membershipId membershipRedemption.membershipId",
          )
          .lean(),
      ]);
      const invoiceIds = new Set(
          invoices.map((invoice: any) => String(invoice.membership)),
        ),
        orderIds = new Set<string>();
      for (const order of orders as any[]) {
        if (order.appliedDiscount?.membership?.membershipId)
          orderIds.add(String(order.appliedDiscount.membership.membershipId));
        if (order.membershipRedemption?.membershipId)
          orderIds.add(String(order.membershipRedemption.membershipId));
      }
      const balanceMap = new Map<string, Map<string, number>>();
      for (const balance of balances as any[]) {
        const id = String(balance.membership),
          map = balanceMap.get(id) || new Map<string, number>();
        map.set(String(balance.benefitKey), Number(balance.available || 0));
        balanceMap.set(id, map);
      }
      const balanceRecords = new Map<string, Map<string, any>>();
      for (const balance of balances as any[]) {
        const id = String(balance.membership),
          map = balanceRecords.get(id) || new Map<string, any>();
        map.set(String(balance.benefitKey), balance);
        balanceRecords.set(id, map);
      }
      const lastLedger = new Map<string, any>();
      for (const entry of ledgers as any[])
        lastLedger.set(`${entry.membership}:${entry.benefitKey}`, entry);
      const openCanonicalCreditsByUser = new Map<string, number>();
      for (const membership of memberships as ImportLookupRecord[]) {
        if (!(
          membership.isOpen === true ||
          [
            "pending",
            "active",
            "past_due",
            "paused",
            "cancel_scheduled",
          ].includes(String(membership.status))
        ))
          continue;
        const version = versionById.get(String(membership.planVersion));
        const creditKeys = new Set(
          (version?.benefits || [])
            .filter(
              (benefit: any) =>
                benefit.type === "allowance" && benefit.unit === "credit",
            )
            .map((benefit: any) => String(benefit.key)),
        );
        const total = [
          ...(balanceMap.get(String(membership._id)) || new Map()).entries(),
        ]
          .filter(([key]) => creditKeys.has(String(key)))
          .reduce((sum, [, amount]) => sum + Number(amount), 0);
        openCanonicalCreditsByUser.set(
          String(membership.user),
          Number(openCanonicalCreditsByUser.get(String(membership.user)) || 0) +
            total,
        );
      }
      const fileKeys = new Map<string, number>();
      return rows.map((row) => {
        const normalized = normalizeMembershipImportRow(
          row.raw as Record<string, string>,
          mapping,
        );
        normalized.currency ||= args.tenantCurrency;
        const issues: ImportIssue[] = [];
        const customer = resolveImportCustomer(normalized, customers);
        if (customer.ambiguous)
          issues.push(
            importError(
              "MEMBERSHIP_CUSTOMER_IDENTITY_CONFLICT",
              "Customer identifiers match different or ambiguous users.",
            ),
          );
        else if (!customer.record)
          issues.push(
            importError(
              "MEMBERSHIP_CUSTOMER_NOT_FOUND",
              "Customer could not be resolved in this workspace.",
            ),
          );
        else normalized.customerId = String(customer.record._id);
        const planMatch = resolveUniqueImportLookup([
          {
            records: normalized.planExternalId
              ? planExternal.get(normalized.planExternalId)
              : undefined,
            kind: "planExternalId",
          },
          {
            records: normalized.planName
              ? planName.get(normalized.planName.toLocaleLowerCase())
              : undefined,
            kind: "planName",
          },
        ]);
        if (planMatch.ambiguous)
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_IDENTITY_CONFLICT",
              "Plan identifiers match different or ambiguous plans.",
            ),
          );
        else if (!planMatch.record)
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_NOT_FOUND",
              "Published plan could not be resolved.",
            ),
          );
        else normalized.planId = String(planMatch.record._id);
        if (normalized.customerId && normalized.planId && normalized.startedAt)
          normalized.fingerprint = naturalFingerprint(
            args.tenantId,
            normalized,
          );
        const match = resolveUniqueImportLookup([
          {
            records: normalized.externalId
              ? existingExternal.get(normalized.externalId)
              : undefined,
            kind: "externalId",
          },
          {
            records: normalized.fingerprint
              ? existingNatural.get(normalized.fingerprint)
              : undefined,
            kind: "natural",
          },
        ]);
        if (match.ambiguous)
          issues.push(
            importError(
              "MEMBERSHIP_IDENTITY_CONFLICT",
              "Membership identifiers match different or ambiguous records.",
            ),
          );
        const existing = match.record,
          provided = new Set(normalized.providedFields);
        if (existing) {
          normalized.expectedUpdatedAt = iso(existing.updatedAt);
          if (!provided.has("status"))
            normalized.status = String(existing.status);
          if (!provided.has("startedAt"))
            normalized.startedAt = iso(existing.startedAt);
          if (!provided.has("periodStart"))
            normalized.periodStart = iso(existing.currentPeriodStart);
          if (!provided.has("periodEnd"))
            normalized.periodEnd = iso(existing.currentPeriodEnd);
          if (!provided.has("cancelledAt"))
            normalized.cancelledAt = iso(existing.cancelledAt);
          if (!provided.has("currency"))
            normalized.currency = String(existing.currency);
          if (!provided.has("amount"))
            normalized.amountMinor = Number(existing.amountMinor);
          if (!provided.has("note"))
            normalized.note = String(existing.assignmentNote || "");
          if (
            normalized.customerId &&
            normalized.planId &&
            normalized.startedAt
          )
            normalized.fingerprint = naturalFingerprint(
              args.tenantId,
              normalized,
            );
        }
        issues.push(...validateMembershipImportRow(normalized));
        if ((normalized.externalId?.length || 0) > 120)
          issues.push(
            importError(
              "MEMBERSHIP_EXTERNAL_ID_TOO_LONG",
              "External ID is too long.",
              "externalId",
            ),
          );
        if (normalized.status === "cancelled" && !normalized.cancelledAt)
          issues.push(
            importWarning(
              "MEMBERSHIP_CANCELLED_AT_UNKNOWN",
              "Cancellation date was not provided and will remain unknown.",
              "cancelledAt",
            ),
          );
        let version: ImportLookupRecord | undefined;
        if (planMatch.record)
          version =
            existing && !provided.has("planVersion")
              ? versionById.get(String(existing.planVersion))
              : normalized.planVersion
                ? (versionsByPlan.get(normalized.planId!) || []).find(
                    (candidate) =>
                      Number(candidate.version) === normalized.planVersion,
                  )
                : versionById.get(
                    String(planMatch.record.currentPublishedVersion),
                  );
        if (!version && planMatch.record)
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_VERSION_NOT_FOUND",
              "Requested published plan version could not be resolved.",
              "planVersion",
            ),
          );
        if (version) {
          normalized.planVersionId = String(version._id);
          normalized.planVersion = Number(version.version);
        }
        if (
          existing &&
          version &&
          snapshotJson(existing.planSnapshot) !==
            snapshotJson(versionSnapshot(version))
        )
          issues.push(
            importError(
              "MEMBERSHIP_PLAN_SNAPSHOT_INCONSISTENT",
              "The stored membership plan snapshot disagrees with its immutable published version.",
            ),
          );
        if (version?.locationScope?.type === "shared_selected") {
          issues.push(importError(
            "MEMBERSHIP_SHARED_IMPORT_UNSUPPORTED",
            "Shared-location memberships must be assigned from Memberships, not imported with a single location.",
          ));
        } else if (version?.locationScope?.type === "all") {
          if (actorMembership.locationAccess?.mode === "selected")
            issues.push(
              importError(
                "MEMBERSHIP_LOCATION_OUT_OF_SCOPE",
                "Only an all-location actor may import an all-location membership.",
              ),
            );
          if (
            normalized.locationCode ||
            normalized.locationSlug ||
            normalized.locationName
          )
            issues.push(
              importError(
                "MEMBERSHIP_LOCATION_NOT_APPLICABLE",
                "This plan applies to all locations.",
              ),
            );
          normalized.selectedLocationId = undefined;
        } else if (version) {
          const hasInput = Boolean(
            normalized.locationCode ||
            normalized.locationSlug ||
            normalized.locationName,
          );
          const inherited =
            existing && !hasInput
              ? accessible.find(
                  (location) =>
                    String(location._id) === String(existing.selectedLocation),
                )
              : undefined;
          const location = inherited
            ? { record: inherited, ambiguous: false }
            : resolveUniqueImportLookup([
                {
                  records: normalized.locationCode
                    ? locationCode.get(normalized.locationCode)
                    : undefined,
                  kind: "locationCode",
                },
                {
                  records: normalized.locationSlug
                    ? locationSlug.get(normalized.locationSlug)
                    : undefined,
                  kind: "locationSlug",
                },
                {
                  records: normalized.locationName
                    ? locationName.get(
                        normalized.locationName.toLocaleLowerCase(),
                      )
                    : undefined,
                  kind: "locationName",
                },
              ]);
          if (
            location.ambiguous ||
            !location.record ||
            !(version.locationScope.locationIds || [])
              .map(String)
              .includes(String(location.record?._id))
          )
            issues.push(
              importError(
                "MEMBERSHIP_LOCATION_NOT_FOUND",
                "Select one plan location within your access.",
              ),
            );
          else normalized.selectedLocationId = String(location.record._id);
        }
        const offered = version?.prices?.find(
          (price: any) => String(price.currency) === normalized.currency,
        );
        if (normalized.currency !== args.tenantCurrency || !offered)
          issues.push(
            importError(
              "MEMBERSHIP_CURRENCY_NOT_OFFERED",
              "Currency must match an offered workspace plan price.",
              "currency",
            ),
          );
        const amountMinor =
          existing && !provided.has("amount")
            ? normalized.amountMinor
            : normalized.amount === null
              ? Number(offered?.amountMinor)
              : toImportMinorUnits(
                  normalized.amount,
                  normalized.currency as StudioCommerceCurrency,
                );
        if (!Number.isSafeInteger(amountMinor) || Number(amountMinor) < 0)
          issues.push(
            importError(
              "MEMBERSHIP_AMOUNT_INVALID",
              "Amount has invalid currency precision.",
              "amount",
            ),
          );
        else normalized.amountMinor = amountMinor;
        const allowances = (version?.benefits || []).filter(
            (benefit: any) => benefit.type === "allowance",
          ),
          keys = new Set(allowances.map((benefit: any) => String(benefit.key)));
        const explicit = provided.has("allowanceBalances")
            ? normalized.allowanceBalances || {}
            : {},
          prior = existing ? targetsObject(existing) : {},
          merged = existing ? { ...prior, ...explicit } : explicit;
        for (const key of Object.keys(explicit))
          if (!keys.has(key))
            issues.push(
              importError(
                "MEMBERSHIP_ALLOWANCE_KEY_INVALID",
                `Allowance ${key} is not offered by this version.`,
                "allowanceBalances",
              ),
            );
        normalized.allowanceTargets = Object.fromEntries(
          allowances.map((benefit: any) => [
            String(benefit.key),
            Number(merged[String(benefit.key)] || 0),
          ]),
        );
        if (
          !existing &&
          isOpenStatus(normalized.status) &&
          allowances.some(
            (benefit: any) =>
              Number(benefit.quantity || 0) > 0 &&
              explicit[String(benefit.key)] === undefined,
          )
        )
          issues.push(
            importWarning(
              "MEMBERSHIP_ALLOWANCE_DEFAULTED_ZERO",
              "Missing source allowance balances default to zero.",
              "allowanceBalances",
            ),
          );
        if (
          !isOpenStatus(normalized.status) &&
          Object.values(explicit).some((target) => target > 0)
        )
          issues.push(
            importError(
              "MEMBERSHIP_TERMINAL_ALLOWANCE_NONZERO",
              "Terminal memberships cannot import spendable allowances.",
              "allowanceBalances",
            ),
          );
        if (
          !existing &&
          normalized.customerId &&
          isOpenStatus(normalized.status) &&
          (memberships as ImportLookupRecord[]).some(
            (membership) =>
              String(membership.user) === normalized.customerId &&
              (membership.isOpen === true ||
                [
                  "pending",
                  "active",
                  "past_due",
                  "paused",
                  "cancel_scheduled",
                ].includes(String(membership.status))),
          )
        )
          issues.push(
            importError(
              "MEMBERSHIP_ALREADY_OPEN",
              "This customer already has an open membership.",
            ),
          );
        if (
          !existing &&
          isOpenStatus(normalized.status) &&
          Number(customer.record?.membershipCredits || 0) !== 0
        )
          issues.push(
            importError(
              "MEMBERSHIP_LEGACY_BALANCE_CONFLICT",
              "The customer has an unreconciled legacy membership-credit balance.",
            ),
          );
        if (existing) {
          if (isRolledBackImportRecord(existing))
            issues.push({ ...rolledBackImportIssue });
          const id = String(existing._id),
            immutableMismatch =
              String(existing.user) !== normalized.customerId ||
              String(existing.plan) !== normalized.planId ||
              String(existing.planVersion) !== normalized.planVersionId ||
              String(existing.selectedLocation || "") !==
                String(normalized.selectedLocationId || "") ||
              String(existing.currency) !== normalized.currency ||
              Number(existing.amountMinor) !== normalized.amountMinor ||
              iso(existing.startedAt) !== normalized.startedAt ||
              iso(existing.currentPeriodStart) !== normalized.periodStart ||
              (existing.importMetadata?.externalId &&
                normalized.externalId &&
                String(existing.importMetadata.externalId) !==
                  normalized.externalId);
          if (immutableMismatch)
            issues.push(
              importError(
                "MEMBERSHIP_IDENTITY_CONFLICT",
                "Membership identity and purchase snapshot are immutable.",
              ),
            );
          if (
            args.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.UPDATE &&
            (!existing.importMetadata ||
              existing.stripe?.connectedAccountId ||
              existing.stripe?.customerId ||
              existing.stripe?.subscriptionId ||
              existing.stripe?.checkoutSessionId ||
              invoiceIds.has(id) ||
              orderIds.has(id))
          )
            issues.push(
              importError(
                "MEMBERSHIP_UPDATE_PROTECTED",
                "Native, paid, invoiced, or externally managed memberships cannot be updated.",
              ),
            );
          if (!transitionAllowed(String(existing.status), normalized.status))
            issues.push(
              importError(
                "MEMBERSHIP_REOPEN_UNSUPPORTED",
                "Membership imports only allow forward lifecycle transitions.",
                "status",
              ),
            );
          if (
            args.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.UPDATE &&
            existing.importMetadata &&
            isOpenStatus(existing.status) &&
            isOpenStatus(normalized.status)
          ) {
            const current = balanceMap.get(id) || new Map<string, number>(),
              previous = targetsObject(existing);
            for (const [key, target] of Object.entries(
              normalized.allowanceTargets || {},
            )) {
              const delta = Number(target) - Number(previous[key] || 0);
              if (delta < 0 && Number(current.get(key) || 0) < -delta)
                issues.push(
                  importError(
                    "MEMBERSHIP_ALLOWANCE_DELTA_INSUFFICIENT",
                    `Lowering ${key} would make its live balance negative.`,
                    "allowanceBalances",
                  ),
                );
            }
          }
          if (existing.importMetadata) {
            const current = balanceMap.get(id) || new Map<string, number>();
            const records = balanceRecords.get(id) || new Map<string, any>();
            const prior = targetsObject(existing);
            for (const benefit of allowances) {
              const key = String(benefit.key);
              const absentTerminalZero =
                !isOpenStatus(existing.status) &&
                Number(prior[key] || 0) === 0 &&
                !current.has(key);
              if (!(key in prior) || (!current.has(key) && !absentTerminalZero))
                issues.push(
                  importError(
                    "MEMBERSHIP_ALLOWANCE_LEDGER_INCONSISTENT",
                    `Imported allowance ${key} has no live entitlement balance.`,
                    "allowanceBalances",
                  ),
                );
            }
            for (const [key, balance] of records) {
              if (!keys.has(key) || !(key in prior))
                issues.push(
                  importError(
                    "MEMBERSHIP_ALLOWANCE_LEDGER_INCONSISTENT",
                    `Allowance ${key} is missing plan or import provenance.`,
                    "allowanceBalances",
                  ),
                );
              const last = lastLedger.get(`${id}:${key}`);
              if (
                Number(balance.sequence || 0) === 0 &&
                [
                  balance.granted,
                  balance.redeemed,
                  balance.adjusted,
                  balance.expired,
                  balance.available,
                ].some((value) => Number(value || 0) !== 0)
              )
                issues.push(
                  importError(
                    "MEMBERSHIP_ALLOWANCE_LEDGER_INCONSISTENT",
                    `Allowance ${key} has value without a ledger sequence.`,
                    "allowanceBalances",
                  ),
                );
              if (
                Number(balance.sequence || 0) === 0 &&
                Number(prior[key] || 0) !== 0
              )
                issues.push(
                  importError(
                    "MEMBERSHIP_ALLOWANCE_LEDGER_INCONSISTENT",
                    `Allowance ${key} target has no ledger history.`,
                    "allowanceBalances",
                  ),
                );
              if (
                Number(balance.sequence || 0) > 0 &&
                (!last ||
                  Number(last.sequence) !== Number(balance.sequence) ||
                  Number(last.balanceAfter) !== Number(balance.available))
              )
                issues.push(
                  importError(
                    "MEMBERSHIP_ALLOWANCE_LEDGER_INCONSISTENT",
                    `Allowance ${key} ledger and balance disagree.`,
                    "allowanceBalances",
                  ),
                );
            }
            const canonicalOpenCredits = Number(
              openCanonicalCreditsByUser.get(normalized.customerId!) || 0,
            );
            if (
              isOpenStatus(existing.status) &&
              Number(customer.record?.membershipCredits || 0) !==
                canonicalOpenCredits
            )
              issues.push(
                importError(
                  "MEMBERSHIP_ALLOWANCE_LEDGER_INCONSISTENT",
                  "Legacy and canonical membership-credit balances disagree.",
                  "allowanceBalances",
                ),
              );
            if (
              !isOpenStatus(existing.status) &&
              ([...current.values()].some((amount) => Number(amount) > 0) ||
                Number(customer.record?.membershipCredits || 0) !==
                  canonicalOpenCredits)
            )
              issues.push(
                importError(
                  "MEMBERSHIP_ALLOWANCE_LEDGER_INCONSISTENT",
                  "A terminal membership retains spendable entitlement.",
                  "allowanceBalances",
                ),
              );
          }
        }
        let duplicate: any = existing
          ? { kind: match.kind || "natural", existingRecordId: existing._id }
          : null;
        const fileDuplicate = registerImportFileIdentity({
          keys: [
            ...(existing
              ? [{ kind: "existingRecord", value: String(existing._id) }]
              : []),
            ...membershipFileIdentityKeys(normalized),
          ],
          rowNumber: row.rowNumber,
          fileKeys,
          issues,
          issueCode: "MEMBERSHIP_DUPLICATE_IN_FILE",
          issueMessage: "This membership already appears earlier in the file.",
        });
        if (fileDuplicate) duplicate = fileDuplicate;
        return { normalized, issues, duplicate };
      });
    },
  });
