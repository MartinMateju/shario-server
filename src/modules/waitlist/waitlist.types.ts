import type { ClientSession, Types } from "mongoose";

import type {
  WAITLIST_ADMIN_ACTION,
  WAITLIST_STATE,
} from "./waitlist.constants.js";

export type WaitlistState =
  (typeof WAITLIST_STATE)[keyof typeof WAITLIST_STATE];

export type WaitlistSettings = {
  enabled: boolean;
  autoPromote: boolean;
  offerWindowHours: number;
  cutoffHours: number;
};

export type WaitlistPriceSnapshot = {
  amountMinor: number;
  currency: string;
  version: string;
  productId: Types.ObjectId;
  capturedAt: Date;
};

export type WaitlistIdentity = {
  normalizedEmailHash: string;
  email: string;
  firstName: string;
  lastName: string;
  customerId?: Types.ObjectId | null;
};

export type WaitlistEntryDto = {
  id: string;
  sessionId: string;
  state: WaitlistState;
  joinedAt: Date;
  offerExpiresAt: Date | null;
  price: {
    amount: number;
    amountMinor: number;
    currency: string;
    version: string;
  };
  refund?: {
    amount: number;
    amountMinor: number;
    currency: string;
    refundedAt: Date;
  };
};

export type WaitlistAdminAction =
  (typeof WAITLIST_ADMIN_ACTION)[keyof typeof WAITLIST_ADMIN_ACTION];

export type WaitlistTransactionContext = {
  session?: ClientSession | null;
};

export type WaitlistSessionLike = {
  _id?: unknown;
  tenant?: unknown;
  bookingProduct?: unknown;
  start?: Date | string | number;
  end?: Date | string | number;
  status?: string;
  archive?: boolean;
  numberOfGuests?: number;
  capacityReservations?: Array<{
    quantity?: number;
    expiresAt?: Date | string | number;
    order?: unknown;
  }>;
  waitlistCapacityHolds?: Array<{
    entry?: unknown;
    offerGeneration?: number;
    expiresAt?: Date | string | number;
    order?: unknown;
  }>;
  waitlistConfig?: Partial<WaitlistSettings>;
};

export type WaitlistProductLike = {
  _id?: unknown;
  price?: number | string;
  currency?: string;
  updatedAt?: Date | string | number;
  maxNumberOfParticipants?: number | null;
  waitlistDefaults?: Partial<WaitlistSettings>;
};
