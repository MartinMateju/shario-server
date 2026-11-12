import type { HydratedDocument, Model, Types } from "mongoose";

import type {
  OrderNotificationChannel,
  OrderNotificationStatus,
  OrderNotificationType,
  OrderStatus,
} from "./order.constants.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

export type ObjectId = Types.ObjectId;

export type OrderCustomerSnapshot = {
  firstname: string;
  lastname: string;
  customId: string;
  memberNumber?: number;
  email: string;
  phone?: string;
  billing?: {
    legalName?: string;
    registrationNumber?: string;
    taxId?: string;
    vatId?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      postalCode?: string;
      country?: string;
      countryCode?: string;
    };
  };
};

export type OrderLineSnapshot = {
  product: ObjectId | null;
  booking: ObjectId | null;
  description: string;
  sku: string;
  quantity: number;
  unitGrossMinor: number;
  grossAmountMinor: number;
  netAmountMinor: number;
  taxAmountMinor: number;
  taxRateBps: number;
  locationIds: ObjectId[];
};

export type OrderPaymentAllocation = {
  method:
    "stripe" | "credits" | "membership_credit" | "voucher" | "free" | "manual";
  amountMinor: number;
  providerReference: string;
};

export type OrderVoucherRedemption = {
  couponId: ObjectId;
  reservationId: string;
  lineIndex: number;
  eligibleProductId: ObjectId;
  amountMinor: number;
  quantity: number;
  appliedAmountMinor: number;
};

export type OrderCreditPurchase = {
  amount: number;
  currency: StudioCommerceCurrency;
};

export type OrderCredits = {
  appliedMajor: number;
  requestedMajor: number;
  currency: StudioCommerceCurrency;
  couponId: string | null;
};

export type OrderMembershipRedemption = {
  membershipId: ObjectId | null;
  benefitKey: string;
  quantity: number;
  ledgerEntryId: ObjectId | null;
};

export type OrderAppliedCoupon = {
  promoCode: string;
  couponId: ObjectId | null;
  couponProductId: ObjectId | null;
  value: number;
  currency: StudioCommerceCurrency;
  cartTotal?: number;
  remainingToPay?: number;
  appliedAt: Date;
};

export type OrderAppliedDiscount = {
  source: "membership" | "coupon";
  label: string;
  currency: StudioCommerceCurrency;
  subtotalAmountMinor: number;
  amountMinor: number;
  percentageBps: number | null;
  membership: {
    membershipId: ObjectId;
    planId: ObjectId;
    planVersionId: ObjectId;
    planVersion: number;
    benefitKey: string;
    benefitLabel: string;
  } | null;
  coupon: {
    couponId: ObjectId | null;
    promoCode: string;
  } | null;
  appliedAt: Date;
};

export type OrderNotificationEvent = {
  type: OrderNotificationType;
  sentAt: Date;
  channel: OrderNotificationChannel;
  to: string;
  template: string;
  provider: string;
  providerMessageId: string;
  status: OrderNotificationStatus;
  error: string;
  attempt: number;
  claimId?: string;
  deliveryVersion?: number;
  providerStartedAt?: Date | null;
  retryable?: boolean;
  providerDeliveryStatus?: "" | "delivered" | "bounced" | "complained";
  providerStatusAt?: Date | null;
  deliveredAt?: Date | null;
};

export type OrderNotificationRecovery = {
  id: string;
  requestedAt: Date;
  expiresAt: Date;
  reason: "smtp-loopback-refused" | "piece-confirmation-missing";
  previousEvents: OrderNotificationEvent[];
  to: string;
};

export type OrderNotificationLock = {
  lockedUntil: Date | null;
  lockedBy: string;
  lockedAt: Date | null;
};

export type OrderCourseSlot = {
  bookingId: ObjectId;
  quantity: number;
  capacityReserved: boolean;
};

export type OrderGuestIncrease = {
  bookingId: ObjectId;
  addGuests: number;
};

export type OrderWaitlistSnapshot = {
  stripeSessionExpiresAt?: Date | null;
  entryId: ObjectId | null;
  offerGeneration: number | null;
  priceVersion: string;
};

export type OrderWaitlistRefundSnapshot = {
  refundId: string;
  status: string;
  amountMinor: number | null;
  lastCheckedAt: Date | null;
};

export type OrderCourseCancellation = {
  bookingId: ObjectId;
  quantity: number;
  releasedQuantity?: number;
  refundAmountMinor: number;
  currency: StudioCommerceCurrency;
  actor: ObjectId;
  reason: string;
  refundedAt: Date;
};

export type OrderStripe = {
  /**
   * Immutable merchant-of-record snapshot. Tenant commerce is created as a
   * direct charge on this connected account; it must never be inferred from
   * the tenant's current Connect configuration after checkout creation.
   */
  connectedAccountId: string;
  livemode: boolean | null;
  customerId: string;
  sessionId: string;
  paymentIntentId: string;
  processedEventIds: string[];
  processingClaimToken: string;
  processingEventId: string;
  processingClaimedAt: Date | null;
  processingLeaseExpiresAt: Date | null;
  processingAttemptCount: number;
  lastProcessingError: string;
  lastProcessingFailedAt: Date | null;
};

export type OrderInvoiceAutomation = {
  attempts: number;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  lastError: string;
};

export type Order = {
  tenant: ObjectId;
  cart: ObjectId;
  createdBy: ObjectId;
  customer: OrderCustomerSnapshot;
  guestCourseCheckout?: {
    version: 1;
    accessNonce: string;
    accessTokenHash: string;
    accessExpiresAt: Date;
    locale: string;
    acceptedTerms?: { acceptedAt: Date; contentHash: string };
    returnContext?: { productId: string; courseSessionId: string; location: string; quantity: string };
  };
  status: OrderStatus;
  currency: StudioCommerceCurrency;
  grossAmountMinor: number;
  expectedAmountMinor: number;
  paidAmountMinor: number | null;
  locationIds: ObjectId[];
  lineItems: OrderLineSnapshot[];
  paymentAllocations: OrderPaymentAllocation[];
  voucherRedemptions: OrderVoucherRedemption[];
  voucherCheckoutReleasedAt?: Date | null;
  voucherStripeRequest?: Record<string, unknown> | null;
  pieceStripeRequest?: Record<string, unknown> | null;
  pieceCheckout?: {
    requestHash: string;
    method: "card" | "credits";
    state: "pending" | "paid" | "cancelled" | "refunded";
    expiresAt: Date;
    refundedAmountMinor: number;
    items: Array<{
      potteryPieceId: ObjectId;
      quoteRevision: string;
      name: string;
      registrationNumber: string;
      amountMinor: number;
    }>;
  } | null;
  invoice?: ObjectId | null;
  invoiceAutomation: OrderInvoiceAutomation;
  note: string;
  isPaid: boolean;
  paidAt: Date | null;
  creditPurchase: OrderCreditPurchase;
  credits: OrderCredits;
  membershipRedemption: OrderMembershipRedemption;
  legacyOrder: boolean;
  appliedDiscount: OrderAppliedDiscount | null;
  appliedCoupons: OrderAppliedCoupon[];
  notificationLog: OrderNotificationEvent[];
  notificationRecovery?: OrderNotificationRecovery;
  notificationLock: OrderNotificationLock;
  bookingExtension?: { bookingId: ObjectId; originalEnd: Date; end: Date; amountMinor: number; refundId?: string; refundStatus?: string };
  workshopBookings: ObjectId[];
  courseBookings: OrderCourseSlot[];
  courseCancellations: OrderCourseCancellation[];
  guestIncreaseBookings: OrderGuestIncrease[];
  waitlist: OrderWaitlistSnapshot;
  waitlistRefund: OrderWaitlistRefundSnapshot;
  stripe: OrderStripe;
  createdAt: Date;
  updatedAt: Date;
};

export type OrderDocument = HydratedDocument<Order>;
export type OrderModel = Model<Order>;

export type OrderFilterInput = {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  userCustomId?: string;
  userEmail?: string;
  productType?: string;
  status?: OrderStatus | string;
  locationId?: string;
  page?: number | string;
  limit?: number | string;
  sortBy?: string;
  sortOrder?: string;
};

export type PaginatedOrdersResult<TOrder = unknown> = {
  orders: TOrder[];
  totalCount: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
};

export type OrderNotificationEmailMeta = {
  provider?: string | null;
  providerMessageId?: string | null;
  template?: string | null;
};

export type PopulatedOrderUser = {
  _id?: ObjectId;
  email?: string;
  firstname?: string;
  lastname?: string;
  customId?: string;
  memberNumber?: number;
};

export type OrderWithCreatedByUser = Omit<Order, "createdBy"> & {
  _id: ObjectId;
  createdBy?: PopulatedOrderUser | ObjectId | null;
};
