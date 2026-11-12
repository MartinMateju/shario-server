import type { HydratedDocument, InferSchemaType, Types } from "mongoose";

import type { couponOrderSchema, couponSchema } from "./coupon.schema.js";
import type {
  CouponOrderStatus,
  CouponSortField,
  SortOrder,
} from "./coupon.constants.js";
import type { IssuedVoucherStatus } from "./voucher-list-policy.js";
import type { PhysicalDeliveryStatus } from "./voucher-physical-delivery.policy.js";

export type Coupon = InferSchemaType<typeof couponSchema>;
export type CouponDocument = HydratedDocument<Coupon>;

export type CouponOrder = InferSchemaType<typeof couponOrderSchema>;
export type CouponOrderDocument = HydratedDocument<CouponOrder>;

export type CouponOrderListFilters = {
  tenantId: string;
  search?: string;
  userCustomId?: string;
  userEmail?: string;
  productType?: string;
  productId?: string;
  physicalStatus?: "all" | PhysicalDeliveryStatus;
  status?: CouponOrderStatus;
  sendPost?: boolean | "all";
  page: number;
  limit: number;
  sortBy: CouponSortField;
  sortOrder: SortOrder;
};

export type CouponListFilters = {
  tenantId: string;
  search?: string;
  productId?: string;
  archiveState?: "unarchived" | "archived" | "all";
  status?: IssuedVoucherStatus | "all";
  isActive?: boolean | "all";
  page: number;
  limit: number;
  sortOrder: SortOrder;
};

export type StatusChangeAudit = {
  adminId: Types.ObjectId;
  adminName: string;
  adminEmail: string;
  previousStatus: string;
  newStatus: string;
  timestamp: Date;
};
