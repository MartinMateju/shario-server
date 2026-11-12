/**
 * Inventory constants
 * Single source of truth for the inventory module.
 */

export const INVENTORY_CATEGORY = {
  TOOL: "tool",
  COFFEE: "coffee",
  MILK: "milk",
  PACKAGING: "packaging",
  CLEANING: "cleaning",
  OTHER: "other",
} as const;

export type InventoryCategory =
  (typeof INVENTORY_CATEGORY)[keyof typeof INVENTORY_CATEGORY];

export const INVENTORY_CATEGORIES = Object.values(
  INVENTORY_CATEGORY,
) as readonly InventoryCategory[];

export const INVENTORY_UNIT = {
  PCS: "pcs",
  KG: "kg",
  G: "g",
  L: "l",
  ML: "ml",
  PACKAGE: "package",
} as const;

export type InventoryUnit =
  (typeof INVENTORY_UNIT)[keyof typeof INVENTORY_UNIT];

export const INVENTORY_UNITS = Object.values(
  INVENTORY_UNIT,
) as readonly InventoryUnit[];

export const INVENTORY_MOVEMENT_TYPE = {
  IN: "in",
  OUT: "out",
  ADJUSTMENT: "adjustment",
  AUDIT: "audit",
  TRANSFER: "transfer",
} as const;

export type InventoryMovementType =
  (typeof INVENTORY_MOVEMENT_TYPE)[keyof typeof INVENTORY_MOVEMENT_TYPE];

export const INVENTORY_MOVEMENT_TYPES = Object.values(
  INVENTORY_MOVEMENT_TYPE,
) as readonly InventoryMovementType[];

export const INVENTORY_MOVEMENT_REASON = {
  PURCHASE: "purchase",
  STUDIO_CONSUMPTION: "studio-consumption",
  SALE: "sale",
  DAMAGE: "damage",
  LOST: "lost",
  MANUAL_ADJUSTMENT: "manual-adjustment",
  INVENTORY_AUDIT: "inventory-audit",
  TRANSFER: "transfer",
  RETURN: "return",
  OTHER: "other",
} as const;

export type InventoryMovementReason =
  (typeof INVENTORY_MOVEMENT_REASON)[keyof typeof INVENTORY_MOVEMENT_REASON];

export const INVENTORY_MOVEMENT_REASONS = Object.values(
  INVENTORY_MOVEMENT_REASON,
) as readonly InventoryMovementReason[];

export const INVENTORY_AUDIT_STATUS = {
  DRAFT: "draft",
  COMPLETED: "completed",
} as const;

export type InventoryAuditStatus =
  (typeof INVENTORY_AUDIT_STATUS)[keyof typeof INVENTORY_AUDIT_STATUS];

export const INVENTORY_AUDIT_STATUSES = Object.values(
  INVENTORY_AUDIT_STATUS,
) as readonly InventoryAuditStatus[];

export const REORDER_STATUS = {
  OPEN: "open",
  ORDERED: "ordered",
  RECEIVED: "received",
  CANCELLED: "cancelled",
} as const;

export type ReorderStatus =
  (typeof REORDER_STATUS)[keyof typeof REORDER_STATUS];

export const REORDER_STATUSES = Object.values(
  REORDER_STATUS,
) as readonly ReorderStatus[];

export const REORDER_PRIORITY = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;

export type ReorderPriority =
  (typeof REORDER_PRIORITY)[keyof typeof REORDER_PRIORITY];

export const REORDER_PRIORITIES = Object.values(
  REORDER_PRIORITY,
) as readonly ReorderPriority[];

export const VAT_RATES = [0, 10, 12, 15, 21] as const;

export type VatRate = (typeof VAT_RATES)[number];

export const DEFAULT_INVENTORY_PAGE = 1;
export const DEFAULT_INVENTORY_LIMIT = 50;
export const MAX_INVENTORY_LIMIT = 100;
