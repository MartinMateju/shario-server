import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  getCanonicalStockLevels,
  requiresManualLegacyStockLocation,
  synchronizeLegacyInventoryStock,
} from "@/modules/inventory/inventory-stock-levels.js";

const LOCATION_A = new mongoose.Types.ObjectId();
const LOCATION_B = new mongoose.Types.ObjectId();

describe("inventory stock-level compatibility", () => {
  it("moves a single-location legacy balance exactly", () => {
    expect(
      getCanonicalStockLevels({
        locations: [LOCATION_A],
        currentQuantity: 8.5,
        minimumQuantity: 2.25,
      }),
    ).toEqual([
      {
        location: LOCATION_A,
        currentQuantity: 8.5,
        minimumQuantity: 2.25,
      },
    ]);
  });

  it("assigns a multi-location legacy balance to the first location without duplication", () => {
    const levels = getCanonicalStockLevels({
      locations: [LOCATION_A, LOCATION_B],
      currentQuantity: 8.5,
      minimumQuantity: 2.25,
    });

    expect(levels).toEqual([
      {
        location: LOCATION_A,
        currentQuantity: 8.5,
        minimumQuantity: 2.25,
      },
      {
        location: LOCATION_B,
        currentQuantity: 0,
        minimumQuantity: 0,
      },
    ]);
    expect(
      levels.reduce((sum, level) => sum + level.currentQuantity, 0),
    ).toBe(8.5);
  });

  it("derives legacy compatibility totals from canonical levels", () => {
    const item = {
      stockLevels: [
        {
          location: LOCATION_A,
          currentQuantity: 4.5,
          minimumQuantity: 2,
        },
        {
          location: LOCATION_B,
          currentQuantity: 3,
          minimumQuantity: 1,
        },
      ],
      locations: [] as mongoose.Types.ObjectId[],
      currentQuantity: 0,
      minimumQuantity: 0,
    };

    synchronizeLegacyInventoryStock(item);

    expect(item.locations).toEqual([LOCATION_A, LOCATION_B]);
    expect(item.currentQuantity).toBe(7.5);
    expect(item.minimumQuantity).toBe(3);
  });

  it("does not erase an orphaned legacy global balance", () => {
    const item = {
      stockLevels: [],
      locations: [],
      currentQuantity: 7,
      minimumQuantity: 2,
    };

    synchronizeLegacyInventoryStock(item);

    expect(item).toEqual({
      stockLevels: [],
      locations: [],
      currentQuantity: 7,
      minimumQuantity: 2,
    });
    expect(requiresManualLegacyStockLocation(item)).toBe(true);
    expect(
      requiresManualLegacyStockLocation({
        stockLevels: [],
        locations: [],
        currentQuantity: 0,
        minimumQuantity: 0,
      }),
    ).toBe(false);
  });
});
