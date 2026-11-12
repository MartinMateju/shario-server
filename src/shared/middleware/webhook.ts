import mongoose from "mongoose";

export type WebhookTenantContext = {
  tenantId: string;
};

export type StripeSessionLike = {
  currency?: string | null;
  amount_total?: number | null;
  metadata?: {
    creditsAppliedMajor?: string | number;
  } | null;
};

export type WebhookOrder = {
  _id?: mongoose.Types.ObjectId | string;
  createdBy?: mongoose.Types.ObjectId | string;
  customer?: {
    firstname?: string;
    lastname?: string;
    customId?: string;
    memberNumber?: number;
    email?: string;
  };
  workshopBookings?: unknown[];
  courseBookings?: Array<{
    bookingId?: string | mongoose.Types.ObjectId;
    quantity?: number;
    capacityReserved?: boolean;
  }>;
  guestIncreaseBookings?: Array<{
    bookingId?: string | mongoose.Types.ObjectId;
    booking?: string | mongoose.Types.ObjectId;
    addGuests?: number;
    capacityReserved?: boolean;
  }>;
  appliedCoupons?: Array<{
    promoCode?: string;
    couponId?: string | mongoose.Types.ObjectId;
  }>;
  credits?: {
    appliedMajor?: number;
    currency?: string;
  };
  currency?: string;
  expectedAmountMinor?: number;
  paidAmountMinor?: number | null;
  creditPurchase?: {
    amount?: number;
    currency?: string;
  };
};

export const toObjectId = (value: string | mongoose.Types.ObjectId) => {
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));
};

export const withTenantId = (
  tenantId: string,
  filter: Record<string, unknown> = {},
): Record<string, unknown> & { tenant: mongoose.Types.ObjectId } => ({
  ...filter,
  tenant: toObjectId(tenantId),
});
