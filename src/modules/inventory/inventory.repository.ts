import type { ClientSession } from "mongoose";

import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

import {
  INVENTORY_AUDIT_STATUS,
  REORDER_STATUS,
  type InventoryAuditStatus,
  type InventoryCategory,
  type InventoryMovementReason,
  type InventoryMovementType,
  type InventoryUnit,
  type ReorderPriority,
  type ReorderStatus,
  type VatRate,
} from "./inventory.constants.js";
import {
  InventoryAudit,
  InventoryItem,
  InventoryMovement,
  ReorderRequest,
} from "./inventory.model.js";
import { getCanonicalStockLevels } from "./inventory-stock-levels.js";
import type {
  InventoryAuditDocument,
  InventoryItemDocument,
  InventoryListFilters,
  InventoryMovementDocument,
  InventoryMovementFilters,
  ReorderRequestDocument,
} from "./inventory.types.js";
import type {
  CreateInventoryAuditInput,
  CreateInventoryItemInput,
  CreateInventoryMovementInput,
  UpdateInventoryItemInput,
} from "./inventory.validators.js";
import { escapeRegex, getPagination, toObjectId } from "./inventory.utils.js";

type MongoFilter = Record<string, unknown>;
type RepositoryOptions = { session?: ClientSession | null };

type CreateInventoryItemPersistenceInput = CreateInventoryItemInput & {
  currency: StudioCommerceCurrency;
};

type UpdateInventoryItemPersistenceInput = Omit<
  UpdateInventoryItemInput,
  "stockLevels" | "sku"
> & {
  sku?: string | null;
  stockLevels?: Array<{
    location: string;
    currentQuantity: number;
    minimumQuantity: number;
  }>;
  currency?: StudioCommerceCurrency;
};

type CreateInventoryMovementPersistenceInput = CreateInventoryMovementInput & {
  currency: StudioCommerceCurrency;
  quantityDelta?: number | null;
  audit?: string | null;
};

const getReferenceId = (value: unknown): string =>
  String(
    value && typeof value === "object" && "_id" in value
      ? (value as { _id: unknown })._id
      : value || "",
  );

const populateItem = (tenantId: string) => [
  {
    path: "supplier",
    match: { tenant: toObjectId(tenantId) },
  },
  { path: "locations" },
  { path: "stockLevels.location" },
];

const populateMovement = (tenantId: string) => [
  {
    path: "item",
    match: { tenant: toObjectId(tenantId) },
    select: "name sku category unit currency isActive",
  },
  { path: "supplier", match: { tenant: toObjectId(tenantId) } },
  { path: "location" },
  { path: "destinationLocation" },
  { path: "createdBy", select: "firstname lastname email customId" },
];

const populateAudit = (tenantId: string) => [
  { path: "location" },
  {
    path: "items.item",
    match: { tenant: toObjectId(tenantId) },
    select: "name sku category unit currency isActive",
  },
  { path: "createdBy", select: "firstname lastname email customId" },
  { path: "completedBy", select: "firstname lastname email customId" },
];

const populateReorder = (tenantId: string) => [
  {
    path: "item",
    match: { tenant: toObjectId(tenantId) },
    select: "name sku category unit currency isActive",
  },
  { path: "supplier", match: { tenant: toObjectId(tenantId) } },
  { path: "location" },
  { path: "createdBy", select: "firstname lastname email customId" },
  { path: "resolvedBy", select: "firstname lastname email customId" },
  { path: "receivedMovement" },
];

const appendAnd = (query: MongoFilter, condition: MongoFilter): void => {
  const existing = Array.isArray(query.$and)
    ? (query.$and as MongoFilter[])
    : [];
  query.$and = [...existing, condition];
};

const itemLocationCondition = (locationIds: readonly string[]): MongoFilter => {
  const objectIds = locationIds.map(toObjectId);

  return {
    $or: [
      { "stockLevels.location": { $in: objectIds } },
      {
        $and: [
          {
            $expr: {
              $eq: [{ $size: { $ifNull: ["$stockLevels", []] } }, 0],
            },
          },
          { locations: { $in: objectIds } },
        ],
      },
    ],
  };
};

const lowStockExpression = (
  visibleLocationIds?: readonly string[] | null,
): MongoFilter => {
  const visibleObjectIds = visibleLocationIds?.map(toObjectId);
  const locationExpression =
    visibleObjectIds === null || visibleObjectIds === undefined
      ? true
      : { $in: ["$$level.location", visibleObjectIds] };

  return {
    $expr: {
      $or: [
        {
          $anyElementTrue: {
            $map: {
              input: { $ifNull: ["$stockLevels", []] },
              as: "level",
              in: {
                $and: [
                  locationExpression,
                  { $gt: ["$$level.minimumQuantity", 0] },
                  {
                    $lte: [
                      "$$level.currentQuantity",
                      "$$level.minimumQuantity",
                    ],
                  },
                ],
              },
            },
          },
        },
        {
          $and: [
            {
              $eq: [{ $size: { $ifNull: ["$stockLevels", []] } }, 0],
            },
            { $gt: ["$minimumQuantity", 0] },
            { $lte: ["$currentQuantity", "$minimumQuantity"] },
          ],
        },
      ],
    },
  };
};

const completeItemLocationScopeExpression = (
  allowedLocationIds: readonly string[],
): MongoFilter => {
  const allowedObjectIds = allowedLocationIds.map(toObjectId);
  const stockLevelCount = {
    $size: { $ifNull: ["$stockLevels", []] },
  };
  const legacyLocationCount = {
    $size: { $ifNull: ["$locations", []] },
  };

  return {
    $expr: {
      $or: [
        {
          $and: [
            { $gt: [stockLevelCount, 0] },
            {
              $eq: [
                stockLevelCount,
                {
                  $size: {
                    $filter: {
                      input: { $ifNull: ["$stockLevels", []] },
                      as: "level",
                      cond: {
                        $in: ["$$level.location", allowedObjectIds],
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
        {
          $and: [
            { $eq: [stockLevelCount, 0] },
            { $gt: [legacyLocationCount, 0] },
            {
              $eq: [
                legacyLocationCount,
                {
                  $size: {
                    $setIntersection: [
                      { $ifNull: ["$locations", []] },
                      allowedObjectIds,
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
};

const toScopedInventoryItem = (
  document: InventoryItemDocument,
  visibleLocationIds?: readonly string[] | null,
) => {
  const item = document.toObject() as Record<string, any>;
  const visible = visibleLocationIds
    ? new Set(visibleLocationIds.map(String))
    : null;
  const stockLevels = getCanonicalStockLevels(item).filter(
    (level) => !visible || visible.has(getReferenceId(level.location)),
  );

  // A legacy row without any location has no safe location-level projection.
  // It remains visible only to all-location members and keeps its exact global
  // compatibility values until explicitly migrated.
  if (
    !stockLevels.length &&
    !item.stockLevels?.length &&
    !item.locations?.length
  ) {
    return item;
  }

  item.stockLevels = stockLevels;
  item.locations = stockLevels.map((level) => level.location);
  item.currentQuantity = stockLevels.reduce(
    (total, level) => total + Number(level.currentQuantity || 0),
    0,
  );
  item.minimumQuantity = stockLevels.reduce(
    (total, level) => total + Number(level.minimumQuantity || 0),
    0,
  );

  return item;
};

export const inventoryRepository = {
  async listItems(filters: InventoryListFilters) {
    const { skip, limit } = getPagination(filters.page, filters.limit);
    const query: MongoFilter = {
      tenant: toObjectId(filters.tenantId),
    };

    if (
      filters.allowedLocationIds !== null &&
      filters.allowedLocationIds !== undefined
    ) {
      appendAnd(query, itemLocationCondition(filters.allowedLocationIds));
    }

    if (filters.location) {
      appendAnd(
        query,
        filters.allowedLocationIds === undefined ||
          filters.allowedLocationIds === null ||
          filters.allowedLocationIds.includes(filters.location)
          ? itemLocationCondition([filters.location])
          : { _id: { $in: [] } },
      );
    }

    if (filters.category) {
      query.category = filters.category as InventoryCategory;
    }

    if (filters.search) {
      const search = {
        $regex: escapeRegex(filters.search),
        $options: "i",
      };
      appendAnd(query, { $or: [{ name: search }, { sku: search }] });
    }

    const visibleLocationIds = filters.location
      ? [filters.location]
      : filters.allowedLocationIds;

    if (filters.lowStock) {
      appendAnd(query, lowStockExpression(visibleLocationIds));
    }

    const [documents, total] = await Promise.all([
      InventoryItem.find(query)
        .populate(populateItem(filters.tenantId))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      InventoryItem.countDocuments(query),
    ]);

    return {
      items: documents.map((item) =>
        toScopedInventoryItem(item, visibleLocationIds),
      ),
      total,
    };
  },

  async countActiveItems(
    tenantId: string,
    options: RepositoryOptions = {},
  ): Promise<number> {
    return InventoryItem.countDocuments({
      tenant: toObjectId(tenantId),
      isActive: true,
    })
      .session(options.session ?? null)
      .exec();
  },

  async createItem(
    tenantId: string,
    input: CreateInventoryItemPersistenceInput,
    options: RepositoryOptions = {},
  ): Promise<InventoryItemDocument> {
    const [item] = await InventoryItem.create(
      [
        {
          ...input,
          tenant: toObjectId(tenantId),
          category: input.category as InventoryCategory,
          unit: input.unit as InventoryUnit,
          stockLevels: input.stockLevels.map((level) => ({
            ...level,
            location: toObjectId(level.location),
          })),
          supplier: input.supplier ? toObjectId(input.supplier) : null,
        },
      ],
      { session: options.session ?? undefined },
    );

    return item;
  },

  async updateItem(
    item: InventoryItemDocument,
    input: UpdateInventoryItemPersistenceInput,
    options: RepositoryOptions = {},
  ): Promise<InventoryItemDocument> {
    if (input.name !== undefined) item.name = input.name;
    if (input.sku === null) item.set("sku", undefined);
    else if (input.sku !== undefined) item.sku = input.sku;
    if (input.category !== undefined) {
      item.category = input.category as InventoryCategory;
    }
    if (input.unit !== undefined) item.unit = input.unit as InventoryUnit;
    if (input.stockLevels !== undefined) {
      item.stockLevels = input.stockLevels.map((level) => ({
        ...level,
        location: toObjectId(level.location),
      })) as typeof item.stockLevels;
    }
    if (input.supplier !== undefined) {
      item.supplier = input.supplier ? toObjectId(input.supplier) : null;
    }
    if (input.averageUnitCostWithoutVat !== undefined) {
      item.averageUnitCostWithoutVat = input.averageUnitCostWithoutVat;
    }
    if (input.currency !== undefined) item.currency = input.currency;
    if (input.note !== undefined) item.note = input.note;
    if (input.isActive !== undefined) item.isActive = input.isActive;

    await item.save({ session: options.session ?? undefined });

    return item;
  },

  async findItemById(
    tenantId: string,
    itemId: string,
    options: RepositoryOptions = {},
  ): Promise<InventoryItemDocument | null> {
    return InventoryItem.findOne({
      _id: toObjectId(itemId),
      tenant: toObjectId(tenantId),
    })
      .session(options.session ?? null)
      .exec();
  },

  async claimItemStockSnapshot(
    params: {
      tenantId: string;
      itemId: string;
      locationId: string;
      updatedAt: string;
      currentQuantity: number;
      minimumQuantity: number;
    },
    options: RepositoryOptions = {},
  ): Promise<boolean> {
    const item = await InventoryItem.findOneAndUpdate(
      {
        _id: toObjectId(params.itemId),
        tenant: toObjectId(params.tenantId),
        updatedAt: new Date(params.updatedAt),
        stockLevels: {
          $elemMatch: {
            location: toObjectId(params.locationId),
            currentQuantity: params.currentQuantity,
            minimumQuantity: params.minimumQuantity,
          },
        },
      },
      {
        // A conditional no-op write holds the item in this transaction. A
        // concurrent stock/item edit therefore conflicts instead of racing
        // past the reviewed snapshot before the reorder is created.
        $set: {
          "stockLevels.$.currentQuantity": params.currentQuantity,
        },
      },
      {
        returnDocument: "before",
        projection: { _id: 1 },
        session: options.session ?? null,
        timestamps: false,
      },
    ).exec();

    return Boolean(item);
  },

  async findItemForResponse(
    tenantId: string,
    itemId: string,
    allowedLocationIds: readonly string[] | null = null,
  ): Promise<Record<string, unknown> | null> {
    const query: MongoFilter = {
      _id: toObjectId(itemId),
      tenant: toObjectId(tenantId),
    };

    if (allowedLocationIds !== null) {
      Object.assign(
        query,
        completeItemLocationScopeExpression(allowedLocationIds),
      );
    }

    const item = await InventoryItem.findOne(query)
      .populate(populateItem(tenantId))
      .exec();

    return item ? toScopedInventoryItem(item, null) : null;
  },

  async saveItem(
    item: InventoryItemDocument,
    options: RepositoryOptions = {},
  ): Promise<InventoryItemDocument> {
    await item.save({ session: options.session ?? undefined });
    return item;
  },

  async countItemsAtLocation(
    tenantId: string,
    itemIds: readonly string[],
    locationId: string,
  ): Promise<number> {
    return InventoryItem.countDocuments({
      _id: { $in: itemIds.map(toObjectId) },
      tenant: toObjectId(tenantId),
      ...itemLocationCondition([locationId]),
    }).exec();
  },

  async createMovement(
    tenantId: string,
    createdBy: string,
    input: CreateInventoryMovementPersistenceInput,
    options: RepositoryOptions = {},
  ): Promise<InventoryMovementDocument> {
    const [movement] = await InventoryMovement.create(
      [
        {
          ...input,
          tenant: toObjectId(tenantId),
          item: toObjectId(input.item),
          supplier: input.supplier ? toObjectId(input.supplier) : null,
          type: input.type as InventoryMovementType,
          reason: input.reason as InventoryMovementReason,
          vatRate: input.vatRate as VatRate,
          location: toObjectId(input.location),
          destinationLocation: input.destinationLocation
            ? toObjectId(input.destinationLocation)
            : null,
          audit: input.audit ? toObjectId(input.audit) : null,
          createdBy: toObjectId(createdBy),
        },
      ],
      { session: options.session ?? undefined },
    );

    return movement;
  },

  async findMovementForResponse(
    tenantId: string,
    movementId: string,
  ): Promise<InventoryMovementDocument | null> {
    return InventoryMovement.findOne({
      _id: toObjectId(movementId),
      tenant: toObjectId(tenantId),
    })
      .populate(populateMovement(tenantId))
      .exec();
  },

  async listMovements(filters: InventoryMovementFilters) {
    const { skip, limit } = getPagination(filters.page, filters.limit);
    const query: MongoFilter = {
      tenant: toObjectId(filters.tenantId),
    };

    if (
      filters.allowedLocationIds !== null &&
      filters.allowedLocationIds !== undefined
    ) {
      query.$or = [
        { location: { $in: filters.allowedLocationIds.map(toObjectId) } },
        {
          destinationLocation: {
            $in: filters.allowedLocationIds.map(toObjectId),
          },
        },
      ];
    }

    if (filters.item) query.item = toObjectId(filters.item);
    if (filters.type) query.type = filters.type as InventoryMovementType;

    if (filters.location) {
      const allowed =
        filters.allowedLocationIds === undefined ||
        filters.allowedLocationIds === null ||
        filters.allowedLocationIds.includes(filters.location);
      query.$or = allowed
        ? [
            { location: toObjectId(filters.location) },
            { destinationLocation: toObjectId(filters.location) },
          ]
        : [{ _id: { $in: [] } }];
    }

    const [movements, total] = await Promise.all([
      InventoryMovement.find(query)
        .populate(populateMovement(filters.tenantId))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      InventoryMovement.countDocuments(query),
    ]);

    return { movements, total };
  },

  async findActiveItemsAtLocation(
    tenantId: string,
    locationId: string,
    options: RepositoryOptions = {},
  ): Promise<InventoryItemDocument[]> {
    return InventoryItem.find({
      tenant: toObjectId(tenantId),
      isActive: true,
      ...itemLocationCondition([locationId]),
    })
      .session(options.session ?? null)
      .exec();
  },

  async createAudit(
    tenantId: string,
    createdBy: string,
    input: CreateInventoryAuditInput,
    items: Array<{
      item: string;
      expectedQuantity: number;
      actualQuantity: number;
    }>,
    options: RepositoryOptions = {},
  ): Promise<InventoryAuditDocument> {
    const [audit] = await InventoryAudit.create(
      [
        {
          tenant: toObjectId(tenantId),
          auditDate: input.auditDate,
          location: toObjectId(input.location),
          note: input.note,
          createdBy: toObjectId(createdBy),
          items: items.map((item) => ({
            ...item,
            item: toObjectId(item.item),
            difference: 0,
          })),
        },
      ],
      { session: options.session ?? undefined },
    );

    return audit;
  },

  async listAudits(
    tenantId: string,
    filters: {
      page?: number;
      limit?: number;
      location?: string;
      status?: string;
      allowedLocationIds?: readonly string[] | null;
    },
  ) {
    const { skip, limit } = getPagination(filters.page, filters.limit);
    const query: MongoFilter = { tenant: toObjectId(tenantId) };

    if (
      filters.allowedLocationIds !== null &&
      filters.allowedLocationIds !== undefined
    ) {
      query.location = { $in: filters.allowedLocationIds.map(toObjectId) };
    }
    if (filters.location) {
      query.location =
        filters.allowedLocationIds === undefined ||
        filters.allowedLocationIds === null ||
        filters.allowedLocationIds.includes(filters.location)
          ? toObjectId(filters.location)
          : { $in: [] };
    }
    if (filters.status) query.status = filters.status as InventoryAuditStatus;

    const [audits, total] = await Promise.all([
      InventoryAudit.find(query)
        .populate(populateAudit(tenantId))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      InventoryAudit.countDocuments(query),
    ]);

    return { audits, total };
  },

  async findAuditById(
    tenantId: string,
    auditId: string,
    options: RepositoryOptions & { populate?: boolean } = {},
  ): Promise<InventoryAuditDocument | null> {
    const query = InventoryAudit.findOne({
      _id: toObjectId(auditId),
      tenant: toObjectId(tenantId),
    }).session(options.session ?? null);

    if (options.populate) query.populate(populateAudit(tenantId));

    return query.exec();
  },

  async saveAudit(
    audit: InventoryAuditDocument,
    options: RepositoryOptions = {},
  ): Promise<InventoryAuditDocument> {
    await audit.save({ session: options.session ?? undefined });
    return audit;
  },

  async createReorderRequest(
    params: {
      tenantId: string;
      itemId: string;
      supplierId?: string | null;
      locationId: string;
      currentQuantity: number;
      recommendedQuantity: number;
      requestedQuantity: number;
      priority: string;
      note: string;
      createdBy: string;
      source?: "manual" | "ai";
      aiActionId?: string | null;
    },
    options: RepositoryOptions = {},
  ): Promise<ReorderRequestDocument> {
    const [request] = await ReorderRequest.create(
      [
        {
          tenant: toObjectId(params.tenantId),
          item: toObjectId(params.itemId),
          supplier: params.supplierId ? toObjectId(params.supplierId) : null,
          location: toObjectId(params.locationId),
          currentQuantity: params.currentQuantity,
          recommendedQuantity: params.recommendedQuantity,
          requestedQuantity: params.requestedQuantity,
          priority: params.priority as ReorderPriority,
          note: params.note,
          source: params.source || "manual",
          aiActionId: params.aiActionId ? toObjectId(params.aiActionId) : null,
          createdBy: toObjectId(params.createdBy),
        },
      ],
      { session: options.session ?? undefined },
    );

    return request;
  },

  async upsertOpenReorderRequest(
    params: {
      tenantId: string;
      itemId: string;
      supplierId?: string | null;
      locationId: string;
      currentQuantity: number;
      recommendedQuantity: number;
      priority: string;
      note: string;
      createdBy: string;
    },
    options: RepositoryOptions = {},
  ): Promise<ReorderRequestDocument> {
    return ReorderRequest.findOneAndUpdate(
      {
        tenant: toObjectId(params.tenantId),
        item: toObjectId(params.itemId),
        location: toObjectId(params.locationId),
        status: REORDER_STATUS.OPEN,
      },
      {
        $set: {
          currentQuantity: params.currentQuantity,
          recommendedQuantity: params.recommendedQuantity,
          supplier: params.supplierId ? toObjectId(params.supplierId) : null,
        },
        $setOnInsert: {
          requestedQuantity: params.recommendedQuantity,
          priority: params.priority as ReorderPriority,
          note: params.note,
          source: "automatic",
          createdBy: toObjectId(params.createdBy),
        },
      },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        session: options.session ?? undefined,
      },
    ).exec();
  },

  async listReorderRequests(
    tenantId: string,
    filters: {
      page?: number;
      limit?: number;
      location?: string;
      status?: string;
      priority?: string;
      allowedLocationIds?: readonly string[] | null;
    },
  ) {
    const { skip, limit } = getPagination(filters.page, filters.limit);
    const query: MongoFilter = { tenant: toObjectId(tenantId) };

    if (
      filters.allowedLocationIds !== null &&
      filters.allowedLocationIds !== undefined
    ) {
      query.location = { $in: filters.allowedLocationIds.map(toObjectId) };
    }
    if (filters.location) {
      query.location =
        filters.allowedLocationIds === undefined ||
        filters.allowedLocationIds === null ||
        filters.allowedLocationIds.includes(filters.location)
          ? toObjectId(filters.location)
          : { $in: [] };
    }
    if (filters.status) query.status = filters.status as ReorderStatus;
    if (filters.priority) query.priority = filters.priority as ReorderPriority;

    const [requests, total] = await Promise.all([
      ReorderRequest.find(query)
        .populate(populateReorder(tenantId))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      ReorderRequest.countDocuments(query),
    ]);

    return { requests, total };
  },

  async findReorderRequestById(
    tenantId: string,
    requestId: string,
    options: RepositoryOptions & { populate?: boolean } = {},
  ): Promise<ReorderRequestDocument | null> {
    const query = ReorderRequest.findOne({
      _id: toObjectId(requestId),
      tenant: toObjectId(tenantId),
    }).session(options.session ?? null);

    if (options.populate) query.populate(populateReorder(tenantId));

    return query.exec();
  },

  async findActiveReorderForItemLocation(
    tenantId: string,
    itemId: string,
    locationId: string,
    options: RepositoryOptions = {},
  ): Promise<ReorderRequestDocument | null> {
    return ReorderRequest.findOne({
      tenant: toObjectId(tenantId),
      item: toObjectId(itemId),
      location: toObjectId(locationId),
      status: { $in: [REORDER_STATUS.OPEN, REORDER_STATUS.ORDERED] },
    })
      .select("+aiActionId")
      .session(options.session ?? null)
      .exec();
  },

  async hasActiveReorderForItemLocation(
    tenantId: string,
    itemId: string,
    locationId: string,
    options: RepositoryOptions = {},
  ): Promise<boolean> {
    const query = ReorderRequest.exists({
      tenant: toObjectId(tenantId),
      item: toObjectId(itemId),
      location: toObjectId(locationId),
      status: { $in: [REORDER_STATUS.OPEN, REORDER_STATUS.ORDERED] },
    });
    if (options.session) query.session(options.session);

    return Boolean(await query.exec());
  },

  async hasDraftAuditForItemLocation(
    tenantId: string,
    itemId: string,
    locationId: string,
    options: RepositoryOptions = {},
  ): Promise<boolean> {
    const query = InventoryAudit.exists({
      tenant: toObjectId(tenantId),
      location: toObjectId(locationId),
      status: INVENTORY_AUDIT_STATUS.DRAFT,
      "items.item": toObjectId(itemId),
    });
    if (options.session) query.session(options.session);

    return Boolean(await query.exec());
  },

  async findAutomaticOpenReorderForItemLocation(
    tenantId: string,
    itemId: string,
    locationId: string,
    options: RepositoryOptions = {},
  ): Promise<ReorderRequestDocument | null> {
    return ReorderRequest.findOne({
      tenant: toObjectId(tenantId),
      item: toObjectId(itemId),
      location: toObjectId(locationId),
      status: REORDER_STATUS.OPEN,
      source: "automatic",
    })
      .session(options.session ?? null)
      .exec();
  },

  async saveReorderRequest(
    request: ReorderRequestDocument,
    options: RepositoryOptions = {},
  ): Promise<ReorderRequestDocument> {
    await request.save({ session: options.session ?? undefined });
    return request;
  },

  auditStatus: INVENTORY_AUDIT_STATUS,
};
