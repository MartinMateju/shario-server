import mongoose from "mongoose";

import LocationModel from "@/modules/location/location.model.js";
import MembershipEntitlementBalanceModel from "@/modules/membership/membership-entitlement-balance.schema.js";
import MembershipEntitlementLedgerModel from "@/modules/membership/membership-entitlement-ledger.schema.js";
import MembershipInvoiceModel from "@/modules/membership/membership-invoice.schema.js";
import MembershipPlanModel from "@/modules/membership/membership-plan.model.js";
import MembershipPlanVersionModel from "@/modules/membership/membership-plan-version.model.js";
import UserMembershipModel from "@/modules/membership/user-membership.model.js";
import { appendMembershipImportAdjustment } from "@/modules/membership/services/membership-entitlement.service.js";
import { terminalizeMembership } from "@/modules/membership/services/membership-lifecycle.service.js";
import OrderModel from "@/modules/order/order.model.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import UserModel from "@/modules/user/user.model.js";

import { validateMembershipImportRow } from "../adapters/membership-import.adapter.js";
import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
} from "../data-import.constants.js";
import type { NormalizedMembershipImportRow } from "../data-import.types.js";
import {
  canImportLocation,
  importMetadata,
  importObjectId,
  isImportDuplicateKey,
  loadCommerceImportGuard,
} from "./commerce-import-execution.utils.js";
import { importFingerprint } from "./import-domain-resolution.service.js";
import { processStagedImportSession } from "./staged-import-execution.service.js";
import {
  importMutationOperation,
  recordDataImportMutation,
} from "./data-import-mutation.service.js";
import { assertImportRecordNotRolledBack } from "./data-import-rollback-marker.service.js";

const MEMBERSHIP_MUTABLE_FIELDS = [
  "status",
  "isOpen",
  "startedAt",
  "currentPeriodStart",
  "currentPeriodEnd",
  "renewsAt",
  "autoRenew",
  "cancelAtPeriodEnd",
  "cancelScheduledAt",
  "cancelledAt",
  "cancellation",
  "assignmentNote",
  "grantedPeriodKeys",
  "importMetadata",
] as const;

const loadAllowancePostState = async (
  tenantId: string,
  membershipId: unknown,
  session: mongoose.ClientSession,
) =>
  (
    await MembershipEntitlementBalanceModel.find({
      tenant: tenantId,
      membership: membershipId,
    })
      .select("benefitKey available sequence")
      .session(session)
      .lean()
  ).map((balance: any) => ({
    benefitKey: String(balance.benefitKey),
    available: Number(balance.available || 0),
    sequence: Number(balance.sequence || 0),
  }));

const OPEN_SOURCE_STATUSES = new Set(["active", "cancel_scheduled"]);
const isOpenSourceStatus = (value: unknown): boolean =>
  OPEN_SOURCE_STATUSES.has(String(value));
const transitionAllowed = (from: string, to: string): boolean =>
  from === to ||
  (from === "active" &&
    ["cancel_scheduled", "cancelled", "expired"].includes(to)) ||
  (from === "cancel_scheduled" && ["cancelled", "expired"].includes(to));
const targetsObject = (membership: any): Record<string, number> => {
  const targets = membership?.importMetadata?.allowanceTargets;
  if (!targets) return {};
  const entries =
    targets instanceof Map ? [...targets.entries()] : Object.entries(targets);
  return Object.fromEntries(
    entries.map(([key, value]) => [String(key), Number(value)]),
  );
};
const iso = (value: unknown): string =>
  value ? new Date(value as string | Date).toISOString() : "";

const findMembership = async ({
  tenantId,
  normalized,
  existingRecordId,
  importKey,
  session = null,
  document = false,
}: {
  tenantId: string;
  normalized: NormalizedMembershipImportRow;
  existingRecordId?: unknown;
  importKey: string;
  session?: mongoose.ClientSession | null;
  document?: boolean;
}) => {
  const or: Record<string, unknown>[] = [
    { "importMetadata.importKey": importKey },
    { "importMetadata.fingerprint": normalized.fingerprint },
  ];
  if (existingRecordId) or.push({ _id: existingRecordId });
  if (normalized.externalId)
    or.push({ "importMetadata.externalId": normalized.externalId });
  if (normalized.customerId && normalized.planId && normalized.startedAt)
    or.push({
      user: normalized.customerId,
      plan: normalized.planId,
      startedAt: new Date(normalized.startedAt),
    });
  const query = UserMembershipModel.find({ tenant: tenantId, $or: or })
    .select(
      "+importMetadata +stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId +grantedPeriodKeys",
    )
    .session(session);
  const rows = document ? await query.exec() : await query.lean();
  const unique = new Map(
    rows.map((record: any) => [String(record._id), record]),
  );
  if (unique.size > 1) throw new Error("Membership identity is ambiguous.");
  return [...unique.values()][0] || null;
};

const membershipIdentityMatches = (
  membership: any,
  normalized: NormalizedMembershipImportRow,
): boolean =>
  String(membership.user) === normalized.customerId &&
  String(membership.plan) === normalized.planId &&
  String(membership.planVersion) === normalized.planVersionId &&
  String(membership.selectedLocation || "") ===
    String(normalized.selectedLocationId || "") &&
  String(membership.currency) === normalized.currency &&
  Number(membership.amountMinor) === Number(normalized.amountMinor) &&
  iso(membership.startedAt) === normalized.startedAt &&
  iso(membership.currentPeriodStart) === normalized.periodStart &&
  (!membership.importMetadata?.externalId ||
    !normalized.externalId ||
    membership.importMetadata.externalId === normalized.externalId);

const planSnapshot = (version: any) => ({
  version: Number(version.version),
  name: version.name,
  description: version.description || "",
  terms: version.terms || "",
  prices: version.prices || [],
  billing: version.billing,
  locationScope: version.locationScope,
  benefits: version.benefits || [],
});
const snapshotJson = (value: any): string =>
  JSON.stringify(value?.toObject?.() || value || null);

const ensureEntitlementConsistency = async ({
  tenantId,
  membership,
  user,
  version,
  session,
}: {
  tenantId: string;
  membership: any;
  user: any;
  version: any;
  session: mongoose.ClientSession;
}) => {
  const allowances = (version.benefits || []).filter(
    (benefit: any) => benefit.type === "allowance",
  );
  const keys = new Set(allowances.map((benefit: any) => String(benefit.key)));
  const prior = targetsObject(membership);
  const balances = await MembershipEntitlementBalanceModel.find({
    tenant: tenantId,
    membership: membership._id,
  })
    .session(session)
    .lean();
  const ledgers = await MembershipEntitlementLedgerModel.find({
    tenant: tenantId,
    membership: membership._id,
  })
    .sort({ sequence: 1 })
    .session(session)
    .lean();
  const balanceByKey = new Map(
    balances.map((balance: any) => [String(balance.benefitKey), balance]),
  );
  const lastByKey = new Map<string, any>();
  for (const entry of ledgers as any[])
    lastByKey.set(String(entry.benefitKey), entry);
  for (const benefit of allowances) {
    const key = String(benefit.key);
    const absentTerminalZero =
      !membership.isOpen &&
      Number(prior[key] || 0) === 0 &&
      !balanceByKey.has(key);
    if (!(key in prior) || (!balanceByKey.has(key) && !absentTerminalZero))
      throw new Error(
        `Imported membership allowance ${key} lacks provenance or a balance.`,
      );
  }
  for (const [key, balance] of balanceByKey) {
    if (!keys.has(key) || !(key in prior))
      throw new Error(
        `Imported membership has an orphan allowance balance: ${key}.`,
      );
    const last = lastByKey.get(key);
    if (
      Number((balance as any).sequence || 0) === 0 &&
      [
        (balance as any).granted,
        (balance as any).redeemed,
        (balance as any).adjusted,
        (balance as any).expired,
        (balance as any).available,
      ].some((value) => Number(value || 0) !== 0)
    )
      throw new Error(
        `Membership allowance ${key} has value without a ledger sequence.`,
      );
    if (
      Number((balance as any).sequence || 0) === 0 &&
      Number(prior[key] || 0) !== 0
    )
      throw new Error(
        `Membership allowance ${key} target has no ledger history.`,
      );
    if (
      Number((balance as any).sequence || 0) > 0 &&
      (!last ||
        Number(last.sequence) !== Number((balance as any).sequence) ||
        Number(last.balanceAfter) !== Number((balance as any).available))
    )
      throw new Error(
        `Membership allowance ${key} ledger and balance disagree.`,
      );
  }
  const openMembershipIds = await UserMembershipModel.find({
    tenant: tenantId,
    user: membership.user,
    isOpen: true,
  })
    .distinct("_id")
    .session(session);
  const openCreditBalances = openMembershipIds.length
    ? await MembershipEntitlementBalanceModel.find({
        tenant: tenantId,
        membership: { $in: openMembershipIds },
        unit: "credit",
      })
        .select("available")
        .session(session)
        .lean()
    : [];
  const canonicalCredits = openCreditBalances.reduce(
    (sum: number, balance: any) => sum + Number(balance.available || 0),
    0,
  );
  if (Number(user.membershipCredits || 0) !== canonicalCredits)
    throw new Error(
      "Legacy and canonical membership-credit balances disagree.",
    );
  if (
    !membership.isOpen &&
    balances.some((balance: any) => Number(balance.available || 0) > 0)
  )
    throw new Error("A terminal membership retains spendable entitlement.");
  return { allowances, prior, balanceByKey };
};

const executeMembershipRow = async ({
  tenantId,
  sessionId,
  actorId,
  session: importSession,
  row,
}: any) => {
  const normalized = row.normalized as NormalizedMembershipImportRow;
  const guard = await loadCommerceImportGuard({
    tenantId,
    actorId,
    permission: WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
    moduleName: "memberships",
  });
  if (guard.currency !== normalized.currency)
    throw new Error("Workspace currency changed after validation.");
  if (
    normalized.selectedLocationId &&
    !canImportLocation(guard.access, normalized.selectedLocationId)
  )
    throw new Error(
      "The queued actor no longer has access to the membership location.",
    );
  const importKey = `${sessionId}:${row.rowNumber}`;
  let record = await findMembership({
    tenantId,
    normalized,
    existingRecordId: row.duplicate?.existingRecordId,
    importKey,
  });
  if (record?.importMetadata?.lastMutationKey === importKey)
    return {
      action: "skipped" as const,
      recordId: record._id,
      message: "Membership row was already applied.",
    };
  if (record && !membershipIdentityMatches(record, normalized))
    throw new Error("Membership immutable identity changed after validation.");
  if (
    record &&
    importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
  )
    return {
      action: "skipped" as const,
      recordId: record._id,
      message: "Existing membership skipped.",
    };

  const transaction = await mongoose.startSession();
  try {
    let result: any;
    await transaction.withTransaction(async () => {
      const currentGuard = await loadCommerceImportGuard({
        tenantId,
        actorId,
        permission: WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
        moduleName: "memberships",
        session: transaction,
      });
      if (currentGuard.currency !== normalized.currency)
        throw new Error("Workspace currency changed after validation.");
      const user = await UserModel.findOne({
        _id: normalized.customerId,
        tenant: tenantId,
      })
        .select("_id membershipCredits membershipCreditsExpireAt")
        .session(transaction);
      if (!user)
        throw new Error(
          "The tenant-scoped membership customer is no longer available.",
        );
      const plan = await MembershipPlanModel.findOne({
        _id: normalized.planId,
        tenant: tenantId,
        status: { $in: ["published", "archived"] },
      })
        .session(transaction)
        .lean();
      const version = await MembershipPlanVersionModel.findOne({
        _id: normalized.planVersionId,
        tenant: tenantId,
        plan: normalized.planId,
        status: "published",
      })
        .session(transaction)
        .lean();
      if (!plan || !version)
        throw new Error(
          "The published membership plan version is no longer available.",
        );
      if (version.locationScope?.type === "shared_selected") {
        throw new Error("Shared-location memberships must be assigned from Memberships, not imported with a single location.");
      } else if (version.locationScope?.type === "all") {
        if (currentGuard.access.locationAccess.mode === "selected")
          throw new Error(
            "The queued actor cannot import an all-location membership.",
          );
        if (normalized.selectedLocationId)
          throw new Error(
            "An all-location plan cannot have a selected location.",
          );
      } else {
        if (
          !normalized.selectedLocationId ||
          !canImportLocation(currentGuard.access, normalized.selectedLocationId)
        )
          throw new Error(
            "The queued actor cannot access the selected membership location.",
          );
        const location = await LocationModel.exists({
          _id: normalized.selectedLocationId,
          tenant: tenantId,
        }).session(transaction);
        if (
          !location ||
          !(version.locationScope?.locationIds || [])
            .map(String)
            .includes(normalized.selectedLocationId)
        )
          throw new Error(
            "The selected membership location is no longer offered by the plan.",
          );
      }
      const runtimeIssues = validateMembershipImportRow(normalized, new Date());
      if (runtimeIssues.some((issue) => issue.severity === "error"))
        throw new Error(runtimeIssues[0].message);
      if (
        !isOpenSourceStatus(normalized.status) &&
        normalized.providedFields.includes("allowanceBalances") &&
        Object.values(normalized.allowanceBalances || {}).some(
          (value) => Number(value) > 0,
        )
      )
        throw new Error(
          "Terminal memberships cannot import spendable allowances.",
        );
      const current = await findMembership({
        tenantId,
        normalized,
        existingRecordId: record?._id || row.duplicate?.existingRecordId,
        importKey,
        session: transaction,
        document: true,
      });
      assertImportRecordNotRolledBack(current);
      if (current?.importMetadata?.lastMutationKey === importKey) {
        if (!membershipIdentityMatches(current, normalized))
          throw new Error(
            "Membership retry identity conflicts with the stored row.",
          );
        result = {
          action: "skipped" as const,
          recordId: current._id,
          message: "Membership row was already applied.",
        };
        return;
      }
      if (!record && current)
        throw new Error(
          "A matching membership was created after validation. Validate again.",
        );
      if (record && (!current || String(current._id) !== String(record._id)))
        throw new Error("Membership identity changed after validation.");
      if (current) {
        if (!membershipIdentityMatches(current, normalized))
          throw new Error(
            "Membership immutable identity changed after validation.",
          );
        if (iso(current.updatedAt) !== normalized.expectedUpdatedAt)
          throw new Error(
            "Membership changed after validation. Validate again.",
          );
        if (
          !current.importMetadata ||
          current.stripe?.connectedAccountId ||
          current.stripe?.customerId ||
          current.stripe?.subscriptionId ||
          current.stripe?.checkoutSessionId
        )
          throw new Error(
            "Only offline import-owned memberships can be updated.",
          );
        if (
          snapshotJson(current.planSnapshot) !==
          snapshotJson(planSnapshot(version))
        )
          throw new Error(
            "The stored membership plan snapshot disagrees with its immutable published version.",
          );
        const invoice = await MembershipInvoiceModel.exists({
          tenant: tenantId,
          membership: current._id,
        }).session(transaction);
        const order = await OrderModel.exists({
          tenant: tenantId,
          $or: [
            { "appliedDiscount.membership.membershipId": current._id },
            { "membershipRedemption.membershipId": current._id },
          ],
        }).session(transaction);
        if (invoice || order)
          throw new Error(
            "Paid, invoiced, or redeemed memberships cannot be updated.",
          );
        if (!transitionAllowed(String(current.status), normalized.status))
          throw new Error(
            "Membership imports cannot reopen or reverse lifecycle state.",
          );
      }
      if (
        current &&
        importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
      ) {
        result = {
          action: "skipped" as const,
          recordId: current._id,
          message: "Existing membership skipped.",
        };
        return;
      }
      const allowances = (version.benefits || []).filter(
        (benefit: any) => benefit.type === "allowance",
      );
      if (!current) {
        const openConflict = await UserMembershipModel.exists({
          tenant: tenantId,
          user: normalized.customerId,
          isOpen: true,
        }).session(transaction);
        if (isOpenSourceStatus(normalized.status) && openConflict)
          throw new Error("The customer already has an open membership.");
        if (
          isOpenSourceStatus(normalized.status) &&
          Number(user.membershipCredits || 0) !== 0
        )
          throw new Error(
            "The customer has an unreconciled legacy membership-credit balance.",
          );
        const membershipId = new mongoose.Types.ObjectId();
        const metadata = {
          ...importMetadata({
            sessionId,
            rowNumber: row.rowNumber,
            actorId,
            fileType: importSession.fileType,
            externalId: normalized.externalId,
            fingerprint: String(normalized.fingerprint),
          }),
          allowanceTargets: normalized.allowanceTargets || {},
          allowanceRevision: 1,
        };
        const created = await UserMembershipModel.create(
          [
            {
              _id: membershipId,
              tenant: importObjectId(tenantId),
              user: importObjectId(normalized.customerId),
              plan: importObjectId(normalized.planId),
              planVersion: importObjectId(normalized.planVersionId),
              planSnapshot: planSnapshot(version),
              selectedLocation: normalized.selectedLocationId
                ? importObjectId(normalized.selectedLocationId)
                : null,
              currency: normalized.currency,
              amountMinor: normalized.amountMinor,
              status: normalized.status,
              isOpen: isOpenSourceStatus(normalized.status),
              startedAt: new Date(normalized.startedAt),
              currentPeriodStart: new Date(normalized.periodStart),
              currentPeriodEnd: new Date(normalized.periodEnd),
              renewsAt: isOpenSourceStatus(normalized.status)
                ? new Date(normalized.periodEnd)
                : null,
              autoRenew: false,
              cancelAtPeriodEnd: normalized.status === "cancel_scheduled",
              cancelScheduledAt: null,
              cancelledAt:
                normalized.status === "cancelled" && normalized.cancelledAt
                  ? new Date(normalized.cancelledAt)
                  : null,
              assignedBy: importObjectId(actorId),
              assignmentSource: "migration",
              assignmentReason: "migration",
              assignmentNote: normalized.note,
              termsAcceptedAt: null,
              termsAcceptedVersion: null,
              grantedPeriodKeys: isOpenSourceStatus(normalized.status)
                ? [`migration:${normalized.periodStart}`]
                : [],
              importMetadata: metadata,
            },
          ] as any,
          { session: transaction },
        );
        if (isOpenSourceStatus(normalized.status)) {
          for (const benefit of allowances) {
            const target = Number(
              normalized.allowanceTargets?.[String(benefit.key)] || 0,
            );
            await appendMembershipImportAdjustment({
              tenantId,
              userId: normalized.customerId!,
              membershipId: String(created[0]._id),
              benefit,
              delta: target,
              periodStart: new Date(normalized.periodStart),
              periodEnd: new Date(normalized.periodEnd),
              actorId,
              note: normalized.note,
              idempotencyKey: `membership-import:${created[0]._id}:r1:${benefit.key}`,
              session: transaction,
            });
          }
        }
        const allowancePostState = await loadAllowancePostState(
          tenantId,
          created[0]._id,
          transaction,
        );
        await recordDataImportMutation({
          tenantId,
          sessionId,
          rowId: row._id,
          rowNumber: row.rowNumber,
          entityType: DATA_IMPORT_ENTITY.MEMBERSHIPS,
          mutationKey: importKey,
          operation: importMutationOperation.DELTA,
          importOutcome: "created",
          importMessage: "Offline membership snapshot imported.",
          targetId: created[0]._id,
          affectedFields: MEMBERSHIP_MUTABLE_FIELDS,
          beforeRecord: null,
          afterRecord: created[0],
          delta: {
            kind: "membership_allowances",
            createdMembership: true,
            userId: normalized.customerId,
            priorTargets: {},
            targetAllowances: normalized.allowanceTargets || {},
            allowancePostState,
            periodStart: normalized.periodStart,
            periodEnd: normalized.periodEnd,
          },
          actorId,
          transaction,
        });
        result = {
          action: "created" as const,
          recordId: created[0]._id,
          message: "Offline membership snapshot imported.",
        };
        return;
      }

      const consistency = await ensureEntitlementConsistency({
        tenantId,
        membership: current,
        user,
        version,
        session: transaction,
      });
      const wasOpen = Boolean(current.isOpen);
      const beforeMembership = current.toObject({ depopulate: true });
      const becomesTerminal = wasOpen && !isOpenSourceStatus(normalized.status);
      const preserveHistoricalTargets = !wasOpen || becomesTerminal;
      const previousTargets = consistency.prior;
      const nextTargets = normalized.allowanceTargets || previousTargets;
      const nextRevision =
        Number(current.importMetadata.allowanceRevision || 1) + 1;
      if (
        !becomesTerminal &&
        wasOpen &&
        isOpenSourceStatus(normalized.status)
      ) {
        for (const benefit of consistency.allowances) {
          const key = String(benefit.key);
          const delta =
            Number(nextTargets[key] || 0) - Number(previousTargets[key] || 0);
          await appendMembershipImportAdjustment({
            tenantId,
            userId: normalized.customerId!,
            membershipId: String(current._id),
            benefit,
            delta,
            periodStart: new Date(normalized.periodStart),
            periodEnd: new Date(normalized.periodEnd),
            actorId,
            note: normalized.note,
            idempotencyKey: `membership-import:${current._id}:r${nextRevision}:${key}`,
            session: transaction,
          });
        }
      }
      const provided = new Set(normalized.providedFields);
      if (provided.has("periodEnd"))
        current.currentPeriodEnd = new Date(normalized.periodEnd);
      if (provided.has("note")) current.assignmentNote = normalized.note;
      if (
        provided.has("cancelledAt") ||
        (becomesTerminal && normalized.status === "cancelled")
      )
        current.cancelledAt = normalized.cancelledAt
          ? new Date(normalized.cancelledAt)
          : null;
      current.status = normalized.status as any;
      current.isOpen = isOpenSourceStatus(normalized.status);
      current.autoRenew = false;
      current.cancelAtPeriodEnd = normalized.status === "cancel_scheduled";
      current.cancelScheduledAt = null;
      current.renewsAt = isOpenSourceStatus(normalized.status)
        ? new Date(normalized.periodEnd)
        : null;
      current.importMetadata = {
        ...((current.importMetadata as any)?.toObject?.() ||
          current.importMetadata),
        source: importSession.fileType,
        importId: sessionId,
        importKey: current.importMetadata.importKey || importKey,
        ...(normalized.externalId ? { externalId: normalized.externalId } : {}),
        fingerprint: normalized.fingerprint,
        allowanceTargets: preserveHistoricalTargets
          ? previousTargets
          : nextTargets,
        allowanceRevision: nextRevision,
        lastMutationKey: importKey,
        importedAt: new Date(),
        importedBy: importObjectId(actorId),
      } as any;
      if (!isOpenSourceStatus(normalized.status)) {
        await terminalizeMembership({
          tenantId,
          membership: current,
          status: normalized.status as "cancelled" | "expired",
          reason: "migration",
          idempotencyPrefix: `membership-import:${current._id}:terminal:r${nextRevision}`,
          session: transaction,
          ...(normalized.cancelledAt
            ? { occurredAt: new Date(normalized.cancelledAt) }
            : {}),
          preserveUnknownCancelledAt:
            normalized.status === "cancelled" && !normalized.cancelledAt,
        });
      } else {
        await current.save({ session: transaction });
      }
      const persistedMembership = await UserMembershipModel.findOne({
        _id: current._id,
        tenant: tenantId,
      })
        .select("+importMetadata +grantedPeriodKeys")
        .session(transaction);
      if (!persistedMembership)
        throw new Error("Membership disappeared during import execution.");
      const allowancePostState = await loadAllowancePostState(
        tenantId,
        current._id,
        transaction,
      );
      await recordDataImportMutation({
        tenantId,
        sessionId,
        rowId: row._id,
        rowNumber: row.rowNumber,
        entityType: DATA_IMPORT_ENTITY.MEMBERSHIPS,
        mutationKey: importKey,
        operation: importMutationOperation.DELTA,
        importOutcome: "updated",
        importMessage:
          "Membership snapshot updated without payment side effects.",
        targetId: current._id,
        affectedFields: MEMBERSHIP_MUTABLE_FIELDS,
        beforeRecord: beforeMembership,
        afterRecord: persistedMembership,
        delta: {
          kind: "membership_allowances",
          createdMembership: false,
          userId: normalized.customerId,
          priorTargets: previousTargets,
          targetAllowances: preserveHistoricalTargets
            ? previousTargets
            : nextTargets,
          allowancePostState,
          periodStart: normalized.periodStart,
          periodEnd: normalized.periodEnd,
          transitionedToTerminal: becomesTerminal,
        },
        actorId,
        transaction,
      });
      result = {
        action: "updated" as const,
        recordId: current._id,
        message: "Membership snapshot updated without payment side effects.",
      };
    });
    return result;
  } catch (error) {
    if (isImportDuplicateKey(error)) {
      record = await UserMembershipModel.findOne({
        tenant: tenantId,
        "importMetadata.lastMutationKey": importKey,
      })
        .select("+importMetadata")
        .lean();
      if (record && membershipIdentityMatches(record, normalized))
        return {
          action: "skipped" as const,
          recordId: record._id,
          message: "Membership row was already applied.",
        };
    }
    throw error;
  } finally {
    await transaction.endSession();
  }
};

export const processMembershipImportSession = ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) =>
  processStagedImportSession({
    tenantId,
    sessionId,
    entityType: DATA_IMPORT_ENTITY.MEMBERSHIPS,
    executeRow: executeMembershipRow,
  });
