import type { ReportLocationScope } from "./reports.types.js";

type CoverageBuilder = {
  available: Set<string>;
  unavailable: Array<{ source: string; reason: string }>;
  limitations: Set<string>;
};
const lineLocationIds = (line: any): string[] =>
  Array.isArray(line?.locationIds)
    ? line.locationIds
        .map((value: unknown) => String(value ?? "").trim())
        .filter(Boolean)
    : [];

const hasTrustedTaxSnapshots = (lines: any[]): boolean =>
  lines.length > 0 &&
  lines.every((line) => {
    const gross = Number(line?.grossAmountMinor);
    const net = Number(line?.netAmountMinor);
    const tax = Number(line?.taxAmountMinor);
    return (
      Number.isSafeInteger(gross) &&
      Number.isSafeInteger(net) &&
      Number.isSafeInteger(tax) &&
      gross >= 0 &&
      net >= 0 &&
      tax >= 0 &&
      net + tax === gross
    );
  });

const UNALLOCATED_LOCATION = "\uffff-unallocated";

export const minorUnits = (value: unknown): number => {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
};

const splitEvenly = (total: number, rawKeys: string[]): Map<string, number> => {
  const keys = [...new Set(rawKeys)].sort();
  const result = new Map(keys.map((key) => [key, 0]));
  if (!keys.length) return result;
  const base = Math.floor(total / keys.length);
  const remainder = total % keys.length;
  keys.forEach((key, index) => {
    result.set(key, base + (index < remainder ? 1 : 0));
  });
  return result;
};

export const allocateMinorUnitsByWeight = (
  totalValue: number,
  rawWeights: Map<string, number>,
): Map<string, number> => {
  const total = minorUnits(totalValue);
  const weights = [...rawWeights.entries()]
    .map(([key, value]) => [key, minorUnits(value)] as const)
    .filter(([, value]) => value > 0);
  const result = new Map([...rawWeights.keys()].map((key) => [key, 0]));
  if (total === 0 || !weights.length) return result;
  const totalWeight = weights.reduce(
    (sum, [, value]) => sum + BigInt(value),
    0n,
  );
  const shares = weights.map(([key, weight]) => {
    const product = BigInt(total) * BigInt(weight);
    return {
      key,
      amount: Number(product / totalWeight),
      remainder: product % totalWeight,
    };
  });
  let remainderUnits =
    total - shares.reduce((sum, share) => sum + share.amount, 0);
  shares.sort((a, b) => {
    if (a.remainder === b.remainder) return a.key.localeCompare(b.key);
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (const share of shares) {
    if (remainderUnits <= 0) break;
    share.amount += 1;
    remainderUnits -= 1;
  }
  for (const share of shares) result.set(share.key, share.amount);
  return result;
};

const roundMinorRatio = (
  value: number,
  numerator: number,
  denominator: number,
): number => {
  if (denominator <= 0 || value <= 0 || numerator <= 0) return 0;
  const product = BigInt(value) * BigInt(numerator);
  const divisor = BigInt(denominator);
  const base = product / divisor;
  const remainder = product % divisor;
  return Number(base + (remainder * 2n >= divisor ? 1n : 0n));
};

type ReportAllocationCell = {
  id: string;
  lineIndex: number;
  locationId: string;
  grossAmountMinor: number;
  taxAmountMinor: number;
};

const allocateCellsThroughLocations = (
  total: number,
  cells: ReportAllocationCell[],
  weight: "grossAmountMinor" | "taxAmountMinor",
): Map<string, number> => {
  const locationWeights = new Map<string, number>();
  for (const cell of cells) {
    locationWeights.set(
      cell.locationId,
      (locationWeights.get(cell.locationId) ?? 0) + cell[weight],
    );
  }
  const locationAmounts = allocateMinorUnitsByWeight(total, locationWeights);
  const result = new Map(cells.map((cell) => [cell.id, 0]));
  for (const [locationId, locationAmount] of locationAmounts) {
    const locationCells = cells.filter(
      (cell) => cell.locationId === locationId,
    );
    const cellWeights = new Map(
      locationCells.map((cell) => [cell.id, cell[weight]]),
    );
    const cellAmounts = allocateMinorUnitsByWeight(locationAmount, cellWeights);
    for (const [cellId, amount] of cellAmounts) result.set(cellId, amount);
  }
  return result;
};

export const allocateOrderForReport = (
  order: any,
  scope: ReportLocationScope,
  coverage: CoverageBuilder,
  linePredicate?: (line: any) => boolean,
) => {
  const allLines = Array.isArray(order.lineItems) ? order.lineItems : [];
  const fullyVisible = scope.unrestricted && !scope.requestedLocationId;
  const snapshotsTrusted = hasTrustedTaxSnapshots(allLines);
  const cells: ReportAllocationCell[] = [];
  const lineLocations = new Map<number, string[]>();
  allLines.forEach((line: any, lineIndex: number) => {
    const locations = [...new Set(lineLocationIds(line))].sort();
    lineLocations.set(lineIndex, locations);
    if (locations.length > 1) {
      coverage.limitations.add(
        "Line items assigned to multiple locations are split equally, with indivisible minor-unit remainders assigned by sorted location ID.",
      );
    }
    const allocationLocations = locations.length
      ? locations
      : [UNALLOCATED_LOCATION];
    const gross = splitEvenly(
      minorUnits(line.grossAmountMinor),
      allocationLocations,
    );
    const tax = snapshotsTrusted
      ? splitEvenly(minorUnits(line.taxAmountMinor), allocationLocations)
      : new Map(allocationLocations.map((locationId) => [locationId, 0]));
    for (const locationId of allocationLocations) {
      cells.push({
        id: `${locationId}:${String(lineIndex).padStart(8, "0")}`,
        lineIndex,
        locationId,
        grossAmountMinor: gross.get(locationId) ?? 0,
        taxAmountMinor: tax.get(locationId) ?? 0,
      });
    }
  });

  const eligibleLineIndexes = new Set<number>();
  allLines.forEach((line: any, lineIndex: number) => {
    if (linePredicate && !linePredicate(line)) return;
    const locations = lineLocations.get(lineIndex) ?? [];
    if (fullyVisible) {
      eligibleLineIndexes.add(lineIndex);
    } else if (scope.requestedLocationId) {
      if (locations.includes(scope.requestedLocationId)) {
        eligibleLineIndexes.add(lineIndex);
      }
    } else if (
      locations.length > 0 &&
      locations.every((locationId) => scope.locationIds.includes(locationId))
    ) {
      eligibleLineIndexes.add(lineIndex);
    }
  });
  const selectedCells = cells.filter(
    (cell) =>
      eligibleLineIndexes.has(cell.lineIndex) &&
      (fullyVisible ||
        !scope.requestedLocationId ||
        cell.locationId === scope.requestedLocationId),
  );
  const allLineGross = cells.reduce(
    (sum, cell) => sum + cell.grossAmountMinor,
    0,
  );
  if (allLineGross <= 0) {
    if (fullyVisible && !linePredicate) {
      coverage.limitations.add(
        "Tax-exclusive net sales are unavailable for legacy orders without allocatable line-item snapshots.",
      );
      const orderSaleValue = minorUnits(order.grossAmountMinor);
      const discount = minorUnits(order.appliedDiscount?.amountMinor);
      return {
        ratio: 1,
        lines: allLines.map((line: any) => ({
          ...line,
          _reportShare: 1,
          _reportGrossAmountMinor: minorUnits(line.grossAmountMinor),
          _reportTaxAmountMinor: null,
          _reportNetSalesMinor: null,
        })),
        grossSalesMinor: orderSaleValue + discount,
        discountsMinor: discount,
        taxMinor: null,
        netSalesMinor: null,
        paidAmountMinor: minorUnits(order.paidAmountMinor),
        allocateMinorUnits: (value: unknown) => minorUnits(value),
      };
    }
    coverage.limitations.add(
      linePredicate
        ? "Course sales exclude legacy orders without classifiable line-item amounts."
        : "Location-scoped sales exclude legacy orders without allocatable line-item locations.",
    );
    return null;
  }
  if (!selectedCells.length) return null;

  const sumSelected = (values: Map<string, number>) =>
    selectedCells.reduce((sum, cell) => sum + (values.get(cell.id) ?? 0), 0);
  const allocateSelectedMinorUnits = (value: unknown) =>
    sumSelected(
      allocateCellsThroughLocations(
        minorUnits(value),
        cells,
        "grossAmountMinor",
      ),
    );
  const orderSaleValue = minorUnits(order.grossAmountMinor);
  const discount = minorUnits(order.appliedDiscount?.amountMinor);
  const saleByCell = allocateCellsThroughLocations(
    orderSaleValue,
    cells,
    "grossAmountMinor",
  );
  const discountByCell = allocateCellsThroughLocations(
    discount,
    cells,
    "grossAmountMinor",
  );
  const paidByCell = allocateCellsThroughLocations(
    minorUnits(order.paidAmountMinor),
    cells,
    "grossAmountMinor",
  );
  const allLineTax = cells.reduce((sum, cell) => sum + cell.taxAmountMinor, 0);
  const fullTax = snapshotsTrusted
    ? roundMinorRatio(orderSaleValue, allLineTax, allLineGross)
    : null;
  const taxByCell =
    fullTax === null
      ? null
      : allocateCellsThroughLocations(fullTax, cells, "taxAmountMinor");
  if (taxByCell === null) {
    coverage.limitations.add(
      "Tax-exclusive net sales are unavailable for legacy orders without line-item tax snapshots.",
    );
  }
  const selectedLineGross = selectedCells.reduce(
    (sum, cell) => sum + cell.grossAmountMinor,
    0,
  );
  const selectedLines = [...eligibleLineIndexes]
    .sort((a, b) => a - b)
    .map((lineIndex) => {
      const line = allLines[lineIndex];
      const lineCells = selectedCells.filter(
        (cell) => cell.lineIndex === lineIndex,
      );
      const lineSale = lineCells.reduce(
        (sum, cell) => sum + (saleByCell.get(cell.id) ?? 0),
        0,
      );
      const lineTax =
        taxByCell === null
          ? null
          : lineCells.reduce(
              (sum, cell) => sum + (taxByCell.get(cell.id) ?? 0),
              0,
            );
      const locations = lineLocations.get(lineIndex) ?? [];
      return {
        ...line,
        _reportShare: fullyVisible
          ? 1
          : locations.length > 0
            ? lineCells.length / locations.length
            : 0,
        _reportGrossAmountMinor: lineCells.reduce(
          (sum, cell) => sum + cell.grossAmountMinor,
          0,
        ),
        _reportTaxAmountMinor: lineTax,
        _reportNetSalesMinor: lineTax === null ? null : lineSale - lineTax,
      };
    });
  const allocatedSaleValue = sumSelected(saleByCell);
  const allocatedDiscount = sumSelected(discountByCell);
  const allocatedTax = taxByCell === null ? null : sumSelected(taxByCell);

  return {
    ratio: selectedLineGross / allLineGross,
    lines: selectedLines,
    grossSalesMinor: allocatedSaleValue + allocatedDiscount,
    discountsMinor: allocatedDiscount,
    taxMinor: allocatedTax,
    netSalesMinor:
      allocatedTax === null ? null : allocatedSaleValue - allocatedTax,
    paidAmountMinor: sumSelected(paidByCell),
    allocateMinorUnits: allocateSelectedMinorUnits,
  };
};
