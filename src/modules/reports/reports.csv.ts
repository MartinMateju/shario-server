const DANGEROUS_FORMULA_PREFIX = /^(?:[\t\r\n]|[ ]*[=+\-@])/;

export const escapeCsvFormula = (value: unknown): string => {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (typeof value !== "string") return normalized;
  return DANGEROUS_FORMULA_PREFIX.test(normalized)
    ? `'${normalized}`
    : normalized;
};

export const csvCell = (value: unknown): string => {
  const safe = escapeCsvFormula(value);
  return `"${safe.replaceAll('"', '""')}"`;
};

export const csvRow = (values: unknown[]): string =>
  values.map(csvCell).join(",");

const kpiRows = (overview: any) =>
  Object.entries(overview.summary ?? {}).map(([metric, raw]) => {
    const value = raw as {
      value: number | null;
      previous: number | null;
      changePercent: number | null;
    };
    const unit =
      metric === "netSales"
        ? `${overview.metadata.currency} minor`
        : metric.toLowerCase().includes("percent")
          ? "percent"
          : "count";
    return csvRow([
      "summary",
      metric,
      value.value,
      value.previous,
      value.changePercent,
      unit,
    ]);
  });

const metadataRows = (overview: any) => {
  const metadata = overview.metadata ?? {};
  return [
    csvRow(["metadata", "field", "value"]),
    csvRow(["metadata", "periodFrom", metadata.period?.from]),
    csvRow(["metadata", "periodTo", metadata.period?.to]),
    csvRow([
      "metadata",
      "comparisonPeriodFrom",
      metadata.comparisonPeriod?.from,
    ]),
    csvRow([
      "metadata",
      "comparisonPeriodTo",
      metadata.comparisonPeriod?.to,
    ]),
    csvRow(["metadata", "timezone", metadata.timezone]),
    csvRow(["metadata", "currency", metadata.currency]),
    csvRow([
      "metadata",
      "locationScope",
      metadata.locationId || "all_accessible",
    ]),
    csvRow(["metadata", "granularity", metadata.granularity]),
    csvRow(["metadata", "generatedAt", metadata.generatedAt]),
  ];
};

const unavailableRows = (section: string) => [
  csvRow([section, "status", "unavailable"]),
];

const limitationRows = (section: string, limitations: unknown) =>
  Array.isArray(limitations)
    ? limitations.map((limitation) =>
        csvRow([`${section}.limitations`, "limitation", limitation]),
      )
    : [];

const salesRows = (overview: any): string[] => {
  const sales = overview.sales;
  if (!sales) return unavailableRows("sales");
  const currencyUnit = `${sales.currency || overview.metadata?.currency || ""} minor`;
  const rows = [
    csvRow(["sales", "metric", "value", "unit"]),
    ...[
      ["grossSalesMinor", sales.grossSalesMinor, currencyUnit],
      ["discountsMinor", sales.discountsMinor, currencyUnit],
      ["taxMinor", sales.taxMinor, currencyUnit],
      ["netSalesMinor", sales.netSalesMinor, currencyUnit],
      ["orders", sales.orders, "count"],
      ["averageOrderValueMinor", sales.averageOrderValueMinor, currencyUnit],
      ["refundsMinor", sales.refundsMinor, currencyUnit],
    ].map(([metric, value, unit]) =>
      csvRow(["sales", metric, value, unit]),
    ),
    csvRow([
      "sales.totalsByCurrency",
      "currency",
      "grossSalesMinor",
      "discountsMinor",
      "taxMinor",
      "netSalesMinor",
      "paidAmountMinor",
      "orders",
    ]),
    ...(sales.totalsByCurrency ?? []).map((entry: any) =>
      csvRow([
        "sales.totalsByCurrency",
        entry.currency,
        entry.grossSalesMinor,
        entry.discountsMinor,
        entry.taxMinor,
        entry.netSalesMinor,
        entry.paidAmountMinor,
        entry.orders,
      ]),
    ),
    csvRow(["sales.paymentMethods", "method", "amountMinor", "currency"]),
    ...(sales.paymentMethods ?? []).map((entry: any) =>
      csvRow([
        "sales.paymentMethods",
        entry.method,
        entry.amountMinor,
        sales.currency,
      ]),
    ),
  ];
  if (sales.topProducts === null) {
    rows.push(...unavailableRows("sales.topProducts"));
  } else {
    rows.push(
      csvRow([
        "sales.topProducts",
        "productId",
        "name",
        "quantity",
        "netSalesMinor",
        "grossSalesMinor",
        "currency",
      ]),
      ...(sales.topProducts ?? []).map((entry: any) =>
        csvRow([
          "sales.topProducts",
          entry.productId,
          entry.name,
          entry.quantity,
          entry.netSalesMinor,
          entry.grossSalesMinor,
          sales.currency,
        ]),
      ),
    );
  }
  rows.push(...limitationRows("sales", sales.limitations));
  return rows;
};

const bookingRows = (overview: any): string[] => {
  const bookings = overview.bookings;
  if (!bookings) return unavailableRows("bookings");
  const rows = [
    csvRow(["bookings", "metric", "value", "unit"]),
    ...[
      ["total", bookings.total, "count"],
      ["participants", bookings.participants, "count"],
      ["cancellations", bookings.cancellations, "count"],
      ["noShows", bookings.noShows, "count"],
      ["bookedHours", bookings.bookedHours, "hours"],
      ["utilizationPercent", bookings.utilizationPercent, "percent"],
    ].map(([metric, value, unit]) =>
      csvRow(["bookings", metric, value, unit]),
    ),
    csvRow(["bookings.types", "type", "count", "participants"]),
    ...(bookings.bookingTypes ?? []).map((entry: any) =>
      csvRow([
        "bookings.types",
        entry.type,
        entry.count,
        entry.participants,
      ]),
    ),
  ];
  if (bookings.courseFill === null) {
    rows.push(...unavailableRows("bookings.courseFill"));
  } else {
    rows.push(
      csvRow([
        "bookings.courseFill",
        "productId",
        "name",
        "sessions",
        "bookedSeats",
        "capacity",
        "fillPercent",
      ]),
      ...(bookings.courseFill ?? []).map((entry: any) =>
        csvRow([
          "bookings.courseFill",
          entry.productId,
          entry.name,
          entry.sessions,
          entry.bookedSeats,
          entry.capacity,
          entry.fillPercent,
        ]),
      ),
    );
  }
  rows.push(
    csvRow([
      "bookings.heatmap",
      "weekday",
      "hour",
      "bookings",
      "participants",
      "capacity",
      "utilizationPercent",
    ]),
    ...(bookings.heatmap ?? []).map((entry: any) =>
      csvRow([
        "bookings.heatmap",
        entry.weekday,
        entry.hour,
        entry.bookings,
        entry.participants,
        entry.capacity,
        entry.utilizationPercent,
      ]),
    ),
    ...limitationRows("bookings", bookings.limitations),
  );
  return rows;
};

const customerRows = (overview: any): string[] => {
  const customers = overview.customers;
  if (!customers) return unavailableRows("customers");
  return [
    csvRow(["customers", "metric", "value", "unit"]),
    ...[
      ["active", customers.active, "count"],
      ["new", customers.new, "count"],
      ["returning", customers.returning, "count"],
      ["returningRatePercent", customers.returningRatePercent, "percent"],
      [
        "averageSpendMinor",
        customers.averageSpendMinor,
        `${overview.metadata?.currency || ""} minor`,
      ],
    ].map(([metric, value, unit]) =>
      csvRow(["customers", metric, value, unit]),
    ),
    ...limitationRows("customers", customers.limitations),
  ];
};

const inventoryRows = (overview: any, inventory: any): string[] => {
  if (!inventory) return unavailableRows("operations.inventory");
  const quantityRows = (
    name: string,
    values: Array<{ unit: string; quantity: number }> | undefined,
  ) => [
    csvRow([name, "unit", "quantity"]),
    ...(values ?? []).map((entry) =>
      csvRow([name, entry.unit, entry.quantity]),
    ),
  ];
  return [
    csvRow(["operations.inventory", "metric", "value", "unit"]),
    csvRow(["operations.inventory", "asOf", inventory.asOf, "timestamp"]),
    csvRow([
      "operations.inventory",
      "purchaseCostWithoutVatMinor",
      inventory.purchaseCostWithoutVatMinor,
      `${overview.metadata?.currency || ""} minor`,
    ]),
    csvRow([
      "operations.inventory",
      "openReorders",
      inventory.openReorders,
      "count",
    ]),
    csvRow([
      "operations.inventory",
      "lowStockItems",
      inventory.lowStockItems,
      "count",
    ]),
    ...quantityRows(
      "operations.inventory.consumptionByUnit",
      inventory.consumptionByUnit,
    ),
    ...quantityRows(
      "operations.inventory.purchasesByUnit",
      inventory.purchasesByUnit,
    ),
    ...quantityRows(
      "operations.inventory.stocktakeDifferenceByUnit",
      inventory.stocktakeDifferenceByUnit,
    ),
    ...limitationRows("operations.inventory", inventory.limitations),
  ];
};

const staffRows = (staff: any): string[] => {
  if (!staff) return unavailableRows("operations.staffTasks");
  return [
    csvRow(["operations.staffTasks", "metric", "value", "unit"]),
    ...[
      ["asOf", staff.asOf, "timestamp"],
      ["completed", staff.completed, "count"],
      ["previousCompleted", staff.previousCompleted, "count"],
      ["changePercent", staff.changePercent, "percent"],
      ["open", staff.open, "count"],
      ["overdue", staff.overdue, "count"],
      ["completionRatePercent", staff.completionRatePercent, "percent"],
    ].map(([metric, value, unit]) =>
      csvRow(["operations.staffTasks", metric, value, unit]),
    ),
    ...limitationRows("operations.staffTasks", staff.limitations),
  ];
};

export const buildReportCsv = (overview: any): string => {
  const operations = overview.operations ?? {};
  const rows = [
    ...metadataRows(overview),
    "",
    csvRow(["section", "metric", "current", "previous", "changePercent", "unit"]),
    ...kpiRows(overview),
    "",
    csvRow([
      "timeSeries",
      "periodStart",
      "periodEnd",
      "netSalesMinor",
      "bookings",
      "participants",
      "utilizationPercent",
    ]),
    ...(overview.timeSeries ?? []).map((point: any) =>
      csvRow([
        "timeSeries",
        point.periodStart,
        point.periodEnd,
        point.netSalesMinor,
        point.bookings,
        point.participants,
        point.utilizationPercent,
      ]),
    ),
    "",
    ...salesRows(overview),
    "",
    ...bookingRows(overview),
    "",
    ...customerRows(overview),
    "",
    "",
    ...inventoryRows(overview, operations.inventory),
    "",
    ...staffRows(operations.staffTasks),
    "",
    csvRow(["coverage", "source", "status", "reason"]),
    ...(overview.coverage?.available ?? []).map((source: string) =>
      csvRow(["coverage", source, "available", ""]),
    ),
    ...(overview.coverage?.unavailable ?? []).map((entry: any) =>
      csvRow(["coverage", entry.source, "unavailable", entry.reason]),
    ),
    ...(overview.coverage?.limitations ?? []).map((limitation: string) =>
      csvRow(["coverage", "limitation", "limited", limitation]),
    ),
  ];

  return `\uFEFF${rows.join("\r\n")}\r\n`;
};
