import mongoose from "mongoose";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";

import { badRequest, notFound } from "../../shared/http/httpErrors.js";
import { AppError } from "@/shared/http/AppError.js";
import { logger } from "@/config/logger.js";
import { normalizeVoucherDesign, type VoucherDesign } from "./voucher-design.js";
import { renderVoucherSvg } from "./voucher-design.renderer.js";
import { normalizeVoucherGiftMessage } from "./voucher-delivery-design.js";
import { buildVoucherPurchaseAccessUrl } from "./voucher-order-access.js";
import { enqueueVoucherDelivery } from "./voucher-delivery.service.js";
import { resolveVoucherDesignAssets } from "@/modules/product/services/voucher-design.service.js";
import { publishCustomerVoucherRedeemedNotificationSafely } from "@/modules/customer-notifications/index.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";
import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";
import { Product } from "@/modules/product/product.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import { Coupon, CouponOrder } from "./coupon.model.js";
import { appendVoucherLedgerEntry } from "./voucher-lifecycle.service.js";
import { assertVoucherCanBeIssued, calculateVoucherExpiry, normalizeVoucherSettings, normalizeVoucherTimezone, type VoucherSettingsSnapshot } from "./voucher-policy.js";
import {
  COUPON_STRIPE_CLIENT_REFERENCE_PREFIX,
  COUPON_STATUS,
} from "./coupon.constants.js";
import { couponRepository } from "./coupon.repository.js";
import type {
  CouponCheckoutInput,
  CouponFilterInput,
  CouponOrderFilterInput,
  ManualPromoCodeInput,
  RedeemCouponInput,
  UpdateCouponOrderStatusInput,
} from "./coupon.validators.js";
import {
  CouponValueSnapshotError,
  couponAmountToMinorUnits,
  createCouponValueSnapshotFromOrder,
  createCouponValueSnapshotFromProduct,
  generatePromoCode,
  getProductNameSnapshot,
  normalizeCouponCurrency,
  resolveCouponRedemptionValue,
} from "./coupon.utils.js";

import {
  fromCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { requireReadyTenantConnectedAccount } from "@/modules/tenant-payments/services/tenant-payment-connect.service.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { attachStripeSessionOrExpire } from "@/modules/checkout/checkout.session-persistence.js";
import {
  buildTenantCommerceUrl,
  normalizeCommerceLocale,
  resolveTenantCommerceOrigin,
} from "@/modules/checkout/checkout.urls.js";

export const getPendingCouponDeliveryChannels = (order: {
  emailSent?: boolean;
  adminEmailSent?: boolean;
  adminEmailSkipped?: boolean;
  customerEmailSent?: boolean;
}) => {
  const legacyAllSent = order.emailSent === true;

  return {
    admin: !legacyAllSent && order.adminEmailSent !== true && order.adminEmailSkipped !== true,
    customer: !legacyAllSent && order.customerEmailSent !== true,
  };
};

const getTenantCouponCurrency = async (
  tenantId: string,
): Promise<StudioCommerceCurrency> => {
  const tenant = await TenantModel.findById(
    couponRepository.toObjectId(tenantId),
  )
    .select("settings.currency")
    .lean()
    .exec();

  if (!tenant) {
    notFound("Tenant not found.");
  }

  try {
    return normalizeCouponCurrency(tenant.settings?.currency);
  } catch {
    badRequest({
      message: "Tenant has an unsupported commerce currency.",
      code: "COUPON_CURRENCY_UNSUPPORTED",
      details: { currency: tenant.settings?.currency },
    });
  }
};

const getCouponPostFee = (
  settings: unknown,
  currency: StudioCommerceCurrency,
  sendPost: boolean,
): number => {
  if (!sendPost) {
    return 0;
  }

  const delivery = (settings as { physicalDelivery?: { enabled?: unknown; postageFeeMinor?: unknown } } | undefined)?.physicalDelivery;
  if (delivery?.enabled !== true) {
    badRequest({
      message: "Physical delivery is not available for this voucher. Please choose digital delivery.",
      code: "VOUCHER_PHYSICAL_DELIVERY_UNAVAILABLE",
    });
  }
  const feeMinor = delivery.postageFeeMinor;
  if (typeof feeMinor !== "number" || !Number.isSafeInteger(feeMinor) || feeMinor < 0) {
    badRequest({
      message: "Physical delivery pricing is not configured correctly. Please contact the studio.",
      code: "VOUCHER_POSTAGE_FEE_INVALID",
    });
  }
  return fromCurrencyMinorUnits(feeMinor as number, currency);
};

const requireCouponAmountMinor = (
  amount: number,
  currency: StudioCommerceCurrency,
): number => {
  let amountMinor: number;
  let restoredAmount: number;

  try {
    amountMinor = couponAmountToMinorUnits(amount, currency);
    restoredAmount = fromCurrencyMinorUnits(amountMinor, currency);
  } catch {
    badRequest({
      message: `Coupon amount has invalid precision for ${currency}.`,
      code: "INVALID_CURRENCY_PRECISION",
      details: { amount, currency },
    });
  }

  if (Math.abs(restoredAmount - amount) > 1e-9) {
    badRequest({
      message: `Coupon amount has invalid precision for ${currency}.`,
      code: "INVALID_CURRENCY_PRECISION",
      details: { amount, currency },
    });
  }

  return amountMinor;
};

const requireCouponProduct = async (tenantId: string, productId: string, session?: mongoose.ClientSession) => {
  const product = session
    ? await Product.findOne({ _id: productId, tenant: tenantId }).session(session).lean().exec()
    : await couponRepository.findProductByIdForTenant(tenantId, productId);

  if (!product) {
    notFound("Product not found.");
  }

  if (product.type !== "coupon") {
    badRequest("Selected product is not a coupon product.");
  }

  if (product.isActive !== true) {
    badRequest("Selected voucher product is not available.");
  }

  const templateKey = String(product.voucherTemplate || "").trim();

  if (!templateKey && !product.voucherDesign) {
    badRequest("Add a voucher design or upload a PDF template before selling this voucher.");
  }
  if (product.voucherDesign) normalizeVoucherDesign(product.voucherDesign);

  const unitPrice = Number(product.price);

  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    badRequest("Coupon product is missing valid price.");
  }

  let currency: StudioCommerceCurrency;

  if (product.currency) {
    try {
      currency = normalizeCouponCurrency(product.currency);
    } catch {
      badRequest({
        message: "Coupon product has an unsupported currency.",
        code: "COUPON_CURRENCY_UNSUPPORTED",
        details: { currency: product.currency },
      });
    }
  } else {
    // Compatibility for legacy products created before currency snapshots.
    currency = await getTenantCouponCurrency(tenantId);
  }

  return {
    ...product,
    currency,
  };
};

const verifyLegacyPlatformCouponOrderSnapshot = async (params: {
  tenantId: string;
  session: Stripe.Checkout.Session;
  livemode: boolean;
}) => {
  const clientReference = params.session.client_reference_id || "";

  if (!clientReference.startsWith(COUPON_STRIPE_CLIENT_REFERENCE_PREFIX)) {
    throw new Error("Legacy voucher Session has an invalid order reference.");
  }

  const couponOrderId = clientReference
    .slice(COUPON_STRIPE_CLIENT_REFERENCE_PREFIX.length)
    .trim();

  if (!mongoose.Types.ObjectId.isValid(couponOrderId)) {
    throw new Error("Legacy voucher Session has an invalid order reference.");
  }

  const order = await couponRepository.findCouponOrderByIdForTenant(
    params.tenantId,
    couponOrderId,
  );

  if (!order) {
    notFound("Coupon order not found.");
  }

  const connectedAccountId = String(
    order.stripeConnectedAccountId || "",
  ).trim();
  const storedLivemode = order.stripeLivemode;
  const currency = normalizeCouponCurrency(order.currencySnapshot);
  const paidCurrency = String(params.session.currency || "")
    .trim()
    .toUpperCase();
  const storedExpectedAmountMinor = Number(order.expectedAmountMinor);
  const expectedAmountMinor =
    storedExpectedAmountMinor > 0
      ? storedExpectedAmountMinor
      : requireCouponAmountMinor(Number(order.totalSnapshot), currency);
  const paidAmountMinor = params.session.amount_total;

  if (connectedAccountId) {
    throw new Error(
      "Legacy platform checkout cannot process a connected-account voucher order.",
    );
  }

  if (
    order.stripeSessionId !== params.session.id ||
    (typeof storedLivemode === "boolean" &&
      storedLivemode !== params.livemode) ||
    params.session.livemode !== params.livemode
  ) {
    throw new Error("Legacy Stripe voucher payment snapshot mismatch.");
  }

  if (paidCurrency !== currency) {
    throw new Error(
      `Coupon payment currency mismatch: expected ${currency}, received ${paidCurrency || "missing"}.`,
    );
  }

  if (
    !Number.isSafeInteger(paidAmountMinor) ||
    paidAmountMinor < 0 ||
    paidAmountMinor !== expectedAmountMinor
  ) {
    throw new Error(
      `Coupon payment amount mismatch: expected ${expectedAmountMinor}, received ${String(paidAmountMinor)}.`,
    );
  }

  return {
    order,
    couponOrderId,
    currency,
    storedExpectedAmountMinor,
  };
};

export const couponService = {
  async listCouponProducts(tenantId: string) {
    return couponRepository.listCouponProducts(tenantId);
  },

  async createCheckout(tenantId: string, input: CouponCheckoutInput) {
    const connectedAccount = await requireReadyTenantConnectedAccount(tenantId);
    const tenant = await TenantModel.findById(
      couponRepository.toObjectId(tenantId),
    )
      .select(
        "slug plan planVersion domains settings.defaultLanguage settings.publicDefaultLanguage settings.timezone",
      )
      .lean()
      .exec();

    if (!tenant) notFound("Tenant not found.");

    const clientUrl = resolveTenantCommerceOrigin({
      tenant,
      requestedOrigin: input.origin,
    });
    const locale = normalizeCommerceLocale(
      input.locale ??
        tenant.settings?.publicDefaultLanguage ??
        tenant.settings?.defaultLanguage,
    );
    const giftMessage = normalizeVoucherGiftMessage(input.giftMessage);
    input = { ...input, giftMessage };
    let preflightDesign: string | undefined;
    if (giftMessage) {
      const offering = await requireCouponProduct(tenantId, input.productId);
      if (offering.voucherDesign) {
        const design = normalizeVoucherDesign(offering.voucherDesign);
        const assets = await resolveVoucherDesignAssets(tenantId, design);
        await renderVoucherSvg({
          design, assets, giftMessage, sample: true,
          metadata: {
            promoCode: "SAMPLE-0000-0000", amountMinor: createCouponValueSnapshotFromProduct(offering).valueMinorSnapshot,
            currency: normalizeCouponCurrency(offering.currency), expiresAt: null,
            timezone: normalizeVoucherTimezone(tenant.settings?.timezone), locale,
            productName: getProductNameSnapshot(offering.name),
          },
        });
        preflightDesign = JSON.stringify(design);
      } else preflightDesign = "legacy";
    }

    const { product, currency, order, expectedAmountMinor } = await mongoose.connection.transaction(async (dbSession) => {
      await acquireVoucherTenantMutationLock(tenantId, dbSession);
      const product = await requireCouponProduct(tenantId, input.productId, dbSession);
      if (giftMessage && preflightDesign !== (product.voucherDesign ? JSON.stringify(normalizeVoucherDesign(product.voucherDesign)) : "legacy")) {
        badRequest({ code: "VOUCHER_DESIGN_CHANGED", message: "This voucher design changed while checking your message. Please try again." });
      }
      const voucherSettings = normalizeVoucherSettings(product.voucherSettings);
      if (voucherSettings.type === "experience") badRequest({ code: "VOUCHER_EXPERIENCE_NOT_AVAILABLE", message: "Experience voucher sales will be available with booking redemption." });
      const timezone = normalizeVoucherTimezone(tenant.settings?.timezone);
      try { assertVoucherCanBeIssued(voucherSettings, new Date(), timezone); }
      catch (error) { badRequest({ code: "VOUCHER_EXPIRY_INVALID", message: error instanceof Error ? error.message : "Invalid voucher validity." }); }
      if (voucherSettings.validity.mode === "date") {
        const expiry = calculateVoucherExpiry({ validity: voucherSettings.validity, issuedAt: new Date(), timezone });
        // Leave a margin beyond the existing 30-minute card checkout window.
        if (!expiry || expiry.getTime() - Date.now() < 35 * 60 * 1000) {
          badRequest({ code: "VOUCHER_EXPIRY_TOO_CLOSE", message: "This voucher expires too soon to complete checkout. Please choose another voucher." });
        }
      }
      const currency = normalizeCouponCurrency(product.currency);
      const shippingFee = getCouponPostFee(product.voucherSettings, currency, input.sendPost);
      const expectedAmountMinor = requireCouponAmountMinor(Number(product.price), currency) * input.quantity
        + requireCouponAmountMinor(shippingFee, currency);
      if (!Number.isSafeInteger(expectedAmountMinor) || expectedAmountMinor <= 0) {
        badRequest({ code: "COUPON_AMOUNT_INVALID", message: "The voucher purchase total is invalid." });
      }
      const order = await couponRepository.createCouponOrderFromCheckout(tenantId, input, { ...product, voucherSettings }, shippingFee, {
        connectedAccountId: connectedAccount.stripeAccountId, expectedAmountMinor,
      }, { session: dbSession, validityTimezoneSnapshot: timezone, localeSnapshot: locale, purchaseOriginSnapshot: clientUrl });
      return { product, currency, order, expectedAmountMinor };
    });

    const imageUrl = String(product.imageSrc || "").trim();
    const images = /^https:\/\/.+/i.test(imageUrl) ? [imageUrl] : undefined;

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name: getProductNameSnapshot(product.name) || "Voucher",
            ...(images ? { images } : {}),
            metadata: {
              productId: String(product._id),
              couponOrderId: String(order._id),
              type: "coupon",
            },
          },
          unit_amount: requireCouponAmountMinor(
            Number(order.unitPriceSnapshot),
            currency,
          ),
        },
        quantity: input.quantity,
      },
    ];

    if (order.sendPost && Number(order.shippingFeeSnapshot) > 0) {
      lineItems.push({
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name: locale === "cs" ? "Poštovné" : "Postage",
            metadata: {
              couponOrderId: String(order._id),
              type: "coupon_shipping",
            },
          },
          unit_amount: requireCouponAmountMinor(
            Number(order.shippingFeeSnapshot),
            currency,
          ),
        },
        quantity: 1,
      });
    }

    const stripe = getTenantPaymentStripe();
    const purchaseAccessUrl = buildVoucherPurchaseAccessUrl(order);
    if (!purchaseAccessUrl) throw new Error("Voucher purchase access could not be prepared.");

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: input.email,
        client_reference_id: `${COUPON_STRIPE_CLIENT_REFERENCE_PREFIX}${order._id.toString()}`,
        line_items: lineItems,
        expires_at: Math.floor(Date.now() / 1000 + 1800),
        success_url: purchaseAccessUrl,
        cancel_url: buildTenantCommerceUrl({
          origin: clientUrl,
          locale,
          path: "vouchers/cancel",
        }),
        metadata: {
          sharioManaged: "true",
          sharioFlow: "voucher-purchase",
          tenantId,
          couponOrderId: String(order._id),
          currency,
          expectedAmountMinor: String(expectedAmountMinor),
        },
        payment_intent_data: { metadata: { sharioManaged: "true", sharioFlow: "voucher-purchase", tenantId, couponOrderId: String(order._id) } },
      },
      getConnectedAccountRequestOptions(connectedAccount.stripeAccountId, {
        idempotencyKey: `coupon-checkout-session:${String(order._id)}`,
      }),
    );

    await attachStripeSessionOrExpire({
      sessionId: session.id,
      attach: () =>
        couponRepository.attachStripeSession({
          tenantId,
          couponOrderId: String(order._id),
          connectedAccountId: connectedAccount.stripeAccountId,
          sessionId: session.id,
          livemode: session.livemode,
          expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : undefined,
        }),
      expire: (sessionId) =>
        stripe.checkout.sessions.expire(
          sessionId,
          getConnectedAccountRequestOptions(connectedAccount.stripeAccountId),
        ),
    });

    return {
      url: session.url,
      couponOrderId: order._id,
      currency,
      total: Number(order.totalSnapshot),
      subtotal: Number(order.subtotalSnapshot),
      shippingFee: Number(order.shippingFeeSnapshot),
      sendPost: order.sendPost === true,
    };
  },

  async createUniquePromoCode(tenantId: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const promoCode = generatePromoCode();
      const exists = await couponRepository.promoCodeExists(
        tenantId,
        promoCode,
      );

      if (!exists) {
        return promoCode;
      }
    }

    throw new Error("Failed to generate unique promo code.");
  },

  async createCouponsForOrder(params: {
    tenantId: string;
    productId: string | mongoose.Types.ObjectId;
    quantity: number;
    couponOrderId: string | mongoose.Types.ObjectId;
    valueMinorSnapshot: number;
    currencySnapshot: StudioCommerceCurrency;
    createdBy?: string | mongoose.Types.ObjectId | null;
    expiresAt?: Date | null;
    voucherSettingsSnapshot?: VoucherSettingsSnapshot;
    designSnapshot?: unknown;
    productNameSnapshot?: string;
    session?: mongoose.ClientSession;
  }) {
    const quantity = Math.max(1, Number(params.quantity) || 1);
    await couponRepository.setMissingCouponValueSnapshotsForOrder({
      tenantId: params.tenantId,
      couponOrderId: params.couponOrderId,
      valueMinorSnapshot: params.valueMinorSnapshot,
      currencySnapshot: params.currencySnapshot,
      ...(params.session ? { session: params.session } : {}),
    });
    const existing = await couponRepository.listCouponsForOrder(
      params.tenantId,
      params.couponOrderId,
      params.session,
    );

    for (const coupon of existing) {
      if (
        Number(coupon.valueMinorSnapshot) !== params.valueMinorSnapshot ||
        coupon.currencySnapshot !== params.currencySnapshot
      ) {
        throw new Error(
          "Coupon order contains a voucher with a missing or mismatched immutable value snapshot.",
        );
      }
    }

    if (existing.length > quantity) {
      throw new Error("Coupon order contains more vouchers than purchased.");
    }

    const coupons: mongoose.Types.ObjectId[] = existing.map(
      (coupon) => coupon._id,
    );
    const promoCodes: string[] = existing.map((coupon) => coupon.promoCode);

    for (let index = existing.length; index < quantity; index += 1) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const promoCode = generatePromoCode();

        try {
          const coupon = await couponRepository.createCoupon({
            tenantId: params.tenantId,
            productId: params.productId,
            promoCode,
            valueMinorSnapshot: params.valueMinorSnapshot,
            currencySnapshot: params.currencySnapshot,
            couponOrderId: params.couponOrderId,
            createdBy: params.createdBy,
            expiresAt: params.expiresAt,
            voucherSettingsSnapshot: params.voucherSettingsSnapshot,
            designSnapshot: params.designSnapshot,
            productNameSnapshot: params.productNameSnapshot,
            session: params.session,
          });

          if (params.voucherSettingsSnapshot && params.session) {
            await appendVoucherLedgerEntry({ tenantId: params.tenantId, couponId: coupon._id,
              operationId: `issue:${coupon._id}`, kind: "issue", currency: params.currencySnapshot,
              amountMinor: params.voucherSettingsSnapshot.type === "value" ? params.valueMinorSnapshot : 0,
              quantity: params.voucherSettingsSnapshot.type === "experience" ? params.voucherSettingsSnapshot.experienceQuantity ?? 1 : 0,
              referenceId: String(params.couponOrderId), actorId: params.createdBy ? String(params.createdBy) : null,
            }, params.session);
          }

          coupons.push(coupon._id);
          promoCodes.push(coupon.promoCode);
          break;
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: number }).code === 11000
          ) {
            if (params.session) throw error;
            continue;
          }

          throw error;
        }
      }
    }

    if (promoCodes.length !== quantity) {
      throw new Error("Failed to generate enough unique promo codes.");
    }

    return { coupons, promoCodes };
  },

  async finalizePaidCouponOrder(params: {
    tenantId: string;
    couponOrderId: string;
    sessionId?: string;
    eventId?: string;
    paymentIntentId?: string;
    paidAt?: Date;
  }): Promise<boolean> {
    const { tenantId, couponOrderId, sessionId, eventId, paymentIntentId } =
      params;
    let acquiredLease = false;
    let acquiredLeaseStartedAt: Date | null = null;

    try {
      if (!mongoose.Types.ObjectId.isValid(couponOrderId)) {
        logger.warn({ couponOrderId }, "Invalid coupon order id.");
        return false;
      }

      const lockedOrder =
        await couponRepository.acquireCouponOrderProcessingLock(
          tenantId,
          couponOrderId,
          sessionId,
          eventId,
          paymentIntentId,
        );

      if (!lockedOrder) {
        const existing = await couponRepository.findCouponOrderByIdForTenant(
          tenantId,
          couponOrderId,
        );

        const alreadyProcessed = Boolean(
          existing?.processedAt ||
          existing?.status === COUPON_STATUS.PROCESSED ||
          existing?.status === COUPON_STATUS.SHIPPED,
        );

        return alreadyProcessed;
      }

      acquiredLease = true;
      acquiredLeaseStartedAt = lockedOrder.processingStartedAt ?? null;
      const artifacts = await mongoose.connection.transaction(async (dbSession) => {
        // Serialize issuance with offering deletion and purchase refunds. The
        // order and all new codes/ledger entries become durable together.
        await acquireVoucherTenantMutationLock(tenantId, dbSession);
        const order = await CouponOrder.findOne({ _id: couponOrderId, tenant: tenantId }).session(dbSession).exec();
        if (!order) throw new Error("Paid voucher order no longer exists.");
        if (!order.paidAt) throw new Error("Voucher payment has not been confirmed.");
        if (
          !order.isProcessing ||
          !order.processingStartedAt ||
          !acquiredLeaseStartedAt ||
          order.processingStartedAt.getTime() !== acquiredLeaseStartedAt.getTime() ||
          !order.processingLeaseExpiresAt || order.processingLeaseExpiresAt <= new Date()
        ) throw new Error("Voucher issuance lease has expired or changed; retry issuance.");
        if ((order.refundState && order.refundState !== "none") || order.refundedAmountMinor > 0) {
          order.isProcessing = false;
          await order.save({ session: dbSession });
          return null;
        }
        // Sold terms are authoritative. A current Product is only a fallback
        // for historical orders that predate template/name snapshots.
        const designSnapshot: VoucherDesign | undefined = order.designSnapshot?.version !== undefined
          ? normalizeVoucherDesign(order.designSnapshot)
          : undefined;
        const historicalProduct = (!designSnapshot && !order.voucherTemplateKeySnapshot) || !order.productNameSnapshot
          ? await Product.findOne({ _id: order.product, tenant: tenantId }).session(dbSession).lean().exec()
          : null;
        const templateKey = String(order.voucherTemplateKeySnapshot || historicalProduct?.voucherTemplate || "").trim();
        if (!templateKey && !designSnapshot) throw new Error("Paid voucher order has no retained voucher design or PDF template.");
        const name = String(order.productNameSnapshot || getProductNameSnapshot(historicalProduct?.name) || "Voucher");
        // Retain the one-time legacy fallback before asynchronous delivery.
        if (!order.voucherTemplateKeySnapshot) order.voucherTemplateKeySnapshot = templateKey;
        if (!order.productNameSnapshot) order.productNameSnapshot = name;
        const paidAt = order.paidAt ?? params.paidAt ?? new Date();
        order.paidAt = paidAt;
        const settings = order.voucherSettingsSnapshot ? normalizeVoucherSettings(order.voucherSettingsSnapshot) : undefined;
        // Historical orders without an explicit policy retain their previous
        // perpetual behavior. New orders always snapshot the 12-month default.
        const expiresAt = settings
          ? order.expiresAtSnapshot ?? calculateVoucherExpiry({ validity: settings.validity, issuedAt: paidAt, timezone: order.validityTimezoneSnapshot || "UTC" })
          : undefined;
        if (expiresAt !== undefined) order.expiresAtSnapshot = expiresAt;
        if (expiresAt && expiresAt <= paidAt) {
          order.refundState = "manual_review";
          order.refundReviewReason = "Payment arrived after the purchased voucher expiry. Review and refund or replace this purchase before delivery.";
          order.isProcessing = false;
          await order.save({ session: dbSession });
          return null;
        }
        const result = await this.createCouponsForOrder({ tenantId, productId: order.product,
          quantity: order.quantity, couponOrderId: order._id, ...createCouponValueSnapshotFromOrder(order),
          createdBy: order.createdBy || null, expiresAt, voucherSettingsSnapshot: settings,
          designSnapshot: order.designSnapshot, productNameSnapshot: name, session: dbSession,
        });
        order.coupons = result.coupons;
        order.promoCodesSnapshot = result.promoCodes;
        order.status = COUPON_STATUS.PROCESSED;
        order.processedAt = new Date();
        order.isProcessing = false;
        order.processingLeaseExpiresAt = null;
        order.processingError = "";
        if (eventId && !order.processedStripeEventIds.includes(eventId)) order.processedStripeEventIds.push(eventId);
        await order.save({ session: dbSession });
        await enqueueVoucherDelivery({ tenantId, couponOrderId, session: dbSession });
        return { ...result, templateKey, designSnapshot, product: { name }, paidAt, expiresAt };
      });
      if (!artifacts) return true;
      return true;
    } catch (error) {
      logger.error(
        { err: error, couponOrderId },
        "Finalize coupon order failed.",
      );

      if (acquiredLease) await couponRepository.releaseCouponOrderProcessingLockWithError(
        tenantId,
        couponOrderId,
        error instanceof Error ? error.message : String(error),
        ...(acquiredLeaseStartedAt ? [acquiredLeaseStartedAt] : []),
      );

      // Stripe retries failed issuance; the durable paid marker also lets the
      // reconciliation job recover independently of webhook retry timing.
      throw error;
    }
  },

  async processCouponOrderFromWebhook(params: {
    tenantId: string;
    session: Stripe.Checkout.Session;
    connectedAccountId: string;
    eventId: string;
    livemode: boolean;
    paidAt?: Date;
  }): Promise<boolean> {
    const clientReference = params.session.client_reference_id || "";

    if (!clientReference.startsWith(COUPON_STRIPE_CLIENT_REFERENCE_PREFIX)) {
      return true;
    }

    const couponOrderId = clientReference
      .slice(COUPON_STRIPE_CLIENT_REFERENCE_PREFIX.length)
      .trim();

    if (!mongoose.Types.ObjectId.isValid(couponOrderId)) {
      throw new Error("Shario voucher Session has an invalid order reference.");
    }

    const order = await couponRepository.findCouponOrderByIdForTenant(
      params.tenantId,
      couponOrderId,
    );

    if (!order) {
      notFound("Coupon order not found.");
    }

    if (
      order.stripeConnectedAccountId !== params.connectedAccountId ||
      order.stripeSessionId !== params.session.id ||
      order.stripeLivemode !== params.livemode
    ) {
      throw new Error("Stripe voucher payment account snapshot mismatch.");
    }

    const currency = normalizeCouponCurrency(order.currencySnapshot);
    const paidCurrency = String(params.session.currency || "")
      .trim()
      .toUpperCase();
    const expectedAmountMinor =
      Number(order.expectedAmountMinor) ||
      requireCouponAmountMinor(Number(order.totalSnapshot), currency);
    const paidAmountMinor = params.session.amount_total;

    if (params.session.payment_status !== "paid" || params.session.status !== "complete") {
      throw new Error(`Coupon checkout ${params.session.id} is not paid.`);
    }

    if (
      (params.session.metadata?.tenantId && params.session.metadata.tenantId !== params.tenantId) ||
      (params.session.metadata?.couponOrderId && params.session.metadata.couponOrderId !== couponOrderId)
    ) throw new Error("Stripe voucher payment metadata does not match its purchase.");

    if (paidCurrency !== currency) {
      throw new Error(
        `Coupon payment currency mismatch: expected ${currency}, received ${paidCurrency || "missing"}.`,
      );
    }

    if (paidAmountMinor !== expectedAmountMinor) {
      throw new Error(
        `Coupon payment amount mismatch: expected ${expectedAmountMinor}, received ${String(paidAmountMinor)}.`,
      );
    }

    await couponRepository.recordConfirmedCouponPayment({
      tenantId: params.tenantId, couponOrderId, sessionId: params.session.id,
      paymentIntentId: typeof params.session.payment_intent === "string" ? params.session.payment_intent : params.session.payment_intent?.id,
      paidAt: params.paidAt ?? new Date(),
    });

    const finalized = await this.finalizePaidCouponOrder({
      tenantId: params.tenantId,
      couponOrderId,
      sessionId: params.session.id,
      eventId: params.eventId,
      paidAt: params.paidAt,
      paymentIntentId:
        typeof params.session.payment_intent === "string"
          ? params.session.payment_intent
          : params.session.payment_intent?.id,
    });

    if (!finalized) {
      throw new Error(
        "Voucher order is already being processed; retry after its lease.",
      );
    }

    return true;
  },

  async processLegacyPlatformCouponOrderFromWebhook(params: {
    tenantId: string;
    session: Stripe.Checkout.Session;
    eventId: string;
    livemode: boolean;
  }): Promise<boolean> {
    if (params.session.payment_status !== "paid" || params.session.status !== "complete") {
      throw new Error(`Coupon checkout ${params.session.id} is not paid.`);
    }

    const snapshot = await verifyLegacyPlatformCouponOrderSnapshot(params);

    if (
      snapshot.order.status === COUPON_STATUS.PROCESSED ||
      snapshot.order.processedAt ||
      snapshot.order.processedStripeEventIds?.includes(params.eventId)
    ) {
      return true;
    }

    const bound = await couponRepository.bindLegacyPlatformCouponOrderSnapshot({
      tenantId: params.tenantId,
      couponOrderId: snapshot.couponOrderId,
      sessionId: params.session.id,
      currency: snapshot.currency,
      storedExpectedAmountMinor: snapshot.storedExpectedAmountMinor,
      livemode: params.livemode,
    });

    if (!bound) {
      const current = await couponRepository.findCouponOrderByIdForTenant(
        params.tenantId,
        snapshot.couponOrderId,
      );

      if (
        current?.status === COUPON_STATUS.PROCESSED ||
        current?.processedStripeEventIds?.includes(params.eventId)
      ) {
        return true;
      }

      if (String(current?.stripeConnectedAccountId || "").trim()) {
        throw new Error(
          "Legacy platform checkout cannot claim a connected-account voucher order.",
        );
      }

      throw new Error(
        "Legacy voucher order snapshot changed before processing; retry the event.",
      );
    }

    await couponRepository.recordConfirmedCouponPayment({
      tenantId: params.tenantId, couponOrderId: snapshot.couponOrderId, sessionId: params.session.id,
      paymentIntentId: typeof params.session.payment_intent === "string" ? params.session.payment_intent : params.session.payment_intent?.id,
      paidAt: snapshot.order.paidAt ?? new Date(),
    });

    const finalized = await this.finalizePaidCouponOrder({
      tenantId: params.tenantId,
      couponOrderId: snapshot.couponOrderId,
      sessionId: params.session.id,
      eventId: params.eventId,
      paymentIntentId:
        typeof params.session.payment_intent === "string"
          ? params.session.payment_intent
          : params.session.payment_intent?.id,
    });

    if (!finalized) {
      throw new Error(
        "Voucher order is already being processed; retry after its lease.",
      );
    }

    return true;
  },

  async releaseExpiredLegacyPlatformCouponOrderFromWebhook(params: {
    tenantId: string;
    session: Stripe.Checkout.Session;
    livemode: boolean;
  }): Promise<boolean> {
    if (
      params.session.status !== "expired" ||
      params.session.payment_status === "paid"
    ) {
      throw new Error("Legacy voucher Session is not safely expired.");
    }

    const snapshot = await verifyLegacyPlatformCouponOrderSnapshot(params);

    if (
      snapshot.order.status === COUPON_STATUS.PROCESSED ||
      snapshot.order.processedAt
    ) {
      return false;
    }

    return couponRepository.releaseExpiredLegacyPlatformCouponOrder({
      tenantId: params.tenantId,
      couponOrderId: snapshot.couponOrderId,
      sessionId: params.session.id,
      currency: snapshot.currency,
      storedExpectedAmountMinor: snapshot.storedExpectedAmountMinor,
      livemode: params.livemode,
    });
  },

  async releaseExpiredCouponOrderFromWebhook(params: {
    tenantId: string;
    couponOrderId: string;
    sessionId: string;
    connectedAccountId: string;
  }): Promise<boolean> {
    return couponRepository.releaseExpiredStripeCouponOrder(params);
  },

  async redeemPromoCode(params: {
    tenantId: string;
    userId: string;
    input: RedeemCouponInput;
  }) {
    const session = await mongoose.startSession();

    try {
      let creditsAdded = 0;
      let newBalance = 0;
      let redeemedCurrency: StudioCommerceCurrency | null = null;
      let redeemedCouponId = "";

      await session.withTransaction(async () => {
        await acquireVoucherTenantMutationLock(params.tenantId, session);
        const coupon = await couponRepository.findCouponForRedemption(
          params.tenantId,
          params.input.promoCode,
          session,
        );

        if (!coupon) {
          notFound("Promo code not found.");
        }

        if (!coupon.isActive) {
          badRequest("Promo code is not active.");
        }
        if (coupon.revokedAt || coupon.refundReviewRequired) badRequest({ code: "VOUCHER_UNAVAILABLE", message: "This voucher is revoked or awaiting refund review." });
        if (coupon.voucherTypeSnapshot === "experience") badRequest({ code: "VOUCHER_EXPERIENCE_REQUIRES_BOOKING", message: "This experience voucher must be redeemed against its booked experience." });
        if (
          coupon.reservedAt || coupon.reservedOrder || coupon.reservedBy ||
          coupon.reservedUntil || coupon.reservedValueMinor > 0 ||
          coupon.reservedQuantity > 0
        ) {
          badRequest({
            code: "VOUCHER_BOOKING_REDEMPTION_IN_PROGRESS",
            message: "This voucher is reserved for a booking. Complete or cancel that payment before exchanging it for credits.",
          });
        }

        if (coupon.redeemedAt || coupon.redeemedBy) {
          badRequest("Promo code has already been redeemed.");
        }

        if (
          coupon.expiresAt &&
          new Date(coupon.expiresAt).getTime() < Date.now()
        ) {
          badRequest("Promo code has expired.");
        }

        const product = await Product.findOne({
          _id: coupon.product,
          tenant: couponRepository.toObjectId(params.tenantId),
        })
          .select("_id name price currency type")
          .session(session)
          .lean()
          .exec();

        const orderSnapshot = coupon.order
          ? await couponRepository.findCouponOrderValueSnapshot(
              params.tenantId,
              coupon.order,
              session,
            )
          : null;

        let resolvedValue: ReturnType<typeof resolveCouponRedemptionValue>;
        try {
          resolvedValue = resolveCouponRedemptionValue({
            coupon,
            orderSnapshot,
            product: product ?? {},
            tenantCurrency:
              product && !product.currency
                ? await getTenantCouponCurrency(params.tenantId)
                : undefined,
          });
        } catch (error) {
          if (error instanceof CouponValueSnapshotError) {
            badRequest({
              message: error.message,
              code: error.code,
            });
          }
          badRequest({
            message: "Voucher value snapshot could not be resolved.",
            code: "COUPON_VALUE_SNAPSHOT_INVALID",
          });
        }

        // Coupon and CouponOrder snapshots are immutable issuance authorities.
        // A later Product deletion or kind change cannot void that liability.
        // Product existence/type remains mandatory only for the legacy fallback
        // whose value still comes from the mutable Product record.
        if (
          resolvedValue.source === "product" &&
          (!product || product.type !== "coupon")
        ) {
          badRequest("Invalid coupon product type.");
        }

        const currency = resolvedValue.currencySnapshot;
        const amountMinor = coupon.lifecycleVersion === 1
          ? coupon.remainingValueMinor
          : resolvedValue.valueMinorSnapshot;
        if (
          !Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
          amountMinor > resolvedValue.valueMinorSnapshot
        ) {
          badRequest({
            code: "VOUCHER_BALANCE_INCONSISTENT",
            message: "This voucher's remaining value needs review before it can be exchanged for credits.",
          });
        }
        const amount = fromCurrencyMinorUnits(amountMinor, currency);

        const redeemed = await couponRepository.redeemCouponAtomically({
          tenantId: params.tenantId,
          couponId: coupon._id,
          promoCode: params.input.promoCode,
          userId: params.userId,
          walletRedeemedValueMinor: amountMinor,
          ...(coupon.lifecycleVersion === 1
            ? { expectedRemainingValueMinor: amountMinor }
            : {}),
          session,
        });

        if (!redeemed) {
          badRequest("Promo code has already been redeemed.");
        }

        if (coupon.lifecycleVersion === 1) {
          await appendVoucherLedgerEntry({ tenantId: params.tenantId, couponId: coupon._id,
            operationId: `wallet-redeem:${coupon._id}`, kind: "wallet_redeem", currency,
            amountMinor, actorId: params.userId,
            referenceId: String(coupon.order || ""), reason: "Voucher claimed into account credits",
          }, session);
        }

        const creditResult = await moneyCreditService.incrementMoneyCredits({
          tenantId: params.tenantId,
          userId: params.userId,
          amount,
          currency,
          transaction: {
            type: MONEY_CREDIT_TRANSACTION_TYPE.COUPON_REDEEMED,
            description: `Uplatněn poukaz ${params.input.promoCode} (${getProductNameSnapshot(product?.name) || "Voucher"})`,
            relatedOrder: redeemed.order || undefined,
            relatedCoupon: redeemed._id,
            reason: "coupon redeemed",
            idempotencyKey: `voucher-wallet:${coupon._id}`,
          },
          session,
        });

        creditsAdded = amount;
        newBalance = creditResult.newBalance;
        redeemedCurrency = currency;
        redeemedCouponId = String(redeemed._id);
      });

      if (redeemedCouponId && redeemedCurrency) {
        await publishCustomerVoucherRedeemedNotificationSafely({
          tenantId: params.tenantId,
          recipientUserId: params.userId,
          couponId: redeemedCouponId,
          creditsAdded,
          currency: redeemedCurrency,
        });
      }

      return {
        message: "Promo code redeemed",
        promoCode: params.input.promoCode,
        creditsAdded,
        newBalance,
        currency: redeemedCurrency,
      };
    } finally {
      await session.endSession();
    }
  },

  async getUserRedeemedCoupons(tenantId: string, userId: string) {
    return couponRepository.listUserRedeemedCoupons(tenantId, userId);
  },

  async listCouponOrders(
    filters: CouponOrderFilterInput & { tenantId: string },
  ) {
    const { couponOrders, totalCount } =
      await couponRepository.listCouponOrders(filters);

    return {
      couponOrders,
      totalCount,
      totalPages: Math.ceil(totalCount / filters.limit),
      currentPage: filters.page,
      pageSize: filters.limit,
    };
  },

  async listCoupons(filters: CouponFilterInput & { tenantId: string }) {
    const { coupons, totalCount } = await couponRepository.listCoupons(filters);

    return {
      coupons,
      totalCount,
      totalPages: Math.ceil(totalCount / filters.limit),
      currentPage: filters.page,
      pageSize: filters.limit,
    };
  },

  async findById(tenantId: string, couponId: string) {
    const coupon = await couponRepository.findCouponByIdForTenant(
      tenantId,
      couponId,
    );

    if (!coupon) {
      notFound("Coupon not found.");
    }

    return coupon;
  },

  async createManualPromoCode(params: {
    tenantId: string;
    input: ManualPromoCodeInput;
    createdBy?: string | null;
  }) {
    const operationId = params.input.operationId || randomUUID();
    const result = await mongoose.connection.transaction(async (session) => {
      await acquireVoucherTenantMutationLock(params.tenantId, session);
      const existing = await CouponOrder.findOne({ tenant: params.tenantId, issuanceOperationId: operationId }).session(session).exec();
      if (existing) {
        if (String(existing.product) !== params.input.productId || existing.email !== params.input.email || String(existing.note || "") !== String(params.input.note || "") || String(existing.createdBy || "") !== String(params.createdBy || "")) {
          badRequest({ code: "VOUCHER_OPERATION_CONFLICT", message: "This operation id belongs to a different voucher issue request." });
        }
        const coupon = await Coupon.findOne({ tenant: params.tenantId, order: existing._id }).session(session).exec();
        if (!coupon) throw new Error("Manual voucher issue is missing its coupon.");
        return { coupon, couponOrder: existing };
      }
      const product = await requireCouponProduct(params.tenantId, params.input.productId, session);
      const tenant = await TenantModel.findById(params.tenantId).select("settings.timezone settings.publicDefaultLanguage settings.defaultLanguage").session(session).lean().exec();
      const timezone = normalizeVoucherTimezone(tenant?.settings?.timezone);
      const settings = normalizeVoucherSettings(product.voucherSettings);
      if (settings.type === "experience") badRequest({ code: "VOUCHER_EXPERIENCE_NOT_AVAILABLE", message: "Experience voucher issuance will be available with booking redemption." });
      let expiresAt: Date | null;
      try { expiresAt = assertVoucherCanBeIssued(settings, new Date(), timezone); }
      catch (error) { badRequest({ code: "VOUCHER_EXPIRY_INVALID", message: error instanceof Error ? error.message : "Invalid voucher validity." }); }
      const value = createCouponValueSnapshotFromProduct(product);
      const designSnapshot = product.voucherDesign ? normalizeVoucherDesign(product.voucherDesign) : undefined;
      const promoCode = generatePromoCode();
      const coupon = await couponRepository.createCoupon({ tenantId: params.tenantId, productId: product._id,
        promoCode, ...value, createdBy: params.createdBy || null, expiresAt,
        voucherSettingsSnapshot: settings, designSnapshot, productNameSnapshot: getProductNameSnapshot(product.name), session,
      });
      const couponOrder = await couponRepository.createManualCouponOrder({ tenantId: params.tenantId, product,
        email: params.input.email, note: params.input.note, couponId: coupon._id, promoCode,
        createdBy: params.createdBy || null, issuanceOperationId: operationId,
        voucherSettingsSnapshot: settings, designSnapshot, validityTimezoneSnapshot: timezone, expiresAtSnapshot: expiresAt,
        localeSnapshot: normalizeCommerceLocale(tenant?.settings?.publicDefaultLanguage || tenant?.settings?.defaultLanguage), session,
      });
      coupon.order = couponOrder._id;
      await coupon.save({ session });
      await appendVoucherLedgerEntry({ tenantId: params.tenantId, couponId: coupon._id,
        operationId: `issue:${coupon._id}`, kind: "issue", currency: value.currencySnapshot,
        amountMinor: value.valueMinorSnapshot, actorId: params.createdBy,
        referenceId: String(couponOrder._id), reason: "Manual voucher issuance",
      }, session);
      return { coupon, couponOrder };
    });
    const { coupon, couponOrder } = result;
    return {
      message: "Promo code created",
      coupon: await couponRepository.findCouponByIdForTenant(params.tenantId, coupon._id),
      promoCode: coupon.promoCode,
      creditsAmount: Number(couponOrder.unitPriceSnapshot),
      currency: normalizeCouponCurrency(couponOrder.currencySnapshot),
      email: params.input.email,
      couponOrderId: couponOrder._id,
    };
  },

  async updateCouponOrderStatus(params: {
    tenantId: string;
    input: UpdateCouponOrderStatusInput;
    admin: {
      id: string;
      firstname?: string;
      lastname?: string;
      email: string;
      tenantRole?: string;
      platformRole?: string;
    };
  }) {
    if (params.input.newStatus !== COUPON_STATUS.SHIPPED) {
      throw new AppError({
        code: "VOUCHER_ORDER_STATUS_MANAGED", statusCode: 409,
        message: "Payment and issuance are managed automatically. A dispatched voucher order cannot be moved back to awaiting dispatch.",
      });
    }
    // Older clients still use the status endpoint. Both entry points must use
    // the same transactional paid/refund/issued-code checks.
    const { voucherPhysicalDeliveryService } = await import("./voucher-physical-delivery.service.js");
    const couponOrder = await voucherPhysicalDeliveryService.dispatch({
      tenantId: params.tenantId,
      couponOrderId: params.input.couponOrderId,
      actorId: params.admin.id,
      operationId: randomUUID(),
    });

    return {
      message: "Coupon order status updated successfully",
      couponOrder,
      newStatus: params.input.newStatus,
      timestamp: new Date().toISOString(),
    };
  },
};
