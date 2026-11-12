import mongoose from "mongoose";
import { Coupon } from "./coupon.model.js";
import { VoucherLedger } from "./voucher-ledger.model.js";
import { appendVoucherLedgerEntry } from "./voucher-lifecycle.service.js";
import { voucherManagementDto } from "./voucher-record.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";

type ArchiveVoucherInput = {
  tenantId: string;
  couponId: string;
  actorId: string;
  operationId: string;
  reason?: string;
};

const changeVisibility = async (input: ArchiveVoucherInput, archived: boolean) =>
  mongoose.connection.transaction(async (session) => {
    await acquireVoucherTenantMutationLock(input.tenantId, session);
    const coupon = await Coupon.findOne({
      tenant: input.tenantId,
      _id: input.couponId,
    }).session(session).exec();
    if (!coupon) notFound({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found." });
    const kind = archived ? "archive" : "restore";
    const reason = input.reason?.trim() || (
      archived ? "Archived from code lists" : "Restored to code lists"
    );
    const operationId = `code-visibility:${input.operationId}`;
    const previous = await VoucherLedger.findOne({
      tenant: input.tenantId,
      operationId,
    }).session(session).lean().exec();
    if (previous) {
      if (String(previous.coupon) !== input.couponId ||
        previous.kind !== kind ||
        String(previous.actor) !== input.actorId ||
        previous.reason !== reason) {
        conflict({ code: "VOUCHER_OPERATION_CONFLICT", message: "This operation id belongs to a different voucher action." });
      }
      // An old archive retry must not undo a more recent restore.
      return voucherManagementDto(coupon);
    }
    if (Boolean(coupon.archivedAt) !== archived) {
      coupon.archivedAt = archived ? new Date() : null;
      coupon.archivedBy = archived ? new mongoose.Types.ObjectId(input.actorId) : null;
      await coupon.save({ session });
    }
    // Include no-op requests so a later retry cannot replay after a new action.
    // No entitlement fields are updated, including on held/used/revoked codes.
    await appendVoucherLedgerEntry({
      ...input,
      operationId,
      kind,
      reason,
      currency: coupon.currencySnapshot ?? null,
      amountMinor: 0,
      quantity: 0,
    }, session);
    return voucherManagementDto(coupon);
  });

export const voucherArchiveService = {
  archive: (input: ArchiveVoucherInput) => changeVisibility(input, true),
  restore: (input: ArchiveVoucherInput) => changeVisibility(input, false),
};
