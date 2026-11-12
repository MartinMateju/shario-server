import mongoose from "mongoose";
import { z } from "zod";

import {
  DEFAULT_INVENTORY_LIMIT,
  DEFAULT_INVENTORY_PAGE,
  INVENTORY_AUDIT_STATUS,
  INVENTORY_CATEGORY,
  INVENTORY_MOVEMENT_REASON,
  INVENTORY_MOVEMENT_TYPE,
  INVENTORY_UNIT,
  MAX_INVENTORY_LIMIT,
  REORDER_PRIORITY,
  REORDER_STATUS,
  VAT_RATES,
} from "./inventory.constants.js";

export const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine(
      (value) => mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}.`,
    );

const optionalObjectIdSchema = (fieldName: string) =>
  z
    .union([objectIdSchema(fieldName), z.literal(""), z.null()])
    .optional()
    .transform((value) => (value ? String(value) : null));

const optionalSkuSchema = z.preprocess(
  (value) => {
    const normalized = String(value ?? "")
      .trim()
      .toUpperCase();

    return normalized || undefined;
  },
  z.string().max(80).optional(),
);

const updateSkuSchema = z.preprocess(
  (value) => {
    if (value === null) return null;
    const normalized = String(value ?? "")
      .trim()
      .toUpperCase();

    return normalized || null;
  },
  z.string().max(80).nullable(),
);

const enumSchema = <T extends string>(values: readonly T[]) =>
  z.enum(values as [T, ...T[]]);

const normalizeLocationQueryAlias = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const {
    locationId,
    ...input
  } = value as Record<string, unknown>;

  return {
    ...input,
    location: input.location ?? locationId,
  };
};

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(DEFAULT_INVENTORY_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_INVENTORY_LIMIT)
    .default(DEFAULT_INVENTORY_LIMIT),
});

export const listInventoryItemsSchema = z.preprocess(
  normalizeLocationQueryAlias,
  paginationSchema
    .extend({
      location: objectIdSchema("location").optional(),
      category: enumSchema(Object.values(INVENTORY_CATEGORY)).optional(),
      search: z.string().trim().default(""),
      lowStock: z.coerce.boolean().optional(),
    })
    .strict(),
);

const inventoryStockLevelSchema = z
  .object({
    location: objectIdSchema("stock location"),
    currentQuantity: z.coerce.number().finite().min(0).default(0),
    minimumQuantity: z.coerce.number().finite().min(0).default(0),
  })
  .strict();

const inventoryStockLevelsSchema = z
  .array(inventoryStockLevelSchema)
  .min(1, "At least one stock location is required.")
  .superRefine((levels, context) => {
    const seen = new Set<string>();

    levels.forEach((level, index) => {
      if (seen.has(level.location)) {
        context.addIssue({
          code: "custom",
          message: "Stock locations must be unique.",
          path: [index, "location"],
        });
      }

      seen.add(level.location);
    });
  });

/**
 * `locations`/`locationIds` plus global quantities were used by the original
 * client. They remain accepted at the boundary, but every parsed request is
 * canonical and contains `stockLevels` only.
 */
const normalizeInventoryItemAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const input = value as Record<string, unknown>;
  const {
    locations,
    locationIds,
    currentQuantity,
    minimumQuantity,
    ...canonical
  } = input;

  if (canonical.stockLevels !== undefined) {
    return canonical;
  }

  const legacyLocations = Array.isArray(locations)
    ? locations
    : Array.isArray(locationIds)
      ? locationIds
      : undefined;

  if (!legacyLocations) {
    if (currentQuantity !== undefined) {
      canonical.currentQuantity = currentQuantity;
    }
    if (minimumQuantity !== undefined) {
      canonical.minimumQuantity = minimumQuantity;
    }
    return canonical;
  }

  canonical.stockLevels = legacyLocations.map((location, index) => ({
    location,
    currentQuantity: index === 0 ? currentQuantity ?? 0 : 0,
    minimumQuantity: index === 0 ? minimumQuantity ?? 0 : 0,
  }));

  return canonical;
};

const normalizeInventoryItemUpdateAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const input = value as Record<string, unknown>;
  const {
    locations,
    locationIds,
    currentQuantity,
    minimumQuantity,
    ...canonical
  } = input;

  if (canonical.stockLevels !== undefined) return canonical;

  const legacyLocations = Array.isArray(locations)
    ? locations
    : Array.isArray(locationIds)
      ? locationIds
      : undefined;

  if (!legacyLocations) {
    if (currentQuantity !== undefined) {
      canonical.currentQuantity = currentQuantity;
    }
    if (minimumQuantity !== undefined) {
      canonical.minimumQuantity = minimumQuantity;
    }
    return canonical;
  }

  // Legacy item edit forms sent the displayed aggregate current quantity
  // alongside locations. It is intentionally ignored here; the service
  // merges server-owned quantities into these threshold/location edits.
  canonical.stockLevels = legacyLocations.map((location, index) => ({
    location,
    minimumQuantity: index === 0 ? minimumQuantity ?? 0 : 0,
  }));

  return canonical;
};

const inventoryItemFields = {
  name: z.string().trim().min(1).max(160),
  sku: optionalSkuSchema,
  category: enumSchema(Object.values(INVENTORY_CATEGORY)).default(
    INVENTORY_CATEGORY.OTHER,
  ),
  unit: enumSchema(Object.values(INVENTORY_UNIT)).default(INVENTORY_UNIT.PCS),
  stockLevels: inventoryStockLevelsSchema,
  supplier: optionalObjectIdSchema("supplier"),
  averageUnitCostWithoutVat: z.coerce.number().finite().min(0).default(0),
  note: z.string().trim().max(2000).default(""),
  isActive: z.coerce.boolean().default(true),
};

const updateInventoryStockLevelSchema = z
  .object({
    location: objectIdSchema("stock location"),
    minimumQuantity: z.coerce.number().finite().min(0),
  })
  .strict();

const updateInventoryStockLevelsSchema = z
  .array(updateInventoryStockLevelSchema)
  .min(1, "At least one stock location is required.")
  .superRefine((levels, context) => {
    const seen = new Set<string>();

    levels.forEach((level, index) => {
      if (seen.has(level.location)) {
        context.addIssue({
          code: "custom",
          message: "Stock locations must be unique.",
          path: [index, "location"],
        });
      }

      seen.add(level.location);
    });
  });

export const createInventoryItemSchema = z.preprocess(
  normalizeInventoryItemAliases,
  z.object(inventoryItemFields).strict(),
);

export const updateInventoryItemSchema = z.preprocess(
  normalizeInventoryItemUpdateAliases,
  z
    .object({
      sku: updateSkuSchema,
      name: z.string().trim().min(1).max(160),
      category: enumSchema(Object.values(INVENTORY_CATEGORY)),
      unit: enumSchema(Object.values(INVENTORY_UNIT)),
      stockLevels: updateInventoryStockLevelsSchema,
      supplier: optionalObjectIdSchema("supplier"),
      averageUnitCostWithoutVat: z.coerce.number().finite().min(0),
      note: z.string().trim().max(2000),
      isActive: z.coerce.boolean(),
    })
    .partial()
    .strict(),
);

const normalizeMovementAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const {
    locationId,
    destinationLocationId,
    ...input
  } = value as Record<string, unknown>;

  return {
    ...input,
    location: input.location ?? locationId,
    destinationLocation:
      input.destinationLocation ?? destinationLocationId,
  };
};

export const createInventoryMovementSchema = z.preprocess(
  normalizeMovementAliases,
  z
    .object({
      item: objectIdSchema("inventory item"),
      supplier: optionalObjectIdSchema("supplier"),
      type: enumSchema(Object.values(INVENTORY_MOVEMENT_TYPE)),
      reason: enumSchema(Object.values(INVENTORY_MOVEMENT_REASON)).default(
        INVENTORY_MOVEMENT_REASON.OTHER,
      ),
      location: objectIdSchema("location"),
      destinationLocation: optionalObjectIdSchema("destination location"),
      quantity: z.coerce.number().finite().min(0),
      unitCostWithoutVat: z.coerce.number().finite().min(0).default(0),
      vatRate: z.coerce
        .number()
        .refine(
          (value) => VAT_RATES.includes(value as never),
          "Invalid VAT rate.",
        )
        .default(21),
      invoiceNumber: z.string().trim().max(120).default(""),
      note: z.string().trim().max(2000).default(""),
    })
    .strict()
    .superRefine((input, context) => {
      if (
        input.type !== INVENTORY_MOVEMENT_TYPE.ADJUSTMENT &&
        input.quantity <= 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Movement quantity must be greater than zero.",
          path: ["quantity"],
        });
      }

      if (input.type === INVENTORY_MOVEMENT_TYPE.AUDIT) {
        context.addIssue({
          code: "custom",
          message: "Audit movements are created by stocktake completion only.",
          path: ["type"],
        });
      }

      if (input.type === INVENTORY_MOVEMENT_TYPE.TRANSFER) {
        if (!input.destinationLocation) {
          context.addIssue({
            code: "custom",
            message: "A transfer destination is required.",
            path: ["destinationLocation"],
          });
        } else if (input.destinationLocation === input.location) {
          context.addIssue({
            code: "custom",
            message: "Transfer locations must be different.",
            path: ["destinationLocation"],
          });
        }
      } else if (input.destinationLocation) {
        context.addIssue({
          code: "custom",
          message: "Destination location is only valid for transfers.",
          path: ["destinationLocation"],
        });
      }
    }),
);

export const listInventoryMovementsSchema = z.preprocess(
  normalizeLocationQueryAlias,
  paginationSchema
    .extend({
      item: objectIdSchema("inventory item").optional(),
      type: enumSchema(Object.values(INVENTORY_MOVEMENT_TYPE)).optional(),
      location: objectIdSchema("location").optional(),
    })
    .strict(),
);

export const createInventoryAuditSchema = z.preprocess(
  normalizeLocationQueryAlias,
  z
    .object({
      auditDate: z.coerce.date(),
      location: objectIdSchema("location"),
      note: z.string().trim().max(2000).default(""),
    })
    .strict(),
);

export const updateInventoryAuditSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            item: objectIdSchema("inventory audit item"),
            actualQuantity: z.coerce.number().finite().min(0).default(0),
            note: z.string().trim().max(1000).default(""),
          })
          .strict(),
      )
      .min(1),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export const listInventoryAuditsSchema = z.preprocess(
  normalizeLocationQueryAlias,
  paginationSchema
    .extend({
      location: objectIdSchema("location").optional(),
      status: enumSchema(Object.values(INVENTORY_AUDIT_STATUS)).optional(),
    })
    .strict(),
);

export const listReorderRequestsSchema = z.preprocess(
  normalizeLocationQueryAlias,
  paginationSchema
    .extend({
      location: objectIdSchema("location").optional(),
      status: enumSchema(Object.values(REORDER_STATUS)).optional(),
      priority: enumSchema(Object.values(REORDER_PRIORITY)).optional(),
    })
    .strict(),
);

export const createReorderRequestSchema = z.preprocess(
  normalizeLocationQueryAlias,
  z
    .object({
      item: objectIdSchema("inventory item"),
      location: objectIdSchema("location"),
      requestedQuantity: z.coerce.number().finite().positive(),
      priority: enumSchema(Object.values(REORDER_PRIORITY)).default(
        REORDER_PRIORITY.MEDIUM,
      ),
      note: z.string().trim().max(2000).default(""),
    })
    .strict(),
);

const receiveReorderFields = {
  receivedQuantity: z.coerce.number().finite().positive().optional(),
  unitCostWithoutVat: z.coerce.number().finite().min(0).optional(),
  vatRate: z.coerce
    .number()
    .refine(
      (value) => VAT_RATES.includes(value as never),
      "Invalid VAT rate.",
    )
    .optional(),
  invoiceNumber: z.string().trim().max(120).optional(),
};

export const receiveReorderRequestSchema = z
  .object(receiveReorderFields)
  .strict();

export const updateReorderRequestSchema = z
  .object({
    requestedQuantity: z.coerce.number().finite().positive().optional(),
    priority: enumSchema(Object.values(REORDER_PRIORITY)).optional(),
    status: enumSchema(Object.values(REORDER_STATUS)).optional(),
    note: z.string().trim().max(2000).optional(),
    ...receiveReorderFields,
  })
  .strict();

export const idParamsSchema = z.object({
  id: objectIdSchema(),
});

export type CreateInventoryItemInput = z.infer<
  typeof createInventoryItemSchema
>;
export type UpdateInventoryItemInput = z.infer<
  typeof updateInventoryItemSchema
>;
export type CreateInventoryMovementInput = z.infer<
  typeof createInventoryMovementSchema
>;
export type CreateInventoryAuditInput = z.infer<
  typeof createInventoryAuditSchema
>;
export type UpdateInventoryAuditInput = z.infer<
  typeof updateInventoryAuditSchema
>;
export type ReceiveReorderRequestInput = z.infer<
  typeof receiveReorderRequestSchema
>;
export type CreateReorderRequestInput = z.infer<
  typeof createReorderRequestSchema
>;
export type UpdateReorderRequestInput = z.infer<
  typeof updateReorderRequestSchema
>;
