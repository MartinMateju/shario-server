import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenant: vi.fn(),
  supplierExists: vi.fn(),
  assertCanAccessAll: vi.fn(),
  assertLocationIds: vi.fn(),
  assertTenantLocations: vi.fn(),
  listItems: vi.fn(),
  countActiveItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  findItemById: vi.fn(),
  findItemForResponse: vi.fn(),
  saveItem: vi.fn(),
  createMovement: vi.fn(),
  findMovementForResponse: vi.fn(),
  listMovements: vi.fn(),
  findActiveItemsAtLocation: vi.fn(),
  createAudit: vi.fn(),
  listAudits: vi.fn(),
  findAuditById: vi.fn(),
  saveAudit: vi.fn(),
  createReorderRequest: vi.fn(),
  upsertOpenReorderRequest: vi.fn(),
  listReorderRequests: vi.fn(),
  findReorderRequestById: vi.fn(),
  findActiveReorder: vi.fn(),
  findAutomaticOpenReorder: vi.fn(),
  saveReorderRequest: vi.fn(),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenant,
}));

vi.mock("@/modules/supplies/supplier.model.js", () => ({
  Supplier: { exists: mocks.supplierExists },
}));

vi.mock("@/modules/tenant-access/index.js", () => ({
  assertCanAccessAllWorkspaceLocations: mocks.assertCanAccessAll,
  assertLocationIdsWithinWorkspaceScope: mocks.assertLocationIds,
  assertTenantLocationsWithinWorkspaceScope: mocks.assertTenantLocations,
}));

vi.mock("@/modules/inventory/inventory.repository.js", () => ({
  inventoryRepository: {
    listItems: mocks.listItems,
    countActiveItems: mocks.countActiveItems,
    createItem: mocks.createItem,
    updateItem: mocks.updateItem,
    findItemById: mocks.findItemById,
    findItemForResponse: mocks.findItemForResponse,
    saveItem: mocks.saveItem,
    createMovement: mocks.createMovement,
    findMovementForResponse: mocks.findMovementForResponse,
    listMovements: mocks.listMovements,
    findActiveItemsAtLocation: mocks.findActiveItemsAtLocation,
    createAudit: mocks.createAudit,
    listAudits: mocks.listAudits,
    findAuditById: mocks.findAuditById,
    saveAudit: mocks.saveAudit,
    createReorderRequest: mocks.createReorderRequest,
    upsertOpenReorderRequest: mocks.upsertOpenReorderRequest,
    listReorderRequests: mocks.listReorderRequests,
    findReorderRequestById: mocks.findReorderRequestById,
    findActiveReorderForItemLocation: mocks.findActiveReorder,
    findAutomaticOpenReorderForItemLocation:
      mocks.findAutomaticOpenReorder,
    saveReorderRequest: mocks.saveReorderRequest,
  },
}));

import { inventoryService } from "@/modules/inventory/services/inventory.service.js";

const TENANT_ID = "64b000000000000000000010";
const USER_ID = "64b000000000000000000020";
const ITEM_ID = "64b000000000000000000030";
const LOCATION_A = "64b000000000000000000001";
const LOCATION_B = "64b000000000000000000002";
const SUPPLIER_ID = "64b000000000000000000040";
const REQUEST_ID = "64b000000000000000000050";
const MOVEMENT_ID = "64b000000000000000000060";
const AUDIT_ID = "64b000000000000000000070";

const session = {
  withTransaction: vi.fn(async (task: () => Promise<unknown>) => task()),
  endSession: vi.fn().mockResolvedValue(undefined),
};

const tenant = {
  _id: TENANT_ID,
  plan: "professional",
  limits: { inventoryItems: 5000 },
  settings: { currency: "CZK" },
};

const item = ({
  stockA = 5,
  stockB,
  minimumA = 0,
  minimumB = 0,
  supplier = null,
}: {
  stockA?: number;
  stockB?: number;
  minimumA?: number;
  minimumB?: number;
  supplier?: string | null;
} = {}) =>
  ({
    _id: new mongoose.Types.ObjectId(ITEM_ID),
    tenant: new mongoose.Types.ObjectId(TENANT_ID),
    name: "Clay",
    sku: "CLAY",
    category: "other",
    unit: "kg",
    stockLevels: [
      {
        location: new mongoose.Types.ObjectId(LOCATION_A),
        currentQuantity: stockA,
        minimumQuantity: minimumA,
      },
      ...(stockB === undefined
        ? []
        : [
            {
              location: new mongoose.Types.ObjectId(LOCATION_B),
              currentQuantity: stockB,
              minimumQuantity: minimumB,
            },
          ]),
    ],
    locations: [
      new mongoose.Types.ObjectId(LOCATION_A),
      ...(stockB === undefined
        ? []
        : [new mongoose.Types.ObjectId(LOCATION_B)]),
    ],
    currentQuantity: stockA + (stockB ?? 0),
    minimumQuantity: minimumA + minimumB,
    supplier,
    averageUnitCostWithoutVat: 12,
    currency: "CZK",
    note: "",
    isActive: true,
  }) as any;

const supplierQuery = (result: unknown) => {
  const query = {
    session: vi.fn(),
    exec: vi.fn().mockResolvedValue(result),
  };
  query.session.mockReturnValue(query);
  return query;
};

describe("inventory service lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    session.withTransaction.mockImplementation(async (task) => task());
    session.endSession.mockResolvedValue(undefined);
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);

    mocks.getTenant.mockResolvedValue(tenant);
    mocks.supplierExists.mockImplementation(() => supplierQuery({ _id: SUPPLIER_ID }));
    mocks.countActiveItems.mockResolvedValue(0);
    mocks.findActiveReorder.mockResolvedValue(null);
    mocks.findAutomaticOpenReorder.mockResolvedValue(null);
    mocks.upsertOpenReorderRequest.mockResolvedValue({ _id: REQUEST_ID });
    mocks.saveItem.mockImplementation(async (value) => value);
    mocks.saveAudit.mockImplementation(async (value) => value);
    mocks.saveReorderRequest.mockImplementation(async (value) => value);
    mocks.createMovement.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(MOVEMENT_ID),
    });
    mocks.findMovementForResponse.mockResolvedValue({ _id: MOVEMENT_ID });
    mocks.findItemForResponse.mockResolvedValue({ _id: ITEM_ID });
  });

  it("returns a complete item detail when every item location is authorized", async () => {
    const current = item({ stockA: 5, stockB: 2 });
    const response = {
      _id: ITEM_ID,
      stockLevels: current.stockLevels,
    };
    mocks.findItemById.mockResolvedValue(current);
    mocks.findItemForResponse.mockResolvedValue(response);

    await expect(
      inventoryService.getItem(TENANT_ID, ITEM_ID, [
        LOCATION_A,
        LOCATION_B,
      ]),
    ).resolves.toBe(response);

    expect(mocks.assertLocationIds).toHaveBeenCalledWith(
      [LOCATION_A, LOCATION_B],
      [LOCATION_A, LOCATION_B],
    );
    expect(mocks.findItemForResponse).toHaveBeenCalledWith(
      TENANT_ID,
      ITEM_ID,
      [LOCATION_A, LOCATION_B],
    );
  });

  it("does not return a partial multi-location item to a restricted caller", async () => {
    mocks.findItemById.mockResolvedValue(item({ stockA: 5, stockB: 2 }));
    mocks.assertLocationIds.mockImplementationOnce(() => {
      throw Object.assign(new Error("Location not found."), {
        statusCode: 404,
        code: "WORKSPACE_LOCATION_NOT_FOUND",
      });
    });

    await expect(
      inventoryService.getItem(TENANT_ID, ITEM_ID, [LOCATION_A]),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });

    expect(mocks.findItemForResponse).not.toHaveBeenCalled();
  });

  it("fails closed if item locations change before the guarded response query", async () => {
    mocks.findItemById.mockResolvedValue(item({ stockA: 5 }));
    mocks.findItemForResponse.mockResolvedValue(null);

    await expect(
      inventoryService.getItem(TENANT_ID, ITEM_ID, [LOCATION_A]),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
  });

  it("preserves existing quantities during item metadata and threshold edits", async () => {
    const current = item({ stockA: 5 });
    mocks.findItemById.mockResolvedValue(current);
    mocks.updateItem.mockImplementation(async (document, input) => {
      document.stockLevels = input.stockLevels;
      return document;
    });

    await inventoryService.updateItem(
      TENANT_ID,
      ITEM_ID,
      USER_ID,
      {
        stockLevels: [
          { location: LOCATION_A, minimumQuantity: 2 },
          { location: LOCATION_B, minimumQuantity: 1 },
        ],
      },
      [LOCATION_A, LOCATION_B],
    );

    expect(mocks.updateItem).toHaveBeenCalledWith(
      current,
      expect.objectContaining({
        stockLevels: [
          {
            location: LOCATION_A,
            currentQuantity: 5,
            minimumQuantity: 2,
          },
          {
            location: LOCATION_B,
            currentQuantity: 0,
            minimumQuantity: 1,
          },
        ],
      }),
      { session },
    );
  });

  it("rejects a supplier from another tenant before creating an item", async () => {
    mocks.supplierExists.mockImplementationOnce(() => supplierQuery(null));

    await expect(
      inventoryService.createItem(
        TENANT_ID,
        USER_ID,
        {
          name: "Clay",
          sku: "CLAY",
          category: "other",
          unit: "kg",
          stockLevels: [
            {
              location: LOCATION_A,
              currentQuantity: 0,
              minimumQuantity: 0,
            },
          ],
          supplier: SUPPLIER_ID,
          averageUnitCostWithoutVat: 0,
          note: "",
          isActive: true,
        },
        [LOCATION_A],
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: "Supplier not found.",
    });

    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it("moves transfer stock between locations with one transaction and ledger entry", async () => {
    const current = item({ stockA: 5, stockB: 1 });
    mocks.findItemById.mockResolvedValue(current);

    await inventoryService.createMovement(
      TENANT_ID,
      USER_ID,
      {
        item: ITEM_ID,
        supplier: null,
        type: "transfer",
        reason: "other",
        location: LOCATION_A,
        destinationLocation: LOCATION_B,
        quantity: 2,
        unitCostWithoutVat: 0,
        vatRate: 21,
        invoiceNumber: "",
        note: "",
      },
      [LOCATION_A, LOCATION_B],
    );

    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(current.stockLevels).toEqual([
      expect.objectContaining({ currentQuantity: 3 }),
      expect.objectContaining({ currentQuantity: 3 }),
    ]);
    expect(mocks.createMovement).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      expect.objectContaining({
        type: "transfer",
        reason: "transfer",
        location: LOCATION_A,
        destinationLocation: LOCATION_B,
        quantity: 2,
      }),
      { session },
    );
  });

  it("rejects an overdrawn transfer without writing stock or ledger", async () => {
    mocks.findItemById.mockResolvedValue(item({ stockA: 1, stockB: 0 }));

    await expect(
      inventoryService.createMovement(
        TENANT_ID,
        USER_ID,
        {
          item: ITEM_ID,
          supplier: null,
          type: "transfer",
          reason: "transfer",
          location: LOCATION_A,
          destinationLocation: LOCATION_B,
          quantity: 2,
          unitCostWithoutVat: 0,
          vatRate: 21,
          invoiceNumber: "",
          note: "",
        },
        [LOCATION_A, LOCATION_B],
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Not enough stock available.",
    });

    expect(mocks.saveItem).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it("does not let a location-restricted manager claim orphaned legacy stock", async () => {
    const orphan = {
      ...item({ stockA: 0 }),
      stockLevels: [],
      locations: [],
      currentQuantity: 8,
      minimumQuantity: 2,
    };
    mocks.findItemById.mockResolvedValue(orphan);
    mocks.assertCanAccessAll.mockImplementationOnce(() => {
      throw Object.assign(new Error("All-location access required."), {
        statusCode: 403,
      });
    });

    await expect(
      inventoryService.createMovement(
        TENANT_ID,
        USER_ID,
        {
          item: ITEM_ID,
          supplier: null,
          type: "out",
          reason: "studio-consumption",
          location: LOCATION_A,
          destinationLocation: null,
          quantity: 1,
          unitCostWithoutVat: 0,
          vatRate: 21,
          invoiceNumber: "",
          note: "",
        },
        [LOCATION_A],
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(mocks.saveItem).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it("makes reorder receipt retries idempotent", async () => {
    const received = {
      _id: new mongoose.Types.ObjectId(REQUEST_ID),
      location: new mongoose.Types.ObjectId(LOCATION_A),
      status: "received",
      receivedMovement: new mongoose.Types.ObjectId(MOVEMENT_ID),
    };
    mocks.findReorderRequestById.mockResolvedValue(received);

    await expect(
      inventoryService.receiveReorderRequest(
        TENANT_ID,
        REQUEST_ID,
        {},
        USER_ID,
        [LOCATION_A],
      ),
    ).resolves.toBe(received);

    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it("flags an ambiguous legacy received reorder instead of silently succeeding", async () => {
    mocks.findReorderRequestById.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(REQUEST_ID),
      location: new mongoose.Types.ObjectId(LOCATION_A),
      status: "received",
      receivedMovement: null,
    });

    await expect(
      inventoryService.receiveReorderRequest(
        TENANT_ID,
        REQUEST_ID,
        {},
        USER_ID,
        [LOCATION_A],
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVENTORY_REORDER_RECEIPT_REVIEW_REQUIRED",
    });

    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it("receives ordered decimal stock without changing average cost when cost is omitted", async () => {
    const request = {
      _id: new mongoose.Types.ObjectId(REQUEST_ID),
      item: new mongoose.Types.ObjectId(ITEM_ID),
      supplier: null,
      location: new mongoose.Types.ObjectId(LOCATION_A),
      requestedQuantity: 2.5,
      status: "ordered",
      receivedQuantity: null,
      receivedMovement: null,
      resolvedBy: null,
      resolvedAt: null,
    } as any;
    const current = item({ stockA: 1 });
    mocks.findReorderRequestById.mockResolvedValue(request);
    mocks.findItemById.mockResolvedValue(current);

    await inventoryService.receiveReorderRequest(
      TENANT_ID,
      REQUEST_ID,
      {},
      USER_ID,
      [LOCATION_A],
    );

    expect(current.averageUnitCostWithoutVat).toBe(12);
    expect(current.stockLevels[0].currentQuantity).toBe(3.5);
    expect(mocks.createMovement).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      expect.objectContaining({
        type: "in",
        quantity: 2.5,
        unitCostWithoutVat: 0,
      }),
      { session },
    );
    expect(request).toMatchObject({
      status: "received",
      receivedQuantity: 2.5,
    });
  });

  it("rejects a stale audit instead of overwriting intervening movements", async () => {
    const audit = {
      _id: new mongoose.Types.ObjectId(AUDIT_ID),
      location: new mongoose.Types.ObjectId(LOCATION_A),
      status: "draft",
      note: "",
      items: [
        {
          item: new mongoose.Types.ObjectId(ITEM_ID),
          expectedQuantity: 2,
          actualQuantity: 1,
          note: "",
        },
      ],
    } as any;
    mocks.findAuditById.mockResolvedValue(audit);
    mocks.findItemById.mockResolvedValue(item({ stockA: 3 }));

    await expect(
      inventoryService.completeAudit(
        TENANT_ID,
        AUDIT_ID,
        USER_ID,
        [LOCATION_A],
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "INVENTORY_AUDIT_STALE",
    });

    expect(mocks.saveItem).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
    expect(mocks.saveAudit).not.toHaveBeenCalled();
  });
});
