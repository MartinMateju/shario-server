import type { Request } from "express";
import type { Types } from "mongoose";
import type Stripe from "stripe";

export type IdLike = string | Types.ObjectId;
export type TenantId = IdLike;
export type PlainObject = Record<string, unknown>;

export type CheckoutRequest = Request & {
  user?: string;
  userInfo?: {
    id?: string;
    email?: string;
    roles?: string[];
  };
};

export type CheckoutProductType =
  | "course"
  | "workshop"
  | "public-course"
  | "private-course"
  | "public-workshop"
  | "private-workshop"
  | "service"
  | "prolong"
  | "blocker"
  | "guest-increase"
  | "coupon";

export type CheckoutProductKind =
  | "open-studio"
  | "class"
  | "membership"
  | "voucher"
  | "private-studio";

export type CheckoutCurrency = "czk" | "eur" | "usd" | string;

export type CartProductRef = {
  _id?: IdLike;
  id?: IdLike;
  name?: string;
  description?: string;
  price?: number | string;
  type?: CheckoutProductType | string;
  kind?: CheckoutProductKind | string;
  bookingMode?: "public" | "private" | string;
  extraCharge?: number | string;
  currency?: CheckoutCurrency;
  imageSrc?: string;
  maxNumberOfParticipants?: number;
};

export type CheckoutCartItem = {
  product?: CartProductRef;
  quantity?: number | string;
  locationId?: IdLike;
  start?: string | Date;
  end?: string | Date;
  date?: string | Date;
  numberOfGuests?: number | string;
  bookingType?: string;
  bookingMode?: string;
  plannedActivity?: string | string[];
  plannedActivities?: string[];
  addGuests?: number | string;
  additionalParticipants?: number | string;
  additionalGuests?: number | string;
  participantsToAdd?: number | string;
  bookingWorkshop?: IdLike;
  bookingRef?: IdLike;
  bookingId?: IdLike;
  booking?: IdLike;
  bookingCourse?: IdLike;
  guests?: unknown[];
  [key: string]: unknown;
};

export type CheckoutUser = {
  _id?: IdLike;
  id?: IdLike;
  firstname?: string;
  lastname?: string;
  email?: string;
  phone?: string;
  customId?: string;
  moneyCredits?: number;
  moneyCreditsMinor?: number | null;
  [key: string]: unknown;
};

export type CheckoutOrder = PlainObject & {
  _id?: IdLike;
  createdBy?: IdLike;
  cart?: IdLike;
  isPaid?: boolean;
  paidAt?: Date;
  status?: string;
  creditPurchase?: { amount?: number };
  credits?: { appliedMajor?: number; [key: string]: unknown };
  workshopBookings?: unknown[];
  courseBookings?: unknown[];
  guestIncreaseBookings?: unknown[];
  appliedCoupons?: unknown[];
  customer?: PlainObject;
};

export type CheckoutRepository = {
  [key: string]: (...args: any[]) => any;
};

export type StripeCheckoutSession = Stripe.Checkout.Session;
export type StripeWebhookEvent = Stripe.Event;
