import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import OrderModel from "@/modules/order/order.model.js";
import UserModel from "@/modules/user/user.model.js";
import InvoiceModel from "@/modules/invoice/invoice.schema.js";
import { INVOICE_DOCUMENT_STATUS } from "@/modules/invoice/invoice.constants.js";
import {
  getInvoiceNumberingBackfillDecision,
  getIssuedCustomerLinkMismatchReasons,
} from "@/modules/invoice/invoice-migration.service.js";
import { hasTrustedOrderInvoiceSnapshot } from "@/modules/invoice/order-invoice-snapshot.service.js";

const shouldApply = process.argv.includes("--apply");

const run = async (): Promise<void> => {
  // This command is the preflight for the new unique indexes; do not let model
  // initialization attempt those indexes before the audit/backfill completes.
  mongoose.set("autoIndex", false);
  await connectDB();

  const cursor = OrderModel.collection.find(
    {},
    {
      projection: {
        tenant: 1,
        createdBy: 1,
        customer: 1,
        lineItems: 1,
        grossAmountMinor: 1,
        paymentAllocations: 1,
        isPaid: 1,
        legacyOrder: 1,
      },
    },
  );

  const report = {
    mode: shouldApply ? "apply" : "dry-run",
    duplicateTenantNumberGroups: 0,
    duplicateTenantNumberDocuments: 0,
    duplicateTenantSeriesSequenceGroups: 0,
    duplicateTenantSeriesSequenceDocuments: 0,
    duplicateNumberSamples: [] as Array<Record<string, unknown>>,
    duplicateSeriesSequenceSamples: [] as Array<Record<string, unknown>>,
    numberingBackfillCandidates: 0,
    numberingBackfilled: 0,
    numberingBackfillConflicts: 0,
    numberingUnparsable: 0,
    issuedCustomerLinksAudited: 0,
    issuedCustomerLinkMismatches: 0,
    unsafeCustomerLinksDetached: 0,
    customerLinkDetachConflicts: 0,
    customerLinkMismatchReasons: {} as Record<string, number>,
    numberingApplyBlockedByDuplicates: false,
    indexPrerequisitesSatisfied: false,
    scanned: 0,
    trusted: 0,
    markedLegacy: 0,
    clearedLegacy: 0,
    customerEmailsBackfilled: 0,
    invoicePaymentAllocationsBackfilled: 0,
  };

  const duplicateNumberGroups = await InvoiceModel.collection
    .aggregate([
      { $match: { number: { $type: "string", $gt: "" } } },
      {
        $group: {
          _id: { tenant: "$tenant", number: "$number" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  const duplicateSeriesSequenceGroups = await InvoiceModel.collection
    .aggregate([
      {
        $match: {
          series: { $type: "string", $gt: "" },
          sequence: { $type: "number" },
        },
      },
      {
        $group: {
          _id: {
            tenant: "$tenant",
            series: "$series",
            sequence: "$sequence",
          },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  report.duplicateTenantNumberGroups = duplicateNumberGroups.length;
  report.duplicateTenantNumberDocuments = duplicateNumberGroups.reduce(
    (sum, group) => sum + Number(group.count || 0),
    0,
  );
  report.duplicateTenantSeriesSequenceGroups =
    duplicateSeriesSequenceGroups.length;
  report.duplicateTenantSeriesSequenceDocuments =
    duplicateSeriesSequenceGroups.reduce(
      (sum, group) => sum + Number(group.count || 0),
      0,
    );
  report.duplicateNumberSamples = duplicateNumberGroups.slice(0, 20).map(
    (group) => ({
      tenant: String(group._id.tenant),
      number: group._id.number,
      count: group.count,
      ids: (group.ids ?? []).slice(0, 20).map(String),
    }),
  );
  report.duplicateSeriesSequenceSamples = duplicateSeriesSequenceGroups
    .slice(0, 20)
    .map((group) => ({
      tenant: String(group._id.tenant),
      series: group._id.series,
      sequence: group._id.sequence,
      count: group.count,
      ids: (group.ids ?? []).slice(0, 20).map(String),
    }));

  const duplicateNumberKeys = new Set(
    duplicateNumberGroups.map(
      (group) => `${String(group._id.tenant)}\u0000${String(group._id.number)}`,
    ),
  );
  const duplicatePairKeys = new Set(
    duplicateSeriesSequenceGroups.map(
      (group) =>
        `${String(group._id.tenant)}\u0000${String(group._id.series)}\u0000${String(group._id.sequence)}`,
    ),
  );
  const hasDuplicateIndexBlockers =
    duplicateNumberGroups.length > 0 ||
    duplicateSeriesSequenceGroups.length > 0;
  report.numberingApplyBlockedByDuplicates = shouldApply && hasDuplicateIndexBlockers;

  const reservedBackfillPairs = new Set<string>();
  const numberingCursor = InvoiceModel.collection.find(
    {
      number: { $type: "string", $gt: "" },
      $or: [
        { series: null },
        { series: "" },
        { sequence: null },
      ],
    },
    { projection: { tenant: 1, number: 1, series: 1, sequence: 1, __v: 1 } },
  );

  for await (const invoice of numberingCursor) {
    const decision = getInvoiceNumberingBackfillDecision({
      number: invoice.number,
      series: invoice.series,
      sequence: invoice.sequence,
    });
    if (decision.status === "unparsable") {
      report.numberingUnparsable += 1;
      continue;
    }
    if (decision.status === "conflict") {
      report.numberingBackfillConflicts += 1;
      continue;
    }
    if (decision.status !== "candidate") continue;

    report.numberingBackfillCandidates += 1;
    const tenant = String(invoice.tenant);
    const numberKey = `${tenant}\u0000${String(invoice.number)}`;
    const pairKey = `${tenant}\u0000${decision.series}\u0000${decision.sequence}`;
    const occupied = await InvoiceModel.collection.findOne(
      {
        _id: { $ne: invoice._id },
        tenant: invoice.tenant,
        series: decision.series,
        sequence: decision.sequence,
      },
      { projection: { _id: 1 } },
    );
    if (
      duplicateNumberKeys.has(numberKey) ||
      duplicatePairKeys.has(pairKey) ||
      reservedBackfillPairs.has(pairKey) ||
      occupied
    ) {
      report.numberingBackfillConflicts += 1;
      continue;
    }
    reservedBackfillPairs.add(pairKey);

    if (!shouldApply || hasDuplicateIndexBlockers) continue;

    const versionFilter =
      invoice.__v === undefined
        ? { __v: { $exists: false } }
        : { __v: invoice.__v };
    const update = await InvoiceModel.collection.updateOne(
      { _id: invoice._id, ...versionFilter },
      { $set: decision.set, $inc: { __v: 1 } },
    );
    if (update.matchedCount === 1) report.numberingBackfilled += 1;
    else report.numberingBackfillConflicts += 1;
  }

  const linkedInvoiceCursor = InvoiceModel.collection.find(
    {
      documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
      customerUser: { $ne: null },
    },
    {
      projection: {
        tenant: 1,
        customerUser: 1,
        customerSnapshot: 1,
        __v: 1,
      },
    },
  );
  for await (const invoice of linkedInvoiceCursor) {
    report.issuedCustomerLinksAudited += 1;
    const customer = await UserModel.collection.findOne(
      { tenant: invoice.tenant, _id: invoice.customerUser },
      {
        projection: {
          firstname: 1,
          lastname: 1,
          email: 1,
          phone: 1,
          tenantRole: 1,
        },
      },
    );
    const reasons = getIssuedCustomerLinkMismatchReasons({
      snapshot: invoice.customerSnapshot,
      user: customer,
    });
    if (!reasons.length) continue;

    report.issuedCustomerLinkMismatches += 1;
    for (const reason of reasons) {
      report.customerLinkMismatchReasons[reason] =
        (report.customerLinkMismatchReasons[reason] || 0) + 1;
    }
    if (!shouldApply) continue;

    // Issued legal snapshots remain byte-for-byte untouched. Removing only
    // the unsafe portal association quarantines the document from `/mine`.
    const update = await InvoiceModel.collection.updateOne(
      {
        _id: invoice._id,
        customerUser: invoice.customerUser,
        documentStatus: INVOICE_DOCUMENT_STATUS.ISSUED,
      },
      { $set: { customerUser: null }, $inc: { __v: 1 } },
    );
    if (update.matchedCount === 1) report.unsafeCustomerLinksDetached += 1;
    else report.customerLinkDetachConflicts += 1;
  }

  for await (const order of cursor) {
    report.scanned += 1;
    const trusted = hasTrustedOrderInvoiceSnapshot(order);
    if (trusted) report.trusted += 1;

    const update: Record<string, unknown> = {};
    if (Boolean(order.legacyOrder) !== !trusted) {
      update.legacyOrder = !trusted;
      if (trusted) report.clearedLegacy += 1;
      else report.markedLegacy += 1;
    }

    if (!String(order.customer?.email || "").trim() && order.createdBy) {
      const user = await UserModel.findOne({
        _id: order.createdBy,
        tenant: order.tenant,
      })
        .select("email")
        .lean()
        .exec();
      const email = String(user?.email || "").trim().toLowerCase();
      if (email) {
        update["customer.email"] = email;
        report.customerEmailsBackfilled += 1;
      }
    }

    if (shouldApply && Object.keys(update).length > 0) {
      await OrderModel.collection.updateOne(
        { _id: order._id },
        { $set: update },
      );
    }
  }

  const invoiceCursor = InvoiceModel.collection.find(
    { "paymentAllocations.0": { $exists: true } },
    {
      projection: {
        issueDate: 1,
        createdAt: 1,
        paymentAllocations: 1,
        __v: 1,
      },
    },
  );
  for await (const initialInvoice of invoiceCursor) {
    let invoice: any = initialInvoice;
    let migrated = false;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let changed = false;
      let idsBackfilled = 0;
      const fallbackDate = invoice.issueDate ?? invoice.createdAt ?? new Date();
      const allocations = (invoice.paymentAllocations ?? []).map(
        (allocation: any) => {
          const next = { ...allocation };
          if (!next._id) {
            next._id = new mongoose.Types.ObjectId();
            idsBackfilled += 1;
            changed = true;
          }
          if (!next.paidAt) {
            next.paidAt = fallbackDate;
            changed = true;
          }
          if (!next.recordedAt) {
            next.recordedAt = fallbackDate;
            changed = true;
          }
          for (const [key, value] of Object.entries({
            idempotencyKey: "",
            recordedBy: null,
            reversedAt: null,
            reversedBy: null,
            reversalReason: "",
            reversalIdempotencyKey: "",
          })) {
            if (next[key] === undefined) {
              next[key] = value;
              changed = true;
            }
          }
          return next;
        },
      );

      if (!changed) {
        migrated = true;
        break;
      }

      if (!shouldApply) {
        report.invoicePaymentAllocationsBackfilled += idsBackfilled;
        migrated = true;
        break;
      }

      const versionFilter =
        invoice.__v === undefined
          ? { __v: { $exists: false } }
          : { __v: invoice.__v };
      const updateResult = await InvoiceModel.collection.updateOne(
        { _id: invoice._id, ...versionFilter },
        {
          $set: { paymentAllocations: allocations },
          $inc: { __v: 1 },
        },
      );
      if (updateResult.matchedCount === 1) {
        report.invoicePaymentAllocationsBackfilled += idsBackfilled;
        migrated = true;
        break;
      }

      invoice = await InvoiceModel.collection.findOne(
        { _id: invoice._id },
        {
          projection: {
            issueDate: 1,
            createdAt: 1,
            paymentAllocations: 1,
            __v: 1,
          },
        },
      );
      if (!invoice) {
        migrated = true;
        break;
      }
    }

    if (!migrated) {
      throw new Error(
        `Invoice ${String(initialInvoice._id)} kept changing during payment audit migration.`,
      );
    }
  }

  const backfillIsComplete = shouldApply
    ? report.numberingBackfilled === report.numberingBackfillCandidates
    : report.numberingBackfillCandidates === 0;
  report.indexPrerequisitesSatisfied =
    !hasDuplicateIndexBlockers &&
    report.numberingBackfillConflicts === 0 &&
    backfillIsComplete;

  console.log(JSON.stringify(report, null, 2));
  if (!shouldApply) {
    console.log(
      "Dry run only. Re-run with --apply to write safe backfills and detach unsafe portal links.",
    );
  } else if (!report.indexPrerequisitesSatisfied) {
    console.error(
      "Invoice unique-index prerequisites are not satisfied. Resolve the reported duplicates/conflicts and rerun this migration before synchronizing indexes.",
    );
    process.exitCode = 2;
  }
};

try {
  await run();
  await mongoose.disconnect();
} catch (error) {
  console.error(error);
  await mongoose.disconnect();
  process.exitCode = 1;
}
