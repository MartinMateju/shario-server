import type { HydratedDocument, InferSchemaType, Model } from "mongoose";

import type { inventoryAuditSchema } from "./inventory-audit.schema.js";
import type { inventoryItemSchema } from "./inventory-item.schema.js";
import type { inventoryMovementSchema } from "./inventory-movement.schema.js";
import type { reorderRequestSchema } from "./reorder-request.schema.js";
import type { InventoryCategory, InventoryMovementType } from "./inventory.constants.js";

export type InventoryItem = InferSchemaType<typeof inventoryItemSchema>;
export type InventoryItemDocument = HydratedDocument<InventoryItem>;
export type InventoryItemModel = Model<InventoryItem>;

export type InventoryMovement = InferSchemaType<typeof inventoryMovementSchema>;
export type InventoryMovementDocument = HydratedDocument<InventoryMovement>;
export type InventoryMovementModel = Model<InventoryMovement>;

export type InventoryAudit = InferSchemaType<typeof inventoryAuditSchema>;
export type InventoryAuditDocument = HydratedDocument<InventoryAudit>;
export type InventoryAuditModel = Model<InventoryAudit>;

export type ReorderRequest = InferSchemaType<typeof reorderRequestSchema>;
export type ReorderRequestDocument = HydratedDocument<ReorderRequest>;
export type ReorderRequestModel = Model<ReorderRequest>;

export type InventoryListFilters = {
  tenantId: string;
  allowedLocationIds?: readonly string[] | null;
  location?: string;
  category?: InventoryCategory;
  search?: string;
  lowStock?: boolean;
  page?: number;
  limit?: number;
};

export type InventoryMovementFilters = {
  tenantId: string;
  allowedLocationIds?: readonly string[] | null;
  item?: string;
  type?: InventoryMovementType;
  location?: string;
  page?: number;
  limit?: number;
};
