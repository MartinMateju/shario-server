import mongoose from "mongoose";
import type Stripe from "stripe";

import { badRequest, notFound } from "../../../shared/http/httpErrors.js";
import { Cart } from "@/modules/cart/cart.model.js";
import { Order } from "@/modules/order/order.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import { toObjectId } from "@/shared/helpers/helper.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import type { PurchaseCreditsInput } from "../money-credit.validators.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { createDurableStripeCheckoutSession } from "@/modules/checkout/checkout.session-persistence.js";
import {
  buildTenantCommerceUrl,
  normalizeCommerceLocale,
  resolveTenantCommerceOrigin,
} from "@/modules/checkout/checkout.urls.js";
import { requireReadyTenantConnectedAccount } from "@/modules/tenant-payments/services/tenant-payment-connect.service.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import {
  normalizeCreditCurrency,
  toMinorUnits,
} from "../money-credit.utils.js";

export const creditCheckoutService = {
  async createCreditPurchaseCheckout(
    tenantId: string,
    userId: string,
    input: PurchaseCreditsInput,
  ) {
    const connectedAccount = await requireReadyTenantConnectedAccount(tenantId);
    const user = await User.findOne({
      _id: toObjectId(userId),
      tenant: toObjectId(tenantId),
    })
      .select("firstname lastname email customId")
      .lean()
      .exec();

    if (!user) {
      badRequest("Authenticated user was not found.");
    }

    const tenant = await TenantModel.findById(toObjectId(tenantId))
      .select(
        "slug plan planVersion domains settings.currency settings.defaultLanguage settings.publicDefaultLanguage",
      )
      .lean()
      .exec();

    if (!tenant) {
      notFound("Tenant not found.");
    }

    let currency: StudioCommerceCurrency;

    try {
      currency = normalizeCreditCurrency(tenant.settings?.currency);
    } catch {
      badRequest({
        message: "Tenant has an unsupported credit currency.",
        code: "CREDIT_CURRENCY_UNSUPPORTED",
        details: { currency: tenant.settings?.currency },
      });
    }

    if (input.currency && input.currency !== currency) {
      badRequest({
        message: "Credit purchase currency does not match the workspace.",
        code: "CREDIT_CURRENCY_MISMATCH",
        details: {
          requestedCurrency: input.currency,
          tenantCurrency: currency,
        },
      });
    }

    const stripe = getTenantPaymentStripe();
    const orderId = new mongoose.Types.ObjectId();
    const clientUrl = resolveTenantCommerceOrigin({
      tenant,
      requestedOrigin: input.origin,
    });
    const locale = normalizeCommerceLocale(
      input.locale ??
        tenant.settings?.publicDefaultLanguage ??
        tenant.settings?.defaultLanguage,
    );
    const stripeCurrency = currency.toLowerCase();
    const expectedAmountMinor = toMinorUnits(input.amount, currency);
    const locationQuery = input.locationReference
      ? { location: input.locationReference }
      : {};

    const cart = await Cart.create({
      tenant: toObjectId(tenantId),
      user: toObjectId(userId),
      cartItems: [],
      totalPrice: input.amount,
      currency,
      expectedAmountMinor,
      status: "converted",
    });

    const sessionPayload: Stripe.Checkout.SessionCreateParams = {
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: stripeCurrency,
            unit_amount: expectedAmountMinor,
            product_data: {
              name: `Kredity ${input.amount} ${currency}`,
              metadata: {
                kind: "credit-purchase",
                amount: String(input.amount),
              },
            },
          },
        },
      ],
      mode: "payment",
      payment_method_types: ["card"],
      expires_at: Math.floor(Date.now() / 1000 + 30 * 60),
      customer_email: user.email,
      success_url: buildTenantCommerceUrl({
        origin: clientUrl,
        locale,
        path: "portal/credits/purchase-success",
        query: { orderId: String(orderId), ...locationQuery },
      }),
      cancel_url: buildTenantCommerceUrl({
        origin: clientUrl,
        locale,
        path: "portal/credits/cancel",
        query: locationQuery,
      }),
      client_reference_id: String(orderId),
      metadata: {
        sharioManaged: "true",
        sharioFlow: "credit-purchase",
        orderId: String(orderId),
        orderType: "credit-purchase",
        currency,
        tenantId,
        userId,
      },
    };

    const orderPayload = {
      _id: orderId,
      tenant: toObjectId(tenantId),
      cart: cart._id,
      createdBy: toObjectId(userId),
      customer: {
        firstname: user.firstname,
        lastname: user.lastname,
        customId: user.customId,
        email: user.email,
      },
      status: "pending_order",
      isPaid: false,
      currency,
      grossAmountMinor: expectedAmountMinor,
      expectedAmountMinor,
      creditPurchase: {
        amount: input.amount,
        currency,
      },
      workshopBookings: [],
      courseBookings: [],
      locationIds: [],
      lineItems: [
        {
          product: null,
          description: `Studio credits ${input.amount} ${currency}`,
          sku: "",
          quantity: 1,
          unitGrossMinor: expectedAmountMinor,
          grossAmountMinor: expectedAmountMinor,
          netAmountMinor: expectedAmountMinor,
          taxAmountMinor: 0,
          taxRateBps: 0,
          locationIds: [],
        },
      ],
      paymentAllocations: [],
      stripe: {
        connectedAccountId: connectedAccount.stripeAccountId,
        livemode: null,
        sessionId: "",
        processedEventIds: [],
      },
    };

    const connectedAccountOptions = getConnectedAccountRequestOptions(
      connectedAccount.stripeAccountId,
    );
    const session = await createDurableStripeCheckoutSession({
      persistOrder: () => new Order(orderPayload).save(),
      createSession: () =>
        stripe.checkout.sessions.create(
          sessionPayload,
          getConnectedAccountRequestOptions(connectedAccount.stripeAccountId, {
            idempotencyKey: `credit-purchase-session:${String(orderId)}`,
          }),
        ),
      attach: (createdSession) =>
        checkoutRepository.attachStripeSession({
          tenantId,
          orderId,
          sessionId: createdSession.id,
          amountMinor: expectedAmountMinor,
          currency,
          connectedAccountId: connectedAccount.stripeAccountId,
          livemode: createdSession.livemode,
        }),
      expire: (sessionId) =>
        stripe.checkout.sessions.expire(sessionId, connectedAccountOptions),
    });

    return {
      url: session.url,
      orderId: String(orderId),
      sessionId: session.id,
      currency,
    };
  },
};
