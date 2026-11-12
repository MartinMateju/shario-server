import { createHash } from "node:crypto";
import mongoose from "mongoose";
import validator from "validator";

const CONFIRMATION = "order_confirm";
const MAX_ORDERS = 50;
export const NOTIFICATION_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
export type RecoveryReason =
  "smtp-loopback-refused" | "piece-confirmation-missing";
export type RecoverySelection = { orderId: string; reason: RecoveryReason };
export type RecoveryDocument = Record<string, any>;
export type RecoveryCandidate = {
  orderId: string;
  reason: RecoveryReason;
  eligible: boolean;
  rejection: string | null;
  paidAt: string | null;
  recipientMasked: string | null;
  paymentMethods: string[];
  amountMinor: number | null;
  currency: string | null;
};
type RecoveryOperation = {
  selection: RecoverySelection;
  order: RecoveryDocument;
  to: string;
};
export type RecoveryPlan = {
  tenantId: string;
  approvalToken: string;
  counts: { requested: number; eligible: number; rejected: number };
  candidates: RecoveryCandidate[];
  operations: RecoveryOperation[];
};

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const email = (value: unknown): string | null => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return validator.isEmail(normalized, { allow_utf8_local_part: false })
    ? normalized
    : null;
};
const isoDate = (value: unknown): string | null => {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const canonical = (value: any): any => {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value && typeof value.toHexString === "function")
    return { $oid: value.toHexString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
};
export const maskRecoveryRecipient = (value: string): string => {
  const [local, domain] = value.split("@");
  const suffix = domain.includes(".")
    ? domain.slice(domain.lastIndexOf("."))
    : "";
  return `${local[0]}***@${domain[0]}***${suffix}`;
};

export const validateRecoverySelection = (
  tenantId: string,
  selections: RecoverySelection[],
): void => {
  if (!validId(tenantId))
    throw new Error("A valid explicit tenant ObjectId is required.");
  if (!selections.length || selections.length > MAX_ORDERS) {
    throw new Error(`Select between 1 and ${MAX_ORDERS} explicit order IDs.`);
  }
  const seen = new Set<string>();
  for (const selection of selections) {
    if (!validId(selection.orderId))
      throw new Error("Every selected order must have a valid ObjectId.");
    if (
      !["smtp-loopback-refused", "piece-confirmation-missing"].includes(
        selection.reason,
      )
    ) {
      throw new Error("Unsupported recovery reason.");
    }
    const id = selection.orderId.toLowerCase();
    if (seen.has(id)) throw new Error(`Duplicate selected order ${id}.`);
    seen.add(id);
  }
};

const methodsFor = (order: RecoveryDocument): string[] => {
  const known = new Set([
    "stripe",
    "credits",
    "voucher",
    "manual",
    "membership",
  ]);
  const methods = Array.isArray(order.paymentAllocations)
    ? order.paymentAllocations
        .filter((item: any) => item?.amountMinor > 0 && known.has(item.method))
        .map((item: any) => String(item.method))
    : [];
  if (order.credits?.appliedMajor > 0) methods.push("credits");
  if (order.pieceCheckout?.method === "card") methods.push("stripe");
  if (order.pieceCheckout?.method === "credits") methods.push("credits");
  if (order.membershipRedemption?.membershipId) methods.push("membership");
  return [...new Set<string>(methods)].sort();
};

export const planNotificationRecovery = ({
  tenantId,
  selections,
  orders,
  userEmails = new Map(),
  now = new Date(),
}: {
  tenantId: string;
  selections: RecoverySelection[];
  orders: RecoveryDocument[];
  /** Only users already scoped to this tenant may be supplied. */
  userEmails?: Map<string, string>;
  now?: Date;
}): RecoveryPlan => {
  validateRecoverySelection(tenantId, selections);
  if (!Number.isFinite(now.getTime()))
    throw new Error("A valid recovery time is required.");
  const byId = new Map(orders.map((order) => [String(order._id), order]));
  const operations: RecoveryOperation[] = [];
  const candidates = selections.map((selection): RecoveryCandidate => {
    const order = byId.get(selection.orderId.toLowerCase());
    let rejection: string | null = null;
    const entries = Array.isArray(order?.notificationLog)
      ? order.notificationLog
      : [];
    const confirmations = entries.filter(
      (event: any) => event?.type === CONFIRMATION,
    );
    const failed = confirmations[0];
    // Reuse the attempted recipient when recovering a definite failed send.
    const to =
      email(failed?.to) ||
      email(order?.customer?.email) ||
      email(userEmails.get(String(order?.createdBy)));
    if (!order || String(order.tenant).toLowerCase() !== tenantId.toLowerCase())
      rejection = "ORDER_NOT_FOUND_IN_TENANT";
    else if (order.legacyOrder === true) rejection = "LEGACY_ORDER";
    else if (
      order.isPaid !== true ||
      order.status !== "processed_order" ||
      !isoDate(order.paidAt)
    )
      rejection = "NOT_PAID_AND_PROCESSED";
    else if (order.notificationRecovery != null)
      rejection = "RECOVERY_ALREADY_EXISTS";
    else if (
      order.notificationLog != null &&
      !Array.isArray(order.notificationLog)
    )
      rejection = "INVALID_NOTIFICATION_HISTORY";
    else if (
      entries.some(
        (event: any) =>
          ["SENT", "UNKNOWN", "AMBIGUOUS", "PROCESSING"].includes(
            event?.status,
          ) ||
          event?.providerStartedAt ||
          event?.providerMessageId,
      )
    )
      rejection = "SENT_UNKNOWN_OR_IN_PROGRESS";
    else if (
      order.notificationLock?.lockedUntil &&
      (!isoDate(order.notificationLock.lockedUntil) ||
        new Date(order.notificationLock.lockedUntil) > now)
    )
      rejection = "NOTIFICATION_LOCKED";
    else if (!to) rejection = "NO_VALID_RECIPIENT";
    else if (selection.reason === "smtp-loopback-refused") {
      if (
        confirmations.length !== 1 ||
        failed.status !== "FAILED" ||
        failed.attempt !== 3 ||
        failed.providerMessageId ||
        failed.provider === "resend"
      ) {
        rejection = "NOT_EXHAUSTED_DEFINITE_SMTP_FAILURE";
      } else if (
        !/^connect ECONNREFUSED 127\.0\.0\.1:1025$/i.test(
          String(failed.error || "").trim(),
        )
      ) {
        rejection = "FAILURE_NOT_CONFIRMED_LOOPBACK_REFUSAL";
      }
    } else if (
      !order.pieceCheckout ||
      order.pieceCheckout.state !== "paid" ||
      !["card", "credits"].includes(order.pieceCheckout.method) ||
      Number(order.pieceCheckout.refundedAmountMinor || 0) !== 0
    ) {
      rejection = "NOT_AN_UNREFUNDED_PAID_PIECE_ORDER";
    } else if (confirmations.length !== 0)
      rejection = "PIECE_CONFIRMATION_ALREADY_EXISTS";
    if (!rejection) operations.push({ selection, order: order!, to: to! });
    return {
      orderId: selection.orderId.toLowerCase(),
      reason: selection.reason,
      eligible: !rejection,
      rejection,
      paidAt: isoDate(order?.paidAt),
      recipientMasked: to ? maskRecoveryRecipient(to) : null,
      paymentMethods: order ? methodsFor(order) : [],
      amountMinor: Number.isSafeInteger(order?.grossAmountMinor)
        ? order.grossAmountMinor
        : null,
      currency: typeof order?.currency === "string" ? order.currency : null,
    };
  });
  const approvalToken = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          version: 1,
          tenantId: tenantId.toLowerCase(),
          selections,
          snapshots: selections.map(
            ({ orderId }) => byId.get(orderId.toLowerCase()) || null,
          ),
          recipients: operations.map(({ selection, to }) => ({
            orderId: selection.orderId,
            to,
          })),
        }),
      ),
    )
    .digest("hex");
  return {
    tenantId: tenantId.toLowerCase(),
    approvalToken,
    counts: {
      requested: selections.length,
      eligible: operations.length,
      rejected: candidates.length - operations.length,
    },
    candidates,
    operations,
  };
};

export const notificationRecoveryWrite = (
  operation: RecoveryOperation,
  {
    tenantId,
    approvalToken,
    now,
  }: {
    tenantId: string;
    approvalToken: string;
    now: Date;
  },
) => {
  const { order, selection, to } = operation;
  const entries: RecoveryDocument[] = order.notificationLog || [];
  const prior = entries.filter((event) => event.type === CONFIRMATION);
  // Compare every reviewed source field, including the full log. A concurrent
  // payment/refund/edit/claim must invalidate approval instead of being overwritten.
  const snapshots = Object.entries(order)
    .filter(([key]) => key !== "_id" && key !== "notificationLock")
    .map(([key, value]) => ({ [key]: { $eq: value } }));
  return {
    filter: {
      _id: new mongoose.Types.ObjectId(selection.orderId),
      tenant: new mongoose.Types.ObjectId(tenantId),
      isPaid: true,
      status: "processed_order",
      legacyOrder: { $ne: true },
      $and: [
        ...snapshots,
        order.notificationLog === undefined
          ? { notificationLog: { $exists: false } }
          : {},
        {
          $or: [
            { notificationRecovery: { $exists: false } },
            { notificationRecovery: null },
          ],
        },
        {
          $or: [
            { "notificationLock.lockedUntil": null },
            { "notificationLock.lockedUntil": { $lte: now } },
          ],
        },
      ],
    },
    update: {
      $set: {
        notificationRecovery: {
          id: approvalToken,
          requestedAt: now,
          expiresAt: new Date(now.getTime() + NOTIFICATION_RECOVERY_WINDOW_MS),
          reason: selection.reason,
          to,
          previousEvents: prior,
        },
        notificationLog: entries.filter((event) => event.type !== CONFIRMATION),
      },
    },
  };
};

export const assertRecoveryApproval = (
  plan: RecoveryPlan,
  approvalToken: string,
): void => {
  if (plan.counts.rejected)
    throw new Error(
      "Recovery refused: every explicitly selected order must be eligible. Review the dry-run report.",
    );
  if (approvalToken !== plan.approvalToken)
    throw new Error(
      "Recovery refused: the approved dry-run token does not match the current snapshot. Run a fresh dry-run.",
    );
};

export class NotificationRecoveryConflictError extends Error {}

export const applyNotificationRecoveryPlan = async ({
  plan,
  approvalToken,
  orders,
  session,
  now = new Date(),
}: {
  plan: RecoveryPlan;
  approvalToken: string;
  orders: mongoose.mongo.Collection;
  session: mongoose.mongo.ClientSession;
  now?: Date;
}): Promise<void> => {
  assertRecoveryApproval(plan, approvalToken);
  await session.withTransaction(
    async () => {
      for (const operation of plan.operations) {
        const { filter, update } = notificationRecoveryWrite(operation, {
          tenantId: plan.tenantId,
          approvalToken: plan.approvalToken,
          now,
        });
        const result = await orders.updateOne(filter, update, { session });
        if (result.modifiedCount !== 1) {
          throw new NotificationRecoveryConflictError(
            `Order ${operation.selection.orderId} changed after review or is locked; no recoveries in this transaction were applied. Run a fresh dry-run.`,
          );
        }
      }
    },
    { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
  );
};

export const parseNotificationRecoveryArgs = (args: string[]) => {
  let tenantId = "";
  let apply = false;
  let approvalToken = "";
  const selections: RecoverySelection[] = [];
  const singleton = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (
      ![
        "--tenant-id",
        "--order-id",
        "--piece-order-id",
        "--approve-plan",
        "--apply",
      ].includes(name)
    ) {
      throw new Error(`Unsupported recovery argument: ${name}.`);
    }
    if (!["--order-id", "--piece-order-id"].includes(name)) {
      if (singleton.has(name))
        throw new Error(`Duplicate recovery argument: ${name}.`);
      singleton.add(name);
    }
    if (name === "--apply") {
      apply = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${name} requires a value.`);
    if (name === "--tenant-id") tenantId = value.toLowerCase();
    else if (name === "--approve-plan") approvalToken = value;
    else
      selections.push({
        orderId: value.toLowerCase(),
        reason:
          name === "--piece-order-id"
            ? "piece-confirmation-missing"
            : "smtp-loopback-refused",
      });
  }
  validateRecoverySelection(tenantId, selections);
  if (apply && !/^[a-f\d]{64}$/.test(approvalToken))
    throw new Error(
      "--apply requires --approve-plan with the exact token from a reviewed dry-run.",
    );
  if (!apply && approvalToken)
    throw new Error("--approve-plan is only valid with --apply.");
  return { tenantId, selections, apply, approvalToken };
};
