import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  createInventoryAuditSchema,
  createInventoryItemSchema,
  createInventoryMovementSchema,
  createReorderRequestSchema,
  listInventoryItemsSchema,
  listInventoryMovementsSchema,
  receiveReorderRequestSchema,
  updateInventoryAuditSchema,
  updateInventoryItemSchema,
  updateReorderRequestSchema,
} from "@/modules/inventory/inventory.validators.js";

const ITEM_ID = new mongoose.Types.ObjectId().toString();
const LOCATION_A = new mongoose.Types.ObjectId().toString();
const LOCATION_B = new mongoose.Types.ObjectId().toString();

describe("inventory request validation", () => {
  it("accepts canonical per-location stock and normalizes optional SKU", () => {
    expect(
      createInventoryItemSchema.parse({
        name: "  White stoneware ",
        sku: " clay-01 ",
        stockLevels: [
          {
            location: LOCATION_A,
            currentQuantity: "12.5",
            minimumQuantity: "4.25",
          },
        ],
      }),
    ).toMatchObject({
      name: "White stoneware",
      sku: "CLAY-01",
      stockLevels: [
        {
          location: LOCATION_A,
          currentQuantity: 12.5,
          minimumQuantity: 4.25,
        },
      ],
    });

    expect(
      createInventoryItemSchema.parse({
        name: "No SKU",
        sku: " ",
        stockLevels: [{ location: LOCATION_A }],
      }).sku,
    ).toBeUndefined();
  });

  it("normalizes legacy locationIds without multiplying global stock", () => {
    const parsed = createInventoryItemSchema.parse({
      name: "Legacy clay",
      locationIds: [LOCATION_A, LOCATION_B],
      currentQuantity: 9.5,
      minimumQuantity: 2,
    });

    expect(parsed.stockLevels).toEqual([
      {
        location: LOCATION_A,
        currentQuantity: 9.5,
        minimumQuantity: 2,
      },
      {
        location: LOCATION_B,
        currentQuantity: 0,
        minimumQuantity: 0,
      },
    ]);
    expect(parsed).not.toHaveProperty("locationIds");
    expect(parsed).not.toHaveProperty("currentQuantity");
  });

  it("requires unique stock locations and at least one location", () => {
    expect(() =>
      createInventoryItemSchema.parse({
        name: "Duplicate",
        stockLevels: [
          { location: LOCATION_A },
          { location: LOCATION_A },
        ],
      }),
    ).toThrow(/unique/i);

    expect(() =>
      createInventoryItemSchema.parse({
        name: "Nowhere",
        stockLevels: [],
      }),
    ).toThrow(/location/i);
  });

  it("prevents metadata edits from changing quantities but supports thresholds and clearing SKU", () => {
    expect(() =>
      updateInventoryItemSchema.parse({
        currentQuantity: 100,
      }),
    ).toThrow();
    expect(() =>
      updateInventoryItemSchema.parse({
        stockLevels: [
          {
            location: LOCATION_A,
            currentQuantity: 100,
            minimumQuantity: 4,
          },
        ],
      }),
    ).toThrow();

    expect(
      updateInventoryItemSchema.parse({
        sku: null,
        stockLevels: [
          {
            location: LOCATION_A,
            minimumQuantity: "4.5",
          },
        ],
      }),
    ).toEqual({
      sku: null,
      stockLevels: [
        {
          location: LOCATION_A,
          minimumQuantity: 4.5,
        },
      ],
    });

    expect(
      updateInventoryItemSchema.parse({
        locationIds: [LOCATION_A, LOCATION_B],
        currentQuantity: 999,
        minimumQuantity: 3,
      }),
    ).toEqual({
      stockLevels: [
        { location: LOCATION_A, minimumQuantity: 3 },
        { location: LOCATION_B, minimumQuantity: 0 },
      ],
    });
  });

  it("validates transfers and supports old location aliases at the boundary", () => {
    expect(
      createInventoryMovementSchema.parse({
        item: ITEM_ID,
        type: "transfer",
        locationId: LOCATION_A,
        destinationLocationId: LOCATION_B,
        quantity: "1.25",
      }),
    ).toMatchObject({
      location: LOCATION_A,
      destinationLocation: LOCATION_B,
      quantity: 1.25,
    });

    expect(() =>
      createInventoryMovementSchema.parse({
        item: ITEM_ID,
        type: "transfer",
        location: LOCATION_A,
        quantity: 1,
      }),
    ).toThrow(/destination/i);
    expect(() =>
      createInventoryMovementSchema.parse({
        item: ITEM_ID,
        type: "transfer",
        location: LOCATION_A,
        destinationLocation: LOCATION_A,
        quantity: 1,
      }),
    ).toThrow(/different/i);

    expect(() =>
      createInventoryMovementSchema.parse({
        item: ITEM_ID,
        type: "audit",
        location: LOCATION_A,
        quantity: 1,
      }),
    ).toThrow(/stocktake/i);
  });

  it("uses canonical list location while accepting locationId compatibility", () => {
    expect(
      listInventoryItemsSchema.parse({ locationId: LOCATION_A }),
    ).toMatchObject({ location: LOCATION_A });
    expect(
      listInventoryMovementsSchema.parse({ locationId: LOCATION_A }),
    ).toMatchObject({ location: LOCATION_A });
  });

  it("keeps audit expected stock server-owned", () => {
    expect(() =>
      updateInventoryAuditSchema.parse({
        items: [
          {
            item: ITEM_ID,
            expectedQuantity: 999,
            actualQuantity: 2,
          },
        ],
      }),
    ).toThrow();

    expect(
      updateInventoryAuditSchema.parse({
        items: [{ item: ITEM_ID, actualQuantity: "2.5" }],
      }),
    ).toMatchObject({
      items: [{ item: ITEM_ID, actualQuantity: 2.5 }],
    });
    expect(
      createInventoryAuditSchema.parse({
        auditDate: "2026-07-27",
        locationId: LOCATION_A,
      }),
    ).toMatchObject({ location: LOCATION_A });
  });

  it("accepts decimal reorder quantities and bounded receipt financial data", () => {
    expect(
      createReorderRequestSchema.parse({
        item: ITEM_ID,
        location: LOCATION_A,
        requestedQuantity: "2.75",
      }),
    ).toMatchObject({ requestedQuantity: 2.75 });
    expect(
      updateReorderRequestSchema.parse({
        status: "received",
        receivedQuantity: "1.5",
      }),
    ).toMatchObject({ status: "received", receivedQuantity: 1.5 });
    expect(
      receiveReorderRequestSchema.parse({
        receivedQuantity: "1.5",
        unitCostWithoutVat: "22.75",
        vatRate: "21",
      }),
    ).toEqual({
      receivedQuantity: 1.5,
      unitCostWithoutVat: 22.75,
      vatRate: 21,
    });
  });
});
