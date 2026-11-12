import { createHash, randomUUID } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import {
  sendManagedTenantEmail,
  type ManagedTenantEmailInput,
} from "@/infrastructure/email/managed-email.service.js";
import { logger } from "@/config/logger.js";
import { AppError } from "@/shared/http/AppError.js";
import { getObjectBufferFromR2 } from "@/infrastructure/storage/r2.client.js";
import { modifyPromoCodePdf } from "@/infrastructure/pdf/pdf.utils.js";
import { resolveVoucherDesignAssets } from "@/modules/product/services/voucher-design.service.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import { Coupon, CouponOrder } from "./coupon.model.js";
import type { CouponOrderDocument } from "./coupon.types.js";
import {
  couponEmailService,
  VOUCHER_EMAIL_ATTACHMENT_LIMIT_BYTES,
} from "./coupon-email.service.js";
import {
  createCouponValueSnapshotFromOrder,
  getProductNameSnapshot,
  normalizeCouponCurrency,
} from "./coupon.utils.js";
import { normalizeVoucherDesign } from "./voucher-design.js";
import { renderVoucherPdf } from "./voucher-design.renderer.js";
import {
  VoucherDeliveryModel,
  type VoucherDelivery,
  type VoucherDeliveryChannel,
} from "./voucher-delivery.model.js";

const CLAIM_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;
const RESEND_COOLDOWN_MS = 5 * 60_000;
const RESENDS_PER_DAY = 5;
const fail = (code: string, message: string, statusCode = 409): never => {
  throw new AppError({ code, message, statusCode });
};
const identifiers = (tenantId: string, couponOrderId: string) => {
  if (
    !/^[a-f\d]{24}$/i.test(tenantId) ||
    !/^[a-f\d]{24}$/i.test(couponOrderId)
  ) {
    fail("VOUCHER_ORDER_NOT_FOUND", "Voucher order not found.", 404);
  }
  return {
    tenant: new mongoose.Types.ObjectId(tenantId),
    _id: new mongoose.Types.ObjectId(couponOrderId),
  };
};
const intentId = (
  tenantId: string,
  couponOrderId: string,
  channel: VoucherDeliveryChannel,
  generation: number,
) =>
  createHash("sha256")
    .update(
      `voucher:${tenantId.toLowerCase()}:${couponOrderId.toLowerCase()}:${channel}:${generation}`,
    )
    .digest("hex");
const messageId = (id: string) => `<voucher.${id}@shario.io>`;
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2000);
const retryAt = (attempts: number, now = new Date()) =>
  attempts < MAX_ATTEMPTS
    ? new Date(
        now.getTime() + Math.min(60, 2 ** Math.min(attempts, 6)) * 60_000,
      )
    : null;

const ensureOrderDeliverable = (
  order: CouponOrderDocument | null,
  allowExpired = false,
) => {
  if (!order) fail("VOUCHER_ORDER_NOT_FOUND", "Voucher order not found.", 404);
  if (!order.paidAt || !order.processedAt)
    fail("VOUCHER_DELIVERY_NOT_READY", "Your voucher is still being prepared.");
  if (
    (order.refundState && order.refundState !== "none") ||
    Number(order.refundedAmountMinor) > 0
  ) {
    fail(
      "VOUCHER_DELIVERY_SUPPRESSED",
      "This purchase requires review before its vouchers can be delivered.",
    );
  }
  if (
    !allowExpired &&
    order.expiresAtSnapshot &&
    new Date(order.expiresAtSnapshot) <= new Date()
  ) {
    fail("VOUCHER_DELIVERY_SUPPRESSED", "These vouchers have expired.");
  }
  return order;
};

const loadDeliverableOrder = async (
  tenantId: string,
  couponOrderId: string,
  session?: ClientSession,
  allowExpired = false,
) => {
  let query = CouponOrder.findOne(identifiers(tenantId, couponOrderId)).select(
    "+purchaseAccessNonce +purchaseAccessTokenHash",
  );
  if (session) query = query.session(session);
  const order = ensureOrderDeliverable(await query.exec(), allowExpired);
  let codesQuery = Coupon.find({
    tenant: order.tenant,
    order: order._id,
  }).select("_id promoCode revokedAt refundReviewRequired expiresAt");
  if (session) codesQuery = codesQuery.session(session);
  const codes = await codesQuery.lean().exec();
  const savedCodes = Array.from(order.promoCodesSnapshot || []);
  if (
    savedCodes.length !== order.quantity ||
    new Set(savedCodes).size !== order.quantity ||
    codes.length !== order.quantity ||
    codes.some(
      (code) =>
        !savedCodes.includes(code.promoCode) ||
        !order.coupons.some((id) => String(id) === String(code._id)),
    )
  ) {
    fail(
      "VOUCHER_DELIVERY_NOT_READY",
      "The purchased vouchers are not ready for delivery.",
    );
  }
  if (
    codes.some(
      (code) =>
        code.revokedAt ||
        code.refundReviewRequired ||
        (!allowExpired &&
          code.expiresAt &&
          new Date(code.expiresAt) <= new Date()),
    )
  ) {
    fail(
      "VOUCHER_DELIVERY_SUPPRESSED",
      "A voucher from this purchase is no longer available for delivery.",
    );
  }
  return order;
};

export const getVoucherDocumentDescriptors = (order: {
  productNameSnapshot?: unknown;
  quantity: number;
}) => {
  if (
    !Number.isSafeInteger(order.quantity) ||
    order.quantity < 1 ||
    order.quantity > 20
  ) {
    fail(
      "VOUCHER_DELIVERY_NOT_READY",
      "This voucher quantity requires studio assistance before delivery.",
    );
  }
  const baseName =
    getProductNameSnapshot(order.productNameSnapshot)
      .replace(/[^\w-]+/g, "_")
      .slice(0, 60) || "Voucher";
  return Array.from({ length: order.quantity }, (_, index) => ({
    index,
    filename: `${baseName}_${index + 1}.pdf`,
    contentType: "application/pdf" as const,
  }));
};

/** Render only purchased snapshots. A live offering is never a fallback here. */
const renderPurchasedVoucherAttachments = async (
  input: CouponOrderDocument,
  index?: number,
  maxAttachmentBytes?: number,
) => {
  // An explicit historical download can show its original expired entitlement.
  // New email attempts are stopped after expiry.
  const allowExpired = index !== undefined;
  const order = await loadDeliverableOrder(
    String(input.tenant),
    String(input._id),
    undefined,
    allowExpired,
  );
  const design =
    order.designSnapshot?.version !== undefined
      ? normalizeVoucherDesign(order.designSnapshot)
      : undefined;
  const templateKey = String(order.voucherTemplateKeySnapshot || "").trim();
  if (!design && !templateKey)
    throw new Error("The purchased voucher design is missing.");
  const assets = design
    ? await resolveVoucherDesignAssets(String(order.tenant), design)
    : undefined;
  const templateBuffer = design
    ? undefined
    : await getObjectBufferFromR2({ key: templateKey });
  const descriptors = getVoucherDocumentDescriptors(order).filter(
    (row) => index === undefined || row.index === index,
  );
  const attachments: Array<{
    filename: string;
    content: Buffer;
    contentType: "application/pdf";
  }> = [];
  let attachmentBytes = 0;
  for (const descriptor of descriptors) {
    const promoCode = order.promoCodesSnapshot[descriptor.index];
    const content = design
      ? await renderVoucherPdf({
          design,
          assets,
          giftMessage: order.giftMessageSnapshot || "",
          metadata: {
            promoCode,
            amountMinor:
              createCouponValueSnapshotFromOrder(order).valueMinorSnapshot,
            currency: normalizeCouponCurrency(order.currencySnapshot),
            expiresAt: order.expiresAtSnapshot ?? null,
            timezone: order.validityTimezoneSnapshot || "UTC",
            locale: order.localeSnapshot || "en",
            productName: getProductNameSnapshot(order.productNameSnapshot),
          },
        })
      : await modifyPromoCodePdf({
          promoCode,
          templateBuffer: templateBuffer!,
          templateKey,
        });
    if (!Buffer.isBuffer(content))
      throw new Error("Voucher rendering did not produce a PDF.");
    attachments.push({
      filename: descriptor.filename,
      content,
      contentType: descriptor.contentType,
    });
    attachmentBytes += content.length;
    // The email builder turns this oversized batch into a secure link-only
    // message. Avoid rendering the remaining PDFs merely to discard them.
    if (
      maxAttachmentBytes !== undefined &&
      attachmentBytes > maxAttachmentBytes
    )
      break;
  }
  await loadDeliverableOrder(
    String(order.tenant),
    String(order._id),
    undefined,
    allowExpired,
  );
  return attachments;
};

export const buildPurchasedVoucherAttachments = (
  order: CouponOrderDocument,
  options: { maxAttachmentBytes?: number } = {},
) =>
  renderPurchasedVoucherAttachments(
    order,
    undefined,
    options.maxAttachmentBytes,
  );

export const getVoucherOrderDocument = async ({
  tenantId,
  couponOrderId,
  index,
}: {
  tenantId: string;
  couponOrderId: string;
  index: number;
}) => {
  const order = await loadDeliverableOrder(
    tenantId,
    couponOrderId,
    undefined,
    true,
  );
  if (!Number.isSafeInteger(index) || index < 0 || index >= order.quantity) {
    fail("VOUCHER_DOCUMENT_NOT_FOUND", "Voucher document not found.", 404);
  }
  return (await renderPurchasedVoucherAttachments(order, index))[0];
};

const enqueueChannel = async (
  order: CouponOrderDocument,
  channel: VoucherDeliveryChannel,
  generation: number,
  session: ClientSession,
) => {
  const id = intentId(
    String(order.tenant),
    String(order._id),
    channel,
    generation,
  );
  const alreadySent =
    generation === 0 &&
    (order.emailSent ||
      (channel === "customer"
        ? order.customerEmailSent
        : order.adminEmailSent));
  const skipped =
    generation === 0 && channel === "admin" && order.adminEmailSkipped;
  await VoucherDeliveryModel.updateOne(
    { _id: id },
    {
      $setOnInsert: {
        _id: id,
        tenant: order.tenant,
        couponOrder: order._id,
        channel,
        generation,
        status: alreadySent ? "sent" : skipped ? "skipped" : "pending",
        sentAt: alreadySent
          ? channel === "customer"
            ? order.customerEmailSentAt
            : order.adminEmailSentAt
          : null,
        attempts: 0,
        nextAttemptAt: alreadySent || skipped ? null : new Date(),
      },
    },
    { upsert: true, session },
  ).exec();
};

/** Called in the same Mongo transaction that persists the purchased codes. */
export const enqueueVoucherDelivery = async ({
  tenantId,
  couponOrderId,
  session,
}: {
  tenantId: string;
  couponOrderId: string;
  session: ClientSession;
}) => {
  if (!session?.inTransaction?.())
    throw new Error(
      "Voucher delivery enqueue requires the issuance transaction.",
    );
  const order = await CouponOrder.findOne(identifiers(tenantId, couponOrderId))
    .session(session)
    .exec();
  if (!order) throw new Error("Voucher delivery order not found.");
  // Issuance may set processedAt later in the same transaction; no external
  // delivery can observe these intents until the entire transaction commits.
  if (
    !order.paidAt ||
    (order.refundState && order.refundState !== "none") ||
    order.refundedAmountMinor > 0 ||
    order.promoCodesSnapshot.length !== order.quantity
  ) {
    throw new Error(
      "Only an issued, paid voucher purchase can queue delivery.",
    );
  }
  for (const channel of ["customer", "admin"] as const)
    await enqueueChannel(order, channel, 0, session);
};

export const getVoucherDeliverySummary = async ({
  tenantId,
  couponOrderId,
}: {
  tenantId: string;
  couponOrderId: string;
}) => {
  const ids = identifiers(tenantId, couponOrderId);
  const read = async (channel: VoucherDeliveryChannel) => {
    const row = await VoucherDeliveryModel.findOne({
      tenant: ids.tenant,
      couponOrder: ids._id,
      channel,
    })
      .sort({ generation: -1 })
      .lean()
      .exec();
    return row
      ? {
          status: row.status,
          generation: row.generation,
          attempts: row.attempts,
          sentAt: row.sentAt ?? null,
          nextAttemptAt: row.nextAttemptAt ?? null,
        }
      : null;
  };
  const [customer, admin] = await Promise.all([
    read("customer"),
    read("admin"),
  ]);
  return { customer, admin };
};

/** Explicit buyer resend creates another intent; it never erases old outcomes. */
export const requestVoucherCustomerResend = async ({
  tenantId,
  couponOrderId,
}: {
  tenantId: string;
  couponOrderId: string;
}) => {
  identifiers(tenantId, couponOrderId);
  await mongoose.connection.transaction(async (session) => {
    await acquireVoucherTenantMutationLock(tenantId, session);
    const order = await loadDeliverableOrder(tenantId, couponOrderId, session);
    const active = await VoucherDeliveryModel.exists({
      tenant: order.tenant,
      couponOrder: order._id,
      channel: "customer",
      $or: [
        { status: { $in: ["pending", "sending"] } },
        { status: "failed", nextAttemptAt: { $ne: null } },
      ],
    })
      .session(session)
      .exec();
    if (active)
      fail(
        "VOUCHER_DELIVERY_PENDING",
        "Your voucher email is already queued for delivery.",
      );
    const now = new Date();
    if (
      order.deliveryResendRequestedAt &&
      now.getTime() - order.deliveryResendRequestedAt.getTime() <
        RESEND_COOLDOWN_MS
    ) {
      fail(
        "VOUCHER_DELIVERY_COOLDOWN",
        "Please wait five minutes before requesting another email.",
        429,
      );
    }
    const day = now.toISOString().slice(0, 10);
    const count =
      order.deliveryResendDay === day ? order.deliveryResendDayCount : 0;
    if (count >= RESENDS_PER_DAY)
      fail(
        "VOUCHER_DELIVERY_LIMIT",
        "The daily voucher email limit has been reached. Please try again tomorrow.",
        429,
      );
    order.deliveryResendGeneration =
      Number(order.deliveryResendGeneration || 0) + 1;
    order.deliveryResendRequestedAt = now;
    order.deliveryResendDay = day;
    order.deliveryResendDayCount = count + 1;
    await order.save({ session });
    await enqueueChannel(
      order,
      "customer",
      order.deliveryResendGeneration,
      session,
    );
  });
  return getVoucherDeliverySummary({ tenantId, couponOrderId });
};

const knownNotSent = (error: any) => {
  return error?.deliveryOutcome === "not_sent";
};

export const recoverStaleVoucherDeliveryClaims = async (now = new Date()) => {
  const safe = await VoucherDeliveryModel.updateMany(
    {
      status: "sending",
      claimExpiresAt: { $lte: now },
      providerAttemptStartedAt: null,
    },
    {
      $set: {
        status: "failed",
        claimToken: "",
        claimExpiresAt: null,
        nextAttemptAt: now,
        lastError:
          "Preparation was interrupted before an email attempt; safe to retry.",
      },
    },
  ).exec();
  await VoucherDeliveryModel.updateMany(
    {
      status: "failed",
      attempts: { $gte: MAX_ATTEMPTS },
      nextAttemptAt: { $ne: null },
    },
    { $set: { nextAttemptAt: null } },
  ).exec();
  const ambiguous = await VoucherDeliveryModel.updateMany(
    {
      status: "sending",
      claimExpiresAt: { $lte: now },
      providerAttemptStartedAt: { $ne: null },
    },
    {
      $set: {
        status: "ambiguous",
        claimToken: "",
        claimExpiresAt: null,
        nextAttemptAt: null,
        lastError:
          "An email provider attempt outlived its lease. The original message may have been accepted; automatic retry is disabled.",
      },
    },
  ).exec();
  return { requeued: safe.modifiedCount, ambiguous: ambiguous.modifiedCount };
};

const recordCompleted = async (
  outbox: VoucherDelivery,
  claimToken: string,
  sent: boolean,
  providerMessageId = "",
) => {
  await mongoose.connection.transaction(async (session) => {
    const result = await VoucherDeliveryModel.updateOne(
      { _id: outbox._id, tenant: outbox.tenant, status: "sending", claimToken },
      {
        $set: {
          status: sent ? "sent" : "skipped",
          sentAt: sent ? new Date() : null,
          providerMessageId: providerMessageId.slice(0, 500),
          claimToken: "",
          claimExpiresAt: null,
          nextAttemptAt: null,
          lastError: "",
        },
      },
      { session },
    ).exec();
    if (result.modifiedCount !== 1)
      throw new Error(
        "Voucher delivery claim was lost before its outcome could be recorded.",
      );
    const flags = sent
      ? outbox.channel === "customer"
        ? { customerEmailSent: true, customerEmailSentAt: new Date() }
        : { adminEmailSent: true, adminEmailSentAt: new Date() }
      : {
          adminEmailSkipped: true,
          adminEmailSkipReason: "No eligible tenant notification recipient.",
        };
    await CouponOrder.updateOne(
      { _id: outbox.couponOrder, tenant: outbox.tenant },
      [
        { $set: flags },
        {
          $set: {
            emailSent: {
              $and: [
                { $eq: ["$customerEmailSent", true] },
                {
                  $or: [
                    { $eq: ["$adminEmailSent", true] },
                    { $eq: ["$adminEmailSkipped", true] },
                  ],
                },
              ],
            },
          },
        },
      ],
      { session, updatePipeline: true },
    ).exec();
  });
};

const prepareMail = async (
  outbox: VoucherDelivery,
): Promise<ManagedTenantEmailInput | null> => {
  const order = await loadDeliverableOrder(
    String(outbox.tenant),
    String(outbox.couponOrder),
  );
  if (outbox.channel === "customer")
    return couponEmailService.prepareCustomerCouponOrderEmail({
      order,
      attachments: await buildPurchasedVoucherAttachments(order, {
        maxAttachmentBytes: VOUCHER_EMAIL_ATTACHMENT_LIMIT_BYTES,
      }),
    });
  return couponEmailService.prepareAdminCouponOrderEmail({
    order,
    product: { name: order.productNameSnapshot },
    promoCodes: order.promoCodesSnapshot,
    templateKey: order.voucherTemplateKeySnapshot || "",
  });
};

/** Each channel owns its lease and retry schedule, independently of Stripe. */
export const processVoucherDeliveryOutbox = async ({
  limit = 25,
}: { limit?: number } = {}) => {
  await recoverStaleVoucherDeliveryClaims();
  let sent = 0;
  let processed = 0;
  for (let index = 0; index < Math.min(100, Math.max(1, limit)); index += 1) {
    const now = new Date();
    const claimToken = randomUUID();
    const outbox = await VoucherDeliveryModel.findOneAndUpdate(
      {
        status: { $in: ["pending", "failed"] },
        nextAttemptAt: { $lte: now, $ne: null },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      {
        $set: {
          status: "sending",
          claimToken,
          claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
          providerAttemptStartedAt: null,
          lastError: "",
        },
        $inc: { attempts: 1 },
      },
      {
        returnDocument: "after",
        sort: { nextAttemptAt: 1, createdAt: 1, _id: 1 },
      },
    )
      .select("+claimToken")
      .lean()
      .exec();
    if (!outbox) break;
    processed += 1;
    let providerStarted = false;
    try {
      const mail = await prepareMail(outbox);
      if (!mail) {
        await recordCompleted(outbox, claimToken, false);
        continue;
      }
      // Rendering and branding queries can take time. Recheck the purchased
      // entitlement before resolving the managed sender.
      await loadDeliverableOrder(
        String(outbox.tenant),
        String(outbox.couponOrder),
      );
      let info;
      try {
        info = await sendManagedTenantEmail({
          ...mail,
          tenantId: String(outbox.tenant),
          orderId: String(outbox.couponOrder),
          deliveryId: outbox._id,
          // The full Message-ID exceeds Postmark's metadata value limit.
          // Keep it in the header; deliveryId provides the same correlation.
          headers: {
            "Message-ID": messageId(outbox._id),
            "X-Shario-Delivery-Key": outbox._id,
          },
          beforeSend: async () => {
            // Sender lookup and attachment validation have not submitted mail.
            // Recheck refunds and the lease only at the provider boundary.
            await loadDeliverableOrder(
              String(outbox.tenant),
              String(outbox.couponOrder),
            );
            const attempt = await VoucherDeliveryModel.updateOne(
              {
                _id: outbox._id,
                tenant: outbox.tenant,
                status: "sending",
                claimToken,
                claimExpiresAt: { $gt: new Date() },
                providerAttemptStartedAt: null,
              },
              { $set: {
                providerAttemptStartedAt: new Date(),
                claimExpiresAt: new Date(Date.now() + CLAIM_MS),
              } },
            ).exec();
            if (attempt.modifiedCount !== 1)
              throw new Error("Voucher delivery claim was lost before sending.");
            providerStarted = true;
          },
        });
      } catch (error) {
        if (!knownNotSent(error)) throw error;
        await VoucherDeliveryModel.updateOne(
          {
            _id: outbox._id,
            tenant: outbox.tenant,
            status: "sending",
            claimToken,
          },
          {
            $set: {
              status: "failed",
              claimToken: "",
              claimExpiresAt: null,
              providerAttemptStartedAt: null,
              nextAttemptAt: (error as { permanent?: boolean })?.permanent
                ? null
                : retryAt(outbox.attempts),
              lastError: errorText(error),
            },
          },
        ).exec();
        continue;
      }
      await recordCompleted(
        outbox,
        claimToken,
        true,
        info.providerMessageId,
      );
      sent += 1;
    } catch (error) {
      const code = error instanceof AppError ? error.code : "";
      const suppressed =
        !providerStarted &&
        ["VOUCHER_DELIVERY_SUPPRESSED", "VOUCHER_ORDER_NOT_FOUND"].includes(
          String(code),
        );
      try {
        await VoucherDeliveryModel.updateOne(
          {
            _id: outbox._id,
            tenant: outbox.tenant,
            status: "sending",
            claimToken,
          },
          {
            $set: {
              status: providerStarted
                ? "ambiguous"
                : suppressed
                  ? "suppressed"
                  : "failed",
              claimToken: "",
              claimExpiresAt: null,
              nextAttemptAt:
                providerStarted || suppressed ? null : retryAt(outbox.attempts),
              lastError: providerStarted
                ? "Email provider acceptance is uncertain or could not be recorded. Automatic retry is disabled; an explicit buyer resend creates a separate message."
                : errorText(error),
            },
          },
        ).exec();
      } catch (recordError) {
        logger.error(
          { err: recordError, voucherDeliveryId: outbox._id },
          "Voucher delivery outcome could not be recorded; lease recovery will reconcile it.",
        );
      }
      logger.error(
        {
          err: error,
          voucherDeliveryId: outbox._id,
          tenantId: String(outbox.tenant),
        },
        "Voucher delivery attempt failed.",
      );
    }
  }
  return { processed, sent };
};

export const voucherDeliveryInternals = {
  intentId,
  messageId,
  knownNotSent,
  retryAt,
  loadDeliverableOrder,
  MAX_ATTEMPTS,
};
