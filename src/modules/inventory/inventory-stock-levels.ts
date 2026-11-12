type StockLocation = {
  toString(): string;
};

export type InventoryStockLevelLike<TLocation extends StockLocation = StockLocation> = {
  location: TLocation;
  currentQuantity: number;
  minimumQuantity: number;
};

type LegacyInventoryStockLike<TLocation extends StockLocation> = {
  stockLevels?: readonly InventoryStockLevelLike<TLocation>[] | null;
  locations?: readonly TLocation[] | null;
  currentQuantity?: number | null;
  minimumQuantity?: number | null;
};

const asNonNegativeNumber = (value: unknown): number => {
  const number = Number(value || 0);

  return Number.isFinite(number) && number >= 0 ? number : 0;
};

/**
 * Builds the canonical location-level stock representation.
 *
 * Legacy multi-location rows only ever had one global quantity. Assigning it
 * to every location would multiply the recorded stock, so the exact legacy
 * quantity and threshold belong to the first location and all remaining
 * locations begin at zero.
 */
export const getCanonicalStockLevels = <
  TLocation extends StockLocation,
>(
  item: LegacyInventoryStockLike<TLocation>,
): InventoryStockLevelLike<TLocation>[] => {
  if (item.stockLevels?.length) {
    return item.stockLevels.map((level) => ({
      location: level.location,
      currentQuantity: asNonNegativeNumber(level.currentQuantity),
      minimumQuantity: asNonNegativeNumber(level.minimumQuantity),
    }));
  }

  return (item.locations || []).map((location, index) => ({
    location,
    currentQuantity:
      index === 0 ? asNonNegativeNumber(item.currentQuantity) : 0,
    minimumQuantity:
      index === 0 ? asNonNegativeNumber(item.minimumQuantity) : 0,
  }));
};

export const getStockLevel = <TLocation extends StockLocation>(
  item: LegacyInventoryStockLike<TLocation>,
  locationId: string,
): InventoryStockLevelLike<TLocation> | undefined =>
  getCanonicalStockLevels(item).find(
    (level) => String(level.location) === locationId,
  );

export const requiresManualLegacyStockLocation = <
  TLocation extends StockLocation,
>(
  item: LegacyInventoryStockLike<TLocation>,
): boolean =>
  !item.stockLevels?.length &&
  !item.locations?.length &&
  (asNonNegativeNumber(item.currentQuantity) > 0 ||
    asNonNegativeNumber(item.minimumQuantity) > 0);

/**
 * Synchronizes compatibility fields from canonical stock levels. It accepts a
 * Mongoose document or a plain mutable object and is also used by migration
 * tests, keeping the no-stock-duplication rule independently testable.
 */
export const synchronizeLegacyInventoryStock = <
  TLocation extends StockLocation,
>(
  item: LegacyInventoryStockLike<TLocation> & {
    stockLevels?: InventoryStockLevelLike<TLocation>[];
    locations?: TLocation[];
    currentQuantity?: number;
    minimumQuantity?: number;
  },
): void => {
  const stockLevels = getCanonicalStockLevels(item);

  // A legacy global row with no location cannot be assigned safely without a
  // tenant primary/default location. Preserve it verbatim for the migration
  // report or an explicit location-scoped operation to resolve.
  if (!stockLevels.length && !(item.stockLevels?.length)) {
    return;
  }

  item.stockLevels = stockLevels;
  item.locations = stockLevels.map((level) => level.location);
  item.currentQuantity = stockLevels.reduce(
    (total, level) => total + level.currentQuantity,
    0,
  );
  item.minimumQuantity = stockLevels.reduce(
    (total, level) => total + level.minimumQuantity,
    0,
  );
};
