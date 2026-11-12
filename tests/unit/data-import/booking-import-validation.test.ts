import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantImportSession: vi.fn(),
  serializeImportSession: vi.fn((value: unknown) => value),
  sessionFindOneAndUpdate: vi.fn(),
  sessionUpdateOne: vi.fn(),
  rowFind: vi.fn(),
  rowBulkWrite: vi.fn(),
  bookingFind: vi.fn(),
  userFind: vi.fn(),
  productFind: vi.fn(),
  locationFind: vi.fn(),
  membershipFind: vi.fn(),
  membershipFindOne: vi.fn(),
  recordAudit: vi.fn(),
  validateAvailability: vi.fn(),
}));

vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  createDataImportSession: vi.fn(),
  getTenantImportSession: mocks.getTenantImportSession,
  serializeImportSession: mocks.serializeImportSession,
}));
vi.mock("@/modules/data-import/data-import-session.model.js", () => ({
  default: {
    findOneAndUpdate: mocks.sessionFindOneAndUpdate,
    updateOne: mocks.sessionUpdateOne,
  },
}));
vi.mock("@/modules/data-import/data-import-row.model.js", () => ({
  default: {
    find: mocks.rowFind,
    bulkWrite: mocks.rowBulkWrite,
  },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { find: mocks.bookingFind },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { find: mocks.userFind },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: { find: mocks.productFind },
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: { find: mocks.locationFind },
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: {
    find: mocks.membershipFind,
    findOne: mocks.membershipFindOne,
  },
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));
vi.mock("@/modules/checkout/services/checkout.capacity.service.js", () => ({
  validateOpenStudioAvailabilityOrThrow: mocks.validateAvailability,
}));

import {
  resolveLocalBookingRange,
  validateBookingImportSession,
} from "@/modules/data-import/services/booking-import.service.js";

const current = {
  _id: "session-1",
  entityType: "bookings",
  status: "uploaded",
  headers: [
    "Booking ID",
    "Service",
    "Email",
    "Start",
    "End",
    "Date",
    "From",
    "To",
    "Guests",
    "Status",
  ],
  fileHash: "a".repeat(64),
};

const selectLean = (value: unknown) => {
  const result = Object.assign(Promise.resolve(value), { exec: () => Promise.resolve(value) });
  const chain = {
    select: () => chain,
    session: () => chain,
    lean: () => result,
  };
  return chain;
};

const rowQuery = (value: unknown) => ({
  sort: () => ({ lean: () => Promise.resolve(value) }),
});

const sessionQuery = (value: unknown) => ({
  lean: () => Promise.resolve(value),
});

const issueCodes = (operation: any): string[] =>
  operation.updateOne.update.$set.issues.map((issue: any) => issue.code);

const normalized = (operation: any) =>
  operation.updateOne.update.$set.normalized;

const status = (operation: any) => operation.updateOne.update.$set.status;

const validate = (mapping: Record<string, string>) =>
  validateBookingImportSession({
    tenantId: "tenant-1",
    sessionId: "session-1",
    mapping,
    duplicateStrategy: "skip",
    actorId: "actor-1",
    tenantLanguage: "cs",
  });

describe("booking import validation semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantImportSession.mockResolvedValue(current);
    mocks.sessionFindOneAndUpdate
      .mockReturnValueOnce(sessionQuery(current))
      .mockReturnValueOnce(
        sessionQuery({
          ...current,
          status: "validated",
          validationRevision: "r",
        }),
      );
    mocks.sessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.userFind.mockReturnValue(selectLean([]));
    mocks.productFind.mockReturnValue(
      selectLean([
        {
          _id: "product-class",
          name: "Wheel Class",
          sku: "CLASS-1",
          kind: "class",
          type: "course",
          isActive: true,
          maxNumberOfParticipants: 8,
        },
      ]),
    );
    mocks.locationFind.mockReturnValue(
      selectLean([
        {
          _id: "location-1",
          name: "Main Studio",
          code: "MAIN",
          slug: "main-studio",
          isActive: true,
          booking: {
            enabled: true,
            timezone: "Europe/Prague",
            minBookingMinutes: 30,
            maxBookingMinutes: 480,
          },
        },
      ]),
    );
    mocks.membershipFind.mockReturnValue(selectLean([]));
    mocks.membershipFindOne.mockReturnValue(
      selectLean({ role: "admin", locationAccess: { mode: "all" } }),
    );
    mocks.bookingFind.mockReturnValue(selectLean([]));
    mocks.rowBulkWrite.mockResolvedValue({ modifiedCount: 1 });
    mocks.recordAudit.mockResolvedValue({});
  });

  it("preserves the real elapsed duration across Prague's fall-back transition", () => {
    const result = resolveLocalBookingRange({
      date: "2026-10-25",
      startTime: "01:30",
      endTime: "03:30",
      timezone: "Europe/Prague",
    });

    expect(result.issueCode).toBeUndefined();
    expect(result.range).not.toBeNull();
    expect(result.range?.start.toISOString()).toBe("2026-10-24T23:30:00.000Z");
    expect(result.range?.end.toISOString()).toBe("2026-10-25T02:30:00.000Z");
    expect(
      (result.range!.end.getTime() - result.range!.start.getTime()) / 3_600_000,
    ).toBe(3);
  });

  it("requires an explicit booking flow for products offering customer choice", async () => {
    mocks.productFind.mockReturnValue(selectLean([{
      _id: "product-choice", name: "Flexible Studio", kind: "open-studio",
      type: "workshop", bookingMode: "customer-choice", isActive: true,
    }]));
    mocks.userFind.mockReturnValue(selectLean([{
      _id: "customer-1", email: "anna@example.com", roles: ["User"],
    }]));
    mocks.rowFind.mockReturnValue(rowQuery([{
      _id: "row-2", rowNumber: 2, raw: {
        Service: "Flexible Studio", Email: "anna@example.com",
        Start: "2099-09-15T09:00:00+02:00", End: "2099-09-15T11:00:00+02:00",
      },
    }]));

    await validate({ productName: "Service", customerEmail: "Email", start: "Start", end: "End" });

    const [operation] = mocks.rowBulkWrite.mock.calls[0][0];
    expect(status(operation)).toBe("invalid");
    expect(issueCodes(operation)).toContain("BOOKING_IMPORT_MODE_REQUIRED");
  });

  it("hydrates overlapping course capacity before simulating an imported studio booking", async () => {
    const course = { _id: "class-session", tag: "course", bookingProduct: "product-class", numberOfGuests: 0 };
    mocks.productFind.mockReturnValue(selectLean([
      { _id: "product-studio", name: "Shared Studio", kind: "open-studio", type: "workshop", bookingMode: "public", location: "location-1", isActive: true },
      { _id: "product-class", name: "Wheel Class", kind: "class", type: "course", maxNumberOfParticipants: 8 },
    ]));
    mocks.userFind.mockReturnValue(selectLean([{ _id: "customer-1", email: "anna@example.com", roles: ["User"] }]));
    mocks.bookingFind.mockImplementation((filter) => selectLean(
      filter.$or?.some((condition: any) => condition.start?.$lt) ? [course] : [],
    ));
    mocks.rowFind.mockReturnValue(rowQuery([{
      _id: "row-2", rowNumber: 2, raw: {
        Service: "Shared Studio", Email: "anna@example.com",
        Start: "2099-09-15T09:00:00+02:00", End: "2099-09-15T11:00:00+02:00",
      },
    }]));
    await validate({ productName: "Service", customerEmail: "Email", start: "Start", end: "End" });
    expect(mocks.productFind).toHaveBeenCalledWith({ tenant: "tenant-1", _id: { $in: ["product-class"] } });
    expect(mocks.validateAvailability).toHaveBeenCalledWith(expect.objectContaining({
      currentBookings: [expect.objectContaining({ tag: "course", maxNumberOfParticipants: 8 })],
    }));
  });

  it.each([
    [undefined, "processed", "2099-09-15T11:00:00+02:00", "PRODUCT_LOCATION_REQUIRED"],
    ["location-2", "processed", "2099-09-15T11:00:00+02:00", "PRODUCT_LOCATION_MISMATCH"],
    ["location-1", "processed", "2099-09-15T11:00:00+02:00", undefined],
    [undefined, "cancelled", "2099-09-15T11:00:00+02:00", undefined],
    [undefined, "completed", "2020-09-15T11:00:00+02:00", undefined],
  ])("validates studio product location %s for %s source reservations", async (location, bookingStatus, end, code) => {
    mocks.productFind.mockReturnValue(selectLean([{
      _id: "private-product", name: "Private Studio", type: "blocker", kind: "private-studio", location,
    }]));
    mocks.rowFind.mockReturnValue(rowQuery([{
      _id: "row-2", rowNumber: 2, raw: {
        Service: "Private Studio", Start: end.replace("11:00", "09:00"), End: end, Status: bookingStatus,
      },
    }]));
    await validate({ productName: "Service", start: "Start", end: "End", status: "Status" });
    const operation = mocks.rowBulkWrite.mock.calls[0][0][0];
    expect(status(operation)).toBe(code ? "invalid" : "valid");
    if (code) expect(issueCodes(operation)).toContain(code);
  });

  it("does not guess between duplicated studio product names for historical bookings", async () => {
    mocks.productFind.mockReturnValue(selectLean([
      { _id: "product-a", name: "Private Studio", kind: "private-studio", type: "blocker", location: "location-1" },
      { _id: "product-b", name: "Private Studio", kind: "private-studio", type: "blocker", location: "location-2" },
    ]));
    mocks.rowFind.mockReturnValue(rowQuery([{
      _id: "row-2", rowNumber: 2, raw: { Service: "Private Studio", Start: "2020-09-15T09:00:00+02:00", End: "2020-09-15T11:00:00+02:00" },
    }]));
    await validate({ productName: "Service", start: "Start", end: "End" });
    expect(issueCodes(mocks.rowBulkWrite.mock.calls[0][0][0])).toContain("BOOKING_PRODUCT_AMBIGUOUS");
  });

  const configureStudioCopies = () => {
    mocks.productFind.mockReturnValue(selectLean([
      { _id: "product-a", name: "Private Studio", sku: "STUDIO", kind: "private-studio", type: "blocker", location: "location-1", importMetadata: { externalId: "original-product" } },
      { _id: "product-b", name: "Private Studio", sku: "STUDIO", kind: "private-studio", type: "blocker", location: "location-2" },
    ]));
    mocks.locationFind.mockReturnValue(selectLean([
      { _id: "location-1", code: "MAIN", name: "Main Studio", isActive: true, booking: { enabled: true } },
      { _id: "location-2", code: "OTHER", name: "Other Studio", isActive: true, booking: { enabled: true } },
      { _id: "location-3", code: "EMPTY", name: "Empty Studio", isActive: true, booking: { enabled: true } },
    ]));
  };

  const studioCopyRow = (overrides: Record<string, string> = {}) => ({
    _id: "row-2", rowNumber: 2, raw: {
      Service: "Private Studio", Email: "OTHER",
      Start: "2099-09-15T09:00:00+02:00", End: "2099-09-15T11:00:00+02:00",
      ...overrides,
    },
  });

  it.each(["productName", "productSku"])("resolves repeated studio %s at the new booking's location", async (identifier) => {
    configureStudioCopies();
    mocks.rowFind.mockReturnValue(rowQuery([studioCopyRow({ Service: identifier === "productSku" ? "STUDIO" : "Private Studio" })]));
    await validate({ [identifier]: "Service", locationCode: "Email", start: "Start", end: "End" });
    const operation = mocks.rowBulkWrite.mock.calls[0][0][0];
    expect(status(operation)).toBe("valid");
    expect(normalized(operation)).toMatchObject({ productId: "product-b", locationId: "location-2" });
  });

  it.each([
    ["EMPTY", "PRODUCT_LOCATION_MISMATCH"],
    ["", "BOOKING_LOCATION_REQUIRED"],
  ])("rejects repeated studio names when the location is %s", async (locationCode, code) => {
    configureStudioCopies();
    mocks.rowFind.mockReturnValue(rowQuery([studioCopyRow({ Email: locationCode })]));
    await validate({ productName: "Service", locationCode: "Email", start: "Start", end: "End" });
    const operation = mocks.rowBulkWrite.mock.calls[0][0][0];
    expect(status(operation)).toBe("invalid");
    expect(issueCodes(operation)).toContain(code);
  });

  it("keeps a stable product external ID instead of selecting its copy at another location", async () => {
    configureStudioCopies();
    mocks.rowFind.mockReturnValue(rowQuery([studioCopyRow({ Service: "original-product" })]));
    await validate({ productExternalId: "Service", locationCode: "Email", start: "Start", end: "End" });
    const operation = mocks.rowBulkWrite.mock.calls[0][0][0];
    expect(status(operation)).toBe("invalid");
    expect(normalized(operation).productId).toBe("product-a");
    expect(issueCodes(operation)).toContain("PRODUCT_LOCATION_MISMATCH");
  });

  it("does not discard a contradictory unique SKU while resolving a repeated name", async () => {
    configureStudioCopies();
    mocks.productFind.mockReturnValue(selectLean([
      { _id: "product-a", name: "Private Studio", sku: "ORIGINAL", kind: "private-studio", type: "blocker", location: "location-1" },
      { _id: "product-b", name: "Private Studio", sku: "COPY", kind: "private-studio", type: "blocker", location: "location-2" },
    ]));
    mocks.rowFind.mockReturnValue(rowQuery([studioCopyRow({ Guests: "ORIGINAL" })]));
    await validate({ productName: "Service", productSku: "Guests", locationCode: "Email", start: "Start", end: "End" });
    expect(issueCodes(mocks.rowBulkWrite.mock.calls[0][0][0])).toContain("BOOKING_PRODUCT_AMBIGUOUS");
  });

  it("does not remap an existing reservation to a same-name studio copy", async () => {
    configureStudioCopies();
    mocks.rowFind.mockReturnValue(rowQuery([studioCopyRow({ "Booking ID": "existing-reservation" })]));
    mocks.bookingFind.mockReturnValue(selectLean([{
      _id: "existing-booking", createdBy: "actor-1", bookingProduct: "product-a", location: "location-2",
      start: new Date("2099-09-15T07:00:00Z"), end: new Date("2099-09-15T09:00:00Z"),
      tag: "private-studio", status: "processed", orders: [],
      importMetadata: { externalId: "existing-reservation", importId: "old-import" },
    }]));
    await validateBookingImportSession({
      tenantId: "tenant-1", sessionId: "session-1", actorId: "actor-1", tenantLanguage: "cs", duplicateStrategy: "update",
      mapping: { externalId: "Booking ID", productName: "Service", locationCode: "Email", start: "Start", end: "End" },
    });
    const operation = mocks.rowBulkWrite.mock.calls[0][0][0];
    expect(status(operation)).toBe("invalid");
    expect(issueCodes(operation)).toContain("BOOKING_PRODUCT_AMBIGUOUS");
  });

  it("rejects class customer enrolments while accepting customer-free sessions", async () => {
    mocks.rowFind.mockReturnValue(
      rowQuery([
        {
          _id: "row-2",
          rowNumber: 2,
          raw: {
            Service: "Wheel Class",
            Email: "anna@example.com",
            Start: "2026-09-15T09:00:00+02:00",
            End: "2026-09-15T11:00:00+02:00",
            Guests: "3",
          },
        },
        {
          _id: "row-3",
          rowNumber: 3,
          raw: {
            Service: "Wheel Class",
            Email: "",
            Start: "2026-09-16T09:00:00+02:00",
            End: "2026-09-16T11:00:00+02:00",
            Guests: "not-a-number",
          },
        },
      ]),
    );

    await validate({
      productName: "Service",
      customerEmail: "Email",
      start: "Start",
      end: "End",
      numberOfGuests: "Guests",
    });

    const operations = mocks.rowBulkWrite.mock.calls[0][0];
    expect(operations).toHaveLength(2);

    expect(status(operations[0])).toBe("invalid");
    expect(issueCodes(operations[0])).toEqual(
      expect.arrayContaining([
        "BOOKING_CLASS_ENROLLMENT_UNSUPPORTED",
        "BOOKING_SESSION_GUESTS_IGNORED",
      ]),
    );
    expect(normalized(operations[0])).toMatchObject({
      tag: "class",
      productKind: "class",
      numberOfGuests: 0,
      bookingMode: null,
    });

    expect(status(operations[1])).toBe("valid");
    expect(issueCodes(operations[1])).toContain(
      "BOOKING_SESSION_GUESTS_IGNORED",
    );
    expect(issueCodes(operations[1])).not.toContain("BOOKING_GUESTS_INVALID");
    expect(normalized(operations[1])).toMatchObject({
      tag: "class",
      productKind: "class",
      numberOfGuests: 0,
    });
    expect(normalized(operations[1]).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a future Open Studio status change during validation", async () => {
    const start = "2099-09-15T09:00:00+02:00";
    const end = "2099-09-15T11:00:00+02:00";
    const existing = {
      _id: "booking-1",
      tag: "workshop",
      orders: [],
      importMetadata: {
        importId: "old-import",
        importKey: "old-import:2",
        externalId: "legacy-booking-1",
      },
      createdBy: "customer-1",
      bookingProduct: "product-open",
      location: "location-1",
      start: new Date("2099-09-15T07:00:00.000Z"),
      end: new Date("2099-09-15T09:00:00.000Z"),
      status: "cancelled",
    };
    mocks.rowFind.mockReturnValue(
      rowQuery([
        {
          _id: "row-2",
          rowNumber: 2,
          raw: {
            "Booking ID": "legacy-booking-1",
            Service: "Open Studio",
            Email: "anna@example.com",
            Start: start,
            End: end,
            Status: "processed",
          },
        },
      ]),
    );
    mocks.userFind.mockReturnValue(
      selectLean([
        {
          _id: "customer-1",
          firstname: "Anna",
          lastname: "Novak",
          customId: "CUS-1",
          email: "anna@example.com",
        },
      ]),
    );
    mocks.productFind.mockReturnValue(
      selectLean([
        {
          _id: "product-open",
          name: "Open Studio",
          sku: "OPEN-1",
          kind: "open-studio",
          type: "workshop",
          bookingMode: "public",
          isActive: true,
          maxNumberOfParticipants: 8,
        },
      ]),
    );
    mocks.bookingFind
      .mockReturnValueOnce(selectLean([existing]))
      .mockReturnValue(selectLean([]));

    await validateBookingImportSession({
      tenantId: "tenant-1",
      sessionId: "session-1",
      mapping: {
        externalId: "Booking ID",
        productName: "Service",
        customerEmail: "Email",
        start: "Start",
        end: "End",
        status: "Status",
      },
      duplicateStrategy: "update",
      actorId: "actor-1",
      tenantLanguage: "cs",
    });

    const operation = mocks.rowBulkWrite.mock.calls[0][0][0];
    expect(status(operation)).toBe("invalid");
    expect(issueCodes(operation)).toContain(
      "BOOKING_FUTURE_STATUS_UPDATE_UNSUPPORTED",
    );
  });

  it.each([
    ["2026-02-30", "10:00", "11:00", "BOOKING_LOCAL_TIME_INVALID"],
    ["2026-03-29", "02:30", "03:30", "BOOKING_LOCAL_TIME_NONEXISTENT"],
    ["2026-10-25", "02:30", "03:30", "BOOKING_LOCAL_TIME_AMBIGUOUS"],
  ])(
    "rejects unsafe local time %s %s-%s as %s",
    async (date, from, to, expectedCode) => {
      mocks.rowFind.mockReturnValue(
        rowQuery([
          {
            _id: "row-2",
            rowNumber: 2,
            raw: {
              Service: "Wheel Class",
              Date: date,
              From: from,
              To: to,
            },
          },
        ]),
      );

      await validate({
        productName: "Service",
        date: "Date",
        startTime: "From",
        endTime: "To",
      });

      const operation = mocks.rowBulkWrite.mock.calls[0][0][0];
      expect(status(operation)).toBe("invalid");
      expect(issueCodes(operation)).toContain(expectedCode);
      expect(normalized(operation).start).toBe("");
      expect(normalized(operation).end).toBe("");
    },
  );
});
