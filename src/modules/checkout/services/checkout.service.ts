import { normalizeExtensionCart } from "@/modules/booking/booking.extension.service.js";
import { resolveCheckoutMembershipAllowance } from "./checkout.membership-allowance.service.js";
import { getCartMembershipPaymentOptions } from "./checkout.membership-options.service.js";
import { reservePersonalCourseDiscounts, unavailablePersonalCourseDiscounts } from "./checkout.membership-course.service.js";
import { resolveProductKindV2 } from "@/modules/product/product.utils.js";
import { processWorkshopBookingsAfterPayment } from "./checkout.workshop-fulfillment.service.js";
import { assertStripeMinimum } from "@/infrastructure/payments/stripe-pricing.js";
import type { GuestCheckoutContext } from "../checkout.guest-access.js";
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import Stripe from "stripe";

import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { badRequest } from "@/shared/http/httpErrors.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { assertProductsEntitledForTenant } from "@/modules/product/product-plan-entitlements.js";
import { resolveProductPrivateBookingSurcharge } from "@/modules/product/product.utils.js";
import {
  fromCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";
import { resolveCreditBalanceMinor } from "@/modules/money-credit/money-credit.balance.js";
import {
  assertValidCartProducts,
  assertValidCartLocations,
  buildCourseBookings,
  buildGuestIncreaseBookings,
  hasStandaloneServiceItems,
  buildWorkshopBookingsToCreate,
  extractProductIdsOrThrow,
  extractLocationIdsOrThrow,
} from "./checkout.cart.service.js";
import {
  buildServerPricedCartItems,
  buildStripeLineItems,
  applyOrderLinePricesToStripePayload,
  assertStripePayableAmountAfterCredits,
  resolveServerCheckoutCurrency,
} from "./checkout.pricing.service.js";
import {
  getCourseCapacity,
  validateCourseAvailabilityOrThrow,
  validateGuestIncreaseAvailabilityOrThrow,
  validateWorkshopAvailabilityOrThrow,
} from "./checkout.capacity.service.js";
import {
  processCourseBookingsAfterPayment,
  processGuestIncreaseBookingsAfterPayment,
} from "./checkout.webhook.service.js";
import { ensureInvoiceSettings } from "@/modules/invoice/invoice-settings.service.js";
import { ensurePaidOrderInvoice } from "@/modules/invoice/invoice.service.js";
import { emitBookingCreatedNotificationsForOrderSafely } from "@/modules/workspace-notifications/workspace-notification.business-events.js";
import {
  assertReferencedBookingContexts,
  attachWorkshopBookingsToOrderLines,
  buildOrderLineSnapshots,
  collectOrderLocationIds,
} from "@/modules/invoice/order-invoice-snapshot.service.js";
import { createDurableStripeCheckoutSession } from "../checkout.session-persistence.js";
import { requireReadyTenantConnectedAccount } from "@/modules/tenant-payments/services/tenant-payment-connect.service.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import {
  buildTenantCommerceUrl,
  normalizeCommerceLocale,
} from "../checkout.urls.js";
import { getStripeCheckoutExpiryWindow } from "../checkout.utils.js";
import { STRIPE_CHECKOUT_SESSION_MINUTES } from "../checkout.constants.js";
import { resolveMembershipProductDiscount } from "@/modules/membership/services/membership-discount.service.js";
import { redeemMembershipEntitlement } from "@/modules/membership/services/membership-entitlement.service.js";
import {
  applyMembershipDiscountToOrderLines,
  buildMembershipDiscountSnapshot,
} from "./checkout.discount.service.js";
import {
  acquireCheckoutOperation,
  completeCheckoutOperation,
  releaseCheckoutOperation,
} from "../checkout-idempotency.service.js";
import {
  assertNoUnattachedCardOrder,
  assertPersistedCardCartSnapshot,
  assertPersistedCardOrderSnapshot,
  assertStripeCheckoutSessionIsAttachable,
  recoverAttachedCardCheckout,
} from "../checkout.card-recovery.js";
import {
  applyWaitlistPriceSnapshot,
  attachWaitlistStripeSession,
  resolveWaitlistCheckoutContext,
  restoreWaitlistHoldAfterCheckoutFailure,
  transferWaitlistHoldToOrder,
  type WaitlistCheckoutContext,
} from "@/modules/waitlist/waitlist.checkout.service.js";

import {
  assertExpectedVoucherQuote,
  type VoucherQuoteExpectation,
} from "../checkout.voucher.validation.js";
import { recoverVoucherStripeSession, snapshotVoucherStripeRequest } from "./checkout.voucher-session.service.js";
import {
  addOwnedVoucherPaymentContext,
  getVoucherCheckoutPlan,
  normalizeCheckoutVoucherCode,
  reserveCheckoutVouchers,
  commitCheckoutVouchers,
} from "./checkout.voucher.service.js";

const makeProductMap = (products = []) =>
  new Map(products.map((product) => [String(product._id), product]));

const makeLocationMap = (locations = []) =>
  new Map(locations.map((location) => [String(location._id), location]));

const deterministicCheckoutObjectId = (
  operationId: string,
  purpose: string,
  index: number,
) =>
  new mongoose.Types.ObjectId(
    createHash("sha256")
      .update(`${operationId}:${purpose}:${index}`)
      .digest("hex")
      .slice(0, 24),
  );

const loadCheckoutLocations = async ({ tenantId, cartItems }) => {
  const locationIds = extractLocationIdsOrThrow(cartItems);
  const locations = locationIds.length
    ? await checkoutRepository.loadLocationsByIds({
        tenantId,
        ids: locationIds,
      })
    : [];
  const locationById = makeLocationMap(locations);

  assertValidCartLocations({ cartItems, locationById });

  return { locationIds, locationById };
};

const loadCourseBookings = async ({
  tenantId,
  cartItems,
  productById,
  mustStartAfter,
}) => {
  const courseBookings = buildCourseBookings(cartItems);

  if (courseBookings.length === 0) return [];

  const uniqueSlotIds = [
    ...new Set(courseBookings.map((course) => String(course.bookingId))),
  ].map((id: string) => new mongoose.Types.ObjectId(id));

  const slots = await checkoutRepository.findCourseSlots({
    tenantId,
    ids: uniqueSlotIds,
  });

  validateCourseAvailabilityOrThrow({
    courseBookings,
    slots,
    productById,
    mustStartAfter,
  });

  // Product identity is a preflight-only field. The durable order schema keeps
  // the immutable slot id and server-normalized participant quantity.
  return courseBookings.map(({ bookingId, productId, quantity }) => ({
    bookingId,
    productId,
    quantity,
    capacity: getCourseCapacity(productById.get(String(productId))),
  }));
};

const loadGuestIncreaseBookings = async ({
  tenantId,
  cartItems,
  user,
  orderId,
}) => {
  const operations = buildGuestIncreaseBookings(cartItems);

  if (operations.length === 0) return [];

  const targets = await checkoutRepository.findGuestIncreaseTargets({
    tenantId,
    ids: operations.map((operation) => operation.bookingId),
  });
  const locationIds = [
    ...new Set(targets.map((target) => String(target.location))),
  ].map((id) => new mongoose.Types.ObjectId(id));
  const [locations, currentBookings] = await Promise.all([
    checkoutRepository.loadLocationsByIds({ tenantId, ids: locationIds }),
    checkoutRepository.findCurrentBookings({ tenantId, locationIds }),
  ]);

  validateGuestIncreaseAvailabilityOrThrow({
    guestIncreaseBookings: operations,
    targets,
    userId: user._id || user.id,
    currentBookings,
    locationById: makeLocationMap(locations),
    reservationOrderId: orderId,
  });

  return operations.map(({ bookingId, addGuests, billingBlocks }) => ({
    bookingId,
    addGuests,
    billingBlocks,
  }));
};

const buildOrderInvoiceData = async ({
  tenantId,
  cartItems,
  mappedCartItems,
  productById,
  currency,
  courseBookings,
  guestIncreaseBookings,
}) => {
  const courseBookingIds = courseBookings.map((item) => item.bookingId);
  const guestIncreaseBookingIds = guestIncreaseBookings.map(
    (item) => item.bookingId,
  );
  const referencedWorkshopBookingIds = [
    ...guestIncreaseBookingIds,
    ...cartItems.filter((item) => item.bookingExtension).map((item) => item.bookingExtension.bookingId),
  ];
  const relatedBookingIds = [
    ...new Set([...courseBookingIds, ...referencedWorkshopBookingIds].map(String)),
  ];
  const related = await checkoutRepository.findBookingLocations({
    tenantId,
    ids: relatedBookingIds,
  });
  const relatedLocationByBookingId = assertReferencedBookingContexts({
    courseBookingIds,
    // Extension lines reference the existing Open Studio booking too; use its
    // persisted location rather than falling back to a client-supplied scope.
    guestIncreaseBookingIds: referencedWorkshopBookingIds,
    contexts: related,
  });
  const invoiceSettings = await ensureInvoiceSettings(String(tenantId));
  const lineItems = buildOrderLineSnapshots({
    sourceCartItems: cartItems,
    pricedCartItems: mappedCartItems,
    productById,
    currency,
    defaultTaxRateBps: invoiceSettings.defaultTaxRateBps,
    pricesIncludeTax: invoiceSettings.pricesIncludeTax,
    relatedLocationByBookingId,
  });

  return {
    lineItems,
    locationIds: collectOrderLocationIds(lineItems),
    grossAmountMinor: lineItems.reduce(
      (sum, line) => sum + line.grossAmountMinor,
      0,
    ),
  };
};

const applyMembershipCheckoutDiscount = async ({
  tenantId,
  userId,
  currency,
  orderInvoiceData,
  eligible,
  productById,
  orderId = undefined,
}) => {
  const membershipDiscount = eligible
    ? await resolveMembershipProductDiscount({
        tenantId: String(tenantId),
        userId: String(userId),
        orderLocationIds: orderInvoiceData.locationIds,
      })
    : null;
  const eligibleCourseBookingIds = new Set<string>(orderInvoiceData.lineItems
    .filter((line: any) => line.booking && resolveProductKindV2(productById?.get(String(line.product)) || {}) === "class")
    .map((line: any) => String(line.booking)));
  const unavailableCourseBookingIds = membershipDiscount?.memberOnly
    ? await unavailablePersonalCourseDiscounts({ tenantId: String(tenantId), userId: String(userId), bookingIds: [...eligibleCourseBookingIds], orderId: orderId ? String(orderId) : undefined })
    : new Set<string>();
  const discounted = applyMembershipDiscountToOrderLines({
    lineItems: orderInvoiceData.lineItems,
    discount: membershipDiscount,
    eligibleCourseBookingIds,
    unavailableCourseBookingIds,
  });

  return {
    personalCourseBookingIds: discounted.personalCourseBookingIds,
    orderInvoiceData: {
      ...orderInvoiceData,
      lineItems: discounted.lineItems,
      grossAmountMinor: discounted.totalAmountMinor,
    },
    appliedDiscount: buildMembershipDiscountSnapshot({
      discount: membershipDiscount,
      subtotalAmountMinor: discounted.subtotalAmountMinor,
      amountMinor: discounted.amountMinor,
      currency,
    }),
  };
};

const quoteAuthenticatedCartTotal = async ({
  tenantId,
  user,
  cartItems,
  currency,
  membershipDiscountEligible,
}) => {
  const dbProducts = await checkoutRepository.loadProductsByIds({
    tenantId,
    productIds: extractProductIdsOrThrow(cartItems),
  });
  const productById = makeProductMap(dbProducts);
  assertValidCartProducts({ cartItems, productById });
  const tenant = await getTenantOrThrow(String(tenantId));
  assertProductsEntitledForTenant({ tenant, products: dbProducts });
  const checkoutCurrency = resolveServerCheckoutCurrency({
    products: dbProducts,
    tenantCurrency: tenant.settings.currency,
    requestedCurrency: currency,
  });
  const orderInvoiceData = await buildOrderInvoiceData({
    tenantId,
    cartItems,
    mappedCartItems: buildServerPricedCartItems({ cartItems, productById }),
    productById,
    currency: checkoutCurrency,
    courseBookings: buildCourseBookings(cartItems),
    guestIncreaseBookings: buildGuestIncreaseBookings(cartItems),
  });
  const discounted = await applyMembershipCheckoutDiscount({
    tenantId,
    userId: user._id || user.id,
    currency: checkoutCurrency.toUpperCase() as StudioCommerceCurrency,
    orderInvoiceData,
    eligible: membershipDiscountEligible,
    productById,
  });
  return discounted.orderInvoiceData.grossAmountMinor;
};

export const checkoutService = {
  async quoteCart({ tenantId, user, cartItems, currency = undefined }) {
    cartItems = await normalizeExtensionCart({
      tenantId, userId: user._id || user.id, cartItems, paymentMethod: "credits",
    });
    // Near the end of a visit, immediate credit payment remains available even
    // when there is not enough time left to complete a card payment session.
    const cardAvailable = !cartItems.some((item) => item.bookingExtension &&
      new Date(item.bookingExtension.originalEnd).getTime() < Date.now() + 36 * 60_000);
    const dbProducts = await checkoutRepository.loadProductsByIds({
      tenantId, productIds: extractProductIdsOrThrow(cartItems),
    });
    const productById = makeProductMap(dbProducts);
    assertValidCartProducts({ cartItems, productById });
    const tenant = await getTenantOrThrow(String(tenantId));
    assertProductsEntitledForTenant({ tenant, products: dbProducts });
    const resolvedCurrency = resolveServerCheckoutCurrency({
      products: dbProducts, tenantCurrency: tenant.settings.currency, requestedCurrency: currency,
    }).toUpperCase() as StudioCommerceCurrency;
    const orderInvoiceData = await buildOrderInvoiceData({
      tenantId, cartItems, productById, currency: resolvedCurrency,
      mappedCartItems: buildServerPricedCartItems({ cartItems, productById }),
      courseBookings: buildCourseBookings(cartItems),
      guestIncreaseBookings: buildGuestIncreaseBookings(cartItems),
    });
    const discounted = await applyMembershipCheckoutDiscount({
      tenantId, userId: user._id || user.id, currency: resolvedCurrency,
      orderInvoiceData, productById,
      eligible: !cartItems.some((item) => item.bookingExtension),
    });
    const totalMinor = discounted.orderInvoiceData.grossAmountMinor;
    const availableMinor = resolveCreditBalanceMinor({
      moneyCreditsMinor: user.moneyCreditsMinor, moneyCredits: user.moneyCredits,
      currency: resolvedCurrency,
    });
    const membershipOptions = tenant.modules?.memberships
      ? await getCartMembershipPaymentOptions({
          tenantId: String(tenantId), userId: String(user._id || user.id),
          cartItems, productById, totalAmountMinor: totalMinor, currency: resolvedCurrency,
        })
      : [];
    return {
      quote: {
        currency: resolvedCurrency, subtotalMinor: orderInvoiceData.grossAmountMinor,
        discountMinor: orderInvoiceData.grossAmountMinor - totalMinor, totalMinor,
      },
      paymentOptions: [
        { method: "card", available: cardAvailable,
          ...(!cardAvailable ? { unavailableReason: "customer_booking_extension_card_window" } : {}) },
        ...(tenant.modules?.credits ? [{
          method: "money_credits", availableMinor,
          availableMajor: fromCurrencyMinorUnits(availableMinor, resolvedCurrency),
          coversTotal: availableMinor >= totalMinor,
        }] : []),
        ...membershipOptions,
      ],
    };
  },

  async quoteVoucherCheckout({
    tenantId,
    user,
    cartItems,
    voucherCode,
    currency = undefined,
    membershipDiscountEligible = true,
  }) {
    if (cartItems.some((item) => item.bookingExtension)) membershipDiscountEligible = false;
    const productIds = extractProductIdsOrThrow(cartItems);
    const dbProducts = await checkoutRepository.loadProductsByIds({
      tenantId,
      productIds,
    });
    const productById = makeProductMap(dbProducts);
    assertValidCartProducts({ cartItems, productById });
    if (
      dbProducts.some(
        (product) =>
          ![
            "course",
            "public-course",
            "private-course",
            "workshop",
            "public-workshop",
            "private-workshop",
          ].includes(product.type),
      )
    ) {
      badRequest({
        code: "VOUCHER_CHECKOUT_UNSUPPORTED",
        message: "Vouchers can fund studio and class bookings.",
      });
    }
    const tenant = await getTenantOrThrow(String(tenantId));
    assertProductsEntitledForTenant({ tenant, products: dbProducts });
    const resolvedCurrency = resolveServerCheckoutCurrency({
      products: dbProducts,
      tenantCurrency: tenant.settings.currency,
      requestedCurrency: currency,
    }).toUpperCase() as StudioCommerceCurrency;
    const mappedCartItems = buildServerPricedCartItems({
      cartItems,
      productById,
    });
    const courseBookings = buildCourseBookings(cartItems);
    const orderInvoiceData = await buildOrderInvoiceData({
      tenantId,
      cartItems,
      mappedCartItems,
      productById,
      currency: resolvedCurrency,
      courseBookings,
      guestIncreaseBookings: [],
    });
    const discounted = await applyMembershipCheckoutDiscount({
      tenantId,
      userId: user._id || user.id,
      currency: resolvedCurrency,
      orderInvoiceData,
      eligible: membershipDiscountEligible,
      productById,
    });
    try {
      const { allocations: _allocations, ...quote } =
        await getVoucherCheckoutPlan({
          tenantId: String(tenantId),
          voucherCode,
          lineItems: discounted.orderInvoiceData.lineItems,
          currency: resolvedCurrency,
        });
      if (
        quote.remainingToPayMinor > 0 &&
        !assertStripeMinimum(
          [
            {
              quantity: 1,
              price_data: { unit_amount: quote.remainingToPayMinor },
            },
          ],
          resolvedCurrency,
        ).ok
      ) {
        badRequest({
          code: "VOUCHER_CARD_MINIMUM",
          message:
            "The remaining card payment is below the payment provider minimum. Use card payment without this voucher or increase the booking total.",
        });
      }
      return quote;
    } catch (error) {
      return addOwnedVoucherPaymentContext(error, {
        tenantId: String(tenantId),
        userId: String(user._id || user.id),
        voucherCode,
      });
    }
  },
  async createStripeCheckout({
    tenantId,
    user,
    cartItems,
    originUrl,
    currency,
    creditsToApplyMajor = 0,
    locale = "en",
    successPath = "portal/success",
    cancelPath = "portal/cancel",
    membershipDiscountEligible = false,
    idempotencyKey = "",
    checkoutOperation = null,
    waitlistOfferToken = "",
    waitlistEntryId = "",
    voucherCode = "",
    expectedVoucherQuote = undefined as VoucherQuoteExpectation | undefined,
    guestCheckout = undefined as GuestCheckoutContext | undefined,
  }) {
    voucherCode = normalizeCheckoutVoucherCode(voucherCode);
    if (voucherCode && (waitlistOfferToken || waitlistEntryId))
      badRequest({
        code: "VOUCHER_CHECKOUT_UNSUPPORTED",
        message: "Voucher payment is unavailable for waitlist offers.",
      });
    const requestedMixedCredits = Number(creditsToApplyMajor);

    if (
      !Number.isFinite(requestedMixedCredits) ||
      requestedMixedCredits !== 0
    ) {
      badRequest({
        message:
          "Combining account credits with a card payment is not supported. Use either card checkout or credits checkout.",
        code: "PARTIAL_CREDIT_CARD_PAYMENT_UNSUPPORTED",
      });
    }

    if (!checkoutOperation) {
      const acquisition = await acquireCheckoutOperation({
        tenantId: String(tenantId),
        userId: String(user._id || user.id),
        kind: "card",
        idempotencyKey,
        request: {
          cartItems,
          originUrl,
          currency,
          creditsToApplyMajor,
          locale,
          successPath,
          cancelPath,
          // Preserve the fingerprint of existing waitlist payment attempts.
          // The saved Order owns their price; enabling the benefit for new
          // offers must not invalidate an already-created checkout operation.
          membershipDiscountEligible:
            waitlistOfferToken || waitlistEntryId
              ? false
              : membershipDiscountEligible,
          waitlistOfferTokenHash: waitlistOfferToken
            ? createHash("sha256").update(waitlistOfferToken).digest("hex")
            : "",
          waitlistEntryId,
          voucherCode,
          expectedVoucherQuote,
          guestCheckout,
        },
      });

      if (acquisition.type === "replay") return acquisition.response;

      try {
        const result = await checkoutService.createStripeCheckout({
          tenantId,
          user,
          cartItems,
          originUrl,
          currency,
          creditsToApplyMajor,
          locale,
          successPath,
          cancelPath,
          membershipDiscountEligible,
          idempotencyKey,
          checkoutOperation: acquisition.lease,
          waitlistOfferToken,
          waitlistEntryId,
          voucherCode,
          expectedVoucherQuote,
          guestCheckout,
        });
        if (result.status !== "confirmed")
          await completeCheckoutOperation(acquisition.lease, result);
        return result;
      } catch (error) {
        await releaseCheckoutOperation(acquisition.lease);
        throw error;
      }
    }

    const checkoutUserId = user._id || user.id;
    const persistedCardCheckout =
      await checkoutRepository.findCardCheckoutRecovery({
        tenantId,
        orderId: checkoutOperation.orderId,
        userId: checkoutUserId,
      });
    if (!persistedCardCheckout) cartItems = await normalizeExtensionCart({ tenantId, userId: user._id || user.id, cartItems, paymentMethod: "card" });
    if (
      !persistedCardCheckout &&
      !guestCheckout &&
      !waitlistOfferToken &&
      !waitlistEntryId &&
      !voucherCode &&
      (await quoteAuthenticatedCartTotal({
        tenantId,
        user,
        cartItems,
        currency,
        membershipDiscountEligible,
      })) === 0
    ) {
      // Keep the original card operation and its stable order/cart ids. The
      // free fulfillment commits that operation with the order atomically.
      // Reprice again there, and never debit credits if a price has changed.
      return checkoutService.checkoutWithCredits({
        tenantId,
        user,
        cartItems,
        originUrl,
        membershipDiscountEligible,
        idempotencyKey,
        locale,
        checkoutOperation,
        requireZeroTotal: true,
      });
    }
    if (voucherCode && !persistedCardCheckout) {
      const quote = await checkoutService.quoteVoucherCheckout({
        tenantId,
        user,
        cartItems,
        voucherCode,
        currency,
        membershipDiscountEligible,
      });
      assertExpectedVoucherQuote(expectedVoucherQuote, quote);
      if (quote.remainingToPayMinor === 0)
        return checkoutService.checkoutWithCredits({
          tenantId,
          user,
          cartItems,
          originUrl,
          paymentSource: "voucher",
          voucherCode,
          expectedVoucherQuote,
          membershipDiscountEligible,
          idempotencyKey,
          locale,
          checkoutOperation,
          guestCheckout,
        });
    }
    const stripe = getTenantPaymentStripe();
    const persistedConnectedAccountId = String(
      persistedCardCheckout?.stripe?.connectedAccountId || "",
    ).trim();
    const hasAttachedCardSession = Boolean(
      String(persistedCardCheckout?.stripe?.sessionId || "").trim(),
    );
    const recoveredCardCheckout = hasAttachedCardSession
      ? await recoverAttachedCardCheckout({
          tenantId: String(tenantId),
          connectedAccountId: persistedConnectedAccountId,
          order: persistedCardCheckout,
          retrieveSession: (sessionId) =>
            stripe.checkout.sessions.retrieve(
              sessionId,
              getConnectedAccountRequestOptions(persistedConnectedAccountId),
            ),
        })
      : null;

    if (recoveredCardCheckout) return recoveredCardCheckout;
    if (
      persistedCardCheckout?.voucherRedemptions?.length &&
      !hasAttachedCardSession
    ) {
      if (
        persistedCardCheckout.isPaid ||
        persistedCardCheckout.status !== "pending_order" ||
        !persistedCardCheckout.voucherStripeRequest ||
        Date.now() - new Date(persistedCardCheckout.createdAt).getTime() >
          23 * 60 * 60 * 1000
      ) {
        badRequest({
          code: "VOUCHER_PAYMENT_REVIEW_REQUIRED",
          message: "This voucher payment needs review before retrying.",
        });
      }
      // Recover an ambiguous create response with exactly the original payload
      // and idempotency key. Never free value while that payment may settle.
      const recovered = await recoverVoucherStripeSession(
        String(tenantId),
        persistedCardCheckout,
      );
      if (
        recovered.status === "expired" &&
        recovered.payment_status !== "paid"
      ) {
        await checkoutRepository.releaseExpiredStripeOrder({
          tenantId,
          orderId: persistedCardCheckout._id,
          sessionId: recovered.id,
          connectedAccountId: persistedConnectedAccountId,
        });
        badRequest({
          code: "VOUCHER_CHECKOUT_EXPIRED",
          message: "This checkout expired. Start a new payment attempt.",
        });
      }
      if (!recovered.url || recovered.status !== "open")
        badRequest({
          code: "VOUCHER_PAYMENT_PROCESSING",
          message: "Payment is being processed. Check your order status.",
        });
      return {
        url: recovered.url,
        orderId: persistedCardCheckout._id,
        sessionId: recovered.id,
        appliedDiscount: persistedCardCheckout.appliedDiscount,
      };
    }

    const isRecoverableWaitlistOrder = Boolean(
      persistedCardCheckout?.waitlist?.entryId,
    );
    if (!isRecoverableWaitlistOrder) {
      assertNoUnattachedCardOrder(persistedCardCheckout);
    }

    // Fail before reserving bookings or persisting an order. Tenant commerce
    // is a direct charge and must never fall back to Shario's platform account.
    const connectedAccount = await requireReadyTenantConnectedAccount(
      String(tenantId),
    );
    const connectedAccountOptions = getConnectedAccountRequestOptions(
      connectedAccount.stripeAccountId,
    );

    await checkoutRepository.deleteProcessingRecords({
      tenantId,
      userId: user._id,
      preserveOrderId: checkoutOperation.orderId,
    });

    await checkoutRepository.deleteProcessingMetadata({
      tenantId,
      userId: user._id,
    });

    const orderId = checkoutOperation.orderId;
    let waitlistContext: WaitlistCheckoutContext | null = null;
    if (waitlistOfferToken || waitlistEntryId) {
      waitlistContext = await resolveWaitlistCheckoutContext({
        tenantId: String(tenantId),
        orderId: String(orderId),
        cartItems,
        entryId: waitlistEntryId || undefined,
        offerToken: waitlistOfferToken || undefined,
        customerId: String(user._id || user.id),
        email: String(user.email || ""),
      });
      cartItems = waitlistContext.cartItems;
    }

    if (cartItems.some((item) => item.bookingExtension)) membershipDiscountEligible = false;
    const productIds = extractProductIdsOrThrow(cartItems);

    const loadedProducts = await checkoutRepository.loadProductsByIds({
      tenantId,
      productIds,
    });

    const dbProducts = waitlistContext
      ? applyWaitlistPriceSnapshot({
          products: loadedProducts,
          context: waitlistContext,
        })
      : loadedProducts;

    const productById = makeProductMap(dbProducts);

    if (waitlistContext) {
      // The saved offer owns the product identity. Its legacy "course" marker
      // must not conflict with a current public-course/class catalog type.
      cartItems = cartItems.map((item) => ({
        ...item,
        product: productById.get(String(item.product?._id)),
      }));
    }

    assertValidCartProducts({
      cartItems,
      productById,
    });

    const tenant = await getTenantOrThrow(String(tenantId));
    assertProductsEntitledForTenant({ tenant, products: dbProducts });
    const checkoutCurrency = resolveServerCheckoutCurrency({
      products: dbProducts,
      tenantCurrency: tenant.settings.currency,
      requestedCurrency: currency,
    });

    const { locationIds, locationById } = await loadCheckoutLocations({
      tenantId,
      cartItems,
    });

    const savedWaitlistExpiry =
      persistedCardCheckout?.waitlist?.stripeSessionExpiresAt;
    const baseCheckoutExpiry = getStripeCheckoutExpiryWindow(
      savedWaitlistExpiry
        ? new Date(savedWaitlistExpiry).getTime() -
            STRIPE_CHECKOUT_SESSION_MINUTES * 60_000
        : Date.now(),
    );
    // offerExpiresAt is the deadline to start checkout. Once the offer is
    // atomically transferred, Stripe receives its normal payment window;
    // loadCourseBookings still rejects a session that starts before that
    // payment window can complete safely.
    const checkoutExpiry = baseCheckoutExpiry;

    const currentBookings = await checkoutRepository.findCurrentBookings({
      tenantId,
      locationIds,
    });

    const workshopBookingsToCreate = buildWorkshopBookingsToCreate({
      cartItems,
      productById,
      user,
      orderId,
      paymentMode: "stripe",
      paymentExpiresAt: checkoutExpiry.workshopReservationExpiresAt,
    }).map((booking, index) => ({
      ...booking,
      _id: deterministicCheckoutObjectId(
        checkoutOperation.operationId,
        "workshop-booking",
        index,
      ),
    }));

    validateWorkshopAvailabilityOrThrow({
      workshopBookings: workshopBookingsToCreate,
      currentBookings,
      locationById,
    });

    const courseCapacityReservations = await loadCourseBookings({
      tenantId,
      cartItems,
      productById,
      mustStartAfter: checkoutExpiry.sessionExpiresAt,
    });
    const courseBookings = courseCapacityReservations.map(
      ({ bookingId, quantity }) => ({
        bookingId,
        quantity,
        capacityReserved: true,
      }),
    );
    const guestIncreaseReservations = await loadGuestIncreaseBookings({
      tenantId,
      cartItems,
      user,
      orderId,
    });
    const guestIncreaseBookings = guestIncreaseReservations.map(
      ({ bookingId, addGuests }) => ({
        bookingId,
        addGuests,
        capacityReserved: true,
      }),
    );

    const mappedCartItems = buildServerPricedCartItems({
      cartItems,
      productById,
    });

    let orderInvoiceData = await buildOrderInvoiceData({
      tenantId,
      cartItems,
      mappedCartItems,
      productById,
      currency: checkoutCurrency,
      courseBookings,
      guestIncreaseBookings,
    });
    const discountedCheckout = isRecoverableWaitlistOrder
      ? {
          // A persisted payment attempt is immutable, including its membership
          // decision. Renewal, expiry or another purchase cannot reprice a retry.
          orderInvoiceData: {
            ...orderInvoiceData,
            lineItems: persistedCardCheckout.lineItems,
            grossAmountMinor: persistedCardCheckout.grossAmountMinor,
          },
          appliedDiscount: persistedCardCheckout.appliedDiscount,
          personalCourseBookingIds: [] as string[],
        }
      : await applyMembershipCheckoutDiscount({
          tenantId,
          userId: user._id,
          currency: checkoutCurrency.toUpperCase() as StudioCommerceCurrency,
          orderInvoiceData,
          // The waitlist snapshot preserves the captured base price; the
          // member's current course benefit applies only to their own seat.
          eligible: membershipDiscountEligible,
          productById,
          orderId,
        });
    orderInvoiceData = discountedCheckout.orderInvoiceData;
    const appliedDiscount = discountedCheckout.appliedDiscount;
    const voucherPlan = voucherCode
      ? await getVoucherCheckoutPlan({
          tenantId: String(tenantId),
          voucherCode,
          lineItems: orderInvoiceData.lineItems,
          currency: checkoutCurrency.toUpperCase() as StudioCommerceCurrency,
          orderId: String(orderId),
        })
      : null;
    if (voucherPlan)
      assertExpectedVoucherQuote(expectedVoucherQuote, voucherPlan);
    // Cart stores the captured base-price lines. Its schema recomputes this
    // sum on save; discounts belong to the immutable Order invoice snapshot.
    const cartTotalMajor = mappedCartItems.reduce(
      (sum, item) => sum + Number(item.totalPrice || 0),
      0,
    );

    const hasAnyWork =
      workshopBookingsToCreate.length > 0 ||
      courseBookings.length > 0 ||
      guestIncreaseBookings.length > 0 ||
      hasStandaloneServiceItems(cartItems);

    if (!hasAnyWork) {
      badRequest("Nothing to checkout.");
    }

    let stripePayload = buildStripeLineItems({
      cartItems,
      productById,
      currency: checkoutCurrency,
    });

    stripePayload = applyOrderLinePricesToStripePayload({
      stripePayload,
      orderLineItems: orderInvoiceData.lineItems,
    });

    if (!stripePayload.lineItems.length) {
      badRequest("Stripe line items are empty.");
    }

    if (!stripePayload.minCheck.ok) {
      badRequest("Stripe minimum amount not reached.");
    }

    if (orderInvoiceData.grossAmountMinor !== stripePayload.totalMinor) {
      badRequest({
        message: "Invoice snapshot does not match the Stripe checkout total.",
        code: "ORDER_INVOICE_TOTAL_MISMATCH",
      });
    }

    const expectedAmountMinor =
      stripePayload.totalMinor - (voucherPlan?.voucherAppliedMinor ?? 0);
    if (voucherPlan) {
      // A voucher is tender. Keep the full invoice/tax snapshot and send only
      // the card-funded remainder to Stripe, with no Stripe coupon involved.
      stripePayload = {
        ...stripePayload,
        totalMinor: expectedAmountMinor,
        lineItems: [
          {
            price_data: {
              currency: stripePayload.currency,
              unit_amount: expectedAmountMinor,
              product_data: { name: "Booking — remaining payment" },
            },
            quantity: 1,
          },
        ],
      };
    }

    assertStripePayableAmountAfterCredits({
      expectedAmountMinor,
      appliedCreditsMinor: 0,
      minimumAmountMinor: stripePayload.minCheck.minMinor,
      currency: stripePayload.currency.toUpperCase(),
    });

    if (!waitlistContext) {
      await checkoutRepository.reserveCourseCapacity({
        tenantId,
        orderId,
        reservations: courseCapacityReservations,
        expiresAt: checkoutExpiry.courseReservationExpiresAt,
        minimumStart: checkoutExpiry.sessionExpiresAt,
      });
    }

    try {
      await checkoutRepository.reserveGuestIncreaseCapacity({
        tenantId,
        userId: user._id,
        orderId,
        reservations: guestIncreaseReservations,
        expiresAt: checkoutExpiry.courseReservationExpiresAt,
      });
    } catch (error) {
      await checkoutRepository.releaseCourseCapacity({
        tenantId,
        orderId,
        bookingIds: courseBookings.map((course) => course.bookingId),
      });
      throw error;
    }

    let workshopBookingIds: any[] = [];

    try {
      if (workshopBookingsToCreate.length > 0) {
        const createdBookings = await checkoutRepository.createBookings({
          tenantId,
          payloads: workshopBookingsToCreate,
          atomicCapacity: true,
        });

        workshopBookingIds = createdBookings.map((booking) => booking._id);
        orderInvoiceData = {
          ...orderInvoiceData,
          lineItems: attachWorkshopBookingsToOrderLines({
            sourceCartItems: cartItems,
            lineItems: orderInvoiceData.lineItems,
            bookingIds: workshopBookingIds,
          }),
        };
      }

      const cartPayload = {
        _id: checkoutOperation.cartId,
        user: user._id,
        cartItems: mappedCartItems,
        currency: stripePayload.currency.toUpperCase(),
        totalPrice: cartTotalMajor,
        expectedAmountMinor,
      };
      const buildOrderPayload = (cartRecord: any): any => ({
        _id: orderId,
        cart: cartRecord._id || cartRecord,
        createdBy: user._id,
        ...(guestCheckout ? { guestCourseCheckout: guestCheckout.orderSnapshot } : {}),
        customer: {
          firstname: user.firstname,
          lastname: user.lastname,
          customId: user.customId,
          memberNumber: user.memberNumber ?? undefined,
          email: user.email,
          phone: user.phone || "",
        },
        status: "pending_order",
        currency: stripePayload.currency.toUpperCase(),
        grossAmountMinor: orderInvoiceData.grossAmountMinor,
        expectedAmountMinor,
        paidAmountMinor: null,
        isPaid: false,
        locationIds: orderInvoiceData.locationIds,
        lineItems: orderInvoiceData.lineItems.map(({ sourceLineIndex: _index, ...line }: any) => line),
        paymentAllocations: voucherPlan
          ? [
              {
                method: "voucher",
                amountMinor: voucherPlan.voucherAppliedMinor,
                providerReference: String(voucherPlan.allocations[0].couponId),
              },
            ]
          : [],
        voucherRedemptions: voucherPlan?.allocations ?? [],
        appliedDiscount,
        appliedCoupons: [],
        ...(cartItems[0]?.bookingExtension ? { bookingExtension: { bookingId: cartItems[0].bookingExtension.bookingId, originalEnd: cartItems[0].start, end: cartItems[0].end, amountMinor: cartItems[0].bookingExtension.amountMinor } } : {}),
        workshopBookings: workshopBookingIds,
        courseBookings,
        guestIncreaseBookings,
        credits: {
          appliedMajor: 0,
          requestedMajor: 0,
          currency: stripePayload.currency.toUpperCase(),
          couponId: null,
        },
        stripe: {
          connectedAccountId: connectedAccount.stripeAccountId,
          livemode: null,
          sessionId: "",
          processedEventIds: [],
        },
        waitlist: waitlistContext
          ? {
              entryId: new mongoose.Types.ObjectId(waitlistContext.entryId),
              offerGeneration: waitlistContext.offerGeneration,
              priceVersion: waitlistContext.price.version,
              ...(!isRecoverableWaitlistOrder || savedWaitlistExpiry
                ? { stripeSessionExpiresAt: checkoutExpiry.sessionExpiresAt }
                : {}),
            }
          : undefined,
      });

      let cartRecord: any;
      let orderPayload: ReturnType<typeof buildOrderPayload>;
      let persistedWaitlistOrder: any = null;

      if (waitlistContext) {
        if (isRecoverableWaitlistOrder) {
          cartRecord = await checkoutRepository.findCardCartRecovery({
            tenantId,
            cartId: persistedCardCheckout.cart,
            userId: checkoutUserId,
          });
          assertPersistedCardCartSnapshot(cartRecord, cartPayload);
          orderPayload = buildOrderPayload(cartRecord);
          assertPersistedCardOrderSnapshot(persistedCardCheckout, orderPayload);
          persistedWaitlistOrder = persistedCardCheckout;

          // The original transaction already committed Cart+Order+reservation.
          // Revalidate the exact pending reservation instead of attempting a
          // duplicate insert, which would abort a new MongoDB transaction.
          await transferWaitlistHoldToOrder({
            tenantId: String(tenantId),
            context: waitlistContext,
            reservationExpiresAt: checkoutExpiry.courseReservationExpiresAt,
            paymentExpiresAt: checkoutExpiry.sessionExpiresAt,
          });
        } else {
          const mongoSession = await mongoose.startSession();
          try {
            await mongoSession.withTransaction(async () => {
              await reservePersonalCourseDiscounts({
                tenantId: String(tenantId),
                userId: String(user._id || user.id),
                orderId: String(orderId),
                bookingIds: discountedCheckout.personalCourseBookingIds,
                session: mongoSession,
              });
              cartRecord = await checkoutRepository.createCart({
                tenantId,
                payload: cartPayload,
                session: mongoSession,
              });
              assertPersistedCardCartSnapshot(cartRecord, cartPayload);
              orderPayload = buildOrderPayload(cartRecord);
              persistedWaitlistOrder = await checkoutRepository.createOrder({
                tenantId,
                payload: orderPayload,
                session: mongoSession,
              });
              assertPersistedCardOrderSnapshot(
                persistedWaitlistOrder,
                orderPayload,
              );
              await transferWaitlistHoldToOrder({
                tenantId: String(tenantId),
                context: waitlistContext,
                reservationExpiresAt: checkoutExpiry.courseReservationExpiresAt,
                paymentExpiresAt: checkoutExpiry.sessionExpiresAt,
                mongoSession,
              });
            });
          } finally {
            await mongoSession.endSession();
          }
        }
      } else {
        cartRecord = await checkoutRepository.createCart({
          tenantId,
          payload: cartPayload,
        });
        assertPersistedCardCartSnapshot(cartRecord, cartPayload);
        orderPayload = buildOrderPayload(cartRecord);
      }

      /*
       * Waitlist Cart+Order+hold transfer committed as one MongoDB unit above.
       * Other card flows persist the Order here before creating Stripe.
       */

      const stripeSessionPayload = {
        line_items: stripePayload.lineItems,
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: user.email,
        // Explicitly request the buyer's receipt on the connected-account
        // payment; customer_email alone only prefills Checkout and leaves
        // delivery dependent on the tenant's Stripe email settings.
        payment_intent_data: { receipt_email: user.email },
        success_url: guestCheckout?.successUrl || buildTenantCommerceUrl({
          origin: originUrl,
          locale: normalizeCommerceLocale(locale),
          path: successPath,
          query: { orderId: String(orderId) },
        }),
        cancel_url: guestCheckout?.cancelUrl || buildTenantCommerceUrl({
          origin: originUrl,
          locale: normalizeCommerceLocale(locale),
          path: cancelPath,
          ...(voucherPlan
            ? { query: { orderId: String(orderId), voucher: "1" } }
            : {}),
        }),
        expires_at: checkoutExpiry.sessionExpiresAtSeconds,
        client_reference_id: String(orderId),
        metadata: {
          sharioManaged: "true",
          sharioFlow: "order",
          tenantId: String(tenantId),
          orderId: String(orderId),
          currency: stripePayload.currency,
          expectedAmountMinor: String(expectedAmountMinor),
          creditsAppliedMajor: "0",
          discountSource: appliedDiscount?.source ?? "none",
          discountAmountMinor: String(appliedDiscount?.amountMinor ?? 0),
          ...(waitlistContext
            ? {
                waitlistEntryId: waitlistContext.entryId,
                waitlistOfferGeneration: String(
                  waitlistContext.offerGeneration,
                ),
                waitlistPriceVersion: waitlistContext.price.version,
              }
            : {}),
        },
      } satisfies Stripe.Checkout.SessionCreateParams;

      let persistedVoucherOrder: any = null;
      if (voucherPlan) {
        orderPayload.voucherStripeRequest = snapshotVoucherStripeRequest(stripeSessionPayload, Boolean(guestCheckout));
        await mongoose.connection.transaction(async (mongoSession) => {
          await reservePersonalCourseDiscounts({ tenantId: String(tenantId), userId: String(user._id || user.id), orderId: String(orderId), bookingIds: discountedCheckout.personalCourseBookingIds, session: mongoSession });
          await reserveCheckoutVouchers({
            tenantId: String(tenantId),
            userId: String(user._id || user.id),
            orderId: String(orderId),
            currency: checkoutCurrency.toUpperCase() as StudioCommerceCurrency,
            allocations: voucherPlan.allocations,
            reviewAfter: checkoutExpiry.sessionExpiresAt,
            session: mongoSession,
          });
          persistedVoucherOrder = await checkoutRepository.createOrder({
            tenantId,
            payload: orderPayload,
            session: mongoSession,
          });
          assertPersistedCardOrderSnapshot(persistedVoucherOrder, orderPayload);
        });
      }
      const session =
        await createDurableStripeCheckoutSession<Stripe.Checkout.Session>({
          persistOrder: async () => {
            if (persistedVoucherOrder || persistedWaitlistOrder) return persistedVoucherOrder || persistedWaitlistOrder;
            if (!discountedCheckout.personalCourseBookingIds.length) return checkoutRepository.createOrder({ tenantId, payload: orderPayload });
            return mongoose.connection.transaction(async (mongoSession) => {
              await reservePersonalCourseDiscounts({ tenantId: String(tenantId), userId: String(user._id || user.id), orderId: String(orderId), bookingIds: discountedCheckout.personalCourseBookingIds, session: mongoSession });
              return checkoutRepository.createOrder({ tenantId, payload: orderPayload, session: mongoSession });
            });
          },
          validatePersistedOrder: (persistedOrder) =>
            assertPersistedCardOrderSnapshot(persistedOrder, orderPayload),
          createSession: () =>
            stripe.checkout.sessions.create(
              stripeSessionPayload,
              getConnectedAccountRequestOptions(
                connectedAccount.stripeAccountId,
                { idempotencyKey: `checkout-session:${String(orderId)}` },
              ),
            ),
          validateSession: (createdSession) =>
            assertStripeCheckoutSessionIsAttachable(createdSession),
          attach: (createdSession) =>
            checkoutRepository.attachStripeSession({
              tenantId,
              orderId,
              sessionId: createdSession.id,
              amountMinor: expectedAmountMinor,
              currency: stripePayload.currency,
              connectedAccountId: connectedAccount.stripeAccountId,
              livemode: createdSession.livemode,
            }),
          expire: (sessionId) =>
            stripe.checkout.sessions.expire(sessionId, connectedAccountOptions),
        });

      if (waitlistContext) {
        await attachWaitlistStripeSession({
          tenantId: String(tenantId),
          orderId: String(orderId),
          stripeSessionId: session.id,
          paymentExpiresAt: new Date(session.expires_at * 1000),
        });
      }

      return {
        url: session.url,
        ...(voucherPlan ? { status: "requires_payment" } : {}),
        orderId,
        sessionId: session.id,
        appliedDiscount,
      };
    } catch (error) {
      let attachedOrder;

      try {
        attachedOrder = await checkoutRepository.findCardCheckoutRecovery({
          tenantId,
          orderId,
          userId: checkoutUserId,
        });
      } catch (attachmentInspectionError) {
        throw new AggregateError(
          [error, attachmentInspectionError],
          "Checkout failed and its Stripe attachment state could not be verified; cleanup was skipped.",
        );
      }

      if (
        String(attachedOrder?.stripe?.sessionId || "").trim() ||
        attachedOrder?.voucherRedemptions?.length
      ) {
        throw error;
      }

      const cleanupErrors: unknown[] = [];

      try {
        await checkoutRepository.releaseCourseCapacity({
          tenantId,
          orderId,
          bookingIds: [
            ...courseBookings.map((course) => course.bookingId),
            ...guestIncreaseBookings.map((increase) => increase.bookingId),
          ],
        });
      } catch (releaseError) {
        cleanupErrors.push(releaseError);
      }

      if (waitlistContext) {
        try {
          await restoreWaitlistHoldAfterCheckoutFailure({
            tenantId: String(tenantId),
            context: waitlistContext,
          });
        } catch (waitlistRestoreError) {
          cleanupErrors.push(waitlistRestoreError);
        }
      }

      try {
        await checkoutRepository.deleteCheckoutBookings({
          tenantId,
          orderId,
          bookingIds: workshopBookingIds,
        });
      } catch (bookingCleanupError) {
        cleanupErrors.push(bookingCleanupError);
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Checkout failed and its capacity reservations could not be fully released.",
        );
      }

      throw error;
    }
  },

  async checkoutWithCredits({
    tenantId,
    user,
    cartItems,
    originUrl,
    paymentSource = "money_credits",
    membershipBenefitKey = undefined,
    membershipQuantity = undefined,
    idempotencyKey = "",
    locale = "en",
    checkoutOperation = null,
    voucherCode = "",
    expectedVoucherQuote = undefined as VoucherQuoteExpectation | undefined,
    membershipDiscountEligible = true,
    requireZeroTotal = false,
    guestCheckout = undefined as GuestCheckoutContext | undefined,
  }) {
    if (!checkoutOperation) {
      const acquisition = await acquireCheckoutOperation({
        tenantId: String(tenantId),
        userId: String(user._id || user.id),
        kind: "credits",
        idempotencyKey,
        request: {
          cartItems,
          originUrl,
          paymentSource,
          membershipBenefitKey,
          membershipQuantity,
          voucherCode,
          expectedVoucherQuote,
          membershipDiscountEligible,
          ...(requireZeroTotal ? { requireZeroTotal: true } : {}),
          guestCheckout,
          locale,
        },
      });

      if (acquisition.type === "replay") return acquisition.response;

      try {
        return await checkoutService.checkoutWithCredits({
          tenantId,
          user,
          cartItems,
          originUrl,
          paymentSource,
          membershipBenefitKey,
          membershipQuantity,
          voucherCode,
          expectedVoucherQuote,
          membershipDiscountEligible,
          requireZeroTotal,
          idempotencyKey,
          locale,
          checkoutOperation: acquisition.lease,
          guestCheckout,
        });
      } catch (error) {
        await releaseCheckoutOperation(acquisition.lease);
        throw error;
      }
    }

    const isMoneyCredits = paymentSource === "money_credits";
    const isMembershipCredits = paymentSource === "membership_credits";
    const isVoucher = paymentSource === "voucher";

    if (!isMoneyCredits && !isMembershipCredits && !isVoucher) {
      badRequest({
        message: "The selected credit payment method is unsupported.",
        code: "CHECKOUT_CREDIT_METHOD_UNSUPPORTED",
      });
    }

    if (
      isMembershipCredits &&
      (typeof membershipBenefitKey !== "string" ||
        !membershipBenefitKey.trim())
    ) {
      badRequest({
        message: "A valid membership allowance is required.",
        code: "MEMBERSHIP_ENTITLEMENT_INVALID",
      });
    }

    cartItems = await normalizeExtensionCart({ tenantId, userId: user._id || user.id, cartItems, paymentMethod: "credits" });
    if (cartItems.some((item) => item.bookingExtension) && paymentSource !== "money_credits") badRequest({ code: "CUSTOMER_BOOKING_EXTENSION_PAYMENT_UNSUPPORTED", message: "Use account credits or card for an extension." });
    if (cartItems.some((item) => item.bookingExtension)) membershipDiscountEligible = false;
    const productIds = extractProductIdsOrThrow(cartItems);

    const dbProducts = await checkoutRepository.loadProductsByIds({
      tenantId,
      productIds,
    });

    const productById = makeProductMap(dbProducts);

    assertValidCartProducts({
      cartItems,
      productById,
    });

    const tenant = await getTenantOrThrow(String(tenantId));
    assertProductsEntitledForTenant({ tenant, products: dbProducts });
    const checkoutCurrency = resolveServerCheckoutCurrency({
      products: dbProducts,
      tenantCurrency: tenant.settings.currency,
    });

    const checkoutCurrencyUpper =
      checkoutCurrency.toUpperCase() as StudioCommerceCurrency;

    const { locationIds, locationById } = await loadCheckoutLocations({
      tenantId,
      cartItems,
    });

    const orderId = checkoutOperation.orderId;
    const paidAt = new Date();

    const currentBookings = await checkoutRepository.findCurrentBookings({
      tenantId,
      locationIds,
    });

    const workshopBookingsToCreate = buildWorkshopBookingsToCreate({
      cartItems,
      productById,
      user,
      orderId,
      paymentMode: "credits",
    }).map((booking, index) => ({
      ...booking,
      _id: deterministicCheckoutObjectId(
        checkoutOperation.operationId,
        "workshop-booking",
        index,
      ),
    }));

    validateWorkshopAvailabilityOrThrow({
      workshopBookings: workshopBookingsToCreate,
      currentBookings,
      locationById,
    });

    const courseCapacityReservations = await loadCourseBookings({
      tenantId,
      cartItems,
      productById,
      mustStartAfter: new Date(),
    });
    const courseBookings = courseCapacityReservations.map(
      ({ bookingId, quantity }) => ({
        bookingId,
        quantity,
        capacityReserved: true,
      }),
    );
    const guestIncreaseReservations = await loadGuestIncreaseBookings({
      tenantId,
      cartItems,
      user,
      orderId,
    });
    const guestIncreaseBookings = guestIncreaseReservations.map(
      ({ bookingId, addGuests }) => ({
        bookingId,
        addGuests,
        capacityReserved: true,
      }),
    );

    const hasAnyWork =
      workshopBookingsToCreate.length > 0 ||
      courseBookings.length > 0 ||
      guestIncreaseBookings.length > 0 ||
      hasStandaloneServiceItems(cartItems);

    if (!hasAnyWork) {
      badRequest("Nothing to checkout.");
    }

    const mappedCartItems = buildServerPricedCartItems({
      cartItems,
      productById,
    });

    let orderInvoiceData = await buildOrderInvoiceData({
      tenantId,
      cartItems,
      mappedCartItems,
      productById,
      currency: checkoutCurrencyUpper,
      courseBookings,
      guestIncreaseBookings,
    });
    const discountedCheckout = await applyMembershipCheckoutDiscount({
      tenantId,
      userId: user._id,
      currency: checkoutCurrencyUpper,
      orderInvoiceData,
      eligible: membershipDiscountEligible,
      productById,
      orderId,
    });
    orderInvoiceData = discountedCheckout.orderInvoiceData;
    const appliedDiscount = discountedCheckout.appliedDiscount;
    const membershipAllowance = isMembershipCredits
      ? await resolveCheckoutMembershipAllowance({ tenantId: String(tenantId), userId: String(user._id || user.id), benefitKey: membershipBenefitKey!.trim(), cartItems, productById, totalAmountMinor: orderInvoiceData.grossAmountMinor, currency: checkoutCurrencyUpper })
      : null;
    if (requireZeroTotal && orderInvoiceData.grossAmountMinor !== 0) {
      badRequest({
        code: "CHECKOUT_PRICE_CHANGED",
        message: "The checkout price changed. Review your cart and try again.",
      });
    }
    const totalToChargeMajor = fromCurrencyMinorUnits(
      orderInvoiceData.grossAmountMinor,
      checkoutCurrencyUpper,
    );

    const availableCreditsMinor = resolveCreditBalanceMinor({
      moneyCreditsMinor: user.moneyCreditsMinor,
      moneyCredits: user.moneyCredits,
      currency: checkoutCurrencyUpper,
    });
    const availableCredits = fromCurrencyMinorUnits(
      availableCreditsMinor,
      checkoutCurrencyUpper,
    );

    if (
      isMoneyCredits &&
      orderInvoiceData.grossAmountMinor > 0 &&
      availableCreditsMinor < orderInvoiceData.grossAmountMinor
    ) {
      badRequest(
        `Insufficient credits. You need ${totalToChargeMajor} ${checkoutCurrencyUpper} but only have ${availableCredits} ${checkoutCurrencyUpper}.`,
      );
    }

    const baseOrderInvoiceData = orderInvoiceData;
    const session = await mongoose.startSession();
    let response: any;
    let notificationOrder: any = null;

    try {
      await session.withTransaction(async () => {
        await reservePersonalCourseDiscounts({ tenantId: String(tenantId), userId: String(user._id || user.id), orderId: String(orderId), bookingIds: discountedCheckout.personalCourseBookingIds, session });
        let transactionOrderInvoiceData = baseOrderInvoiceData;
        let membershipRedemption: any = null;
        let updatedUser: any = user;
        const voucherPlan = isVoucher
          ? await getVoucherCheckoutPlan({
              tenantId: String(tenantId),
              voucherCode,
              lineItems: transactionOrderInvoiceData.lineItems,
              currency: checkoutCurrencyUpper,
              orderId: String(orderId),
              session,
            })
          : null;
        if (voucherPlan)
          assertExpectedVoucherQuote(expectedVoucherQuote, voucherPlan);
        if (voucherPlan && voucherPlan.remainingToPayMinor !== 0)
          badRequest({
            code: "VOUCHER_BALANCE_CHANGED",
            message: "Voucher balance changed. Check the payment amount again.",
          });
        if (voucherPlan)
          await reserveCheckoutVouchers({
            tenantId: String(tenantId),
            userId: String(user._id || user.id),
            orderId: String(orderId),
            currency: checkoutCurrencyUpper,
            allocations: voucherPlan.allocations,
            session,
          });

        await checkoutRepository.reserveCourseCapacity({
          tenantId,
          orderId,
          reservations: courseCapacityReservations,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          minimumStart: new Date(),
          session,
        });
        await checkoutRepository.reserveGuestIncreaseCapacity({
          tenantId,
          userId: user._id,
          orderId,
          reservations: guestIncreaseReservations,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          session,
        });

        const cartRecord = await checkoutRepository.createCart({
          tenantId,
          session,
          payload: {
            _id: checkoutOperation.cartId,
            user: user._id,
            cartItems: mappedCartItems,
            currency: checkoutCurrencyUpper,
            totalPrice: totalToChargeMajor,
            expectedAmountMinor: 0,
          },
        });

        if (
          transactionOrderInvoiceData.grossAmountMinor > 0 &&
          isMoneyCredits
        ) {
          const creditChange = await moneyCreditService.incrementMoneyCredits({
            tenantId,
            userId: user._id,
            amount: -totalToChargeMajor,
            currency: checkoutCurrencyUpper,
            transaction: {
              type: MONEY_CREDIT_TRANSACTION_TYPE.USED,
              description: `Payment with credits for order ${String(orderId)}`,
              relatedOrder: orderId,
              idempotencyKey: `checkout:${String(orderId)}:money-credit`,
            },
            session,
          });
          updatedUser = creditChange?.user;

          if (!updatedUser) {
            badRequest(
              "Credit balance could not be updated. Please try again.",
            );
          }
        } else if (
          transactionOrderInvoiceData.grossAmountMinor > 0 &&
          isMembershipCredits
        ) {
          membershipRedemption = await redeemMembershipEntitlement({
            tenantId: String(tenantId),
            userId: String(user._id || user.id),
            benefitKey: membershipBenefitKey.trim(),
            quantity: membershipAllowance!.quantity,
            bookingContext: membershipAllowance!.bookingContext,
            ...(workshopBookingsToCreate.some(
              (booking) =>
                booking.customerChoiceBooking &&
                booking.bookingMode === "private" &&
                resolveProductPrivateBookingSurcharge(
                  productById.get(String(booking.bookingProduct)),
                ) > 0,
            )
              ? {
                  requiredMoneyAmountMinor: transactionOrderInvoiceData.grossAmountMinor,
                  requiredMoneyCurrency: checkoutCurrencyUpper,
                }
              : {}),
            locationId: locationIds[0] ? String(locationIds[0]) : null,
            reference: { type: "order", id: String(orderId) },
            idempotencyKey: `checkout:${String(orderId)}:membership-credit`,
            session,
          });
        }

        const createdBookings = await checkoutRepository.createBookings({
          tenantId,
          payloads: workshopBookingsToCreate,
          atomicCapacity: true,
          session,
        });
        const workshopBookingIds = createdBookings.map(
          (booking) => booking._id,
        );
        transactionOrderInvoiceData = {
          ...transactionOrderInvoiceData,
          lineItems: attachWorkshopBookingsToOrderLines({
            sourceCartItems: cartItems,
            lineItems: transactionOrderInvoiceData.lineItems,
            bookingIds: workshopBookingIds,
          }),
        };

        const paymentAllocations =
          transactionOrderInvoiceData.grossAmountMinor === 0
            ? [{ method: "free", amountMinor: 0, providerReference: "" }]
            : isVoucher
              ? [
                  {
                    method: "voucher",
                    amountMinor: transactionOrderInvoiceData.grossAmountMinor,
                    providerReference: String(
                      voucherPlan.allocations[0].couponId,
                    ),
                  },
                ]
              : isMembershipCredits
                ? [
                    {
                      method: "membership_credit",
                      amountMinor: transactionOrderInvoiceData.grossAmountMinor,
                      providerReference: String(
                        membershipRedemption?._id || "",
                      ),
                    },
                  ]
                : [
                    {
                      method: "credits",
                      amountMinor: transactionOrderInvoiceData.grossAmountMinor,
                      providerReference: "",
                    },
                  ];

        const order = await checkoutRepository.createOrder({
          tenantId,
          session,
          payload: {
            _id: orderId,
            cart: cartRecord._id || cartRecord,
            createdBy: user._id,
            customer: {
              firstname: user.firstname,
              lastname: user.lastname,
              customId: user.customId,
              memberNumber: user.memberNumber ?? undefined,
              email: user.email,
              phone: user.phone || "",
            },
            ...(guestCheckout ? { guestCourseCheckout: guestCheckout.orderSnapshot } : {}),
            status: "processed_order",
            currency: checkoutCurrencyUpper,
            grossAmountMinor: transactionOrderInvoiceData.grossAmountMinor,
            expectedAmountMinor: 0,
            paidAmountMinor: 0,
            isPaid: true,
            paidAt,
            locationIds: transactionOrderInvoiceData.locationIds,
            lineItems: transactionOrderInvoiceData.lineItems.map(({ sourceLineIndex: _index, ...line }: any) => line),
            paymentAllocations,
            voucherRedemptions: voucherPlan?.allocations ?? [],
            credits: {
              appliedMajor: isMoneyCredits ? totalToChargeMajor : 0,
              requestedMajor: isMoneyCredits ? totalToChargeMajor : 0,
              currency: checkoutCurrencyUpper,
              couponId: null,
            },
            membershipRedemption: membershipRedemption
              ? {
                  membershipId: membershipRedemption.membership,
                  benefitKey: membershipRedemption.benefitKey,
                  quantity: Math.abs(Number(membershipRedemption.amount)),
                  ledgerEntryId: membershipRedemption._id,
                }
              : undefined,
            appliedDiscount,
            appliedCoupons: [],
            ...(cartItems[0]?.bookingExtension ? { bookingExtension: { bookingId: cartItems[0].bookingExtension.bookingId, originalEnd: cartItems[0].start, end: cartItems[0].end, amountMinor: cartItems[0].bookingExtension.amountMinor } } : {}),
            workshopBookings: workshopBookingIds,
            courseBookings,
            guestIncreaseBookings,
            stripe: { processedEventIds: [] },
          },
        });

        if (isVoucher)
          await commitCheckoutVouchers({
            tenantId: String(tenantId),
            order,
            session,
            paymentState: "not_required",
          });
        if (cartItems.some((item) => item.bookingExtension)) {
          await processWorkshopBookingsAfterPayment(order, { tenantId, session });
        }
        notificationOrder = order;

        if (courseBookings.length > 0) {
          await processCourseBookingsAfterPayment(order, { tenantId, session });
        }
        if (guestIncreaseBookings.length > 0) {
          await processGuestIncreaseBookingsAfterPayment(order, {
            tenantId,
            session,
          });
        }

        response = {
          success: true,
          ...(transactionOrderInvoiceData.grossAmountMinor === 0 || isMembershipCredits
            ? { status: "confirmed" }
            : {}),
          ...(isVoucher ? { voucherFunded: true, status: "confirmed" } : {}),
          message:
            transactionOrderInvoiceData.grossAmountMinor === 0
              ? "Booking completed successfully"
              : isVoucher
                ? "Booking completed successfully using voucher"
                : isMembershipCredits
                  ? "Booking completed successfully using membership credits"
                  : "Booking completed successfully using credits",
          orderId,
          amountCharged: totalToChargeMajor,
          remainingCredits: fromCurrencyMinorUnits(
            resolveCreditBalanceMinor({
              moneyCreditsMinor: updatedUser.moneyCreditsMinor,
              moneyCredits: updatedUser.moneyCredits,
              currency: checkoutCurrencyUpper,
            }),
            checkoutCurrencyUpper,
          ),
          membershipRedemption: membershipRedemption
            ? {
                benefitKey: membershipRedemption.benefitKey,
                quantity: Math.abs(Number(membershipRedemption.amount)),
              }
            : null,
          url: guestCheckout?.successUrl || buildTenantCommerceUrl({
            origin: originUrl,
            locale: normalizeCommerceLocale(locale),
            path: "portal/success",
            query: { orderId: String(orderId) },
          }),
        };

        await completeCheckoutOperation(checkoutOperation, guestCheckout
          ? { orderId: String(orderId), status: "confirmed" }
          : response, session);
      });
    } finally {
      await session.endSession();
    }

    if (notificationOrder && !notificationOrder.bookingExtension) {
      await emitBookingCreatedNotificationsForOrderSafely({
        tenantId: String(tenantId),
        order: notificationOrder,
      });
    }

    /*
     * The order, capacity consumption, balance ledger and idempotency replay
     * committed together. Invoice creation is independently retryable and
     * must not roll back or duplicate the paid checkout.
     */
    try {
      await ensurePaidOrderInvoice({
        tenantId: String(tenantId),
        orderId: String(orderId),
      });
    } catch (invoiceError) {
      console.error("[CHECKOUT_INVOICE_ERROR]", invoiceError);
    }

    return response;
  },
};
