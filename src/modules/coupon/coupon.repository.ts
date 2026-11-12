import mongoose, { type ClientSession, type PipelineStage } from "mongoose";

import Product from "@/modules/product/product.model.js";
import User from "@/modules/user/user.model.js";
import { fromCurrencyMinorUnits, type StudioCommerceCurrency } from "@/shared/money/currency.js";
import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import {
  COUPON_SORT_FIELD,
  COUPON_STATUS,
} from "@/modules/coupon/coupon.constants.js";
import type {
  CouponDocument,
  CouponListFilters,
  CouponOrderDocument,
  CouponOrderListFilters,
} from "@/modules/coupon/coupon.types.js";
import type { CouponCheckoutInput } from "@/modules/coupon/coupon.validators.js";
import { createVoucherPurchaseAccess } from "./voucher-order-access.js";
import { issuedVoucherStatusAggregation } from "./voucher-list-policy.js";
import { voucherManagementDto } from "./voucher-record.js";
import { buildPhysicalDeliveryDto, physicalStatusFilter } from "./voucher-physical-delivery.policy.js";
import {
  escapeRegex,
  getProductNameSnapshot,
  normalizeCouponCurrency,
} from "@/modules/coupon/coupon.utils.js";

const toObjectId = (
  value: string | mongoose.Types.ObjectId,
): mongoose.Types.ObjectId => {
  return typeof value === "string" ? new mongoose.Types.ObjectId(value) : value;
};

/** Voucher history shows the purchased value/name even after an offering edit or deletion. */
export const withCouponHistoricalDisplay = (coupon: any) => {
  if (!coupon) return coupon;
  const currentProduct = coupon.product && typeof coupon.product === "object" && !(coupon.product instanceof mongoose.Types.ObjectId)
    ? coupon.product : {};
  const name = coupon.productNameSnapshot || coupon.order?.productNameSnapshot || currentProduct.name;
  const currency = coupon.currencySnapshot || coupon.order?.currencySnapshot;
  let price = coupon.order?.unitPriceSnapshot ?? currentProduct.price;
  if (Number.isSafeInteger(coupon.valueMinorSnapshot) && currency) {
    price = fromCurrencyMinorUnits(coupon.valueMinorSnapshot, currency);
  }
  return { ...coupon, product: name !== undefined || price !== undefined
    ? { ...currentProduct, ...(name !== undefined ? { name } : {}), ...(price !== undefined ? { price } : {}), ...(currency ? { currency } : {}) }
    : coupon.product };
};

export const couponRepository = {
  toObjectId,

  async listCouponProducts(tenantId: string) {
    return Product.find({
      tenant: toObjectId(tenantId),
      type: "coupon",
      isActive: true,
    })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean()
      .exec();
  },

  async findProductByIdForTenant(tenantId: string, productId: string) {
    return Product.findOne({
      _id: toObjectId(productId),
      tenant: toObjectId(tenantId),
    })
      .lean()
      .exec();
  },

  async findCouponByIdForTenant(
    tenantId: string,
    couponId: string | mongoose.Types.ObjectId,
  ) {
    const coupon = await Coupon.findOne({
      _id: toObjectId(couponId),
      tenant: toObjectId(tenantId),
    })
      .populate({
        path: "product",
        select: "name price type imageSrc",
        match: { tenant: toObjectId(tenantId) },
      })
      .populate({
        path: "order",
        select: "email firstname lastname status createdAt productNameSnapshot unitPriceSnapshot currencySnapshot",
        match: { tenant: toObjectId(tenantId) },
      })
      .lean()
      .exec();
    return withCouponHistoricalDisplay(coupon);
  },

  async createCouponOrderFromCheckout(
    tenantId: string,
    input: CouponCheckoutInput,
    product: {
      _id: mongoose.Types.ObjectId;
      name?: unknown;
      price?: number;
      currency?: string;
      voucherTemplate?: string;
      voucherSettings?: unknown;
      designSnapshot?: unknown;
      voucherDesign?: unknown;
    },
    shippingFee = 0,
    stripeSnapshot?: {
      connectedAccountId: string;
      livemode?: boolean;
      expectedAmountMinor: number;
    },
    options?: { session?: ClientSession; validityTimezoneSnapshot?: string; localeSnapshot?: string; purchaseOriginSnapshot?: string },
  ): Promise<CouponOrderDocument> {
    const unitPrice = Number(product.price || 0);
    const currency = normalizeCouponCurrency(product.currency);
    const orderId = new mongoose.Types.ObjectId();
    const access = options?.purchaseOriginSnapshot ? createVoucherPurchaseAccess({ tenantId, couponOrderId: String(orderId) }) : undefined;

    const data = {
      _id: orderId,
      tenant: toObjectId(tenantId),
      product: product._id,
      productNameSnapshot: getProductNameSnapshot(product.name),
      voucherTemplateKeySnapshot: String(product.voucherTemplate || "").trim(),
      voucherSettingsSnapshot: product.voucherSettings,
      designSnapshot: product.voucherDesign ? JSON.parse(JSON.stringify(product.voucherDesign)) : product.designSnapshot,
      validityTimezoneSnapshot: options?.validityTimezoneSnapshot,
      localeSnapshot: options?.localeSnapshot,
      giftMessageSnapshot: input.giftMessage || "",
      purchaseOriginSnapshot: options?.purchaseOriginSnapshot,
      purchaseAccessNonce: access?.purchaseAccessNonce,
      purchaseAccessTokenHash: access?.purchaseAccessTokenHash,
      purchaseAccessExpiresAt: access?.purchaseAccessExpiresAt,
      unitPriceSnapshot: unitPrice,
      currencySnapshot: currency,
      quantity: input.quantity,
      shippingFeeSnapshot: shippingFee,
      expectedAmountMinor: stripeSnapshot?.expectedAmountMinor ?? 0,
      stripeConnectedAccountId: stripeSnapshot?.connectedAccountId ?? "",
      stripeLivemode: stripeSnapshot?.livemode ?? null,

      firstname: input.sendPost ? input.firstname : "",
      lastname: input.sendPost ? input.lastname : "",
      email: input.email,

      sendPost: input.sendPost,
      street: input.sendPost ? input.street : "",
      city: input.sendPost ? input.city : "",
      postalCode: input.sendPost ? input.postalCode : "",
      countryCode: input.sendPost ? input.countryCode : "",
      note: input.note,

      status: COUPON_STATUS.PENDING_PAYMENT,
      coupons: [],
      promoCodesSnapshot: [],

      // Voucher checkout is public. Never let an unauthenticated caller
      // associate an order with an arbitrary user id supplied in the body.
      createdBy: null,
    };
    if (options?.session) {
      const [order] = await CouponOrder.create([data], { session: options.session });
      return order;
    }
    return CouponOrder.create(data);
  },

  async acquireCouponOrderProcessingLock(
    tenantId: string,
    couponOrderId: string,
    sessionId?: string,
    eventId?: string,
    paymentIntentId?: string,
  ): Promise<CouponOrderDocument | null> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);

    return CouponOrder.findOneAndUpdate(
      {
        _id: toObjectId(couponOrderId),
        tenant: toObjectId(tenantId),
        status: COUPON_STATUS.PENDING_PAYMENT,
        processedAt: null,
        paidAt: { $ne: null },
        ...(sessionId ? { stripeSessionId: sessionId } : {}),
        ...(paymentIntentId ? { stripePaymentIntentId: { $in: [null, "", paymentIntentId] } } : {}),
        ...(eventId ? { processedStripeEventIds: { $ne: eventId } } : {}),
        $or: [
          { isProcessing: false },
          { processingLeaseExpiresAt: { $exists: false } },
          { processingLeaseExpiresAt: null },
          { processingLeaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          isProcessing: true,
          processingStartedAt: now,
          processingLeaseExpiresAt: leaseExpiresAt,
          ...(sessionId ? { stripeSessionId: sessionId } : {}),
          ...(paymentIntentId
            ? { stripePaymentIntentId: paymentIntentId }
            : {}),
          processingError: "",
        },
      },
      { returnDocument: "after" },
    ).exec();
  },

  /** Called only after the signed Stripe payment has matched all order snapshots. */
  async recordConfirmedCouponPayment(params: {
    tenantId: string;
    couponOrderId: string;
    sessionId: string;
    paymentIntentId?: string;
    paidAt: Date;
  }): Promise<void> {
    if (!Number.isFinite(params.paidAt.getTime())) throw new Error("Invalid confirmed payment date.");
    const result = await CouponOrder.updateOne(
      {
        _id: toObjectId(params.couponOrderId),
        tenant: toObjectId(params.tenantId),
        stripeSessionId: params.sessionId,
        ...(params.paymentIntentId ? { stripePaymentIntentId: { $in: [null, "", params.paymentIntentId] } } : {}),
      },
      [{ $set: {
        // The first verified payment time remains authoritative across replays.
        paidAt: { $ifNull: ["$paidAt", { $literal: params.paidAt }] },
        ...(params.paymentIntentId ? { stripePaymentIntentId: { $literal: params.paymentIntentId } } : {}),
      } }],
      { updatePipeline: true },
    ).exec();
    if (result.matchedCount !== 1) throw new Error("Voucher payment snapshot changed before confirmation.");
  },

  async releaseCouponOrderProcessingLockWithError(
    tenantId: string,
    couponOrderId: string,
    errorMessage: string,
    expectedProcessingStartedAt?: Date,
  ): Promise<void> {
    await CouponOrder.updateOne(
      {
        _id: toObjectId(couponOrderId),
        tenant: toObjectId(tenantId),
        ...(expectedProcessingStartedAt ? { isProcessing: true, processingStartedAt: expectedProcessingStartedAt } : {}),
      },
      {
        $set: {
          isProcessing: false,
          processingError: errorMessage.slice(0, 2000),
        },
        $unset: { processingLeaseExpiresAt: 1 },
      },
    ).exec();
  },

  async findCouponOrderByIdForTenant(tenantId: string, couponOrderId: string) {
    return CouponOrder.findOne({
      _id: toObjectId(couponOrderId),
      tenant: toObjectId(tenantId),
    }).exec();
  },

  async markCouponOrderProcessed(
    couponOrder: CouponOrderDocument,
    couponIds: mongoose.Types.ObjectId[],
    promoCodes: string[],
    eventId?: string,
  ): Promise<CouponOrderDocument> {
    const now = new Date();
    const completed = await CouponOrder.findOneAndUpdate(
      {
        _id: couponOrder._id,
        tenant: couponOrder.tenant,
        stripeSessionId: couponOrder.stripeSessionId || "",
        isProcessing: true,
        ...(couponOrder.processingStartedAt ? { processingStartedAt: couponOrder.processingStartedAt } : {}),
        refundState: { $in: [null, "none"] },
        refundedAmountMinor: { $in: [null, 0] },
      },
      {
        $set: {
          coupons: couponIds,
          promoCodesSnapshot: promoCodes,
          status: COUPON_STATUS.PROCESSED,
          processedAt: now,
          isProcessing: false,
          processingError: "",
          processingLeaseExpiresAt: null,
          // Delivery booleans are written after each actual send/skip. This
          // update must not claim that an intentionally skipped message sent.
          emailSent: couponOrder.emailSent || Boolean(
            couponOrder.customerEmailSent && (couponOrder.adminEmailSent || couponOrder.adminEmailSkipped),
          ),
          ...(couponOrder.adminEmailSent ? { adminEmailSentAt: couponOrder.adminEmailSentAt ?? now } : {}),
          ...(couponOrder.customerEmailSent ? { customerEmailSentAt: couponOrder.customerEmailSentAt ?? now } : {}),
        },
        ...(eventId ? { $addToSet: { processedStripeEventIds: eventId } } : {}),
      },
      { returnDocument: "after" },
    ).exec();
    if (completed) return completed;

    const current = await CouponOrder.findOne({ _id: couponOrder._id, tenant: couponOrder.tenant }).exec();
    if (current && (current.refundedAmountMinor > 0 || (current.refundState && current.refundState !== "none") || current.processedAt)) {
      if (current.isProcessing && couponOrder.processingStartedAt instanceof Date) {
        await CouponOrder.updateOne({
          _id: couponOrder._id, tenant: couponOrder.tenant, isProcessing: true,
          processingStartedAt: couponOrder.processingStartedAt,
        }, { $set: { isProcessing: false }, $unset: { processingLeaseExpiresAt: 1 } }).exec();
      }
      return current;
    }
    // Issuance updates the order in a transaction and may increment __v; never
    // save the stale pre-issuance document here. Losing the lease is retryable.
    throw new Error("Voucher order processing lease was lost before completion; retry delivery.");
  },

  async markCouponOrderAdminEmailSent(
    tenantId: string,
    couponOrderId: string,
  ): Promise<void> {
    await CouponOrder.updateOne(
      {
        _id: toObjectId(couponOrderId),
        tenant: toObjectId(tenantId),
        adminEmailSent: { $ne: true },
      },
      {
        $set: {
          adminEmailSent: true,
          adminEmailSentAt: new Date(),
        },
      },
    ).exec();
  },

  async markCouponOrderCustomerEmailSent(
    tenantId: string,
    couponOrderId: string,
  ): Promise<void> {
    await CouponOrder.updateOne(
      {
        _id: toObjectId(couponOrderId),
        tenant: toObjectId(tenantId),
        customerEmailSent: { $ne: true },
      },
      {
        $set: {
          customerEmailSent: true,
          customerEmailSentAt: new Date(),
        },
      },
    ).exec();
  },

  async attachStripeSession(params: {
    tenantId: string;
    couponOrderId: string;
    connectedAccountId: string;
    sessionId: string;
    livemode: boolean;
    expiresAt?: Date;
  }) {
    return CouponOrder.updateOne(
      {
        _id: toObjectId(params.couponOrderId),
        tenant: toObjectId(params.tenantId),
        status: COUPON_STATUS.PENDING_PAYMENT,
        stripeConnectedAccountId: params.connectedAccountId,
        stripeLivemode: null,
        $or: [
          { stripeSessionId: { $exists: false } },
          { stripeSessionId: "" },
          { stripeSessionId: null },
        ],
      },
      {
        $set: {
          stripeSessionId: params.sessionId,
          stripeLivemode: params.livemode,
          ...(params.expiresAt ? { checkoutExpiresAt: params.expiresAt } : {}),
        },
      },
    ).exec();
  },

  async releaseExpiredStripeCouponOrder(params: {
    tenantId: string;
    couponOrderId: string;
    connectedAccountId: string;
    sessionId: string;
  }): Promise<boolean> {
    const result = await CouponOrder.updateOne(
      {
        _id: toObjectId(params.couponOrderId),
        tenant: toObjectId(params.tenantId),
        status: COUPON_STATUS.PENDING_PAYMENT,
        paidAt: null,
        processedAt: null,
        isProcessing: false,
        stripeConnectedAccountId: params.connectedAccountId,
        stripeSessionId: params.sessionId,
      },
      { $set: { status: COUPON_STATUS.EXPIRED } },
    ).exec();

    return result.modifiedCount === 1;
  },

  async bindLegacyPlatformCouponOrderSnapshot(params: {
    tenantId: string;
    couponOrderId: string;
    sessionId: string;
    currency: string;
    storedExpectedAmountMinor: number;
    livemode: boolean;
  }): Promise<boolean> {
    const result = await CouponOrder.updateOne(
      {
        $and: [
          { _id: toObjectId(params.couponOrderId) },
          { tenant: toObjectId(params.tenantId) },
          { status: COUPON_STATUS.PENDING_PAYMENT },
          { processedAt: null },
          { stripeSessionId: params.sessionId },
          { currencySnapshot: params.currency },
          { expectedAmountMinor: params.storedExpectedAmountMinor },
          {
            $or: [
              { stripeConnectedAccountId: { $exists: false } },
              { stripeConnectedAccountId: "" },
              { stripeConnectedAccountId: null },
            ],
          },
          {
            $or: [
              { stripeLivemode: { $exists: false } },
              { stripeLivemode: null },
              { stripeLivemode: params.livemode },
            ],
          },
        ],
      } as never,
      { $set: { stripeLivemode: params.livemode } },
    ).exec();

    return result.matchedCount === 1;
  },

  async releaseExpiredLegacyPlatformCouponOrder(params: {
    tenantId: string;
    couponOrderId: string;
    sessionId: string;
    currency: string;
    storedExpectedAmountMinor: number;
    livemode: boolean;
  }): Promise<boolean> {
    const result = await CouponOrder.updateOne(
      {
        $and: [
          { _id: toObjectId(params.couponOrderId) },
          { tenant: toObjectId(params.tenantId) },
          { status: COUPON_STATUS.PENDING_PAYMENT },
          { paidAt: null },
          { processedAt: null },
          { isProcessing: false },
          { stripeSessionId: params.sessionId },
          { currencySnapshot: params.currency },
          { expectedAmountMinor: params.storedExpectedAmountMinor },
          {
            $or: [
              { stripeConnectedAccountId: { $exists: false } },
              { stripeConnectedAccountId: "" },
              { stripeConnectedAccountId: null },
            ],
          },
          {
            $or: [
              { stripeLivemode: { $exists: false } },
              { stripeLivemode: null },
              { stripeLivemode: params.livemode },
            ],
          },
        ],
      } as never,
      {
        $set: {
          status: COUPON_STATUS.EXPIRED,
          stripeLivemode: params.livemode,
        },
      },
    ).exec();

    return result.modifiedCount === 1;
  },

  async createCoupon(params: {
    tenantId: string;
    productId: string | mongoose.Types.ObjectId;
    promoCode: string;
    valueMinorSnapshot: number;
    currencySnapshot: StudioCommerceCurrency;
    couponOrderId?: string | mongoose.Types.ObjectId | null;
    createdBy?: string | mongoose.Types.ObjectId | null;
    expiresAt?: Date | null;
    voucherSettingsSnapshot?: { type: "value" | "experience"; experienceQuantity?: number; [key: string]: unknown };
    designSnapshot?: unknown;
    productNameSnapshot?: string;
    session?: ClientSession;
  }): Promise<CouponDocument> {
    const data = {
      tenant: toObjectId(params.tenantId),
      product: toObjectId(params.productId),
      promoCode: params.promoCode,
      isActive: true,
      singleUse: true,
      valueMinorSnapshot: params.valueMinorSnapshot,
      currencySnapshot: params.currencySnapshot,
      order: params.couponOrderId ? toObjectId(params.couponOrderId) : null,
      createdBy: params.createdBy ? toObjectId(params.createdBy) : null,
      ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
      ...(params.voucherSettingsSnapshot ? {
        lifecycleVersion: 1,
        voucherTypeSnapshot: params.voucherSettingsSnapshot.type,
        voucherSettingsSnapshot: params.voucherSettingsSnapshot,
        designSnapshot: params.designSnapshot,
        productNameSnapshot: params.productNameSnapshot,
        ...(params.voucherSettingsSnapshot.type === "experience"
          ? { remainingQuantity: params.voucherSettingsSnapshot.experienceQuantity || 1 }
          : { remainingValueMinor: params.valueMinorSnapshot }),
      } : {}),
    };
    if (params.session) {
      const [coupon] = await Coupon.create([data], { session: params.session });
      return coupon;
    }
    return Coupon.create(data);
  },

  async setMissingCouponValueSnapshotsForOrder(params: {
    tenantId: string;
    couponOrderId: string | mongoose.Types.ObjectId;
    valueMinorSnapshot: number;
    currencySnapshot: StudioCommerceCurrency;
    session?: ClientSession;
  }) {
    // Raw collection access is intentional: the snapshot paths are immutable
    // after issuance, while this conditional write upgrades only legacy rows
    // that have neither half of the snapshot pair.
    return Coupon.collection.updateMany(
      {
        tenant: toObjectId(params.tenantId),
        order: toObjectId(params.couponOrderId),
        valueMinorSnapshot: null,
        currencySnapshot: null,
      },
      {
        $set: {
          valueMinorSnapshot: params.valueMinorSnapshot,
          currencySnapshot: params.currencySnapshot,
        },
      },
      ...(params.session ? [{ session: params.session }] : []),
    );
  },

  async listCouponsForOrder(
    tenantId: string,
    couponOrderId: string | mongoose.Types.ObjectId,
    session?: ClientSession,
  ) {
    const query = Coupon.find({
      tenant: toObjectId(tenantId),
      order: toObjectId(couponOrderId),
    })
      .select("_id promoCode valueMinorSnapshot currencySnapshot expiresAt lifecycleVersion voucherTypeSnapshot remainingValueMinor remainingQuantity revokedAt")
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    if (session) query.session(session);
    return query.exec();
  },

  async persistCouponOrderFulfillmentArtifacts(
    couponOrder: CouponOrderDocument,
    couponIds: mongoose.Types.ObjectId[],
    promoCodes: string[],
  ): Promise<CouponOrderDocument> {
    couponOrder.coupons = couponIds;
    couponOrder.promoCodesSnapshot = promoCodes;
    return couponOrder.save();
  },

  async promoCodeExists(tenantId: string, promoCode: string): Promise<boolean> {
    const exists = await Coupon.exists({
      tenant: toObjectId(tenantId),
      promoCode,
    })
      .lean()
      .exec();

    return Boolean(exists);
  },

  async listUserRedeemedCoupons(tenantId: string, userId: string) {
    const coupons = await Coupon.find({
      tenant: toObjectId(tenantId),
      redeemedBy: toObjectId(userId),
      redeemedAt: { $ne: null },
    })
      .select("promoCode redeemedAt product order productNameSnapshot valueMinorSnapshot currencySnapshot voucherTypeSnapshot remainingValueMinor remainingQuantity walletRedeemedValueMinor")
      .populate({
        path: "product",
        select: "name price type imageSrc",
        match: { tenant: toObjectId(tenantId) },
      })
      .populate({ path: "order", select: "productNameSnapshot unitPriceSnapshot currencySnapshot", match: { tenant: toObjectId(tenantId) } })
      .sort({ redeemedAt: -1 })
      .lean()
      .exec();
    return coupons.map(withCouponHistoricalDisplay);
  },

  async listCouponOrders(filters: CouponOrderListFilters) {
    const page = Math.max(filters.page, 1);
    const limit = Math.min(Math.max(filters.limit, 1), 100);
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {
      tenant: toObjectId(filters.tenantId),
    };

    if (filters.productId) query.product = toObjectId(filters.productId);
    if (filters.physicalStatus && filters.physicalStatus !== "all") {
      query.$and = [physicalStatusFilter(filters.physicalStatus)];
    }

    if (filters.sendPost === true || filters.sendPost === false) {
      query.sendPost = filters.sendPost;
    }

    if (filters.search) {
      const escaped = escapeRegex(filters.search);

      query.$or = [
        { email: { $regex: escaped, $options: "i" } },
        { firstname: { $regex: escaped, $options: "i" } },
        { lastname: { $regex: escaped, $options: "i" } },
        { productNameSnapshot: { $regex: escaped, $options: "i" } },
        { promoCodesSnapshot: { $regex: escaped, $options: "i" } },
      ];

      if (mongoose.Types.ObjectId.isValid(filters.search)) {
        (query.$or as unknown[]).push({ _id: toObjectId(filters.search) });
      }
    }

    let userFilterEmail = "";

    if (filters.userCustomId) {
      const user = await User.findOne({
        tenant: toObjectId(filters.tenantId),
        customId: filters.userCustomId,
      })
        .select("email")
        .lean()
        .exec();

      if (!user?.email) {
        return { couponOrders: [], totalCount: 0 };
      }

      userFilterEmail = String(user.email).toLowerCase();
    }

    if (filters.userEmail) {
      if (userFilterEmail && userFilterEmail !== filters.userEmail) {
        return { couponOrders: [], totalCount: 0 };
      }

      userFilterEmail = filters.userEmail;
    }

    if (userFilterEmail) {
      query.email = userFilterEmail;
    }

    if (filters.productType) {
      query.productNameSnapshot = {
        $regex: escapeRegex(filters.productType),
        $options: "i",
      };
    }

    if (filters.status) {
      query.status = filters.status;
    }

    const sort: Record<string, 1 | -1> = {};

    if (
      filters.sortBy === COUPON_SORT_FIELD.STATUS ||
      filters.sortBy === COUPON_SORT_FIELD.PRODUCT_NAME
    ) {
      sort[filters.sortBy] = filters.sortOrder === "asc" ? 1 : -1;
    } else {
      sort.createdAt = filters.sortOrder === "asc" ? 1 : -1;
    }

    const [couponOrders, totalCount] = await Promise.all([
      CouponOrder.find(query).sort(sort).skip(skip).limit(limit).lean().exec(),
      CouponOrder.countDocuments(query),
    ]);

    return {
      couponOrders: couponOrders.map(order => ({
        ...order, physicalDelivery: buildPhysicalDeliveryDto(order),
      })),
      totalCount,
    };
  },

  async listCoupons(filters: CouponListFilters) {
    const page = Math.max(filters.page, 1);
    const limit = Math.min(Math.max(filters.limit, 1), 100);
    const skip = (page - 1) * limit;

    const match: Record<string, unknown> = {
      tenant: toObjectId(filters.tenantId),
    };

    if (filters.productId) match.product = toObjectId(filters.productId);
    if (!filters.archiveState || filters.archiveState === "unarchived") {
      match.archivedAt = null;
    } else if (filters.archiveState === "archived") {
      match.archivedAt = { $ne: null };
    }
    // A specific lifecycle selection supersedes the legacy active toggle.
    if ((!filters.status || filters.status === "all") && typeof filters.isActive === "boolean") {
      match.isActive = filters.isActive;
    }

    const pipeline: PipelineStage[] = [
      { $match: match },
      { $set: { productId: "$product", status: issuedVoucherStatusAggregation(new Date()) } },
      ...(filters.status && filters.status !== "all" ? [{ $match: { status: filters.status } }] : []),
      {
        $lookup: {
          from: Product.collection.name,
          let: { productId: "$product", tenantId: "$tenant" },
          pipeline: [{ $match: { $expr: { $and: [
            { $eq: ["$_id", "$$productId"] },
            { $eq: ["$tenant", "$$tenantId"] },
          ] } } }],
          as: "product",
        },
      },
      {
        $unwind: {
          path: "$product",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: CouponOrder.collection.name,
          let: {
            tenantId: "$tenant",
            couponId: "$_id",
            directOrderId: { $ifNull: ["$order", null] },
            promoCode: "$promoCode",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$tenant", "$$tenantId"] },
                    { $cond: [
                      { $ne: ["$$directOrderId", null] },
                      { $eq: ["$_id", "$$directOrderId"] },
                      { $or: [
                        { $in: ["$$couponId", { $ifNull: ["$coupons", []] }] },
                        { $in: ["$$promoCode", { $ifNull: ["$promoCodesSnapshot", []] }] },
                      ] },
                    ] },
                  ],
                },
              },
            },
            // A stored coupon id is stronger evidence than a legacy code match.
            { $addFields: { relationshipRank: { $cond: [
              { $in: ["$$couponId", { $ifNull: ["$coupons", []] }] }, 0, 1,
            ] } } },
            { $sort: { relationshipRank: 1, createdAt: 1, _id: 1 } },
            {
              $project: {
                email: 1,
                firstname: 1,
                lastname: 1,
                productNameSnapshot: 1,
                unitPriceSnapshot: 1,
                currencySnapshot: 1,
                totalSnapshot: 1,
                status: 1,
                sendPost: 1,
                createdAt: 1,
              },
            },
            { $limit: 1 },
          ],
          as: "order",
        },
      },
      {
        $unwind: {
          path: "$order",
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    if (filters.search) {
      const escaped = escapeRegex(filters.search);

      const searchMatch: Record<string, unknown[]> = {
        $or: [
          { promoCode: { $regex: escaped, $options: "i" } },
          { productNameSnapshot: { $regex: escaped, $options: "i" } },
          { "order.productNameSnapshot": { $regex: escaped, $options: "i" } },
          { "order.email": { $regex: escaped, $options: "i" } },
          { "order.firstname": { $regex: escaped, $options: "i" } },
          { "order.lastname": { $regex: escaped, $options: "i" } },
          { "product.name": { $regex: escaped, $options: "i" } },
          { "product.name.CZ": { $regex: escaped, $options: "i" } },
          { "product.name.EN": { $regex: escaped, $options: "i" } },
        ],
      };

      if (mongoose.Types.ObjectId.isValid(filters.search)) {
        searchMatch.$or.push({ "order._id": toObjectId(filters.search) });
        searchMatch.$or.push({ order: toObjectId(filters.search) });
      }

      pipeline.push({ $match: searchMatch });
    }

    pipeline.push(
      {
        $sort: {
          _id: filters.sortOrder === "asc" ? 1 : -1,
        },
      },
      {
        $facet: {
          coupons: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      },
    );

    const result = await Coupon.aggregate(pipeline).exec();

    const coupons = (result?.[0]?.coupons || []).map((coupon: any) => {
      const historical = withCouponHistoricalDisplay(coupon);
      const record = voucherManagementDto(coupon);
      return {
        ...historical,
        productId: record.productId,
        status: record.status,
        originalValueMinor: record.valueMinor,
        currency: record.currency,
        remainingValueMinor: record.remainingValueMinor,
        walletRedeemedValueMinor: record.walletRedeemedValueMinor,
        remainingQuantity: record.remainingQuantity,
        reservedValueMinor: record.reservedValueMinor,
        reservedQuantity: record.reservedQuantity,
        archivedAt: record.archivedAt,
        archivedBy: record.archivedBy,
        canArchive: record.canArchive,
        canRestore: record.canRestore,
        canRevoke: record.canRevoke,
      };
    });
    const totalCount = result?.[0]?.total?.[0]?.count || 0;

    return { coupons, totalCount };
  },

  async findCouponForRedemption(
    tenantId: string,
    promoCode: string,
    session: mongoose.ClientSession,
  ) {
    return Coupon.findOne({
      tenant: toObjectId(tenantId),
      promoCode,
    })
      .select(
        "_id product isActive singleUse valueMinorSnapshot currencySnapshot expiresAt redeemedAt redeemedBy order promoCode lifecycleVersion voucherTypeSnapshot voucherSettingsSnapshot remainingValueMinor remainingQuantity reservedValueMinor reservedQuantity reservedAt reservedOrder reservedBy reservedUntil revokedAt refundReviewRequired",
      )
      .session(session)
      .exec();
  },

  async findCouponOrderValueSnapshot(
    tenantId: string,
    couponOrderId: string | mongoose.Types.ObjectId,
    session: mongoose.ClientSession,
  ) {
    return CouponOrder.findOne({
      _id: toObjectId(couponOrderId),
      tenant: toObjectId(tenantId),
    })
      .select("unitPriceSnapshot currencySnapshot")
      .session(session)
      .lean()
      .exec();
  },

  async redeemCouponAtomically(params: {
    tenantId: string;
    couponId: mongoose.Types.ObjectId;
    promoCode: string;
    userId: string;
    expectedRemainingValueMinor?: number;
    walletRedeemedValueMinor?: number;
    session: mongoose.ClientSession;
  }) {
    return Coupon.findOneAndUpdate(
      {
        _id: params.couponId,
        tenant: toObjectId(params.tenantId),
        promoCode: params.promoCode,
        isActive: true,
        redeemedAt: null,
        redeemedBy: null,
        revokedAt: null,
        refundReviewRequired: { $ne: true },
        reservedAt: null,
        reservedOrder: null,
        reservedBy: null,
        reservedUntil: null,
        reservedValueMinor: { $in: [null, 0] },
        reservedQuantity: { $in: [null, 0] },
        voucherTypeSnapshot: { $ne: "experience" },
        ...(params.expectedRemainingValueMinor === undefined
          ? {}
          : { remainingValueMinor: params.expectedRemainingValueMinor }),
        $and: [
          { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
          { $or: [
            { lifecycleVersion: { $ne: 1 } },
            { $expr: { $and: [
              { $gt: ["$remainingValueMinor", 0] },
              { $lte: ["$remainingValueMinor", "$valueMinorSnapshot"] },
            ] } },
          ] },
        ],
      },
      {
        $set: {
          isActive: false,
          remainingValueMinor: 0,
          redeemedAt: new Date(),
          redeemedBy: toObjectId(params.userId),
          ...(params.walletRedeemedValueMinor === undefined
            ? {}
            : { walletRedeemedValueMinor: params.walletRedeemedValueMinor }),
        },
      },
      { returnDocument: "after", session: params.session },
    ).exec();
  },

  async createManualCouponOrder(params: {
    tenantId: string;
    product: {
      _id: mongoose.Types.ObjectId;
      name?: unknown;
      price?: number;
      currency?: string;
      voucherTemplate?: string;
      voucherSettings?: unknown;
      designSnapshot?: unknown;
      voucherDesign?: unknown;
    };
    email: string;
    note?: string;
    couponId: mongoose.Types.ObjectId;
    promoCode: string;
    createdBy?: string | null;
    session?: ClientSession;
    issuanceOperationId?: string;
    voucherSettingsSnapshot?: unknown;
    designSnapshot?: unknown;
    localeSnapshot?: string;
    validityTimezoneSnapshot?: string;
    expiresAtSnapshot?: Date | null;
  }) {
    const unitPrice = Number(params.product.price || 0);

    const data = {
      tenant: toObjectId(params.tenantId),
      product: params.product._id,
      productNameSnapshot: getProductNameSnapshot(params.product.name),
      voucherTemplateKeySnapshot: String(params.product.voucherTemplate || ""),
      voucherSettingsSnapshot: params.voucherSettingsSnapshot ?? params.product.voucherSettings,
      designSnapshot: params.designSnapshot ?? (params.product.voucherDesign ? JSON.parse(JSON.stringify(params.product.voucherDesign)) : params.product.designSnapshot),
      localeSnapshot: params.localeSnapshot,
      validityTimezoneSnapshot: params.validityTimezoneSnapshot,
      expiresAtSnapshot: params.expiresAtSnapshot,
      paidAt: new Date(),
      issuanceOperationId: params.issuanceOperationId,
      unitPriceSnapshot: unitPrice,
      currencySnapshot: normalizeCouponCurrency(params.product.currency),
      quantity: 1,
      email: params.email,
      sendPost: false,
      note: params.note || "",
      status: COUPON_STATUS.PROCESSED,
      coupons: [params.couponId],
      promoCodesSnapshot: [params.promoCode],
      processedAt: new Date(),
      isProcessing: false,
      createdBy: params.createdBy ? toObjectId(params.createdBy) : null,
    };
    if (params.session) {
      const [order] = await CouponOrder.create([data], { session: params.session });
      return order;
    }
    return CouponOrder.create(data);
  },
};
