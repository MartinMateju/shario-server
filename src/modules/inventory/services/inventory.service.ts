import mongoose, { type ClientSession } from "mongoose";

import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";
import { Supplier } from "@/modules/supplies/supplier.model.js";
import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationsWithinWorkspaceScope,
  type AllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/index.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { emitWorkspaceNotificationEvent } from "@/modules/workspace-notifications/workspace-notification.events.js";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";
import {
  assertCurrencyAmountFields,
  resolveFinancialRecordCurrency,
} from "@/shared/money/financial-record.js";
import {
  normalizeStudioCommerceCurrency,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

import {
  INVENTORY_AUDIT_STATUS,
  INVENTORY_MOVEMENT_REASON,
  INVENTORY_MOVEMENT_TYPE,
  REORDER_PRIORITY,
  REORDER_STATUS,
  type InventoryCategory,
  type InventoryMovementType,
} from "../inventory.constants.js";
import { inventoryRepository } from "../inventory.repository.js";
import {
  getCanonicalStockLevels,
  type InventoryStockLevelLike,
} from "../inventory-stock-levels.js";
import type {
  InventoryItemDocument,
  InventoryListFilters,
  InventoryMovementFilters,
  ReorderRequestDocument,
} from "../inventory.types.js";
import type {
  CreateInventoryAuditInput,
  CreateInventoryItemInput,
  CreateInventoryMovementInput,
  CreateReorderRequestInput,
  ReceiveReorderRequestInput,
  UpdateInventoryAuditInput,
  UpdateInventoryItemInput,
  UpdateReorderRequestInput,
} from "../inventory.validators.js";
import { calculateAverageCost, toObjectId } from "../inventory.utils.js";

type ListInventoryItemsServiceFilters = Omit<
  InventoryListFilters,
  "category"
> & {
  category?: string;
};

type ListInventoryMovementsServiceFilters = Omit<
  InventoryMovementFilters,
  "type"
> & {
  type?: string;
};

type MutableStockLevel = InventoryStockLevelLike<mongoose.Types.ObjectId>;

type LowStockNotificationCandidate = {
  requestId: string;
  itemId: string;
  itemName: string;
  locationId: string;
  currentQuantity: number;
  minimumQuantity: number;
};

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === 11000,
  );

const runInTransaction = async <T>(
  task: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();

  try {
    let result: T | undefined;

    await session.withTransaction(async () => {
      result = await task(session);
    });

    if (result === undefined) {
      throw new Error("Inventory transaction completed without a result.");
    }

    return result;
  } finally {
    await session.endSession();
  }
};

const getTenantCurrency = (tenant: TenantDocument): StudioCommerceCurrency =>
  normalizeStudioCommerceCurrency(tenant.settings.currency);

const getItemLocationIds = (item: InventoryItemDocument): string[] => {
  const levels = getCanonicalStockLevels(item as never);
  if (levels.length) return levels.map((level) => String(level.location));

  return Array.from(item.locations || [], String);
};

const assertItemWithinLocationScope = (
  item: InventoryItemDocument,
  allowedLocationIds: AllowedWorkspaceLocationIds,
): void => {
  const locationIds = getItemLocationIds(item);

  if (!locationIds.length) {
    assertCanAccessAllWorkspaceLocations(allowedLocationIds);
    return;
  }

  assertLocationIdsWithinWorkspaceScope(locationIds, allowedLocationIds);
};

const assertCanResolveLocationlessLegacyStock = (
  item: InventoryItemDocument,
  allowedLocationIds: AllowedWorkspaceLocationIds,
): void => {
  if (!getItemLocationIds(item).length) {
    assertCanAccessAllWorkspaceLocations(allowedLocationIds);
  }
};

/**
 * Runtime-safe lazy migration. An orphaned legacy global item is assigned only
 * when an owner explicitly performs an operation at a chosen tenant location;
 * passive reads never guess or erase its stock.
 */
const getMutableStockLevels = (
  item: InventoryItemDocument,
  explicitFallbackLocation?: string,
): MutableStockLevel[] => {
  let levels = getCanonicalStockLevels(item as never).map((level) => ({
    location: toObjectId(String(level.location)),
    currentQuantity: Number(level.currentQuantity || 0),
    minimumQuantity: Number(level.minimumQuantity || 0),
  }));

  if (!levels.length && explicitFallbackLocation) {
    levels = [
      {
        location: toObjectId(explicitFallbackLocation),
        currentQuantity: Number(item.currentQuantity || 0),
        minimumQuantity: Number(item.minimumQuantity || 0),
      },
    ];
  }

  return levels;
};

const assignStockLevels = (
  item: InventoryItemDocument,
  levels: MutableStockLevel[],
): void => {
  item.stockLevels = levels as typeof item.stockLevels;
};

const findStockLevel = (
  levels: MutableStockLevel[],
  locationId: string,
): MutableStockLevel | undefined =>
  levels.find((level) => String(level.location) === locationId);

const assertSupplierBelongsToTenant = async ({
  tenantId,
  supplierId,
  session,
}: {
  tenantId: string;
  supplierId?: string | null;
  session?: ClientSession | null;
}): Promise<void> => {
  if (!supplierId) return;

  const query = Supplier.exists({
    _id: toObjectId(supplierId),
    tenant: toObjectId(tenantId),
  });
  if (session) query.session(session);

  if (!(await query.exec())) {
    notFound("Supplier not found.");
  }
};

const assertInventoryCapacity = async (
  tenant: TenantDocument,
  session: ClientSession,
): Promise<void> => {
  const tenantId = String(tenant._id);
  const currentTenant = await TenantModel.findOneAndUpdate(
    { _id: tenantId },
    { $inc: { accessControlVersion: 1 } },
    { returnDocument: "after", session },
  ).exec();
  if (!currentTenant) notFound("Tenant not found.");
  const activeInventoryItems = await inventoryRepository.countActiveItems(
    tenantId,
    { session },
  );
  const inventoryItemLimit = Math.max(
    Number(currentTenant.limits?.inventoryItems ?? 0),
    0,
  );

  if (activeInventoryItems >= inventoryItemLimit) {
    conflict({
      message: "Your current plan has reached its active inventory item limit.",
      code: "INVENTORY_ITEM_LIMIT_REACHED",
      details: {
        activeInventoryItems,
        inventoryItemLimit,
        plan: currentTenant.plan,
        upgradeRequired: true,
      },
    });
  }
};

const syncLowStockReorder = async ({
  tenantId,
  item,
  level,
  actorId,
  session,
  note,
}: {
  tenantId: string;
  item: InventoryItemDocument;
  level: MutableStockLevel;
  actorId: string;
  session: ClientSession;
  note: string;
}): Promise<LowStockNotificationCandidate | null> => {
  const itemId = String(item._id);
  const locationId = String(level.location);
  const currentQuantity = Number(level.currentQuantity || 0);
  const minimumQuantity = Number(level.minimumQuantity || 0);
  const isLow = minimumQuantity > 0 && currentQuantity <= minimumQuantity;

  if (!isLow) {
    const automatic =
      await inventoryRepository.findAutomaticOpenReorderForItemLocation(
        tenantId,
        itemId,
        locationId,
        { session },
      );

    if (automatic) {
      automatic.status = REORDER_STATUS.CANCELLED;
      automatic.resolvedBy = toObjectId(actorId);
      automatic.resolvedAt = new Date();
      await inventoryRepository.saveReorderRequest(automatic, { session });
    }
    return null;
  }

  const existing = await inventoryRepository.findActiveReorderForItemLocation(
    tenantId,
    itemId,
    locationId,
    { session },
  );

  // An ordered request or a manually curated open request already represents
  // this item/location and must not be duplicated or overwritten.
  if (
    existing &&
    (existing.status === REORDER_STATUS.ORDERED ||
      String(existing.source || "manual") === "manual")
  ) {
    return null;
  }

  const supplierId = item.supplier ? String(item.supplier) : null;
  await assertSupplierBelongsToTenant({
    tenantId,
    supplierId,
    session,
  });

  const recommendedQuantity = Math.max(
    minimumQuantity * 2 - currentQuantity,
    Number.EPSILON,
  );

  const request = await inventoryRepository.upsertOpenReorderRequest(
    {
      tenantId,
      itemId,
      supplierId,
      locationId,
      currentQuantity,
      recommendedQuantity,
      priority:
        currentQuantity === 0 ? REORDER_PRIORITY.HIGH : REORDER_PRIORITY.MEDIUM,
      note,
      createdBy: actorId,
    },
    { session },
  );

  // Updating the quantities on an already-open automatic request is not a new
  // operational event. Emit only for the first automatic request.
  if (existing) return null;

  return {
    requestId: String(request._id),
    itemId,
    itemName: String(item.name || "Inventory item"),
    locationId,
    currentQuantity,
    minimumQuantity,
  };
};

const emitLowStockEvents = (
  tenantId: string,
  candidates: readonly LowStockNotificationCandidate[],
): void => {
  for (const candidate of candidates) {
    emitWorkspaceNotificationEvent({
      tenantId,
      requiredPermission: WORKSPACE_PERMISSION.INVENTORY_VIEW,
      preferenceKey: "inventoryAlerts",
      locationId: candidate.locationId,
      eventType: "inventory.low",
      category: "inventory",
      severity: candidate.currentQuantity === 0 ? "critical" : "warning",
      title: {
        en: "Low inventory",
        cs: "Nízký stav zásob",
      },
      message: {
        en:
          candidate.itemName +
          " is at " +
          candidate.currentQuantity +
          " (minimum " +
          candidate.minimumQuantity +
          ").",
        cs:
          candidate.itemName +
          " má stav " +
          candidate.currentQuantity +
          " (minimum " +
          candidate.minimumQuantity +
          ").",
      },
      actionUrl: "/app/operations?section=inventory",
      sourceType: "reorder-request",
      sourceId: candidate.requestId,
      deduplicationKey: "inventory-reorder:" + candidate.requestId + ":created",
      groupKey: "inventory.low",
    });
  }
};

const getReorderForResponse = async (
  tenantId: string,
  requestId: string,
): Promise<ReorderRequestDocument> => {
  const request = await inventoryRepository.findReorderRequestById(
    tenantId,
    requestId,
    { populate: true },
  );
  if (!request) notFound("Reorder request not found.");

  return request;
};

export const inventoryService = {
  async listItems(filters: ListInventoryItemsServiceFilters) {
    return inventoryRepository.listItems({
      ...filters,
      category: filters.category as InventoryCategory | undefined,
    });
  },

  async getItem(
    tenantId: string,
    itemId: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const item = await inventoryRepository.findItemById(tenantId, itemId);
    if (!item) notFound("Inventory item not found.");

    assertItemWithinLocationScope(item, allowedLocationIds);

    const response = await inventoryRepository.findItemForResponse(
      tenantId,
      itemId,
      allowedLocationIds,
    );

    // The item may have gained a location between authorization and the
    // guarded response query. Fail closed rather than returning a partial
    // object that could later be submitted as a full PATCH replacement.
    if (!response) {
      notFound({
        message: "Location not found.",
        code: "WORKSPACE_LOCATION_NOT_FOUND",
      });
    }

    return response;
  },

  async createItem(
    tenantId: string,
    createdBy: string,
    input: CreateInventoryItemInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const locationIds = input.stockLevels.map((level) => level.location);

    await assertTenantLocationsWithinWorkspaceScope({
      tenantId,
      locationIds,
      allowedLocationIds,
    });

    const tenant = await getTenantOrThrow(tenantId);
    const currency = getTenantCurrency(tenant);

    assertCurrencyAmountFields(
      { averageUnitCostWithoutVat: input.averageUnitCostWithoutVat },
      currency,
    );

    let itemId = "";
    let lowStockNotifications: LowStockNotificationCandidate[] = [];

    try {
      const result = await runInTransaction(async (session) => {
        const candidates: LowStockNotificationCandidate[] = [];
        await assertSupplierBelongsToTenant({
          tenantId,
          supplierId: input.supplier,
          session,
        });
        if (input.isActive) await assertInventoryCapacity(tenant, session);

        const item = await inventoryRepository.createItem(
          tenantId,
          { ...input, currency },
          { session },
        );

        for (const level of getMutableStockLevels(item)) {
          if (level.currentQuantity > 0) {
            await inventoryRepository.createMovement(
              tenantId,
              createdBy,
              {
                item: String(item._id),
                supplier: input.supplier,
                type: INVENTORY_MOVEMENT_TYPE.ADJUSTMENT,
                reason: INVENTORY_MOVEMENT_REASON.MANUAL_ADJUSTMENT,
                location: String(level.location),
                destinationLocation: null,
                quantity: level.currentQuantity,
                unitCostWithoutVat: input.averageUnitCostWithoutVat,
                vatRate: 21,
                invoiceNumber: "",
                note: "Opening inventory balance.",
                currency,
              },
              { session },
            );
          }

          const candidate = await syncLowStockReorder({
            tenantId,
            item,
            level,
            actorId: createdBy,
            session,
            note: "Automatically created from the inventory threshold.",
          });
          if (candidate) candidates.push(candidate);
        }

        return {
          itemId: String(item._id),
          lowStockNotifications: candidates,
        };
      });
      itemId = result.itemId;
      lowStockNotifications = result.lowStockNotifications;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        conflict({
          message: "An inventory item with this SKU already exists.",
          code: "INVENTORY_SKU_CONFLICT",
        });
      }
      throw error;
    }

    emitLowStockEvents(tenantId, lowStockNotifications);
    return inventoryRepository.findItemForResponse(
      tenantId,
      itemId,
      allowedLocationIds,
    );
  },

  async updateItem(
    tenantId: string,
    itemId: string,
    updatedBy: string,
    input: UpdateInventoryItemInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const existingItem = await inventoryRepository.findItemById(
      tenantId,
      itemId,
    );
    if (!existingItem) notFound("Inventory item not found.");

    assertItemWithinLocationScope(existingItem, allowedLocationIds);

    if (input.stockLevels) {
      await assertTenantLocationsWithinWorkspaceScope({
        tenantId,
        locationIds: input.stockLevels.map((level) => level.location),
        allowedLocationIds,
      });
    }

    const tenant = await getTenantOrThrow(tenantId);
    let currencyPatch: { currency?: StudioCommerceCurrency } = {};

    if (input.averageUnitCostWithoutVat !== undefined) {
      const resolution = resolveFinancialRecordCurrency({
        tenantCurrency: getTenantCurrency(tenant),
        recordCurrency: existingItem.currency,
        existingAmounts: [Number(existingItem.averageUnitCostWithoutVat || 0)],
      });
      assertCurrencyAmountFields(
        { averageUnitCostWithoutVat: input.averageUnitCostWithoutVat },
        resolution.currency,
      );
      if (resolution.persistSnapshot) {
        currencyPatch = { currency: resolution.currency };
      }
    }

    let lowStockNotifications: LowStockNotificationCandidate[] = [];
    try {
      lowStockNotifications = await runInTransaction(async (session) => {
        const candidates: LowStockNotificationCandidate[] = [];
        const item = await inventoryRepository.findItemById(tenantId, itemId, {
          session,
        });
        if (!item) notFound("Inventory item not found.");
        assertItemWithinLocationScope(item, allowedLocationIds);

        await assertSupplierBelongsToTenant({
          tenantId,
          supplierId:
            input.supplier !== undefined
              ? input.supplier
              : item.supplier
                ? String(item.supplier)
                : null,
          session,
        });

        if (input.isActive === true && !item.isActive) {
          await assertInventoryCapacity(tenant, session);
        }

        let mergedStockLevels:
          | Array<{
              location: string;
              currentQuantity: number;
              minimumQuantity: number;
            }>
          | undefined;

        if (input.stockLevels) {
          const currentLevels = getMutableStockLevels(
            item,
            input.stockLevels[0]?.location,
          );
          const nextLocationIds = new Set(
            input.stockLevels.map((level) => level.location),
          );

          const removedWithStock = currentLevels.find(
            (level) =>
              !nextLocationIds.has(String(level.location)) &&
              Number(level.currentQuantity || 0) > 0,
          );
          if (removedWithStock) {
            badRequest(
              "Move or remove the remaining stock before removing this location.",
            );
          }

          for (const currentLevel of currentLevels) {
            const locationId = String(currentLevel.location);
            if (nextLocationIds.has(locationId)) continue;

            const [hasReorder, hasDraftAudit] = await Promise.all([
              inventoryRepository.hasActiveReorderForItemLocation(
                tenantId,
                itemId,
                locationId,
                { session },
              ),
              inventoryRepository.hasDraftAuditForItemLocation(
                tenantId,
                itemId,
                locationId,
                { session },
              ),
            ]);
            if (hasReorder || hasDraftAudit) {
              conflict(
                "Complete or cancel active reorders and stocktakes before removing this location.",
              );
            }
          }

          mergedStockLevels = input.stockLevels.map((level) => {
            const current = findStockLevel(currentLevels, level.location);
            return {
              location: level.location,
              currentQuantity: Number(current?.currentQuantity || 0),
              minimumQuantity: level.minimumQuantity,
            };
          });
        }

        const { stockLevels: _submittedStockLevels, ...metadataInput } = input;

        await inventoryRepository.updateItem(
          item,
          {
            ...metadataInput,
            ...currencyPatch,
            ...(mergedStockLevels ? { stockLevels: mergedStockLevels } : {}),
          },
          { session },
        );

        for (const level of getMutableStockLevels(item)) {
          const candidate = await syncLowStockReorder({
            tenantId,
            item,
            level,
            actorId: updatedBy,
            session,
            note: "Automatically updated from the inventory threshold.",
          });
          if (candidate) candidates.push(candidate);
        }

        return candidates;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        conflict({
          message: "An inventory item with this SKU already exists.",
          code: "INVENTORY_SKU_CONFLICT",
        });
      }
      throw error;
    }

    emitLowStockEvents(tenantId, lowStockNotifications);
    return inventoryRepository.findItemForResponse(
      tenantId,
      itemId,
      allowedLocationIds,
    );
  },

  async createMovement(
    tenantId: string,
    createdBy: string,
    input: CreateInventoryMovementInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    if (input.type === INVENTORY_MOVEMENT_TYPE.AUDIT) {
      badRequest("Audit movements are created by stocktake completion only.");
    }

    const movementLocationIds = [
      input.location,
      ...(input.destinationLocation ? [input.destinationLocation] : []),
    ];
    await assertTenantLocationsWithinWorkspaceScope({
      tenantId,
      locationIds: movementLocationIds,
      allowedLocationIds,
    });

    const tenant = await getTenantOrThrow(tenantId);
    const tenantCurrency = getTenantCurrency(tenant);
    assertCurrencyAmountFields(
      { unitCostWithoutVat: input.unitCostWithoutVat },
      tenantCurrency,
    );

    const result = await runInTransaction(async (session) => {
      const candidates: LowStockNotificationCandidate[] = [];
      await assertSupplierBelongsToTenant({
        tenantId,
        supplierId: input.supplier,
        session,
      });

      const item = await inventoryRepository.findItemById(
        tenantId,
        input.item,
        { session },
      );
      if (!item) notFound("Inventory item not found.");
      assertCanResolveLocationlessLegacyStock(item, allowedLocationIds);

      const levels = getMutableStockLevels(item, input.location);
      const source = findStockLevel(levels, input.location);
      if (!source) {
        badRequest("Inventory item is not available at the selected location.");
      }

      const movementQuantity = Number(input.quantity || 0);
      const beforeTotal = levels.reduce(
        (total, level) => total + Number(level.currentQuantity || 0),
        0,
      );
      let nextAverageCost: number | undefined;

      if (
        (input.type === INVENTORY_MOVEMENT_TYPE.OUT ||
          input.type === INVENTORY_MOVEMENT_TYPE.TRANSFER) &&
        source.currentQuantity < movementQuantity
      ) {
        badRequest("Not enough stock available.");
      }

      if (input.type === INVENTORY_MOVEMENT_TYPE.IN) {
        source.currentQuantity += movementQuantity;
        const resolution = resolveFinancialRecordCurrency({
          tenantCurrency,
          recordCurrency: item.currency,
          existingAmounts: [Number(item.averageUnitCostWithoutVat || 0)],
        });
        nextAverageCost = calculateAverageCost({
          currentQuantity: beforeTotal,
          currentAverageCost: Number(item.averageUnitCostWithoutVat || 0),
          addedQuantity: movementQuantity,
          addedUnitCost: Number(input.unitCostWithoutVat || 0),
          currency: resolution.currency,
        });
        if (resolution.persistSnapshot) item.currency = resolution.currency;
      } else if (input.type === INVENTORY_MOVEMENT_TYPE.OUT) {
        source.currentQuantity -= movementQuantity;
      } else if (input.type === INVENTORY_MOVEMENT_TYPE.ADJUSTMENT) {
        source.currentQuantity = movementQuantity;
      } else if (input.type === INVENTORY_MOVEMENT_TYPE.TRANSFER) {
        source.currentQuantity -= movementQuantity;
        let destination = findStockLevel(
          levels,
          String(input.destinationLocation),
        );
        if (!destination) {
          destination = {
            location: toObjectId(String(input.destinationLocation)),
            currentQuantity: 0,
            minimumQuantity: 0,
          };
          levels.push(destination);
        }
        destination.currentQuantity += movementQuantity;
      }

      if (nextAverageCost !== undefined) {
        item.averageUnitCostWithoutVat = nextAverageCost;
      }
      assignStockLevels(item, levels);
      await inventoryRepository.saveItem(item, { session });

      const movement = await inventoryRepository.createMovement(
        tenantId,
        createdBy,
        {
          ...input,
          reason:
            input.type === INVENTORY_MOVEMENT_TYPE.TRANSFER
              ? INVENTORY_MOVEMENT_REASON.TRANSFER
              : input.reason,
          currency: tenantCurrency,
        },
        { session },
      );

      const changedLocationIds = new Set(movementLocationIds);
      for (const level of levels) {
        if (changedLocationIds.has(String(level.location))) {
          const candidate = await syncLowStockReorder({
            tenantId,
            item,
            level,
            actorId: createdBy,
            session,
            note: "Automatically created after a stock movement.",
          });
          if (candidate) candidates.push(candidate);
        }
      }

      return {
        movementId: String(movement._id),
        lowStockNotifications: candidates,
      };
    });

    emitLowStockEvents(tenantId, result.lowStockNotifications);
    return inventoryRepository.findMovementForResponse(
      tenantId,
      result.movementId,
    );
  },

  async listMovements(filters: ListInventoryMovementsServiceFilters) {
    return inventoryRepository.listMovements({
      ...filters,
      type: filters.type as InventoryMovementType | undefined,
    });
  },

  async createAudit(
    tenantId: string,
    createdBy: string,
    input: CreateInventoryAuditInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    await assertTenantLocationsWithinWorkspaceScope({
      tenantId,
      locationIds: [input.location],
      allowedLocationIds,
    });

    const auditId = await runInTransaction(async (session) => {
      const items = await inventoryRepository.findActiveItemsAtLocation(
        tenantId,
        input.location,
        { session },
      );
      const snapshots: Array<{
        item: string;
        expectedQuantity: number;
        actualQuantity: number;
      }> = [];

      for (const item of items) {
        const hadCanonicalStock = Boolean(item.stockLevels?.length);
        const levels = getMutableStockLevels(item);
        const level = findStockLevel(levels, input.location);
        if (!level) continue;

        if (!hadCanonicalStock) {
          assignStockLevels(item, levels);
          await inventoryRepository.saveItem(item, { session });
        }

        snapshots.push({
          item: String(item._id),
          expectedQuantity: level.currentQuantity,
          actualQuantity: level.currentQuantity,
        });
      }

      const audit = await inventoryRepository.createAudit(
        tenantId,
        createdBy,
        input,
        snapshots,
        { session },
      );
      return String(audit._id);
    });

    return inventoryRepository.findAuditById(tenantId, auditId, {
      populate: true,
    });
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
    return inventoryRepository.listAudits(tenantId, filters);
  },

  async updateAudit(
    tenantId: string,
    auditId: string,
    input: UpdateInventoryAuditInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const existingAudit = await inventoryRepository.findAuditById(
      tenantId,
      auditId,
    );
    if (!existingAudit) notFound("Inventory audit not found.");
    assertLocationIdsWithinWorkspaceScope(
      [String(existingAudit.location)],
      allowedLocationIds,
    );
    if (existingAudit.status !== INVENTORY_AUDIT_STATUS.DRAFT) {
      conflict("Inventory audit is already completed.");
    }

    const expectedIds = existingAudit.items.map((item) => String(item.item));
    const suppliedIds = input.items.map((item) => item.item);
    if (
      new Set(suppliedIds).size !== suppliedIds.length ||
      expectedIds.length !== suppliedIds.length ||
      expectedIds.some((id) => !suppliedIds.includes(id))
    ) {
      badRequest(
        "Audit counts must contain every snapshotted item exactly once.",
      );
    }

    await runInTransaction(async (session) => {
      const audit = await inventoryRepository.findAuditById(tenantId, auditId, {
        session,
      });
      if (!audit || audit.status !== INVENTORY_AUDIT_STATUS.DRAFT) {
        conflict("Inventory audit is already completed.");
      }

      const counts = new Map(input.items.map((item) => [item.item, item]));
      for (const auditItem of audit.items) {
        const count = counts.get(String(auditItem.item));
        if (!count) {
          badRequest("Audit snapshot does not match the submitted counts.");
        }
        auditItem.actualQuantity = count.actualQuantity;
        auditItem.difference =
          count.actualQuantity - Number(auditItem.expectedQuantity || 0);
        auditItem.note = count.note;
      }
      if (input.note !== undefined) audit.note = input.note;
      await inventoryRepository.saveAudit(audit, { session });
      return true;
    });

    return inventoryRepository.findAuditById(tenantId, auditId, {
      populate: true,
    });
  },

  async completeAudit(
    tenantId: string,
    auditId: string,
    completedBy: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const existingAudit = await inventoryRepository.findAuditById(
      tenantId,
      auditId,
    );
    if (!existingAudit) notFound("Inventory audit not found.");
    assertLocationIdsWithinWorkspaceScope(
      [String(existingAudit.location)],
      allowedLocationIds,
    );

    const tenant = await getTenantOrThrow(tenantId);
    const tenantCurrency = getTenantCurrency(tenant);

    const lowStockNotifications = await runInTransaction(async (session) => {
      const candidates: LowStockNotificationCandidate[] = [];
      const audit = await inventoryRepository.findAuditById(tenantId, auditId, {
        session,
      });
      if (!audit) notFound("Inventory audit not found.");
      if (audit.status !== INVENTORY_AUDIT_STATUS.DRAFT) {
        conflict("Inventory audit is already completed.");
      }

      for (const auditItem of audit.items) {
        const itemId = String(auditItem.item);
        const item = await inventoryRepository.findItemById(tenantId, itemId, {
          session,
        });
        if (!item) {
          conflict("An item in this audit no longer exists.");
        }

        const levels = getMutableStockLevels(item, String(audit.location));
        const level = findStockLevel(levels, String(audit.location));
        if (!level) {
          conflict("An item is no longer assigned to the audit location.");
        }

        const expected = Number(auditItem.expectedQuantity || 0);
        if (Number(level.currentQuantity || 0) !== expected) {
          conflict({
            message:
              "Stock changed after this audit started. Start a new stocktake.",
            code: "INVENTORY_AUDIT_STALE",
            details: { itemId, expected, current: level.currentQuantity },
          });
        }

        const actual = Number(auditItem.actualQuantity || 0);
        const difference = actual - expected;
        level.currentQuantity = actual;
        assignStockLevels(item, levels);
        await inventoryRepository.saveItem(item, { session });

        if (difference !== 0) {
          await inventoryRepository.createMovement(
            tenantId,
            completedBy,
            {
              item: itemId,
              supplier: null,
              type: INVENTORY_MOVEMENT_TYPE.AUDIT,
              reason: INVENTORY_MOVEMENT_REASON.INVENTORY_AUDIT,
              location: String(audit.location),
              destinationLocation: null,
              quantity: Math.abs(difference),
              quantityDelta: difference,
              audit: String(audit._id),
              unitCostWithoutVat: 0,
              vatRate: 21,
              invoiceNumber: "",
              note:
                auditItem.note || audit.note || "Inventory audit adjustment.",
              currency: tenantCurrency,
            },
            { session },
          );
        }

        const candidate = await syncLowStockReorder({
          tenantId,
          item,
          level,
          actorId: completedBy,
          session,
          note: "Automatically created after inventory audit.",
        });
        if (candidate) candidates.push(candidate);
      }

      audit.status = INVENTORY_AUDIT_STATUS.COMPLETED;
      audit.completedBy = toObjectId(completedBy);
      audit.completedAt = new Date();
      await inventoryRepository.saveAudit(audit, { session });
      return candidates;
    });

    emitLowStockEvents(tenantId, lowStockNotifications);
    return inventoryRepository.findAuditById(tenantId, auditId, {
      populate: true,
    });
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
    return inventoryRepository.listReorderRequests(tenantId, filters);
  },

  async createReorderRequest(
    tenantId: string,
    createdBy: string,
    input: CreateReorderRequestInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
    metadata: {
      source?: "manual" | "ai";
      aiActionId?: string | null;
      expectedSnapshot?: {
        updatedAt: string;
        currentQuantity: number;
        minimumQuantity: number;
      };
    } = {},
  ) {
    await assertTenantLocationsWithinWorkspaceScope({
      tenantId,
      locationIds: [input.location],
      allowedLocationIds,
    });

    const requestId = await runInTransaction(async (session) => {
      const item = await inventoryRepository.findItemById(
        tenantId,
        input.item,
        { session },
      );
      if (!item) notFound("Inventory item not found.");
      assertCanResolveLocationlessLegacyStock(item, allowedLocationIds);

      const levels = getMutableStockLevels(item, input.location);
      const level = findStockLevel(levels, input.location);
      if (!level) {
        badRequest("Inventory item is not available at the selected location.");
      }

      if (metadata.expectedSnapshot) {
        const snapshotClaimed =
          await inventoryRepository.claimItemStockSnapshot(
            {
              tenantId,
              itemId: input.item,
              locationId: input.location,
              ...metadata.expectedSnapshot,
            },
            { session },
          );
        if (!snapshotClaimed) {
          conflict({
            message:
              "The inventory item changed after this action was proposed.",
            code: "AI_ACTION_TARGET_CHANGED",
          });
        }
      }

      const supplierId = item.supplier ? String(item.supplier) : null;
      await assertSupplierBelongsToTenant({
        tenantId,
        supplierId,
        session,
      });

      const existing =
        await inventoryRepository.findActiveReorderForItemLocation(
          tenantId,
          input.item,
          input.location,
          { session },
        );
      if (existing) return String(existing._id);

      const request = await inventoryRepository.createReorderRequest(
        {
          tenantId,
          itemId: input.item,
          supplierId,
          locationId: input.location,
          currentQuantity: level.currentQuantity,
          recommendedQuantity: input.requestedQuantity,
          requestedQuantity: input.requestedQuantity,
          priority: input.priority,
          note: input.note,
          createdBy,
          source: metadata.source,
          aiActionId: metadata.aiActionId,
        },
        { session },
      );
      return String(request._id);
    });

    return getReorderForResponse(tenantId, requestId);
  },

  async receiveReorderRequest(
    tenantId: string,
    requestId: string,
    input: ReceiveReorderRequestInput,
    receivedBy: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const existing = await inventoryRepository.findReorderRequestById(
      tenantId,
      requestId,
    );
    if (!existing) notFound("Reorder request not found.");
    assertLocationIdsWithinWorkspaceScope(
      [String(existing.location)],
      allowedLocationIds,
    );

    if (existing.status === REORDER_STATUS.RECEIVED) {
      if (!existing.receivedMovement) {
        conflict({
          message:
            "This legacy receipt has no stock movement and requires review before it can be retried.",
          code: "INVENTORY_REORDER_RECEIPT_REVIEW_REQUIRED",
        });
      }
      return getReorderForResponse(tenantId, requestId);
    }
    if (existing.status !== REORDER_STATUS.ORDERED) {
      conflict("Only an ordered reorder request can be received.");
    }

    const tenant = await getTenantOrThrow(tenantId);
    const tenantCurrency = getTenantCurrency(tenant);
    if (input.unitCostWithoutVat !== undefined) {
      assertCurrencyAmountFields(
        { unitCostWithoutVat: input.unitCostWithoutVat },
        tenantCurrency,
      );
    }

    const lowStockNotifications = await runInTransaction(async (session) => {
      const request = await inventoryRepository.findReorderRequestById(
        tenantId,
        requestId,
        { session },
      );
      if (!request) notFound("Reorder request not found.");
      if (request.status === REORDER_STATUS.RECEIVED) {
        if (!request.receivedMovement) {
          conflict({
            message:
              "This legacy receipt has no stock movement and requires review before it can be retried.",
            code: "INVENTORY_REORDER_RECEIPT_REVIEW_REQUIRED",
          });
        }
        return [];
      }
      if (request.status !== REORDER_STATUS.ORDERED) {
        conflict("Only an ordered reorder request can be received.");
      }

      const item = await inventoryRepository.findItemById(
        tenantId,
        String(request.item),
        { session },
      );
      if (!item) notFound("Inventory item not found.");
      assertCanResolveLocationlessLegacyStock(item, allowedLocationIds);

      const supplierId = request.supplier
        ? String(request.supplier)
        : item.supplier
          ? String(item.supplier)
          : null;
      await assertSupplierBelongsToTenant({
        tenantId,
        supplierId,
        session,
      });

      const locationId = String(request.location);
      const levels = getMutableStockLevels(item, locationId);
      const level = findStockLevel(levels, locationId);
      if (!level) {
        badRequest("Inventory item is not available at the reorder location.");
      }

      const receivedQuantity = Number(
        input.receivedQuantity ?? request.requestedQuantity,
      );
      const beforeTotal = levels.reduce(
        (total, stockLevel) => total + Number(stockLevel.currentQuantity || 0),
        0,
      );
      level.currentQuantity += receivedQuantity;

      // An omitted price means "cost unknown", not "free stock". Preserve the
      // existing weighted average unless the receiver explicitly supplies it.
      if (input.unitCostWithoutVat !== undefined) {
        const resolution = resolveFinancialRecordCurrency({
          tenantCurrency,
          recordCurrency: item.currency,
          existingAmounts: [Number(item.averageUnitCostWithoutVat || 0)],
        });
        item.averageUnitCostWithoutVat = calculateAverageCost({
          currentQuantity: beforeTotal,
          currentAverageCost: Number(item.averageUnitCostWithoutVat || 0),
          addedQuantity: receivedQuantity,
          addedUnitCost: input.unitCostWithoutVat,
          currency: resolution.currency,
        });
        if (resolution.persistSnapshot) item.currency = resolution.currency;
      }

      assignStockLevels(item, levels);
      await inventoryRepository.saveItem(item, { session });

      const movement = await inventoryRepository.createMovement(
        tenantId,
        receivedBy,
        {
          item: String(item._id),
          supplier: supplierId,
          type: INVENTORY_MOVEMENT_TYPE.IN,
          reason: INVENTORY_MOVEMENT_REASON.PURCHASE,
          location: locationId,
          destinationLocation: null,
          quantity: receivedQuantity,
          unitCostWithoutVat: input.unitCostWithoutVat ?? 0,
          vatRate: input.vatRate ?? 21,
          invoiceNumber: input.invoiceNumber ?? "",
          note: `Received reorder ${String(request._id)}.`,
          currency: tenantCurrency,
        },
        { session },
      );

      request.status = REORDER_STATUS.RECEIVED;
      request.receivedQuantity = receivedQuantity;
      request.receivedMovement = movement._id;
      request.resolvedBy = toObjectId(receivedBy);
      request.resolvedAt = new Date();
      await inventoryRepository.saveReorderRequest(request, { session });

      const candidate = await syncLowStockReorder({
        tenantId,
        item,
        level,
        actorId: receivedBy,
        session,
        note: "Automatically created because received stock remains low.",
      });
      return candidate ? [candidate] : [];
    });

    emitLowStockEvents(tenantId, lowStockNotifications);
    return getReorderForResponse(tenantId, requestId);
  },

  async updateReorderRequest(
    tenantId: string,
    requestId: string,
    input: UpdateReorderRequestInput,
    updatedBy: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    if (input.status === REORDER_STATUS.RECEIVED) {
      return this.receiveReorderRequest(
        tenantId,
        requestId,
        {
          receivedQuantity: input.receivedQuantity,
          unitCostWithoutVat: input.unitCostWithoutVat,
          vatRate: input.vatRate,
          invoiceNumber: input.invoiceNumber,
        },
        updatedBy,
        allowedLocationIds,
      );
    }

    const existing = await inventoryRepository.findReorderRequestById(
      tenantId,
      requestId,
    );
    if (!existing) notFound("Reorder request not found.");
    assertLocationIdsWithinWorkspaceScope(
      [String(existing.location)],
      allowedLocationIds,
    );

    if (
      existing.status === REORDER_STATUS.RECEIVED ||
      existing.status === REORDER_STATUS.CANCELLED
    ) {
      conflict("A terminal reorder request cannot be changed.");
    }
    if (
      input.status &&
      input.status !== existing.status &&
      input.status !== REORDER_STATUS.CANCELLED &&
      !(
        existing.status === REORDER_STATUS.OPEN &&
        input.status === REORDER_STATUS.ORDERED
      )
    ) {
      conflict("Invalid reorder status transition.");
    }
    if (
      input.receivedQuantity !== undefined ||
      input.unitCostWithoutVat !== undefined ||
      input.vatRate !== undefined ||
      input.invoiceNumber !== undefined
    ) {
      badRequest("Receiving details are only valid when status is received.");
    }

    await runInTransaction(async (session) => {
      const request = await inventoryRepository.findReorderRequestById(
        tenantId,
        requestId,
        { session },
      );
      if (!request) notFound("Reorder request not found.");
      if (
        request.status === REORDER_STATUS.RECEIVED ||
        request.status === REORDER_STATUS.CANCELLED
      ) {
        conflict("A terminal reorder request cannot be changed.");
      }

      if (input.requestedQuantity !== undefined) {
        request.requestedQuantity = input.requestedQuantity;
      }
      if (input.priority !== undefined) request.priority = input.priority;
      if (input.note !== undefined) request.note = input.note;
      if (input.status !== undefined) request.status = input.status;
      if (input.status === REORDER_STATUS.CANCELLED) {
        request.resolvedBy = toObjectId(updatedBy);
        request.resolvedAt = new Date();
      }

      await inventoryRepository.saveReorderRequest(request, { session });
      return true;
    });

    return getReorderForResponse(tenantId, requestId);
  },
};
