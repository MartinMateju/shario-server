import type { HydratedDocument, Model, Types } from "mongoose";

import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

import type {
  SortDirection,
  SupplyOrderPriority,
  SupplyOrderSortField,
  SupplyOrderStatus,
} from "./supply-order.constants.js";

export type ObjectId = Types.ObjectId;

export type SupplyOrder = {
  tenant: ObjectId;
  title: string;
  location?: ObjectId | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  assignedTo?: ObjectId | null;
  registeredAt: Date;
  deadline?: Date | null;
  status: SupplyOrderStatus;
  priority: SupplyOrderPriority;
  currency?: StudioCommerceCurrency;
  price: number;
  depositPaid: number;
  units: number;
  unitLabel: string;
  publicNote: string;
  internalNote: string;
  requestedByUser?: ObjectId | null;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type SupplyOrderDocument = HydratedDocument<SupplyOrder>;
export type SupplyOrderModel = Model<SupplyOrder>;

export type Supplier = {
  tenant: ObjectId;
  name: string;
  ico: string;
  dic: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SupplierDocument = HydratedDocument<Supplier>;
export type SupplierModel = Model<Supplier>;

export type SupplyOrderListFilters = {
  tenantId: string;
  allowedLocationIds?: readonly string[] | null;
  status?: SupplyOrderStatus;
  priority?: SupplyOrderPriority;
  location?: string;
  assignedTo?: string;
  search?: string;
  page: number;
  limit: number;
  sortBy: SupplyOrderSortField;
  sortDirection: SortDirection;
};

export type SupplierListFilters = {
  tenantId: string;
  search?: string;
  isActive?: boolean;
};
