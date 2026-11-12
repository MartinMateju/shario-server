import type { HydratedDocument, Model, Types } from "mongoose";

import type { LocationActivitySelectionMode } from "./location.constants.js";

export type OpeningHoursDay = {
  isOpen: boolean;
  openTime: string;
  closeTime: string;
};

export type ActivityCapacity = {
  activity: string;
  capacity: number;
};

export type Location = {
  tenant: Types.ObjectId;
  name: string;
  slug: string;
  code: string;
  isActive: boolean;
  isPrimary: boolean;
  pricingMode?: "time" | null;
  address: {
    line1: string;
    line2: string;
    city: string;
    postalCode: string;
    country: string;
  };
  contact: {
    email: string;
    phone: string;
  };
  booking: {
    enabled: boolean;
    timezone: string;
    slotStepMinutes: number;
    minBookingMinutes: number;
    maxBookingMinutes: number;
    allowPublicSoloOverlap: boolean;
    maxPublicSoloOverlaps: number;
    globalCapacity: number;
    activitySelectionMode?: LocationActivitySelectionMode;
    activityCapacities: ActivityCapacity[];
    privateSessionBlocksAll: boolean;
    groupBookingBlocksAll: boolean;
    doorCodeMinutesBefore: number;
    capacityRevision: number;
  };
  openingHours: Record<
    | "monday"
    | "tuesday"
    | "wednesday"
    | "thursday"
    | "friday"
    | "saturday"
    | "sunday",
    OpeningHoursDay
  >;
  access: {
    automaticEmailEnabled?: boolean;
    publicInstructions: string;
    privateInstructions: string;
    doorCode: string;
  };
  notes: string;
  createdAt: Date;
  updatedAt: Date;
};

export type LocationDocument = HydratedDocument<Location>;
export type LocationMongooseModel = Model<Location>;

export type LocationListFilters = {
  tenantId: string;
  /** null/undefined means all tenant locations; an array is an allow-list. */
  allowedLocationIds?: readonly string[] | null;
  search?: string;
  isActive?: boolean;
  bookingEnabled?: boolean;
  page: number;
  limit: number;
};
