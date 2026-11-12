import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionFindOneAndUpdate: vi.fn(),
  sessionUpdateOne: vi.fn(),
  rowFind: vi.fn(),
  rowFindOneAndUpdate: vi.fn(),
  rowUpdateOne: vi.fn(),
  rowCountDocuments: vi.fn(),
  bookingFind: vi.fn(),
  bookingFindOne: vi.fn(),
  bookingCreate: vi.fn(),
  bookingFindOneAndUpdate: vi.fn(),
  productFindOne: vi.fn(),
  productFind: vi.fn(),
  locationFindOne: vi.fn(),
  membershipFindOne: vi.fn(),
  membershipExists: vi.fn(),
  userFindOne: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  hasWorkspacePermission: vi.fn(),
  validateAvailability: vi.fn(),
  tenantFindOne: vi.fn(),
  recordAudit: vi.fn(),
  mutationFindOne: vi.fn(),
  recordMutation: vi.fn(),
  completeImport: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
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
    findOneAndUpdate: mocks.rowFindOneAndUpdate,
    updateOne: mocks.rowUpdateOne,
    countDocuments: mocks.rowCountDocuments,
  },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
    findOne: mocks.bookingFindOne,
    create: mocks.bookingCreate,
    findOneAndUpdate: mocks.bookingFindOneAndUpdate,
  },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: { findOne: mocks.productFindOne, find: mocks.productFind },
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: { findOne: mocks.locationFindOne },
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: {
    findOne: mocks.membershipFindOne,
    exists: mocks.membershipExists,
  },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.userFindOne },
}));
vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  resolveWorkspaceAccessForUser: mocks.resolveWorkspaceAccess,
  hasWorkspacePermission: mocks.hasWorkspacePermission,
}));
vi.mock("@/modules/checkout/services/checkout.capacity.service.js", () => ({
  validateOpenStudioAvailabilityOrThrow: mocks.validateAvailability,
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));

vi.mock("@/modules/data-import/data-import-mutation.model.js", () => ({
  default: { findOne: mocks.mutationFindOne },
}));

vi.mock(
  "@/modules/data-import/services/data-import-mutation.service.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/modules/data-import/services/data-import-mutation.service.js")
      >();
    return { ...actual, recordDataImportMutation: mocks.recordMutation };
  },
);

vi.mock(
  "@/modules/data-import/services/data-import-rollback-availability.service.js",
  () => ({ completeImportWithRollbackAvailability: mocks.completeImport }),
);

import { processBookingImportSession } from "@/modules/data-import/services/booking-import-execution.service.js";

const tenantId = new mongoose.Types.ObjectId().toString();
const sessionId = new mongoose.Types.ObjectId().toString();
const actorId = new mongoose.Types.ObjectId().toString();
const customerId = new mongoose.Types.ObjectId().toString();
const productId = new mongoose.Types.ObjectId().toString();
const locationId = new mongoose.Types.ObjectId().toString();

const query = (value: unknown) => {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.session = vi.fn(() => chain);
  chain.lean = vi.fn(() => Promise.resolve(value));
  return chain;
};

const selectResult = (value: unknown) => ({
  select: () => Promise.resolve(value),
});

const session = (duplicateStrategy: "skip" | "update" = "skip") => ({
  _id: sessionId,
  tenant: tenantId,
  createdBy: "original-actor",
  queuedBy: actorId,
  fileType: "csv",
  duplicateStrategy,
});

const normalizedBooking = (
  kind: "open-studio" | "class" | "private-studio" = "class",
  overrides: Record<string, unknown> = {},
) => ({
  externalId: "legacy-booking-1",
  start: "2099-09-15T07:00:00.000Z",
  end: "2099-09-15T09:00:00.000Z",
  numberOfGuests: kind === "open-studio" ? 1 : 0,
  numberOfGuestsProvided: false,
  status: "processed",
  language: "cs",
  plannedActivity: "UNDEFINED",
  lecturer: "",
  description: "Imported booking",
  note: "",
  productId,
  locationId,
  tag: kind,
  productKind: kind,
  bookingMode: kind === "open-studio" ? "public" : null,
  durationHours: 2,
  fingerprint: "f".repeat(64),
  parseErrors: [],
  ...(kind === "open-studio" ? { customerId } : {}),
  ...overrides,
});

const row = (normalized = normalizedBooking()) => ({
  _id: "row-2",
  rowNumber: 2,
  normalized,
  duplicate: null,
});

const configureSession = (duplicateStrategy: "skip" | "update" = "skip") => {
  mocks.sessionFindOneAndUpdate.mockReturnValue(
    query(session(duplicateStrategy)),
  );
};

const configureRows = (rows: any[]) => {
  mocks.rowFind.mockReturnValue({ sort: () => Promise.resolve(rows) });
  mocks.rowFindOneAndUpdate.mockImplementation(({ _id }) =>
    Promise.resolve(rows.find((item) => item._id === _id) || null),
  );
};

const configureKind = (kind: "open-studio" | "class" | "private-studio") => {
  mocks.productFindOne.mockReturnValue(
    query({
      _id: productId,
      kind,
      type: kind === "class" ? "course" : kind === "private-studio" ? "blocker" : "workshop",
      location: kind !== "class" ? locationId : undefined,
      bookingMode: kind === "open-studio" ? "public" : null,
      isActive: true,
      maxNumberOfParticipants: 8,
    }),
  );
  mocks.userFindOne.mockReturnValue(
    query({
      _id: kind === "open-studio" ? customerId : actorId,
      firstname: kind === "open-studio" ? "Anna" : "Import",
      lastname: kind === "open-studio" ? "Novak" : "Operator",
      customId: kind === "open-studio" ? "CUS-1" : "STAFF-1",
    }),
  );
};

const markedStatus = (status: string) =>
  mocks.rowUpdateOne.mock.calls.filter(
    ([, update]) => update?.$set?.status === status,
  ).length;

describe("booking import execution safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureSession();
    configureRows([row()]);
    configureKind("class");
    mocks.sessionUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mocks.rowUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mocks.rowCountDocuments.mockImplementation(({ status }) =>
      Promise.resolve(markedStatus(status)),
    );
    mocks.bookingFind.mockReturnValue(query([]));
    mocks.bookingFindOne.mockReturnValue(selectResult(null));
    mocks.bookingCreate.mockResolvedValue([{ _id: "created-booking" }]);
    mocks.bookingFindOneAndUpdate.mockReturnValue(
      selectResult({ _id: "updated-booking" }),
    );
    mocks.locationFindOne.mockReturnValue(
      query({
        _id: locationId,
        isActive: true,
        booking: { enabled: true, timezone: "Europe/Prague" },
      }),
    );
    mocks.membershipFindOne.mockReturnValue(
      query({ locationAccess: { mode: "all" } }),
    );
    mocks.membershipExists.mockReturnValue({
      session: () => Promise.resolve(null),
    });
    mocks.resolveWorkspaceAccess.mockResolvedValue({ status: "active" });
    mocks.hasWorkspacePermission.mockReturnValue(true);
    mocks.validateAvailability.mockReturnValue(undefined);
    mocks.tenantFindOne.mockResolvedValue({ modules: { bookings: true } });
    (mongoose.connection as any).db = {
      collection: () => ({ findOne: mocks.tenantFindOne }),
    };
    mocks.mutationFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });
    mocks.recordMutation.mockResolvedValue({});
    mocks.completeImport.mockResolvedValue(undefined);
    mocks.withTransaction.mockImplementation(async (callback) => callback());
    mocks.endSession.mockResolvedValue(undefined);
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    } as never);
    mocks.recordAudit.mockResolvedValue({});
  });

  afterEach(() => {
    (mongoose.connection as any).db = undefined;
    vi.restoreAllMocks();
  });

  it("creates an Open Studio technical reservation without commerce or delivery side effects", async () => {
    configureKind("open-studio");
    configureRows([row(normalizedBooking("open-studio"))]);

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });

    const payload = mocks.bookingCreate.mock.calls[0][0][0];
    expect(payload).toMatchObject({
      tenant: tenantId,
      createdBy: customerId,
      participants: [],
      orders: [],
      paymentStatus: "CONFIRMED",
      wasReminderSent: true,
      importMetadata: {
        importId: sessionId,
        importKey: `${sessionId}:2`,
        externalId: "legacy-booking-1",
        fingerprint: "f".repeat(64),
        importedBy: actorId,
      },
    });
    expect(payload).not.toHaveProperty("confirmationSentAt");
  });

  it("loads course product capacity before checking the imported studio reservation", async () => {
    configureKind("open-studio");
    configureRows([row(normalizedBooking("open-studio"))]);
    const course = { _id: "class-session", tag: "course", bookingProduct: productId, numberOfGuests: 0 };
    mocks.bookingFind.mockImplementation((filter) => query(filter.end?.$gt ? [course] : []));
    mocks.productFind.mockReturnValue({
      select: vi.fn().mockReturnThis(), session: vi.fn().mockReturnThis(), lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([{ _id: productId, maxNumberOfParticipants: 8 }]),
    });
    await expect(processBookingImportSession({ tenantId, sessionId })).resolves.toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });
    expect(mocks.productFind).toHaveBeenCalledWith({ tenant: tenantId, _id: { $in: [productId] } });
    expect(mocks.validateAvailability).toHaveBeenCalledWith(expect.objectContaining({
      currentBookings: [expect.objectContaining({ tag: "course", maxNumberOfParticipants: 8 })],
    }));
  });

  it.each([
    ["open-studio", undefined],
    ["open-studio", "64b000000000000000000199"],
    ["private-studio", undefined],
    ["private-studio", "64b000000000000000000199"],
  ] as const)("revalidates new future %s product location %s during execution", async (kind, location) => {
    configureKind(kind);
    configureRows([row(normalizedBooking(kind))]);
    mocks.productFindOne.mockReturnValue(query({
      _id: productId, kind, type: kind === "open-studio" ? "workshop" : "blocker", bookingMode: "public", location,
    }));
    await expect(processBookingImportSession({ tenantId, sessionId }))
      .resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });
    expect(mocks.productFindOne).toHaveBeenCalledWith({ _id: productId, tenant: tenantId });
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", "2020-09-15T09:00:00.000Z"],
    ["cancelled", "2099-09-15T09:00:00.000Z"],
  ])("preserves historical %s imports of unassigned studio products", async (status, end) => {
    configureKind("open-studio");
    configureRows([row(normalizedBooking("open-studio", {
      status, end, start: new Date(new Date(end).getTime() - 7_200_000).toISOString(),
    }))]);
    mocks.productFindOne.mockReturnValue(query({ _id: productId, kind: "open-studio", type: "workshop" }));
    await expect(processBookingImportSession({ tenantId, sessionId }))
      .resolves.toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });
    expect(mocks.bookingCreate.mock.calls[0][0][0]).toMatchObject({ location: locationId, bookingProduct: productId });
  });

  it("preserves an unchanged future imported reservation whose product has no location", async () => {
    configureSession("update");
    configureKind("open-studio");
    const normalized = normalizedBooking("open-studio", { providedFields: ["productName", "start", "end", "note"], note: "Updated note" });
    configureRows([row(normalized)]);
    mocks.productFindOne.mockReturnValue(query({ _id: productId, kind: "open-studio", type: "workshop" }));
    mocks.bookingFind.mockReturnValue(query([{
      _id: "legacy-reservation", tag: "workshop", orders: [], createdBy: customerId,
      bookingProduct: productId, location: locationId, start: new Date(normalized.start), end: new Date(normalized.end),
      status: "processed", importMetadata: { importId: "old", importKey: "old:2" },
    }]));
    await expect(processBookingImportSession({ tenantId, sessionId }))
      .resolves.toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });
    expect(mocks.bookingFindOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ note: "Updated note" });
  });

  it("does not silently choose public if the product becomes customer-choice after validation", async () => {
    configureKind("open-studio");
    configureRows([row(normalizedBooking("open-studio"))]);
    mocks.productFindOne.mockReturnValue(query({
      _id: productId, kind: "open-studio", type: "workshop",
      bookingMode: "customer-choice", isActive: true,
    }));

    await expect(processBookingImportSession({ tenantId, sessionId })).resolves.toEqual({
      created: 0, updated: 0, skipped: 0, failed: 1,
    });
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({
        status: "failed", resultMessage: expect.stringContaining("public or private choice"),
      }) }),
    );
  });

  it("creates a future Class session owned by the queued actor with reminders enabled", async () => {
    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });

    expect(mocks.userFindOne).toHaveBeenCalledWith({
      _id: actorId,
      tenant: tenantId,
    });
    expect(mocks.bookingCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          createdBy: actorId,
          participants: [],
          orders: [],
          tag: "class",
          wasReminderSent: false,
        }),
      ],
      { session: expect.any(Object) },
    );
  });

  it("reuses a committed mutation when a worker retries a created row", async () => {
    mocks.mutationFindOne.mockReturnValue({
      lean: () =>
        Promise.resolve({
          importOutcome: "created",
          target: "already-created",
          importMessage: "Booking created.",
        }),
    });

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });

    expect(mocks.mutationFindOne).toHaveBeenCalledWith({
      tenant: tenantId,
      session: sessionId,
      row: "row-2",
      isCanonicalResult: true,
    });
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "created",
          resultRecord: "already-created",
        }),
      }),
    );
  });

  it("skips a legacy-equivalent native Class duplicate", async () => {
    mocks.bookingFind.mockReturnValue(
      query([{ _id: "native-course", tag: "course", orders: [] }]),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 1, failed: 0 });

    const lookup = mocks.bookingFind.mock.calls[0][0];
    expect(lookup.$or).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: { $in: ["class", "course"] } }),
      ]),
    );
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "skipped",
          resultRecord: "native-course",
        }),
      }),
    );
  });

  it("preserves the original import key when updating an imported booking", async () => {
    configureSession("update");
    const normalized = normalizedBooking("class");
    configureRows([row(normalized)]);
    mocks.bookingFind.mockReturnValue(
      query([
        {
          _id: "existing-import",
          tag: "course",
          orders: [],
          createdBy: actorId,
          bookingProduct: productId,
          location: locationId,
          start: new Date(normalized.start),
          end: new Date(normalized.end),
          status: "processed",
          importMetadata: {
            importId: "original-import",
            importKey: "original-import:8",
          },
        },
      ]),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });

    const [, update] = mocks.bookingFindOneAndUpdate.mock.calls[0];
    expect(update.$set).not.toHaveProperty("importMetadata.importKey");
  });

  it("preserves omitted booking fields and lifecycle state during update", async () => {
    configureSession("update");
    const normalized = normalizedBooking("class", {
      start: "2020-09-15T07:00:00.000Z",
      end: "2020-09-15T09:00:00.000Z",
      status: "completed",
      language: "cs",
      plannedActivity: "UNDEFINED",
      description: "",
      note: "",
      numberOfGuests: 0,
      providedFields: ["productName", "start", "end"],
    });
    configureRows([row(normalized)]);
    mocks.bookingFind.mockReturnValue(
      query([
        {
          _id: "cancelled-import",
          tag: "course",
          orders: [],
          participants: [{ firstname: "Existing" }],
          bookingRefs: [{ booking: "child" }],
          capacityReservations: [{ order: "hold" }],
          paymentStatus: "CONFIRMED",
          wasReminderSent: true,
          accessCodeDelivery: { status: "sent" },
          confirmationSentAt: new Date("2020-09-14T10:00:00.000Z"),
          lastNotificationChannel: "email",
          importMetadata: {
            importId: "original-import",
            importKey: "original-import:8",
          },
          createdBy: actorId,
          bookingProduct: productId,
          location: locationId,
          start: new Date(normalized.start),
          end: new Date(normalized.end),
          status: "cancelled",
          language: "en",
          plannedActivity: "WORKSTATION",
          description: "Keep description",
          note: "Keep note",
          lecturer: "Keep lecturer",
          numberOfGuests: 7,
        },
      ]),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });

    const [, update] = mocks.bookingFindOneAndUpdate.mock.calls[0];
    for (const omittedField of [
      "status",
      "numberOfGuests",
      "language",
      "plannedActivity",
      "description",
      "note",
      "lecturer",
      "participants",
      "orders",
      "bookingRefs",
      "capacityReservations",
      "paymentStatus",
      "wasReminderSent",
      "accessCodeDelivery",
      "confirmationSentAt",
      "lastNotificationChannel",
      "createdBy",
      "author",
    ]) {
      expect(update.$set).not.toHaveProperty(omittedField);
    }
    expect(update.$set).not.toHaveProperty("importMetadata.importKey");
    expect(update.$set["importMetadata.fingerprint"]).toBe(
      normalized.fingerprint,
    );
  });

  it.each([
    ["native booking", undefined, []],
    [
      "booking with Orders",
      { importId: "old", importKey: "old:2" },
      ["order-1"],
    ],
  ])(
    "rejects update of a protected %s",
    async (_label, importMetadata, orders) => {
      configureSession("update");
      const normalized = normalizedBooking("class");
      configureRows([row(normalized)]);
      mocks.bookingFind.mockReturnValue(
        query([
          {
            _id: "protected-booking",
            tag: "class",
            orders,
            importMetadata,
            createdBy: actorId,
            bookingProduct: productId,
            location: locationId,
            start: new Date(normalized.start),
            end: new Date(normalized.end),
            status: "processed",
          },
        ]),
      );

      await expect(
        processBookingImportSession({ tenantId, sessionId }),
      ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

      expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
        { _id: "row-2" },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: "failed",
            resultMessage:
              "Only import-owned bookings without Orders can be updated.",
          }),
        }),
      );
    },
  );

  it("rejects rescheduling a future Open Studio reservation", async () => {
    configureSession("update");
    configureKind("open-studio");
    const normalized = normalizedBooking("open-studio");
    configureRows([row(normalized)]);
    const current = {
      _id: "future-import",
      tag: "workshop",
      orders: [],
      importMetadata: { importId: "old", importKey: "old:2" },
      createdBy: customerId,
      bookingProduct: productId,
      location: locationId,
      start: new Date(normalized.start),
      end: new Date("2099-09-15T08:30:00.000Z"),
      status: "processed",
    };
    mocks.bookingFind
      .mockReturnValueOnce(query([current]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([current]));

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage:
            "Future Open Studio reservations cannot be rescheduled or reassigned by import.",
        }),
      }),
    );
  });

  it("rejects changing a future Open Studio reservation status", async () => {
    configureSession("update");
    configureKind("open-studio");
    const normalized = normalizedBooking("open-studio", {
      status: "processed",
      providedFields: [
        "externalId",
        "customerEmail",
        "productName",
        "locationCode",
        "start",
        "end",
        "status",
      ],
    });
    configureRows([row(normalized)]);
    mocks.bookingFind.mockReturnValue(
      query([
        {
          _id: "future-cancelled-import",
          tag: "workshop",
          orders: [],
          importMetadata: { importId: "old", importKey: "old:2" },
          createdBy: customerId,
          bookingProduct: productId,
          location: locationId,
          start: new Date(normalized.start),
          end: new Date(normalized.end),
          status: "cancelled",
        },
      ]),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage:
            "Future Open Studio reservation status cannot be changed by import.",
        }),
      }),
    );
  });

  it("rejects an Open Studio to Class kind mismatch before skip or update", async () => {
    mocks.bookingFind.mockReturnValue(
      query([{ _id: "open-booking", tag: "open-studio", orders: [] }]),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage: "An import cannot change an existing booking kind.",
        }),
      }),
    );
  });

  it("aborts before claiming rows when booking import permission was revoked", async () => {
    mocks.hasWorkspacePermission.mockReturnValue(false);

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).rejects.toThrow(
      "The queued actor no longer has booking import permission.",
    );

    expect(mocks.rowFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
  });

  it("fails closed when the bookings module was disabled after validation", async () => {
    mocks.tenantFindOne.mockResolvedValue({ modules: { bookings: false } });

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage: "The bookings module is no longer enabled.",
        }),
      }),
    );
  });

  it("fails closed when the actor lost access to the booking location", async () => {
    mocks.membershipFindOne.mockReturnValue(
      query({
        locationAccess: { mode: "selected", locationIds: ["another-location"] },
      }),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage:
            "The queued actor no longer has access to this location.",
        }),
      }),
    );
  });

  it("cannot update an external-ID booking at an inaccessible existing location", async () => {
    configureSession("update");
    const inaccessibleLocationId = new mongoose.Types.ObjectId().toString();
    const normalized = normalizedBooking("class");
    configureRows([row(normalized)]);
    mocks.membershipFindOne.mockReturnValue(
      query({
        locationAccess: { mode: "selected", locationIds: [locationId] },
      }),
    );
    mocks.bookingFind.mockReturnValue(
      query([
        {
          _id: "inaccessible-import",
          tag: "class",
          orders: [],
          importMetadata: { importId: "old", importKey: "old:2" },
          createdBy: actorId,
          bookingProduct: productId,
          location: inaccessibleLocationId,
          start: new Date(normalized.start),
          end: new Date(normalized.end),
          status: "processed",
        },
      ]),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage:
            "The queued actor cannot access the existing booking's location.",
        }),
      }),
    );
  });

  it("requires revalidation when a split-time location timezone changed", async () => {
    configureRows([
      row(
        normalizedBooking("class", {
          resolvedTimezone: "America/New_York",
        }),
      ),
    ]);

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });

    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          resultMessage:
            "The location timezone changed after split local times were validated. Validate the import again.",
        }),
      }),
    );
  });

  it("keeps explicit-offset bookings independent of later timezone changes", async () => {
    mocks.locationFindOne.mockReturnValue(
      query({
        _id: locationId,
        isActive: true,
        booking: { enabled: true, timezone: "America/New_York" },
      }),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });

    expect(mocks.bookingCreate).toHaveBeenCalledOnce();
  });

  it("resolves an E11000 creation race to a safe skip", async () => {
    mocks.bookingFind
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(
        query([{ _id: "race-winner", tag: "class", orders: [] }]),
      );
    mocks.bookingCreate.mockRejectedValue(
      Object.assign(new Error("duplicate key"), { code: 11000 }),
    );

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).resolves.toEqual({ created: 0, updated: 0, skipped: 1, failed: 0 });

    expect(mocks.rowUpdateOne).toHaveBeenCalledWith(
      { _id: "row-2" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "skipped",
          resultRecord: "race-winner",
        }),
      }),
    );
  });

  it("aborts safely when the worker loses its execution lease", async () => {
    mocks.sessionUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await expect(
      processBookingImportSession({ tenantId, sessionId }),
    ).rejects.toThrow("Booking import execution lease was lost.");

    expect(mocks.rowFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingCreate).not.toHaveBeenCalled();
    expect(mocks.sessionUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: sessionId, tenant: tenantId }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          lastError: expect.objectContaining({
            code: "IMPORT_EXECUTION_FAILED",
          }),
        }),
      }),
    );
  });
});
