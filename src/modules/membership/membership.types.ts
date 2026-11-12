import type { HydratedDocument, InferSchemaType, Model, Types } from "mongoose";

import type { membershipPlanSchema } from "./membership-plan.schema.js";
import type { membershipPlanVersionSchema } from "./membership-plan-version.schema.js";
import type { userMembershipSchema } from "./user-membership.schema.js";
import type { MembershipStatus } from "./membership.constants.js";
import type { MembershipBenefitTranslation, MembershipTextTranslation, MembershipTranslations } from "./membership.localization.js";

export type MembershipPlan = InferSchemaType<typeof membershipPlanSchema>;
export type MembershipPlanDocument = HydratedDocument<MembershipPlan>;
export type MembershipPlanModel = Model<MembershipPlan>;
export type MembershipPlanVersion = InferSchemaType<typeof membershipPlanVersionSchema>;
export type MembershipPlanVersionDocument = HydratedDocument<MembershipPlanVersion>;
export type UserMembership = InferSchemaType<typeof userMembershipSchema>;
export type UserMembershipDocument = HydratedDocument<UserMembership>;
export type UserMembershipModel = Model<UserMembership>;

export type TenantId = string;
export type UserId = string;
export type MembershipPlanId = string;
export type UserMembershipId = string;
export type MembershipPlanLean = MembershipPlan & { _id: Types.ObjectId };
export type UserMembershipLean = UserMembership & { _id: Types.ObjectId };

export type MembershipPlanListFilters = {
  tenantId: TenantId;
  locationId?: string | null;
  allowedLocationIds?: readonly string[] | null;
  includeInactive?: boolean;
  status?: string;
  page?: number;
  limit?: number;
};

export type UserMembershipListFilters = {
  tenantId: TenantId;
  userId?: UserId;
  userIds?: readonly UserId[];
  planId?: MembershipPlanId;
  allowedPlanIds?: readonly string[] | null;
  allowedLocationIds?: readonly string[] | null;
  status?: MembershipStatus;
  page?: number;
  limit?: number;
};

export type MembershipAllowanceBenefit = {
  key: string;
  label: string;
  translations?: MembershipTranslations<MembershipBenefitTranslation>;
  type: "allowance";
  unit:
    | "credit"
    | "visit"
    | "session"
    | "minute"
    | "hour"
    | "booking"
    | "item"
    | "money_minor"
    | "custom";
  quantity: number;
  currency?: string;
  expiresAfterDays?: number | null;
  adjustable?: boolean;
  usageScope?: "open_studio";
  memberOnly?: true;
  rolloverPercent?: number;
};

export type MembershipPercentageBenefit = {
  key: string;
  label: string;
  translations?: MembershipTranslations<MembershipBenefitTranslation>;
  type: "percentage";
  percentageBps: number;
  appliesTo: "bookings" | "products" | "all";
  productScope?: "all" | "courses";
  eligibleProductIds?: string[];
  memberOnly?: true;
};

export type MembershipLimitBenefit = {
  key: string;
  label: string;
  translations?: MembershipTranslations<MembershipBenefitTranslation>;
  type: "limit";
  limit: number;
  unit: "active_bookings" | "priority_days" | "custom";
};

export type MembershipBooleanBenefit = {
  key: string;
  label: string;
  translations?: MembershipTranslations<MembershipBenefitTranslation>;
  type: "boolean";
  enabled: boolean;
};

export type MembershipBenefit =
  | MembershipAllowanceBenefit
  | MembershipPercentageBenefit
  | MembershipLimitBenefit
  | MembershipBooleanBenefit;

export type MembershipVersionConfig = {
  name: string;
  description: string;
  terms: string;
  sourceLanguage?: keyof MembershipTranslations<MembershipTextTranslation>;
  translations?: MembershipTranslations<MembershipTextTranslation>;
  prices: Array<{ currency: string; amountMinor: number }>;
  billing:
    | { type: "recurring"; interval: "month" | "year"; intervalCount: number }
    | { type: "fixed"; durationDays: number };
  locationScope: { type: "all" | "selected" | "shared_selected"; locationIds: unknown[] };
  benefits: MembershipBenefit[];
};
