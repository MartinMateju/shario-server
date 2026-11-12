import { acquireVoucherTenantMutationLock, assertVoucherOfferingPublicationAllowed } from "@/modules/product/voucher-offering.policy.js";
import { resolveProductKindV2 } from "@/modules/product/product.utils.js";
import { assertVoucherCanBeIssued, normalizeVoucherSettings } from "@/modules/coupon/voucher-policy.js";
import { createHash, randomUUID } from "node:crypto";

import mongoose from "mongoose";

import BookingModel from "@/modules/booking/booking.model.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import MembershipEntitlementBalanceModel from "@/modules/membership/membership-entitlement-balance.schema.js";
import MembershipInvoiceModel from "@/modules/membership/membership-invoice.schema.js";
import MembershipPlanModel from "@/modules/membership/membership-plan.model.js";
import MembershipPlanVersionModel from "@/modules/membership/membership-plan-version.model.js";
import UserMembershipModel from "@/modules/membership/user-membership.model.js";
import { appendMembershipImportAdjustment } from "@/modules/membership/services/membership-entitlement.service.js";
import { terminalizeMembership } from "@/modules/membership/services/membership-lifecycle.service.js";
import CreditImportAllocationModel from "@/modules/money-credit/credit-import-allocation.model.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";
import { resolveCreditBalanceMinor } from "@/modules/money-credit/money-credit.balance.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";
import OrderModel from "@/modules/order/order.model.js";
import ProductModel from "@/modules/product/product.model.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";
import UserModel from "@/modules/user/user.model.js";
import { tenantHasModule } from "@/shared/middleware/tenantFeatures.js";
import {
  fromCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { conflict } from "@/shared/http/httpErrors.js";

import {
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_MUTATION_OPERATION,
  DATA_IMPORT_MUTATION_ROLLBACK_STATUS,
  DATA_IMPORT_ROLLBACK_REASON,
  DATA_IMPORT_ROLLBACK_STATUS,
  DATA_IMPORT_STATUS,
  type DataImportEntity,
} from "../data-import.constants.js";
import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import { assertCommerceImportReady } from "./commerce-import-readiness.service.js";
import {
  captureImportMutationSnapshot,
  dataImportMutationHash,
  verifyDataImportMutationPayload,
} from "./data-import-mutation.service.js";
import {
  getTenantImportSession,
  serializeImportSession,
} from "./data-import.service.js";

const ROLLBACK_LEASE_MS = 5 * 60_000;
const RETENTION_MS = 90 * 86_400_000;

const rollbackExecutionConfig = {
  [DATA_IMPORT_ENTITY.CUSTOMERS]: {
    permissions: [
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      WORKSPACE_PERMISSION.CUSTOMERS_IMPORT,
      WORKSPACE_PERMISSION.CUSTOMERS_MANAGE,
    ],
    modules: ["customers"],
  },
  [DATA_IMPORT_ENTITY.PRODUCTS]: {
    permissions: [
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      WORKSPACE_PERMISSION.PRODUCTS_IMPORT,
      WORKSPACE_PERMISSION.PRODUCTS_MANAGE,
    ],
    modules: ["bookings", "courses"],
  },
  [DATA_IMPORT_ENTITY.BOOKINGS]: {
    permissions: [
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      WORKSPACE_PERMISSION.BOOKINGS_IMPORT,
      WORKSPACE_PERMISSION.BOOKINGS_CANCEL,
      WORKSPACE_PERMISSION.BOOKINGS_UPDATE,
    ],
    modules: ["bookings"],
  },
  [DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS]: {
    permissions: [
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
      WORKSPACE_PERMISSION.MEMBERSHIPS_MANAGE,
    ],
    modules: ["memberships"],
  },
  [DATA_IMPORT_ENTITY.MEMBERSHIPS]: {
    permissions: [
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      WORKSPACE_PERMISSION.MEMBERSHIPS_IMPORT,
      WORKSPACE_PERMISSION.MEMBERSHIPS_MANAGE,
    ],
    modules: ["memberships"],
  },
  [DATA_IMPORT_ENTITY.CREDITS]: {
    permissions: [
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      WORKSPACE_PERMISSION.CREDITS_IMPORT,
      WORKSPACE_PERMISSION.CREDITS_MANAGE,
    ],
    modules: ["credits"],
  },
  [DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS]: {
    permissions: [
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
      WORKSPACE_PERMISSION.VOUCHERS_MANAGE,
    ],
    modules: ["vouchers"],
  },
  [DATA_IMPORT_ENTITY.VOUCHERS]: {
    permissions: [
      WORKSPACE_PERMISSION.DATA_IMPORTS_ROLLBACK,
      WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
      WORKSPACE_PERMISSION.VOUCHERS_MANAGE,
    ],
    modules: ["vouchers"],
  },
} as const;

export const assertImportRollbackExecutionAccess = async ({
  tenantId,
  actorId,
  entityType,
}: {
  tenantId: string;
  actorId: string;
  entityType: DataImportEntity;
}): Promise<void> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database connection is unavailable.");
  const config = rollbackExecutionConfig[entityType];
  const [access, tenant] = await Promise.all([
    resolveWorkspaceAccessForUser({ tenantId, userId: actorId }),
    db
      .collection("tenants")
      .findOne(
        { _id: new mongoose.Types.ObjectId(tenantId) },
        { projection: { modules: 1, plan: 1, planVersion: 1 } },
      ),
    assertCommerceImportReady(entityType),
  ]);
  if (
    !access ||
    access.status !== "active" ||
    config.permissions.some(
      (permission) => !hasWorkspacePermission(access, permission),
    )
  )
    throw new Error(
      "The queued actor no longer has permission to roll back this import.",
    );
  if (
    !tenant ||
    !config.modules.some((moduleName) =>
      tenantHasModule(tenant as never, moduleName as never),
    )
  )
    throw new Error("The required workspace module is no longer enabled.");
};

type RollbackCheck = { eligible: true } | { eligible: false; code: string };

type RollbackPreviewRow = {
  rowId: string;
  rowNumber: number;
  status: "eligible" | "blocked" | "compensated";
  reasonCode: string | null;
  manifestDigest?: string;
};

const deltaOf = (mutation: any): Record<string, any> =>
  (mutation.delta || {}) as Record<string, any>;

const importedPasswordHashUnchanged = (mutation: any, target: any): boolean => {
  const expected = String(deltaOf(mutation).importedPasswordHashDigest || "");
  const passwordHash = String(target?.password || "");
  return Boolean(
    expected &&
      passwordHash &&
      createHash("sha256").update(passwordHash).digest("hex") === expected,
  );
};

const modelFor = (mutation: any): any => {
  if (
    mutation.entityType === DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS &&
    deltaOf(mutation).kind === "membership_plan_version"
  )
    return MembershipPlanVersionModel;
  return {
    [DATA_IMPORT_ENTITY.CUSTOMERS]: UserModel,
    [DATA_IMPORT_ENTITY.PRODUCTS]: ProductModel,
    [DATA_IMPORT_ENTITY.BOOKINGS]: BookingModel,
    [DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS]: MembershipPlanModel,
    [DATA_IMPORT_ENTITY.MEMBERSHIPS]: UserMembershipModel,
    [DATA_IMPORT_ENTITY.CREDITS]: CreditImportAllocationModel,
    [DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS]: ProductModel,
    [DATA_IMPORT_ENTITY.VOUCHERS]: Coupon,
  }[mutation.entityType as DataImportEntity];
};

const loadTarget = async (
  mutation: any,
  transaction: mongoose.ClientSession | null,
) => {
  const model = modelFor(mutation);
  if (!model) return null;
  return model
    .findOne({ _id: mutation.target, tenant: mutation.tenant })
    .select(
      "+importMetadata +memberNumberHistory +password +refreshToken +tenantRole +roles +stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId +grantedPeriodKeys +stripeProductId +stripePriceId",
    )
    .session(transaction)
    .lean();
};

const snapshotMatches = (mutation: any, target: any): boolean => {
  if (!target) return false;
  const snapshot = captureImportMutationSnapshot(
    target,
    mutation.affectedFields || [],
  );
  return dataImportMutationHash(snapshot) === mutation.afterHash;
};

const unchangedSinceImport = (mutation: any, target: any): boolean =>
  !mutation.targetUpdatedAt ||
  new Date(target.updatedAt).getTime() ===
    new Date(mutation.targetUpdatedAt).getTime();

const customerHasDependencies = async (
  tenantId: unknown,
  userId: unknown,
  transaction: mongoose.ClientSession | null,
): Promise<boolean> =>
  Boolean(
    (await TenantMembershipModel.exists({
      tenant: tenantId,
      user: userId,
    }).session(transaction)) ||
    (await BookingModel.exists({ tenant: tenantId, createdBy: userId }).session(
      transaction,
    )) ||
    (await UserMembershipModel.exists({
      tenant: tenantId,
      user: userId,
    }).session(transaction)) ||
    (await CreditImportAllocationModel.exists({
      tenant: tenantId,
      user: userId,
    }).session(transaction)) ||
    (await MoneyCredit.exists({ tenant: tenantId, user: userId }).session(
      transaction,
    )) ||
    (await Coupon.exists({ tenant: tenantId, redeemedBy: userId }).session(
      transaction,
    )) ||
    (await OrderModel.exists({
      tenant: tenantId,
      createdBy: userId,
    }).session(transaction)),
  );

const productHasDependencies = async (
  tenantId: unknown,
  productId: unknown,
  transaction: mongoose.ClientSession | null,
): Promise<boolean> =>
  Boolean(
    (await BookingModel.exists({
      tenant: tenantId,
      bookingProduct: productId,
    }).session(transaction)) ||
    (await Coupon.exists({ tenant: tenantId, product: productId }).session(
      transaction,
    )) ||
    (await ProductModel.exists({
      tenant: tenantId,
      couponProduct: productId,
    }).session(transaction)) ||
    (await OrderModel.exists({
      tenant: tenantId,
      $or: [
        { "lineItems.product": productId },
        { "appliedCoupons.couponProductId": productId },
      ],
    }).session(transaction)),
  );

const bookingHasActivity = (record: any): boolean =>
  Boolean(
    (record.orders || []).length ||
    record.paymentConfirmedAt ||
    record.confirmationSentAt ||
    record.lastNotificationChannel ||
    (record.capacityReservations || []).length ||
    (record.bookingRefs || []).length ||
    ["processing", "sent", "delivery_unknown"].includes(
      String(record.accessCodeDelivery?.status || ""),
    ),
  );

const bookingHasDependencies = async (
  tenantId: unknown,
  bookingId: unknown,
  transaction: mongoose.ClientSession | null,
): Promise<boolean> =>
  Boolean(
    await OrderModel.exists({
      tenant: tenantId,
      $or: [
        { "lineItems.booking": bookingId },
        { workshopBookings: bookingId },
        { "courseBookings.bookingId": bookingId },
        { "guestIncreaseBookings.bookingId": bookingId },
      ],
    }).session(transaction),
  );

const membershipHasDependencies = async (
  mutation: any,
  target: any,
  transaction: mongoose.ClientSession | null,
): Promise<boolean> =>
  Boolean(
    target.stripe?.connectedAccountId ||
    target.stripe?.customerId ||
    target.stripe?.subscriptionId ||
    target.stripe?.checkoutSessionId ||
    (await MembershipInvoiceModel.exists({
      tenant: mutation.tenant,
      membership: mutation.target,
    }).session(transaction)) ||
    (await OrderModel.exists({
      tenant: mutation.tenant,
      $or: [
        { "appliedDiscount.membership.membershipId": mutation.target },
        { "membershipRedemption.membershipId": mutation.target },
      ],
    }).session(transaction)),
  );

const allowanceStateMatches = async (
  mutation: any,
  transaction: mongoose.ClientSession | null,
): Promise<boolean> => {
  const expected = deltaOf(mutation).allowancePostState || [];
  const balances = await MembershipEntitlementBalanceModel.find({
    tenant: mutation.tenant,
    membership: mutation.target,
  })
    .select("benefitKey available sequence")
    .session(transaction)
    .lean();
  const actual = balances
    .map((balance: any) => ({
      benefitKey: String(balance.benefitKey),
      available: Number(balance.available || 0),
      sequence: Number(balance.sequence || 0),
    }))
    .sort((left, right) => left.benefitKey.localeCompare(right.benefitKey));
  const normalizedExpected = [...expected].sort((left: any, right: any) =>
    String(left.benefitKey).localeCompare(String(right.benefitKey)),
  );
  return JSON.stringify(actual) === JSON.stringify(normalizedExpected);
};

const checkMutation = async (
  mutation: any,
  transaction: mongoose.ClientSession | null = null,
): Promise<RollbackCheck> => {
  if (
    mutation.rollback?.status ===
    DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED
  )
    return {
      eligible: false,
      code: DATA_IMPORT_ROLLBACK_REASON.ALREADY_COMPENSATED,
    };
  const target = await loadTarget(mutation, transaction);
  if (!target)
    return {
      eligible: false,
      code: DATA_IMPORT_ROLLBACK_REASON.RECORD_MISSING,
    };
  if (
    !snapshotMatches(mutation, target) ||
    !unchangedSinceImport(mutation, target)
  )
    return {
      eligible: false,
      code: DATA_IMPORT_ROLLBACK_REASON.RECORD_CHANGED,
    };

  if (mutation.entityType === DATA_IMPORT_ENTITY.CUSTOMERS) {
    if (
      mutation.operation === DATA_IMPORT_MUTATION_OPERATION.CREATE &&
      (target.lastLoginAt ||
        (target.password && !importedPasswordHashUnchanged(mutation, target)) ||
        target.isEmailVerified ||
        (target.refreshToken || []).length ||
        (await customerHasDependencies(
          mutation.tenant,
          mutation.target,
          transaction,
        )))
    )
      return {
        eligible: false,
        code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
      };
  }

  if (
    [DATA_IMPORT_ENTITY.PRODUCTS, DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS].includes(
      mutation.entityType,
    ) &&
    mutation.operation === DATA_IMPORT_MUTATION_OPERATION.CREATE
  ) {
    if (
      target.stripeProductId ||
      target.stripePriceId ||
      target.imageSrc ||
      target.voucherTemplate ||
      target.voucherDesign ||
      target.couponProduct ||
      (await productHasDependencies(
        mutation.tenant,
        mutation.target,
        transaction,
      ))
    )
      return {
        eligible: false,
        code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
      };
  }

  if (
    mutation.entityType === DATA_IMPORT_ENTITY.BOOKINGS &&
    (bookingHasActivity(target) ||
      (await bookingHasDependencies(
        mutation.tenant,
        mutation.target,
        transaction,
      )))
  )
    return {
      eligible: false,
      code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
    };

  if (mutation.entityType === DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS) {
    const planId =
      deltaOf(mutation).kind === "membership_plan_version"
        ? deltaOf(mutation).planId
        : mutation.target;
    const planVersionId =
      deltaOf(mutation).kind === "membership_plan_version"
        ? mutation.target
        : deltaOf(mutation).createdVersionId;
    if (
      await OrderModel.exists({
        tenant: mutation.tenant,
        $or: [
          { "appliedDiscount.membership.planId": planId },
          ...(planVersionId
            ? [{ "appliedDiscount.membership.planVersionId": planVersionId }]
            : []),
        ],
      }).session(transaction)
    )
      return {
        eligible: false,
        code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
      };
    if (deltaOf(mutation).kind === "membership_plan_version") {
      const referenced = await UserMembershipModel.exists({
        tenant: mutation.tenant,
        planVersion: mutation.target,
      }).session(transaction);
      if (referenced)
        return {
          eligible: false,
          code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
        };
    } else if (
      mutation.operation === DATA_IMPORT_MUTATION_OPERATION.CREATE &&
      (await UserMembershipModel.exists({
        tenant: mutation.tenant,
        plan: mutation.target,
      }).session(transaction))
    )
      return {
        eligible: false,
        code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
      };
  }

  if (mutation.entityType === DATA_IMPORT_ENTITY.MEMBERSHIPS) {
    if (
      deltaOf(mutation).transitionedToTerminal ||
      (await membershipHasDependencies(mutation, target, transaction))
    )
      return {
        eligible: false,
        code: deltaOf(mutation).transitionedToTerminal
          ? DATA_IMPORT_ROLLBACK_REASON.TERMINAL_STATE
          : DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
      };
    if (!(await allowanceStateMatches(mutation, transaction)))
      return {
        eligible: false,
        code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
      };
  }

  if (mutation.entityType === DATA_IMPORT_ENTITY.CREDITS) {
    const delta = deltaOf(mutation);
    const amountMinor = Number(delta.amountMinor || 0);
    if (amountMinor > 0) {
      const currency = String(
        delta.currency || "",
      ).toUpperCase() as StudioCommerceCurrency;
      const user = await UserModel.findOne({
        _id: delta.userId,
        tenant: mutation.tenant,
      })
        .select("moneyCredits moneyCreditsMinor")
        .session(transaction)
        .lean();
      const ledger = await MoneyCredit.findOne({
        tenant: mutation.tenant,
        user: delta.userId,
      })
        .session(transaction)
        .lean();
      if (
        !user ||
        !ledger ||
        String(ledger.currency || "").toUpperCase() !== currency
      )
        return {
          eligible: false,
          code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
        };
      const userBalanceMinor = resolveCreditBalanceMinor({
        moneyCreditsMinor: user.moneyCreditsMinor,
        moneyCredits: user.moneyCredits,
        currency,
      });
      const ledgerBalanceMinor = resolveCreditBalanceMinor({
        moneyCreditsMinor: ledger.balanceMinor,
        moneyCredits: ledger.balance,
        currency,
      });
      if (userBalanceMinor !== ledgerBalanceMinor)
        return {
          eligible: false,
          code: DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
        };
      if (userBalanceMinor < amountMinor)
        return {
          eligible: false,
          code: DATA_IMPORT_ROLLBACK_REASON.INSUFFICIENT_BALANCE,
        };
    }
  }

  if (mutation.entityType === DATA_IMPORT_ENTITY.VOUCHERS) {
    if (
      target.reservedAt ||
      target.reservedBy ||
      target.reservedOrder ||
      target.reservedUntil ||
      target.order ||
      (await OrderModel.exists({
        tenant: mutation.tenant,
        $or: [
          { "appliedCoupons.couponId": mutation.target },
          { "appliedDiscount.coupon.couponId": mutation.target },
        ],
      }).session(transaction)) ||
      (await MoneyCredit.exists({
        tenant: mutation.tenant,
        transactions: { $elemMatch: { relatedCoupon: mutation.target } },
      }).session(transaction))
    )
      return {
        eligible: false,
        code:
          target.redeemedAt &&
          mutation.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE
            ? DATA_IMPORT_ROLLBACK_REASON.TERMINAL_STATE
            : DATA_IMPORT_ROLLBACK_REASON.DEPENDENT_ACTIVITY,
      };
    const introducedTerminalState = ["redeemedAt", "redeemedBy"].some(
      (field) =>
        (mutation.affectedFields || []).includes(field) &&
        mutation.before?.values?.[field] == null &&
        mutation.after?.values?.[field] != null,
    );
    if (
      mutation.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE &&
      introducedTerminalState
    )
      return {
        eligible: false,
        code: DATA_IMPORT_ROLLBACK_REASON.TERMINAL_STATE,
      };
  }

  return { eligible: true };
};

const mapWithConcurrency = async <Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> => {
  const output = new Array<Output>(inputs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (cursor < inputs.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await operation(inputs[index]);
      }
    }),
  );
  return output;
};

const persistRollbackPreview = async ({
  tenantId,
  sessionId,
  digest,
  checkedAt,
}: {
  tenantId: string;
  sessionId: unknown;
  digest: string;
  checkedAt: Date;
}): Promise<number> => {
  const changed = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: sessionId,
      tenant: tenantId,
      "rollback.previewDigest": { $ne: digest },
    },
    {
      $set: {
        "rollback.previewDigest": digest,
        "rollback.previewedAt": checkedAt,
      },
      $inc: { "rollback.revision": 1 },
    },
    { returnDocument: "after" },
  )
    .select("+rollback.previewDigest rollback.revision")
    .lean();
  if (changed) return Number(changed.rollback?.revision || 0);
  const current = await DataImportSessionModel.findOne({
    _id: sessionId,
    tenant: tenantId,
  })
    .select("+rollback.previewDigest rollback.revision")
    .lean();
  return Number(current?.rollback?.revision || 0);
};

const previewDigest = ({
  session,
  rows,
  expectedRows,
}: {
  session: any;
  rows: RollbackPreviewRow[];
  expectedRows: number;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: String(session._id),
        importStatus: session.status,
        importCompletedAt: session.completedAt || null,
        rollbackAvailableUntil: session.rollbackAvailableUntil || null,
        expectedRows,
        rows: [...rows].sort((left, right) =>
          left.rowId.localeCompare(right.rowId),
        ),
      }),
    )
    .digest("hex");

const isValidRowManifest = (mutations: readonly any[]): boolean => {
  if (!mutations.length) return false;
  if (mutations.some((mutation) => !verifyDataImportMutationPayload(mutation)))
    return false;
  const canonical = mutations.filter((mutation) => mutation.isCanonicalResult);
  if (canonical.length !== 1) return false;
  const rowId = String(mutations[0].row);
  const entityType = mutations[0].entityType;
  if (
    mutations.some(
      (mutation) =>
        String(mutation.row) !== rowId || mutation.entityType !== entityType,
    )
  )
    return false;
  if (entityType === DATA_IMPORT_ENTITY.CUSTOMERS) {
    const customerMutationIsCanonical = (mutation: any): boolean =>
      Boolean(
        mutation.isCanonicalResult &&
          ((mutation.operation === DATA_IMPORT_MUTATION_OPERATION.CREATE &&
            mutation.importOutcome === "created") ||
            (mutation.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE &&
              mutation.importOutcome === "updated")),
      );
    const customer = canonical[0];
    if (!customerMutationIsCanonical(customer)) return false;
    if (mutations.length === 1) return true;
    if (mutations.length !== 2) return false;

    const displacement = mutations.find(
      (mutation) => !mutation.isCanonicalResult,
    );
    const delta = deltaOf(displacement);
    const affectedFields = [...(displacement?.affectedFields || [])].sort();
    const requestedMemberNumber = Number(delta.requestedMemberNumber);
    const replacementMemberNumber = Number(delta.replacementMemberNumber);
    return Boolean(
      displacement &&
        displacement.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE &&
        displacement.importOutcome === "updated" &&
        delta.kind === "customer_member_number_displacement" &&
        String(delta.importedCustomerId || "") === String(customer.target) &&
        String(displacement.target) !== String(customer.target) &&
        Number.isSafeInteger(requestedMemberNumber) &&
        requestedMemberNumber > 0 &&
        Number.isSafeInteger(replacementMemberNumber) &&
        replacementMemberNumber > 0 &&
        affectedFields.length === 2 &&
        affectedFields[0] === "memberNumber" &&
        affectedFields[1] === "memberNumberHistory" &&
        Number(displacement.before?.values?.memberNumber) ===
          requestedMemberNumber &&
        Number(displacement.after?.values?.memberNumber) ===
          replacementMemberNumber &&
        Number(customer.after?.values?.memberNumber) === requestedMemberNumber
    );
  }
  if (entityType !== DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS) {
    if (mutations.length !== 1) return false;
    const mutation = mutations[0];
    if (
      [DATA_IMPORT_ENTITY.CREDITS, DATA_IMPORT_ENTITY.MEMBERSHIPS].includes(
        entityType,
      )
    )
      return (
        mutation.operation === DATA_IMPORT_MUTATION_OPERATION.DELTA &&
        ["created", "updated"].includes(mutation.importOutcome)
      );
    return (
      (mutation.operation === DATA_IMPORT_MUTATION_OPERATION.CREATE &&
        mutation.importOutcome === "created") ||
      (mutation.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE &&
        mutation.importOutcome === "updated")
    );
  }
  if (mutations.length !== 2) return false;
  const plan = canonical[0];
  const version = mutations.find(
    (mutation) => deltaOf(mutation).kind === "membership_plan_version",
  );
  if (!version || deltaOf(plan).kind !== "membership_plan") return false;
  const createdVersionId =
    deltaOf(plan).createdVersionId ||
    plan.after?.values?.currentPublishedVersion;
  const isCreate = plan.importOutcome === "created";
  return Boolean(
    createdVersionId &&
    String(deltaOf(version).planId) === String(plan.target) &&
    String(version.target) === String(createdVersionId) &&
    version.importOutcome === plan.importOutcome &&
    version.operation === DATA_IMPORT_MUTATION_OPERATION.CREATE &&
    plan.operation ===
      (isCreate
        ? DATA_IMPORT_MUTATION_OPERATION.CREATE
        : DATA_IMPORT_MUTATION_OPERATION.UPDATE) &&
    ["created", "updated"].includes(plan.importOutcome),
  );
};

const isValidSessionManifest = ({
  session,
  mutations,
  resultRows,
}: {
  session: any;
  mutations: readonly any[];
  resultRows: readonly any[];
}): boolean => {
  const expectedRows =
    Number(session.summary?.created || 0) +
    Number(session.summary?.updated || 0);
  if (expectedRows <= 0 || resultRows.length !== expectedRows) return false;
  if (
    resultRows.filter((row: any) => row.status === "created").length !==
      Number(session.summary?.created || 0) ||
    resultRows.filter((row: any) => row.status === "updated").length !==
      Number(session.summary?.updated || 0)
  )
    return false;
  const byRow = new Map<string, any[]>();
  for (const mutation of mutations) {
    const rowId = String(mutation.row);
    byRow.set(rowId, [...(byRow.get(rowId) || []), mutation]);
  }
  if (byRow.size !== resultRows.length) return false;
  const resultById = new Map(
    resultRows.map((row: any) => [String(row._id), row]),
  );
  return [...byRow.entries()].every(([rowId, rowMutations]) => {
    const row = resultById.get(rowId);
    const canonical = rowMutations.find(
      (mutation) => mutation.isCanonicalResult,
    );
    return Boolean(
      row &&
      isValidRowManifest(rowMutations) &&
      rowMutations.every(
        (mutation) =>
          mutation.entityType === session.entityType &&
          Number(mutation.rowNumber) === Number(row.rowNumber),
      ) &&
      canonical?.importOutcome === row.status &&
      String(canonical?.target || "") ===
        String(
          session.entityType === DATA_IMPORT_ENTITY.CUSTOMERS
            ? row.resultUser
            : row.resultRecord,
        ),
    );
  });
};

export const previewImportRollback = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const session = await getTenantImportSession({ tenantId, sessionId });
  const checkedAt = new Date();
  const expectedRows = Math.max(
    0,
    Number(session.summary?.created || 0) +
      Number(session.summary?.updated || 0),
  );
  const totalRows = Math.max(0, Number(session.summary?.total || 0));
  const persistResult = async ({
    rows,
    eligibleRows,
    blockedRows,
    compensatedRows,
    reasonGroups,
  }: {
    rows: RollbackPreviewRow[];
    eligibleRows: number;
    blockedRows: number;
    compensatedRows: number;
    reasonGroups: Array<{ code: string; count: number }>;
  }) => {
    const digest = previewDigest({ session, rows, expectedRows });
    const revision = await persistRollbackPreview({
      tenantId,
      sessionId: session._id,
      digest,
      checkedAt,
    });
    return {
      sessionId,
      revision,
      previewToken: digest,
      available: eligibleRows > 0,
      eligibleRows,
      blockedRows,
      compensatedRows,
      mutationRows: expectedRows,
      totalRows,
      reasonGroups,
      checkedAt,
    };
  };

  if (session.status !== DATA_IMPORT_STATUS.COMPLETED) {
    const rows: RollbackPreviewRow[] = [
      {
        rowId: "session",
        rowNumber: 0,
        status: "blocked",
        reasonCode: DATA_IMPORT_ROLLBACK_REASON.IMPORT_NOT_COMPLETED,
      },
    ];
    return persistResult({
      rows,
      eligibleRows: 0,
      blockedRows: expectedRows,
      compensatedRows: 0,
      reasonGroups: [
        { code: DATA_IMPORT_ROLLBACK_REASON.IMPORT_NOT_COMPLETED, count: 1 },
      ],
    });
  }
  const [mutations, resultRows] = await Promise.all([
    DataImportMutationModel.find({
      tenant: tenantId,
      session: session._id,
    })
      .sort({ rowNumber: -1, isCanonicalResult: -1, createdAt: 1, _id: 1 })
      .lean(),
    DataImportRowModel.find({
      tenant: tenantId,
      session: session._id,
      status: { $in: ["created", "updated"] },
    })
      .select("_id rowNumber status resultUser resultRecord")
      .sort({ rowNumber: -1, _id: -1 })
      .lean(),
  ]);
  const byRow = new Map<string, any[]>();
  for (const mutation of mutations) {
    const rowId = String(mutation.row);
    byRow.set(rowId, [...(byRow.get(rowId) || []), mutation]);
  }

  if (!mutations.length || !expectedRows) {
    const noMutationReason = expectedRows
      ? session.rollbackAvailableUntil &&
        new Date(session.rollbackAvailableUntil).getTime() <=
          checkedAt.getTime()
        ? DATA_IMPORT_ROLLBACK_REASON.RETENTION_EXPIRED
        : DATA_IMPORT_ROLLBACK_REASON.LEGACY_MANIFEST_MISSING
      : DATA_IMPORT_ROLLBACK_REASON.NO_IMPORTED_MUTATIONS;
    const rows: RollbackPreviewRow[] = [
      {
        rowId: "session",
        rowNumber: 0,
        status: "blocked",
        reasonCode: noMutationReason,
      },
    ];
    return persistResult({
      rows,
      eligibleRows: 0,
      blockedRows: expectedRows,
      compensatedRows: 0,
      reasonGroups: [
        {
          code: noMutationReason,
          count: Math.max(1, expectedRows),
        },
      ],
    });
  }
  if (
    !session.rollbackAvailableUntil ||
    new Date(session.rollbackAvailableUntil).getTime() <= checkedAt.getTime()
  ) {
    const rows: RollbackPreviewRow[] = [
      {
        rowId: "session",
        rowNumber: 0,
        status: "blocked",
        reasonCode: DATA_IMPORT_ROLLBACK_REASON.RETENTION_EXPIRED,
      },
    ];
    return persistResult({
      rows,
      eligibleRows: 0,
      blockedRows: expectedRows,
      compensatedRows: 0,
      reasonGroups: [
        { code: DATA_IMPORT_ROLLBACK_REASON.RETENTION_EXPIRED, count: 1 },
      ],
    });
  }

  const manifestInvalid = !isValidSessionManifest({
    session,
    mutations,
    resultRows,
  });
  if (manifestInvalid) {
    const rows: RollbackPreviewRow[] = [
      {
        rowId: "session",
        rowNumber: 0,
        status: "blocked",
        reasonCode: DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
        manifestDigest: createHash("sha256")
          .update(
            JSON.stringify(
              mutations.map((mutation) => ({
                row: String(mutation.row),
                payloadHash: mutation.payloadHash,
              })),
            ),
          )
          .digest("hex"),
      },
    ];
    return persistResult({
      rows,
      eligibleRows: 0,
      blockedRows: expectedRows,
      compensatedRows: 0,
      reasonGroups: [
        {
          code: DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
          count: Math.max(1, expectedRows),
        },
      ],
    });
  }

  const rowEntries = [...byRow.entries()];
  const checkedRows = await mapWithConcurrency(
    rowEntries,
    10,
    async ([rowId, rowMutations]): Promise<RollbackPreviewRow> => {
      const manifestDigest = createHash("sha256")
        .update(
          JSON.stringify(
            rowMutations.map((mutation) => ({
              id: String(mutation._id),
              payloadHash: mutation.payloadHash,
              status: mutation.rollback?.status,
            })),
          ),
        )
        .digest("hex");
      if (!isValidRowManifest(rowMutations))
        return {
          rowId,
          rowNumber: Number(rowMutations[0]?.rowNumber || 0),
          status: "blocked",
          reasonCode: DATA_IMPORT_ROLLBACK_REASON.MANIFEST_INCONSISTENT,
          manifestDigest,
        };
      const compensated = rowMutations.filter(
        (mutation) =>
          mutation.rollback?.status ===
          DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
      ).length;
      if (compensated === rowMutations.length)
        return {
          rowId,
          rowNumber: Number(rowMutations[0]?.rowNumber || 0),
          status: "compensated",
          reasonCode: DATA_IMPORT_ROLLBACK_REASON.ALREADY_COMPENSATED,
          manifestDigest,
        };
      if (compensated > 0)
        return {
          rowId,
          rowNumber: Number(rowMutations[0]?.rowNumber || 0),
          status: "blocked",
          reasonCode: DATA_IMPORT_ROLLBACK_REASON.MANIFEST_INCONSISTENT,
          manifestDigest,
        };
      for (const mutation of rowMutations) {
        const check = await checkMutation(mutation);
        if (check.eligible === false)
          return {
            rowId,
            rowNumber: Number(mutation.rowNumber || 0),
            status: "blocked",
            reasonCode: check.code,
            manifestDigest,
          };
      }
      return {
        rowId,
        rowNumber: Number(rowMutations[0]?.rowNumber || 0),
        status: "eligible",
        reasonCode: null,
        manifestDigest,
      };
    },
  );
  const eligibleRows = checkedRows.filter(
    (row) => row.status === "eligible",
  ).length;
  const compensatedRows = checkedRows.filter(
    (row) => row.status === "compensated",
  ).length;
  const blocked = checkedRows.filter((row) => row.status === "blocked");
  const reasons = new Map<string, number>();
  for (const row of blocked) {
    const reason =
      row.reasonCode || DATA_IMPORT_ROLLBACK_REASON.RETRYABLE_FAILURE;
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  return persistResult({
    rows: checkedRows,
    eligibleRows,
    blockedRows: blocked.length,
    compensatedRows,
    reasonGroups: [...reasons.entries()].map(([code, count]) => ({
      code,
      count,
    })),
  });
};

const casFilter = (mutation: any) => {
  const filter: Record<string, unknown> = {
    _id: mutation.target,
    tenant: mutation.tenant,
  };
  const present = new Set(mutation.after?.present || []);
  for (const field of mutation.affectedFields || [])
    filter[field] = present.has(field)
      ? mutation.after.values[field]
      : { $exists: false };
  return filter;
};

const restoreUpdate = async (
  mutation: any,
  transaction: mongoose.ClientSession,
) => {
  const present = new Set(mutation.before?.present || []);
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const field of mutation.affectedFields || []) {
    if (present.has(field)) set[field] = mutation.before.values[field];
    else unset[field] = 1;
  }
  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  const result = await modelFor(mutation).updateOne(
    casFilter(mutation),
    update,
    {
      session: transaction,
      runValidators: true,
    },
  );
  if (result.matchedCount !== 1)
    throw Object.assign(new Error("Imported fields changed after import."), {
      rollbackCode: DATA_IMPORT_ROLLBACK_REASON.RECORD_CHANGED,
    });
};

const marker = (mutation: any, actorId: string) => ({
  "importMetadata.rolledBackAt": new Date(),
  "importMetadata.rolledBackBy": new mongoose.Types.ObjectId(actorId),
  "importMetadata.rollbackMutationKey": `rollback:${mutation._id}`,
});

const compensateMembership = async (
  mutation: any,
  actorId: string,
  target: any,
  transaction: mongoose.ClientSession,
) => {
  const delta = deltaOf(mutation);
  const version = await MembershipPlanVersionModel.findOne({
    _id: target.planVersion,
    tenant: mutation.tenant,
  })
    .session(transaction)
    .lean();
  if (!version) throw new Error("Membership plan version is unavailable.");
  const benefitByKey = new Map<string, any>(
    (version.benefits || []).map(
      (benefit: any) => [String(benefit.key), benefit] as const,
    ),
  );
  const prior = delta.priorTargets || {};
  const after = delta.targetAllowances || {};
  for (const key of new Set([...Object.keys(prior), ...Object.keys(after)])) {
    const adjustment = Number(prior[key] || 0) - Number(after[key] || 0);
    if (!adjustment) continue;
    const benefit = benefitByKey.get(key);
    if (!benefit)
      throw new Error(`Membership allowance ${key} is unavailable.`);
    await appendMembershipImportAdjustment({
      tenantId: String(mutation.tenant),
      userId: String(delta.userId || target.user),
      membershipId: String(mutation.target),
      benefit,
      delta: adjustment,
      periodStart: new Date(delta.periodStart),
      periodEnd: delta.periodEnd ? new Date(delta.periodEnd) : null,
      actorId,
      note: "Import rollback compensation",
      idempotencyKey: `data-import-rollback:${mutation._id}:${key}`,
      session: transaction,
    });
  }
  if (delta.createdMembership) {
    const document = await UserMembershipModel.findOne({
      _id: mutation.target,
      tenant: mutation.tenant,
    })
      .select("+importMetadata +grantedPeriodKeys")
      .session(transaction);
    if (!document) throw new Error("Membership is unavailable.");
    if (document.isOpen)
      await terminalizeMembership({
        tenantId: String(mutation.tenant),
        membership: document,
        status: "cancelled",
        reason: "migration",
        idempotencyPrefix: `data-import-rollback:${mutation._id}`,
        session: transaction,
      });
    await UserMembershipModel.updateOne(
      { _id: mutation.target, tenant: mutation.tenant },
      { $set: marker(mutation, actorId) },
      { session: transaction },
    );
  } else {
    await restoreUpdate(mutation, transaction);
  }
};

const compensateCredit = async (
  mutation: any,
  actorId: string,
  transaction: mongoose.ClientSession,
) => {
  const delta = deltaOf(mutation);
  const amountMinor = Number(delta.amountMinor || 0);
  if (amountMinor) {
    await moneyCreditService.changeBalance({
      tenantId: String(mutation.tenant),
      userId: String(delta.userId),
      amountDelta:
        -Math.sign(amountMinor) *
        fromCurrencyMinorUnits(
          Math.abs(amountMinor),
          delta.currency as StudioCommerceCurrency,
        ),
      transaction: {
        type:
          amountMinor > 0
            ? MONEY_CREDIT_TRANSACTION_TYPE.MIGRATION_ROLLBACK_DEBIT
            : MONEY_CREDIT_TRANSACTION_TYPE.MIGRATION_ROLLBACK_CREDIT,
        currency: delta.currency as StudioCommerceCurrency,
        description: "Import rollback credit compensation",
        adminId: new mongoose.Types.ObjectId(actorId),
        reason: "migration_rollback",
        idempotencyKey: `data-import-rollback:${mutation._id}`,
      },
      session: transaction,
    });
  }
  const result = await CreditImportAllocationModel.updateOne(
    {
      _id: mutation.target,
      tenant: mutation.tenant,
      revision: Number(delta.allocationRevision),
      targetAmountMinor: Number(delta.targetAmountMinor),
    },
    {
      $set: {
        targetAmountMinor: Number(delta.priorTargetAmountMinor || 0),
        rolledBackAt: new Date(),
        rolledBackBy: actorId,
        rollbackMutationKey: `rollback:${mutation._id}`,
        lastMutationKey: `rollback:${mutation._id}`,
      },
      $inc: { revision: 1 },
    },
    { session: transaction, runValidators: true },
  );
  if (result.matchedCount !== 1)
    throw Object.assign(new Error("Credit allocation changed after import."), {
      rollbackCode: DATA_IMPORT_ROLLBACK_REASON.RECORD_CHANGED,
    });
};

const compensateCreate = async (
  mutation: any,
  actorId: string,
  target: any,
  transaction: mongoose.ClientSession,
) => {
  if (mutation.entityType === DATA_IMPORT_ENTITY.CUSTOMERS) {
    const removeImportedPassword = importedPasswordHashUnchanged(
      mutation,
      target,
    );
    const filter = casFilter(mutation);
    if (removeImportedPassword) filter.password = target.password;
    const update: Record<string, unknown> = {
      $set: {
        isAccessGranted: false,
        refreshToken: [],
        ...marker(mutation, actorId),
      },
      $inc: { sessionVersion: 1 },
    };
    const unset: Record<string, 1> = {};
    if (removeImportedPassword) unset.password = 1;
    if (mutation.affectedFields?.includes("memberNumber")) {
      unset.memberNumber = 1;
    }
    if (mutation.affectedFields?.includes("memberNumberHistory")) {
      unset.memberNumberHistory = 1;
    }
    if (Object.keys(unset).length) update.$unset = unset;
    const result = await UserModel.updateOne(
      filter,
      update,
      { session: transaction, runValidators: true },
    );
    if (result.matchedCount !== 1)
      throw new Error("Customer changed during rollback.");
    return;
  }
  if (
    [DATA_IMPORT_ENTITY.PRODUCTS, DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS].includes(
      mutation.entityType,
    )
  ) {
    const result = await ProductModel.updateOne(
      casFilter(mutation),
      { $set: { isActive: false, ...marker(mutation, actorId) } },
      { session: transaction, runValidators: true },
    );
    if (result.matchedCount !== 1)
      throw new Error("Product changed during rollback.");
    return;
  }
  if (mutation.entityType === DATA_IMPORT_ENTITY.BOOKINGS) {
    const result = await BookingModel.updateOne(
      casFilter(mutation),
      {
        $set: {
          status: "cancelled",
          archive: true,
          "accessCodeDelivery.status": "cancelled",
          ...marker(mutation, actorId),
        },
      },
      { session: transaction, runValidators: true },
    );
    if (result.matchedCount !== 1)
      throw new Error("Booking changed during rollback.");
    return;
  }
  if (mutation.entityType === DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS) {
    if (deltaOf(mutation).kind === "membership_plan_version") {
      // Published plan versions are immutable audit records. The canonical
      // plan journal restores or archives the plan pointer; the unreferenced
      // import-created version is intentionally retained as historical data.
      return;
    }
    const result = await MembershipPlanModel.updateOne(
      casFilter(mutation),
      {
        $set: {
          status: "archived",
          archivedAt: new Date(),
          ...marker(mutation, actorId),
        },
      },
      { session: transaction, runValidators: true },
    );
    if (result.matchedCount !== 1)
      throw new Error("Membership plan changed during rollback.");
    return;
  }
  if (mutation.entityType === DATA_IMPORT_ENTITY.VOUCHERS) {
    const result = await Coupon.updateOne(
      casFilter(mutation),
      { $set: { isActive: false, ...marker(mutation, actorId) } },
      { session: transaction, runValidators: true },
    );
    if (result.matchedCount !== 1)
      throw new Error("Voucher changed during rollback.");
    return;
  }
  if (mutation.entityType === DATA_IMPORT_ENTITY.MEMBERSHIPS) {
    await compensateMembership(mutation, actorId, target, transaction);
    return;
  }
  throw new Error("Import mutation does not have a rollback adapter.");
};

const compensateMutation = async (
  mutation: any,
  actorId: string,
  transaction: mongoose.ClientSession,
) => {
  const isProductMutation = [DATA_IMPORT_ENTITY.PRODUCTS, DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS].includes(mutation.entityType);
  const voucherTenant = isProductMutation
    ? await acquireVoucherTenantMutationLock(String(mutation.tenant), transaction)
    : null;
  const check = await checkMutation(mutation, transaction);
  if (!check.eligible) return check;
  const target = await loadTarget(mutation, transaction);
  if (voucherTenant && mutation.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE) {
    const desired = { ...target };
    const present = new Set(mutation.before?.present || []);
    for (const field of mutation.affectedFields || []) {
      // Import offering fields are top-level. Dotted import metadata cannot
      // affect the offering's quota or validity rules.
      if (field.includes(".")) continue;
      if (present.has(field)) desired[field] = mutation.before.values[field];
      else delete desired[field];
    }
    if (resolveProductKindV2(desired) === "voucher" && desired.isActive !== false) {
      assertVoucherCanBeIssued(normalizeVoucherSettings(desired.voucherSettings), new Date(), voucherTenant.settings?.timezone ?? "UTC");
    }
    await assertVoucherOfferingPublicationAllowed({
      tenantId: String(mutation.tenant), session: transaction,
      tenant: voucherTenant, current: target, desired,
    });
  }
  if (mutation.entityType === DATA_IMPORT_ENTITY.CREDITS) {
    await compensateCredit(mutation, actorId, transaction);
  } else if (mutation.entityType === DATA_IMPORT_ENTITY.MEMBERSHIPS) {
    await compensateMembership(mutation, actorId, target, transaction);
  } else if (mutation.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE) {
    await restoreUpdate(mutation, transaction);
  } else {
    await compensateCreate(mutation, actorId, target, transaction);
  }
  return { eligible: true } as const;
};

const finalizeRollbackFailure = async ({
  tenantId,
  sessionId,
  revision,
  claimToken,
  code,
  message,
}: {
  tenantId: string;
  sessionId: unknown;
  revision: number;
  claimToken: string;
  code: string;
  message: string;
}): Promise<boolean> => {
  const retentionUntil = new Date(Date.now() + RETENTION_MS);
  const transaction = await mongoose.startSession();
  try {
    let finalized = false;
    await transaction.withTransaction(async () => {
      const result = await DataImportSessionModel.updateOne(
        {
          _id: sessionId,
          tenant: tenantId,
          "rollback.claimToken": claimToken,
          "rollback.revision": revision,
        },
        {
          $set: {
            "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.FAILED,
            "rollback.lastError": { code, message: message.slice(0, 1_000) },
            "rollback.leaseExpiresAt": null,
            "rollback.claimToken": null,
            rollbackAvailableUntil: retentionUntil,
            reportAvailableUntil: retentionUntil,
          },
        },
        { session: transaction },
      );
      if (result.matchedCount !== 1) return;
      finalized = true;
      await DataImportMutationModel.updateMany(
        {
          tenant: tenantId,
          session: sessionId,
          "rollback.status": {
            $in: [
              DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PENDING,
              DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PROCESSING,
            ],
          },
        },
        {
          $set: {
            "rollback.status": DATA_IMPORT_MUTATION_ROLLBACK_STATUS.FAILED,
            "rollback.reasonCode": code,
            "rollback.message": message.slice(0, 1_000),
            "rollback.completedAt": new Date(),
            "rollback.leaseExpiresAt": null,
            "rollback.claimToken": null,
          },
        },
        { session: transaction },
      );
      const canonical = await DataImportMutationModel.find({
        tenant: tenantId,
        session: sessionId,
        isCanonicalResult: true,
      })
        .select("entityType operation rollback.status")
        .session(transaction)
        .lean();
      let rolledBack = 0;
      let restored = 0;
      let archived = 0;
      let compensated = 0;
      let blocked = 0;
      let failed = 0;
      for (const mutation of canonical) {
        if (
          mutation.rollback?.status ===
          DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED
        ) {
          rolledBack += 1;
          if (
            [
              DATA_IMPORT_ENTITY.CREDITS,
              DATA_IMPORT_ENTITY.MEMBERSHIPS,
            ].includes(mutation.entityType as any)
          )
            compensated += 1;
          else if (mutation.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE)
            restored += 1;
          else archived += 1;
        } else if (
          mutation.rollback?.status ===
          DATA_IMPORT_MUTATION_ROLLBACK_STATUS.BLOCKED
        )
          blocked += 1;
        else failed += 1;
      }
      await DataImportSessionModel.updateOne(
        { _id: sessionId, tenant: tenantId },
        {
          $set: {
            "rollback.counters.eligible": 0,
            "rollback.counters.rolledBack": rolledBack,
            "rollback.counters.restored": restored,
            "rollback.counters.archived": archived,
            "rollback.counters.compensated": compensated,
            "rollback.counters.blocked": blocked,
            "rollback.counters.failed": failed,
          },
        },
        { session: transaction },
      );
      await DataImportMutationModel.updateMany(
        { tenant: tenantId, session: sessionId },
        { $set: { expiresAt: retentionUntil } },
        { session: transaction },
      );
      await DataImportRowModel.updateMany(
        { tenant: tenantId, session: sessionId },
        { $set: { expiresAt: retentionUntil } },
        { session: transaction },
      );
    });
    return finalized;
  } finally {
    await transaction.endSession();
  }
};

export const processImportRollbackSession = async ({
  tenantId,
  sessionId,
  revision,
}: {
  tenantId: string;
  sessionId: string;
  revision: number;
}) => {
  const queuedSession = await DataImportSessionModel.findOne({
    _id: sessionId,
    tenant: tenantId,
    status: DATA_IMPORT_STATUS.COMPLETED,
    "rollback.revision": revision,
  })
    .select("entityType createdBy rollback.requestedBy rollback.status")
    .lean();
  if (!queuedSession) return { skipped: true, reason: "not_claimable" };
  const claimToken = randomUUID();
  const now = new Date();
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: sessionId,
      tenant: tenantId,
      status: DATA_IMPORT_STATUS.COMPLETED,
      "rollback.revision": revision,
      $or: [
        { "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.QUEUED },
        { "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.FAILED },
        {
          "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.PROCESSING,
          "rollback.leaseExpiresAt": { $lte: now },
        },
      ],
    },
    {
      $set: {
        "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.PROCESSING,
        "rollback.startedAt": now,
        "rollback.leaseExpiresAt": new Date(now.getTime() + ROLLBACK_LEASE_MS),
        "rollback.claimToken": claimToken,
        "rollback.lastError": null,
      },
    },
    { returnDocument: "after" },
  )
    .select("+rollback.claimToken")
    .lean();
  if (!session) return { skipped: true, reason: "not_claimable" };
  const actorId = String(session.rollback?.requestedBy || session.createdBy);
  try {
    await assertImportRollbackExecutionAccess({
      tenantId,
      actorId,
      entityType: session.entityType as DataImportEntity,
    });
  } catch (error: any) {
    await finalizeRollbackFailure({
      tenantId,
      sessionId: session._id,
      revision,
      claimToken,
      code: "IMPORT_ROLLBACK_ACCESS_REVOKED",
      message: String(
        error?.message || "Rollback permission is no longer available.",
      ),
    });
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "rollback_failed",
      metadata: { revision, code: "IMPORT_ROLLBACK_ACCESS_REVOKED" },
    });
    throw error;
  }
  await recordDataImportAudit({
    tenantId,
    sessionId,
    actorId,
    action: "rollback_started",
    metadata: { revision },
  });

  let manifestMutations: any[];
  let manifestRows: any[];
  try {
    [manifestMutations, manifestRows] = await Promise.all([
      DataImportMutationModel.find({ tenant: tenantId, session: session._id })
        .sort({ rowNumber: -1, isCanonicalResult: -1, createdAt: 1, _id: 1 })
        .lean(),
      DataImportRowModel.find({
        tenant: tenantId,
        session: session._id,
        status: { $in: ["created", "updated"] },
      })
        .select("_id rowNumber status resultUser resultRecord")
        .lean(),
    ]);
  } catch (error: any) {
    await finalizeRollbackFailure({
      tenantId,
      sessionId: session._id,
      revision,
      claimToken,
      code: "IMPORT_ROLLBACK_MANIFEST_READ_FAILED",
      message: String(error?.message || "Rollback journal could not be read."),
    });
    throw error;
  }
  if (
    !isValidSessionManifest({
      session,
      mutations: manifestMutations,
      resultRows: manifestRows,
    })
  ) {
    const retentionUntil = new Date(Date.now() + RETENTION_MS);
    const manifestTransaction = await mongoose.startSession();
    try {
      await manifestTransaction.withTransaction(async () => {
        const blocked = await DataImportSessionModel.updateOne(
          {
            _id: session._id,
            tenant: tenantId,
            "rollback.claimToken": claimToken,
            "rollback.revision": revision,
          },
          {
            $set: {
              "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
              "rollback.completedAt": new Date(),
              "rollback.leaseExpiresAt": null,
              "rollback.claimToken": null,
              "rollback.counters.eligible": 0,
              "rollback.counters.blocked": Math.max(1, manifestRows.length),
              "rollback.lastError": {
                code: DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
                message: "The import rollback journal is incomplete.",
              },
              rollbackAvailableUntil: retentionUntil,
              reportAvailableUntil: retentionUntil,
            },
          },
          { session: manifestTransaction },
        );
        if (blocked.matchedCount !== 1)
          throw new Error("Import rollback execution lease was lost.");
        await DataImportMutationModel.updateMany(
          {
            tenant: tenantId,
            session: session._id,
            "rollback.status": {
              $ne: DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
            },
          },
          {
            $set: {
              "rollback.status": DATA_IMPORT_MUTATION_ROLLBACK_STATUS.BLOCKED,
              "rollback.reasonCode":
                DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
              "rollback.completedAt": new Date(),
              "rollback.leaseExpiresAt": null,
              "rollback.claimToken": null,
              expiresAt: retentionUntil,
            },
          },
          { session: manifestTransaction },
        );
        await DataImportRowModel.updateMany(
          { tenant: tenantId, session: session._id },
          { $set: { expiresAt: retentionUntil } },
          { session: manifestTransaction },
        );
      });
    } catch (error: any) {
      await finalizeRollbackFailure({
        tenantId,
        sessionId: session._id,
        revision,
        claimToken,
        code: "IMPORT_ROLLBACK_MANIFEST_INVALID",
        message: String(
          error?.message || "Rollback journal validation failed.",
        ),
      });
      throw error;
    } finally {
      await manifestTransaction.endSession();
    }
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "rollback_blocked",
      metadata: {
        revision,
        code: DATA_IMPORT_ROLLBACK_REASON.MANIFEST_COUNT_MISMATCH,
      },
    });
    return {
      status: DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
      rolledBack: 0,
      restored: 0,
      archived: 0,
      compensated: 0,
      blocked: Math.max(1, manifestRows.length),
      failed: 0,
    };
  }

  const heartbeat = async (): Promise<void> => {
    await assertImportRollbackExecutionAccess({
      tenantId,
      actorId,
      entityType: session.entityType as DataImportEntity,
    });
    const renewed = await DataImportSessionModel.updateOne(
      {
        _id: session._id,
        tenant: tenantId,
        "rollback.claimToken": claimToken,
        "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.PROCESSING,
        "rollback.revision": revision,
      },
      {
        $set: {
          "rollback.leaseExpiresAt": new Date(Date.now() + ROLLBACK_LEASE_MS),
        },
      },
    );
    if (renewed.matchedCount !== 1)
      throw new Error("Import rollback execution lease was lost.");
  };

  try {
    const rowKeys = await DataImportMutationModel.aggregate<{
      row: mongoose.Types.ObjectId;
      rowNumber: number;
    }>([
      { $match: { tenant: session.tenant, session: session._id } },
      {
        $group: {
          _id: "$row",
          rowNumber: { $max: "$rowNumber" },
        },
      },
      { $sort: { rowNumber: -1, _id: -1 } },
      { $project: { _id: 0, row: "$_id", rowNumber: 1 } },
    ]);

    for (const rowKey of rowKeys) {
      await heartbeat();
      const attemptId = `${sessionId}:r${revision}:row:${rowKey.row}`;
      await DataImportMutationModel.updateMany(
        {
          tenant: tenantId,
          session: session._id,
          row: rowKey.row,
          "rollback.status": {
            $ne: DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
          },
        },
        {
          $set: {
            "rollback.status": DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PROCESSING,
            "rollback.attemptId": attemptId,
            "rollback.claimToken": claimToken,
            "rollback.leaseExpiresAt": new Date(Date.now() + ROLLBACK_LEASE_MS),
            "rollback.startedAt": new Date(),
            "rollback.reasonCode": null,
            "rollback.message": null,
            expiresAt: null,
          },
        },
      );
      const transaction = await mongoose.startSession();
      try {
        await transaction.withTransaction(async () => {
          const ownsClaim = await DataImportSessionModel.updateOne(
            {
              _id: session._id,
              tenant: tenantId,
              "rollback.claimToken": claimToken,
              "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.PROCESSING,
              "rollback.revision": revision,
              "rollback.leaseExpiresAt": { $gt: new Date() },
            },
            {
              $set: {
                "rollback.leaseExpiresAt": new Date(
                  Date.now() + ROLLBACK_LEASE_MS,
                ),
              },
            },
            { session: transaction },
          );
          if (ownsClaim.matchedCount !== 1)
            throw new Error("Import rollback execution lease was lost.");
          const rowMutations = await DataImportMutationModel.find({
            tenant: tenantId,
            session: session._id,
            row: rowKey.row,
          })
            .select("+rollback.claimToken")
            .sort({ isCanonicalResult: -1, createdAt: 1, _id: 1 })
            .session(transaction)
            .lean();
          if (!rowMutations.length) return;
          if (!isValidRowManifest(rowMutations)) {
            await DataImportMutationModel.updateMany(
              { _id: { $in: rowMutations.map((mutation) => mutation._id) } },
              {
                $set: {
                  "rollback.status":
                    DATA_IMPORT_MUTATION_ROLLBACK_STATUS.BLOCKED,
                  "rollback.reasonCode":
                    DATA_IMPORT_ROLLBACK_REASON.MANIFEST_INCONSISTENT,
                  "rollback.message":
                    "The row rollback journal is inconsistent.",
                  "rollback.completedAt": new Date(),
                  "rollback.leaseExpiresAt": null,
                  "rollback.claimToken": null,
                },
              },
              { session: transaction },
            );
            return;
          }
          const compensatedCount = rowMutations.filter(
            (mutation) =>
              mutation.rollback.status ===
              DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
          ).length;
          if (compensatedCount === rowMutations.length) return;

          const mutableIds = rowMutations
            .filter(
              (mutation) =>
                mutation.rollback.status !==
                DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
            )
            .map((mutation) => mutation._id);
          if (compensatedCount > 0) {
            await DataImportMutationModel.updateMany(
              { _id: { $in: mutableIds }, tenant: tenantId },
              {
                $set: {
                  "rollback.status":
                    DATA_IMPORT_MUTATION_ROLLBACK_STATUS.BLOCKED,
                  "rollback.reasonCode":
                    DATA_IMPORT_ROLLBACK_REASON.MANIFEST_INCONSISTENT,
                  "rollback.message":
                    "The row contains a partially compensated journal.",
                  "rollback.completedAt": new Date(),
                  "rollback.leaseExpiresAt": null,
                  "rollback.claimToken": null,
                },
              },
              { session: transaction },
            );
            return;
          }

          let blocked: { eligible: false; code: string } | null = null;
          for (const mutation of rowMutations) {
            const check = await checkMutation(mutation, transaction);
            if (check.eligible === false) {
              blocked = check;
              break;
            }
          }
          if (blocked !== null) {
            await DataImportMutationModel.updateMany(
              { _id: { $in: mutableIds }, tenant: tenantId },
              {
                $set: {
                  "rollback.status":
                    DATA_IMPORT_MUTATION_ROLLBACK_STATUS.BLOCKED,
                  "rollback.reasonCode": blocked.code,
                  "rollback.message": null,
                  "rollback.completedAt": new Date(),
                  "rollback.leaseExpiresAt": null,
                  "rollback.claimToken": null,
                },
              },
              { session: transaction },
            );
            return;
          }

          for (const mutation of rowMutations) {
            const result = await compensateMutation(
              mutation,
              actorId,
              transaction,
            );
            if (result.eligible === false)
              throw Object.assign(
                new Error("Rollback eligibility changed during compensation."),
                { rollbackCode: result.code },
              );
          }
          await DataImportMutationModel.updateMany(
            { _id: { $in: mutableIds }, tenant: tenantId },
            {
              $set: {
                "rollback.status":
                  DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED,
                "rollback.reasonCode": null,
                "rollback.message": null,
                "rollback.completedAt": new Date(),
                "rollback.leaseExpiresAt": null,
                "rollback.claimToken": null,
              },
            },
            { session: transaction },
          );
        });
      } catch (error: any) {
        if (String(error?.message || "").includes("execution lease was lost"))
          throw error;
        const failureTransaction = await mongoose.startSession();
        try {
          await failureTransaction.withTransaction(async () => {
            const fenced = await DataImportSessionModel.updateOne(
              {
                _id: session._id,
                tenant: tenantId,
                "rollback.claimToken": claimToken,
                "rollback.revision": revision,
                "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.PROCESSING,
              },
              {
                $set: {
                  "rollback.leaseExpiresAt": new Date(
                    Date.now() + ROLLBACK_LEASE_MS,
                  ),
                },
              },
              { session: failureTransaction },
            );
            if (fenced.matchedCount !== 1)
              throw new Error("Import rollback execution lease was lost.");
            const marked = await DataImportMutationModel.updateMany(
              {
                tenant: tenantId,
                session: session._id,
                row: rowKey.row,
                "rollback.status":
                  DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PROCESSING,
                "rollback.claimToken": claimToken,
                "rollback.attemptId": attemptId,
              },
              {
                $set: {
                  "rollback.status":
                    DATA_IMPORT_MUTATION_ROLLBACK_STATUS.FAILED,
                  "rollback.reasonCode":
                    error?.rollbackCode ||
                    DATA_IMPORT_ROLLBACK_REASON.RETRYABLE_FAILURE,
                  "rollback.message": String(
                    error?.message || "Rollback failed.",
                  ).slice(0, 1_000),
                  "rollback.leaseExpiresAt": null,
                  "rollback.claimToken": null,
                },
              },
              { session: failureTransaction },
            );
            if (marked.matchedCount === 0) throw error;
          });
        } finally {
          await failureTransaction.endSession();
        }
      } finally {
        await transaction.endSession();
      }
    }
    await heartbeat();
  } catch (error: any) {
    await finalizeRollbackFailure({
      tenantId,
      sessionId: session._id,
      revision,
      claimToken,
      code: "IMPORT_ROLLBACK_EXECUTION_FAILED",
      message: String(error?.message || "Rollback execution failed."),
    });
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "rollback_failed",
      metadata: { revision, code: "IMPORT_ROLLBACK_EXECUTION_FAILED" },
    });
    throw error;
  }

  try {
    const journalRows = await DataImportMutationModel.find({
      tenant: tenantId,
      session: session._id,
      isCanonicalResult: true,
    })
      .select("row entityType operation rollback.status")
      .lean();
    const expectedRows = Math.max(
      0,
      Number(session.summary?.created || 0) +
        Number(session.summary?.updated || 0),
    );
    let rolledBack = 0;
    let compensated = 0;
    let blocked = Math.max(0, expectedRows - journalRows.length);
    let failed = journalRows.length > expectedRows ? 1 : 0;
    let restored = 0;
    let archived = 0;
    for (const mutation of journalRows) {
      if (
        mutation.rollback?.status ===
        DATA_IMPORT_MUTATION_ROLLBACK_STATUS.COMPENSATED
      ) {
        rolledBack += 1;
        if (
          [DATA_IMPORT_ENTITY.CREDITS, DATA_IMPORT_ENTITY.MEMBERSHIPS].includes(
            mutation.entityType as any,
          )
        ) {
          compensated += 1;
        } else if (
          mutation.operation === DATA_IMPORT_MUTATION_OPERATION.UPDATE
        ) {
          restored += 1;
        } else {
          archived += 1;
        }
      } else if (
        mutation.rollback?.status ===
        DATA_IMPORT_MUTATION_ROLLBACK_STATUS.BLOCKED
      )
        blocked += 1;
      else failed += 1;
    }
    const status =
      rolledBack > 0 && blocked + failed === 0
        ? DATA_IMPORT_ROLLBACK_STATUS.COMPLETED
        : rolledBack > 0
          ? DATA_IMPORT_ROLLBACK_STATUS.PARTIAL
          : blocked > 0 && failed === 0
            ? DATA_IMPORT_ROLLBACK_STATUS.BLOCKED
            : DATA_IMPORT_ROLLBACK_STATUS.FAILED;
    const retentionUntil = new Date(Date.now() + RETENTION_MS);
    const finalTransaction = await mongoose.startSession();
    try {
      await finalTransaction.withTransaction(async () => {
        const finalized = await DataImportSessionModel.updateOne(
          {
            _id: session._id,
            tenant: tenantId,
            "rollback.claimToken": claimToken,
            "rollback.revision": revision,
            "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.PROCESSING,
          },
          {
            $set: {
              "rollback.status": status,
              "rollback.completedAt": new Date(),
              "rollback.leaseExpiresAt": null,
              "rollback.claimToken": null,
              "rollback.counters.compensated": compensated,
              "rollback.counters.rolledBack": rolledBack,
              "rollback.counters.restored": restored,
              "rollback.counters.archived": archived,
              "rollback.counters.blocked": blocked,
              "rollback.counters.failed": failed,
              rollbackAvailableUntil: retentionUntil,
              reportAvailableUntil: retentionUntil,
            },
          },
          { session: finalTransaction },
        );
        if (finalized.matchedCount !== 1)
          throw new Error("Import rollback execution lease was lost.");
        await DataImportMutationModel.updateMany(
          { tenant: tenantId, session: session._id },
          { $set: { expiresAt: retentionUntil } },
          { session: finalTransaction },
        );
        await DataImportRowModel.updateMany(
          { tenant: tenantId, session: session._id },
          { $set: { expiresAt: retentionUntil } },
          { session: finalTransaction },
        );
      });
    } finally {
      await finalTransaction.endSession();
    }
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action:
        status === DATA_IMPORT_ROLLBACK_STATUS.COMPLETED
          ? "rollback_completed"
          : status === DATA_IMPORT_ROLLBACK_STATUS.PARTIAL
            ? "rollback_partial"
            : status === DATA_IMPORT_ROLLBACK_STATUS.BLOCKED
              ? "rollback_blocked"
              : "rollback_failed",
      metadata: {
        revision,
        rolledBack,
        restored,
        archived,
        compensated,
        blocked,
        failed,
      },
    });
    return {
      status,
      rolledBack,
      restored,
      archived,
      compensated,
      blocked,
      failed,
    };
  } catch (error: any) {
    await finalizeRollbackFailure({
      tenantId,
      sessionId: session._id,
      revision,
      claimToken,
      code: "IMPORT_ROLLBACK_FINALIZATION_FAILED",
      message: String(error?.message || "Rollback finalization failed."),
    });
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "rollback_failed",
      metadata: { revision, code: "IMPORT_ROLLBACK_FINALIZATION_FAILED" },
    });
    throw error;
  }
};

export const queueImportRollbackState = async ({
  tenantId,
  sessionId,
  revision,
  previewToken,
  idempotencyKey,
  actorId,
}: {
  tenantId: string;
  sessionId: string;
  revision: number;
  previewToken: string;
  idempotencyKey: string;
  actorId: string;
}) => {
  const existingRequest = await DataImportSessionModel.findOne({
    _id: sessionId,
    tenant: tenantId,
    "rollback.requestKey": idempotencyKey,
  })
    .select("+rollback.requestPreviewToken")
    .lean();
  if (existingRequest) {
    if (
      String(existingRequest.rollback?.requestedBy || "") !== actorId ||
      existingRequest.rollback?.requestPreviewToken !== previewToken
    )
      conflict({
        message: "The rollback idempotency key was already used.",
        code: "IMPORT_ROLLBACK_IDEMPOTENCY_KEY_REUSED",
      });
    return serializeImportSession(existingRequest);
  }
  const preview = await previewImportRollback({ tenantId, sessionId });
  if (
    preview.revision !== revision ||
    !previewToken ||
    preview.previewToken !== previewToken
  )
    conflict({
      message: "The rollback preview is stale. Review it again.",
      code: "IMPORT_ROLLBACK_PREVIEW_STALE",
    });
  if (!preview.available)
    conflict({
      message: "This import has no rows that are safe to roll back.",
      code: "IMPORT_ROLLBACK_UNAVAILABLE",
      details: { reasonGroups: preview.reasonGroups },
    });
  const transaction = await mongoose.startSession();
  let queued: any = null;
  try {
    await transaction.withTransaction(async () => {
      queued = await DataImportSessionModel.findOneAndUpdate(
        {
          _id: sessionId,
          tenant: tenantId,
          status: DATA_IMPORT_STATUS.COMPLETED,
          "rollback.revision": revision,
          "rollback.status": {
            $in: [
              DATA_IMPORT_ROLLBACK_STATUS.AVAILABLE,
              DATA_IMPORT_ROLLBACK_STATUS.UNAVAILABLE,
              DATA_IMPORT_ROLLBACK_STATUS.FAILED,
              DATA_IMPORT_ROLLBACK_STATUS.PARTIAL,
              DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
            ],
          },
        },
        {
          $set: {
            "rollback.status": DATA_IMPORT_ROLLBACK_STATUS.QUEUED,
            "rollback.requestedBy": actorId,
            "rollback.requestedAt": new Date(),
            "rollback.requestKey": idempotencyKey,
            "rollback.requestPreviewToken": previewToken,
            "rollback.completedAt": null,
            "rollback.lastError": null,
            "rollback.counters.eligible": preview.eligibleRows,
            "rollback.counters.blocked": preview.blockedRows,
          },
          $inc: { "rollback.revision": 1 },
        },
        { returnDocument: "after", session: transaction },
      ).lean();
      if (!queued) return;
      await DataImportMutationModel.updateMany(
        { tenant: tenantId, session: queued._id },
        { $set: { expiresAt: null } },
        { session: transaction },
      );
      await DataImportMutationModel.updateMany(
        {
          tenant: tenantId,
          session: queued._id,
          "rollback.status": {
            $in: [
              DATA_IMPORT_MUTATION_ROLLBACK_STATUS.BLOCKED,
              DATA_IMPORT_MUTATION_ROLLBACK_STATUS.FAILED,
            ],
          },
        },
        {
          $set: {
            "rollback.status": DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PENDING,
            "rollback.reasonCode": null,
            "rollback.message": null,
            "rollback.completedAt": null,
            "rollback.leaseExpiresAt": null,
            "rollback.claimToken": null,
          },
        },
        { session: transaction },
      );
      await DataImportRowModel.updateMany(
        { tenant: tenantId, session: queued._id },
        { $set: { expiresAt: null } },
        { session: transaction },
      );
    });
  } finally {
    await transaction.endSession();
  }
  if (!queued) {
    const replay = await DataImportSessionModel.findOne({
      _id: sessionId,
      tenant: tenantId,
      "rollback.requestKey": idempotencyKey,
    })
      .select("+rollback.requestPreviewToken")
      .lean();
    if (
      replay &&
      String(replay.rollback?.requestedBy || "") === actorId &&
      replay.rollback?.requestPreviewToken === previewToken
    )
      return serializeImportSession(replay);
    conflict({
      message: "The rollback state changed. Refresh and try again.",
      code: "IMPORT_ROLLBACK_STATE_CONFLICT",
    });
  }
  await recordDataImportAudit({
    tenantId,
    sessionId,
    actorId,
    action: "rollback_requested",
    metadata: { revision: Number(queued.rollback?.revision) },
  });
  return serializeImportSession(queued);
};
