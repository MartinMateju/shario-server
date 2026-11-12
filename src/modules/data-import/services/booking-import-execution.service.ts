import { randomUUID } from "node:crypto";

import mongoose from "mongoose";

import BookingModel from "@/modules/booking/booking.model.js";
import { loadCourseCapacityForBookings } from "@/modules/booking/booking.course-capacity.js";
import { validateOpenStudioAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";
import LocationModel from "@/modules/location/location.model.js";
import ProductModel from "@/modules/product/product.model.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";
import UserModel from "@/modules/user/user.model.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_ROW_STATUS,
  DATA_IMPORT_STATUS,
} from "../data-import.constants.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import type { NormalizedBookingImportRow } from "../data-import.types.js";
import { isProtectedWorkspaceUser } from "../adapters/customer-import.adapter.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import {
  importMutationOperation,
  recordDataImportMutation,
} from "./data-import-mutation.service.js";
import { completeImportWithRollbackAvailability } from "./data-import-rollback-availability.service.js";
import { assertImportRecordNotRolledBack } from "./data-import-rollback-marker.service.js";
import { assertImportedBookingProductLocation } from "./booking-import-location.policy.js";

const BOOKING_CREATE_FIELDS = [
  "createdBy",
  "author",
  "bookingProduct",
  "location",
  "start",
  "end",
  "numberOfHours",
  "numberOfGuests",
  "status",
  "archive",
  "language",
  "plannedActivity",
  "lecturer",
  "description",
  "note",
  "tag",
  "bookingType",
  "bookingMode",
  "importMetadata",
] as const;

const LEASE_MS = 5 * 60_000;

const safeError = (error: unknown): string =>
  (error instanceof Error ? error.message : "Booking import failed.").slice(
    0,
    1_000,
  );

const kindOf = (product: any): string => {
  if (["open-studio", "class", "private-studio"].includes(product?.kind))
    return product.kind;
  if (
    ["workshop", "public-workshop", "private-workshop"].includes(product?.type)
  )
    return "open-studio";
  if (["course", "public-course", "private-course"].includes(product?.type))
    return "class";
  if (["blocker", "private-studio"].includes(product?.type))
    return "private-studio";
  return "";
};

const canonicalBookingTag = (value: unknown): string => {
  const tag = String(value || "");
  if (["open-studio", "workshop"].includes(tag)) return "open-studio";
  if (["class", "course"].includes(tag)) return "class";
  if (["private-studio", "private-session"].includes(tag))
    return "private-studio";
  return tag;
};

const bookingTagAliases = (value: unknown): string[] => {
  const tag = canonicalBookingTag(value);
  if (tag === "open-studio") return ["open-studio", "workshop"];
  if (tag === "class") return ["class", "course"];
  if (tag === "private-studio") return ["private-studio", "private-session"];
  return tag ? [tag] : [];
};

const findCurrentBooking = async (
  tenantId: string,
  normalized: NormalizedBookingImportRow,
  transaction: mongoose.ClientSession | null = null,
) => {
  const conditions: Record<string, unknown>[] = [];
  if (normalized.externalId)
    conditions.push({ "importMetadata.externalId": normalized.externalId });
  if (normalized.fingerprint)
    conditions.push({ "importMetadata.fingerprint": normalized.fingerprint });
  if (
    normalized.customerId &&
    normalized.productId &&
    normalized.locationId &&
    normalized.start &&
    normalized.tag
  ) {
    conditions.push({
      ...(normalized.tag === "open-studio"
        ? { createdBy: normalized.customerId }
        : {}),
      bookingProduct: normalized.productId,
      location: normalized.locationId,
      start: new Date(normalized.start),
      tag: { $in: bookingTagAliases(normalized.tag) },
    });
  }
  if (!conditions.length) return { record: null, conflict: false };
  const records = await BookingModel.find({ tenant: tenantId, $or: conditions })
    .select(
      "_id orders createdBy bookingProduct location start end status tag accessCodeDelivery confirmationSentAt lastNotificationChannel +importMetadata",
    )
    .session(transaction)
    .lean();
  const byId = new Map(
    (records as any[]).map((record) => [String(record._id), record]),
  );
  return byId.size > 1
    ? { record: null, conflict: true }
    : { record: [...byId.values()][0] || null, conflict: false };
};

const isHistorical = (normalized: NormalizedBookingImportRow): boolean =>
  ["completed", "cancelled", "delivered"].includes(normalized.status) ||
  new Date(normalized.end).getTime() <= Date.now();

const assertBookingImportPermission = async (
  tenantId: string,
  actorId: string,
): Promise<void> => {
  const access = await resolveWorkspaceAccessForUser({
    tenantId,
    userId: actorId,
  });
  if (
    !access ||
    access.status !== "active" ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.BOOKINGS_IMPORT)
  ) {
    throw new Error(
      "The queued actor no longer has booking import permission.",
    );
  }
};

const getExecutionContext = async ({
  tenantId,
  actorId,
  normalized,
  transaction = null,
}: {
  tenantId: string;
  actorId: string;
  normalized: NormalizedBookingImportRow;
  transaction?: mongoose.ClientSession | null;
}) => {
  const actorMembership = await TenantMembershipModel.findOne({
    tenant: tenantId,
    user: actorId,
    status: "active",
  })
    .select("locationAccess")
    .session(transaction)
    .lean();
  const product = await ProductModel.findOne({
    _id: normalized.productId,
    tenant: tenantId,
  })
    .select("_id kind type location bookingMode isActive maxNumberOfParticipants")
    .session(transaction)
    .lean();
  const location = await LocationModel.findOne({
    _id: normalized.locationId,
    tenant: tenantId,
  })
    .select("_id isActive booking")
    .session(transaction)
    .lean();
  if (!actorMembership || !product || !location)
    throw new Error(
      "A tenant-scoped booking reference is no longer available.",
    );
  if (
    actorMembership.locationAccess?.mode === "selected" &&
    !(actorMembership.locationAccess.locationIds || []).some(
      (id: any) => String(id) === String(location._id),
    )
  )
    throw new Error("The queued actor no longer has access to this location.");
  if (
    normalized.resolvedTimezone &&
    normalized.resolvedTimezone !==
      String(location.booking?.timezone || "Europe/Prague")
  ) {
    throw new Error(
      "The location timezone changed after split local times were validated. Validate the import again.",
    );
  }
  const kind = kindOf(product);
  if (!kind || kind !== normalized.productKind)
    throw new Error("The product kind changed after validation.");
  if (kind === "open-studio" && product.bookingMode === "customer-choice")
    throw new Error(
      "This product now requires a public or private choice. Create the booking through the booking flow, or validate the import using a product with a fixed Shared or Exclusive mode.",
    );
  const customerId = kind === "open-studio" ? normalized.customerId : actorId;
  const customer = await UserModel.findOne({
    _id: customerId,
    tenant: tenantId,
  })
    .select("_id firstname lastname customId +tenantRole +roles")
    .session(transaction)
    .lean();
  if (!customer)
    throw new Error("The tenant-scoped booking owner is no longer available.");
  if (kind === "open-studio") {
    const team = await TenantMembershipModel.exists({
      tenant: tenantId,
      user: customer._id,
    }).session(transaction);
    if (team || isProtectedWorkspaceUser(customer))
      throw new Error(
        "A workspace team account cannot be used as an imported customer booking.",
      );
  }
  if (
    ["completed", "delivered"].includes(normalized.status) &&
    new Date(normalized.end).getTime() > Date.now()
  )
    throw new Error(
      "Completed or delivered bookings cannot end in the future.",
    );
  const historical = isHistorical(normalized);
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database connection is unavailable.");
  const tenant = await db
    .collection("tenants")
    .findOne(
      { _id: new mongoose.Types.ObjectId(tenantId) },
      { projection: { modules: 1 }, session: transaction || undefined },
    );
  if (!(tenant?.modules as any)?.bookings)
    throw new Error("The bookings module is no longer enabled.");
  return { actorMembership, product, location, customer, kind, historical };
};

const bookingPayload = ({
  tenantId,
  actorId,
  sessionId,
  rowNumber,
  fileType,
  normalized,
  context,
}: {
  tenantId: string;
  actorId: string;
  sessionId: string;
  rowNumber: number;
  fileType: "csv" | "xlsx";
  normalized: NormalizedBookingImportRow;
  context: any;
}) => ({
  tenant: tenantId,
  location: normalized.locationId,
  // Open Studio checkout stores ownership in `createdBy`/`author`; the
  // participants array belongs to Class enrolment reconciliation.
  participants: [],
  createdBy: context.customer._id,
  orders: [],
  start: new Date(normalized.start),
  end: new Date(normalized.end),
  bookingProduct: normalized.productId,
  author: {
    name:
      [context.customer.firstname, context.customer.lastname]
        .filter(Boolean)
        .join(" ") || "Imported booking",
    customId: context.customer.customId,
  },
  numberOfHours: mongoose.Types.Decimal128.fromString(
    String(normalized.durationHours),
  ),
  lecturer: normalized.lecturer,
  bookingType:
    context.kind === "open-studio"
      ? context.product.bookingMode === "private" ||
        context.product.type === "private-workshop"
        ? "private"
        : "public"
      : "private",
  bookingMode:
    context.kind === "open-studio"
      ? context.product.bookingMode === "private" ||
        context.product.type === "private-workshop"
        ? "private"
        : "public"
      : null,
  language: normalized.language === "en" ? "en" : "cs",
  description: normalized.description,
  archive: false,
  note: normalized.note,
  status: normalized.status,
  paymentStatus: "CONFIRMED",
  plannedActivity: normalized.plannedActivity,
  tag: normalized.tag,
  bookingRefs: [],
  capacityReservations: [],
  isRoot: context.kind !== "open-studio",
  numberOfGuests:
    context.kind === "open-studio" ? normalized.numberOfGuests : 0,
  // No notification has been sent by the migration itself. Future normal
  // reminder automation may operate on this booking according to its date.
  // Import execution sends no communication; suppress legacy reminder jobs.
  wasReminderSent: context.kind === "class" ? context.historical : true,
  importMetadata: {
    source: fileType,
    importId: sessionId,
    importKey: `${sessionId}:${rowNumber}`,
    ...(normalized.externalId ? { externalId: normalized.externalId } : {}),
    fingerprint: normalized.fingerprint,
    sourceStatus: normalized.status,
    importedAt: new Date(),
    importedBy: actorId,
  },
});

const availabilityWarning = async ({
  tenantId,
  normalized,
  context,
  excludeId,
}: {
  tenantId: string;
  normalized: NormalizedBookingImportRow;
  context: any;
  excludeId?: any;
}): Promise<string> => {
  if (context.kind !== "open-studio" || context.historical) return "";
  const current = await BookingModel.find({
    tenant: tenantId,
    location: normalized.locationId,
    start: { $lt: new Date(normalized.end) },
    end: { $gt: new Date(normalized.start) },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select(
      "_id bookingProduct location start end status archive paymentStatus paymentExpiresAt tag bookingType bookingMode plannedActivity courseEquipmentRequired numberOfGuests capacityReservations waitlistCapacityHolds",
    )
    .lean();
  await loadCourseCapacityForBookings({ bookings: current, tenantId });
  const candidate = {
    location: normalized.locationId,
    start: normalized.start,
    end: normalized.end,
    status: normalized.status,
    paymentStatus: "CONFIRMED",
    tag: normalized.tag,
    bookingType:
      context.product.bookingMode === "private" ||
      context.product.type === "private-workshop"
        ? "private"
        : "public",
    bookingMode:
      context.product.bookingMode === "private" ||
      context.product.type === "private-workshop"
        ? "private"
        : "public",
    plannedActivity: normalized.plannedActivity,
    numberOfGuests: normalized.numberOfGuests,
  };
  try {
    validateOpenStudioAvailabilityOrThrow({
      openStudioBookings: [candidate],
      currentBookings: current,
      locationById: new Map([[String(context.location._id), context.location]]),
    });
    return "";
  } catch (error: any) {
    return ` Availability warning: ${String(error?.code || "capacity conflict")}; source reservation preserved.`;
  }
};

const updateImportedBooking = async ({
  tenantId,
  actorId,
  sessionId,
  rowNumber,
  fileType,
  record,
  normalized,
  context,
  transaction,
}: any) => {
  if (!record.importMetadata || (record.orders || []).length)
    throw new Error(
      "Only import-owned bookings without Orders can be updated.",
    );
  const provided = new Set(normalized.providedFields || []);
  const hasLocationIdentity = [
    "locationCode",
    "locationSlug",
    "locationName",
  ].some((field) => provided.has(field));
  const hasCustomerIdentity = [
    "customerExternalId",
    "customerEmail",
    "customerPhone",
  ].some((field) => provided.has(field));
  const hasProductIdentity = [
    "productExternalId",
    "productSku",
    "productName",
  ].some((field) => provided.has(field));
  const hasTimeIdentity =
    (provided.has("start") && provided.has("end")) ||
    (provided.has("date") &&
      provided.has("startTime") &&
      provided.has("endTime"));
  const scheduleOrRecipientChanged =
    String(record.createdBy) !== String(context.customer._id) ||
    String(record.bookingProduct) !== String(normalized.productId) ||
    String(record.location) !== String(normalized.locationId) ||
    new Date(record.start).getTime() !== new Date(normalized.start).getTime() ||
    new Date(record.end).getTime() !== new Date(normalized.end).getTime();
  const existingHistorical =
    ["completed", "cancelled", "delivered"].includes(String(record.status)) ||
    new Date(record.end).getTime() <= Date.now();
  // Future Open Studio access-code delivery is backed by a durable repository
  // whose schedule/recipient lifecycle cannot be changed by a plain document
  // update. Keep update imports safe by allowing field corrections only; use
  // the canonical rescheduling flow for a schedule, product, location, or
  // customer change.
  if (
    context.kind === "open-studio" &&
    (!context.historical || !existingHistorical) &&
    scheduleOrRecipientChanged
  ) {
    throw new Error(
      "Future Open Studio reservations cannot be rescheduled or reassigned by import.",
    );
  }
  if (
    context.kind === "open-studio" &&
    provided.has("status") &&
    String(record.status) !== normalized.status &&
    (new Date(record.end).getTime() > Date.now() ||
      new Date(normalized.end).getTime() > Date.now())
  ) {
    throw new Error(
      "Future Open Studio reservation status cannot be changed by import.",
    );
  }

  assertImportedBookingProductLocation({
    product: context.product,
    booking: {
      productId: hasProductIdentity ? normalized.productId : String(record.bookingProduct),
      locationId: hasLocationIdentity ? normalized.locationId : String(record.location),
      status: provided.has("status") ? normalized.status : String(record.status),
      end: hasTimeIdentity ? normalized.end : new Date(record.end).toISOString(),
    },
    existing: record,
  });

  const set: Record<string, unknown> = {
    "importMetadata.source": fileType,
    "importMetadata.importId": sessionId,
    "importMetadata.importedAt": new Date(),
    "importMetadata.importedBy": actorId,
  };
  if (!record.importMetadata.importKey) {
    set["importMetadata.importKey"] = `${sessionId}:${rowNumber}`;
  }
  if (provided.has("externalId") && normalized.externalId) {
    set["importMetadata.externalId"] = normalized.externalId;
  }
  if (provided.has("status")) {
    set.status = normalized.status;
    set["importMetadata.sourceStatus"] = normalized.status;
  }
  if (hasProductIdentity) set.bookingProduct = normalized.productId;
  if (hasLocationIdentity) set.location = normalized.locationId;
  if (hasTimeIdentity) {
    set.start = new Date(normalized.start);
    set.end = new Date(normalized.end);
    set.numberOfHours = mongoose.Types.Decimal128.fromString(
      String(normalized.durationHours),
    );
  }
  if (context.kind === "open-studio" && hasCustomerIdentity) {
    set.createdBy = context.customer._id;
    set.author = {
      name:
        [context.customer.firstname, context.customer.lastname]
          .filter(Boolean)
          .join(" ") || "Imported booking",
      customId: context.customer.customId,
    };
  }
  if (
    hasProductIdentity &&
    String(record.bookingProduct) !== String(normalized.productId) &&
    context.kind === "open-studio"
  ) {
    const mode =
      context.product.bookingMode === "private" ||
      context.product.type === "private-workshop"
        ? "private"
        : "public";
    set.bookingMode = mode;
    set.bookingType = mode;
  }
  if (provided.has("numberOfGuests") && context.kind === "open-studio")
    set.numberOfGuests = normalized.numberOfGuests;
  if (provided.has("language")) set.language = normalized.language;
  if (provided.has("plannedActivity"))
    set.plannedActivity = normalized.plannedActivity;
  if (provided.has("lecturer")) set.lecturer = normalized.lecturer;
  if (provided.has("description")) set.description = normalized.description;
  if (provided.has("note")) set.note = normalized.note;

  const effectiveLocationId = hasLocationIdentity
    ? normalized.locationId
    : String(record.location);
  if (
    normalized.fingerprint &&
    String(effectiveLocationId) === String(normalized.locationId)
  ) {
    set["importMetadata.fingerprint"] = normalized.fingerprint;
  }

  const updated = await BookingModel.findOneAndUpdate(
    {
      _id: record._id,
      tenant: tenantId,
      orders: { $size: 0 },
      "importMetadata.importId": { $exists: true },
      updatedAt: record.updatedAt,
    },
    { $set: set },
    { returnDocument: "after", runValidators: true, session: transaction },
  ).select("+importMetadata");
  if (!updated) return null;
  return { record: updated, affectedFields: Object.keys(set) };
};

const markRow = (
  rowId: any,
  status: string,
  resultRecord: any,
  resultMessage: string,
) =>
  DataImportRowModel.updateOne(
    { _id: rowId },
    { $set: { status, resultRecord, resultMessage } },
  );

export const processBookingImportSession = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const claimToken = randomUUID();
  const now = new Date();
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: sessionId,
      tenant: tenantId,
      entityType: DATA_IMPORT_ENTITY.BOOKINGS,
      $or: [
        { status: DATA_IMPORT_STATUS.QUEUED },
        { status: DATA_IMPORT_STATUS.FAILED },
        {
          status: DATA_IMPORT_STATUS.PROCESSING,
          leaseExpiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: DATA_IMPORT_STATUS.PROCESSING,
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        claimToken,
        lastError: null,
      },
    },
    { returnDocument: "after" },
  )
    .select("+claimToken")
    .lean();
  if (!session) return { skipped: true, reason: "not_claimable" };
  const actorId = String(session.queuedBy || session.createdBy);
  try {
    const rows = await DataImportRowModel.find({
      tenant: tenantId,
      session: session._id,
      status: {
        $in: [DATA_IMPORT_ROW_STATUS.VALID, DATA_IMPORT_ROW_STATUS.PROCESSING],
      },
    }).sort({ rowNumber: 1 });
    let heartbeatAt = 0;
    for (let index = 0; index < rows.length; index += 1) {
      if (Date.now() - heartbeatAt >= 30_000) {
        await assertBookingImportPermission(tenantId, actorId);
        const heartbeat = await DataImportSessionModel.updateOne(
          { _id: session._id, tenant: tenantId, claimToken },
          { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
        );
        if (!heartbeat.matchedCount)
          throw new Error("Booking import execution lease was lost.");
        heartbeatAt = Date.now();
      }
      const row = await DataImportRowModel.findOneAndUpdate(
        {
          _id: rows[index]._id,
          tenant: tenantId,
          session: session._id,
          status: {
            $in: [
              DATA_IMPORT_ROW_STATUS.VALID,
              DATA_IMPORT_ROW_STATUS.PROCESSING,
            ],
          },
        },
        { $set: { status: DATA_IMPORT_ROW_STATUS.PROCESSING } },
        { returnDocument: "after" },
      );
      if (!row) continue;
      let raceNormalized =
        row.normalized as unknown as NormalizedBookingImportRow;
      try {
        const committed = await DataImportMutationModel.findOne({
          tenant: tenantId,
          session: session._id,
          row: row._id,
          isCanonicalResult: true,
        }).lean();
        if (committed) {
          await markRow(
            row._id,
            committed.importOutcome === "created"
              ? DATA_IMPORT_ROW_STATUS.CREATED
              : DATA_IMPORT_ROW_STATUS.UPDATED,
            committed.target,
            committed.importMessage,
          );
          continue;
        }
        const normalized = raceNormalized;
        if (row.duplicate?.kind === "file") {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.SKIPPED,
            null,
            "Duplicate row in the uploaded file.",
          );
          continue;
        }
        const context = await getExecutionContext({
          tenantId,
          actorId,
          normalized,
        });
        const effectiveNormalized = {
          ...normalized,
          customerId:
            context.kind === "open-studio"
              ? normalized.customerId
              : String(context.customer._id),
        };
        raceNormalized = effectiveNormalized;
        const match = await findCurrentBooking(tenantId, effectiveNormalized);
        assertImportRecordNotRolledBack(match.record);
        if (match.conflict) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            "Booking identifiers now match multiple records.",
          );
          continue;
        }
        if (
          match.record &&
          canonicalBookingTag(match.record.tag) !== normalized.tag
        ) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            "An import cannot change an existing booking kind.",
          );
          continue;
        }
        if (
          match.record &&
          context.actorMembership.locationAccess?.mode === "selected" &&
          !(context.actorMembership.locationAccess.locationIds || []).some(
            (id: any) => String(id) === String(match.record.location),
          )
        ) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            "The queued actor cannot access the existing booking's location.",
          );
          continue;
        }
        if (
          match.record &&
          session.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
        ) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.SKIPPED,
            match.record._id,
            "Existing booking skipped.",
          );
          continue;
        }
        const availability = await availabilityWarning({
          tenantId,
          normalized,
          context,
          excludeId: match.record?._id,
        });
        const transaction = await mongoose.startSession();
        try {
          let outcome: {
            action: "created" | "updated";
            recordId: unknown;
            message: string;
          } | null = null;
          await transaction.withTransaction(async () => {
            const runtimeContext = await getExecutionContext({
              tenantId,
              actorId,
              normalized,
              transaction,
            });
            const current = await findCurrentBooking(
              tenantId,
              effectiveNormalized,
              transaction,
            );
            if (current.conflict)
              throw new Error("Booking identity changed during execution.");
            assertImportRecordNotRolledBack(current.record);
            if (match.record) {
              if (
                !current.record ||
                String(current.record._id) !== String(match.record._id)
              )
                throw new Error("Booking identity changed during execution.");
              const updated = await updateImportedBooking({
                tenantId,
                actorId,
                sessionId,
                rowNumber: row.rowNumber,
                fileType: session.fileType,
                record: current.record,
                normalized,
                context: runtimeContext,
                transaction,
              });
              if (!updated)
                throw new Error(
                  "The imported booking became protected before update.",
                );
              const message = `Existing booking updated.${availability}`;
              await recordDataImportMutation({
                tenantId,
                sessionId,
                rowId: row._id,
                rowNumber: row.rowNumber,
                entityType: DATA_IMPORT_ENTITY.BOOKINGS,
                mutationKey: `${sessionId}:${row.rowNumber}`,
                operation: importMutationOperation.UPDATE,
                importOutcome: "updated",
                importMessage: message,
                targetId: updated.record._id,
                affectedFields: updated.affectedFields,
                beforeRecord: current.record,
                afterRecord: updated.record,
                actorId,
                transaction,
              });
              outcome = {
                action: "updated",
                recordId: updated.record._id,
                message,
              };
              return;
            }
            if (current.record)
              throw new Error(
                "A matching booking was created after validation. Validate again.",
              );
            assertImportedBookingProductLocation({
              product: runtimeContext.product,
              booking: normalized,
            });
            const importKey = `${sessionId}:${row.rowNumber}`;
            const created = await BookingModel.create(
              [
                bookingPayload({
                  tenantId,
                  actorId,
                  sessionId,
                  rowNumber: row.rowNumber,
                  fileType: session.fileType,
                  normalized,
                  context: runtimeContext,
                }) as any,
              ],
              { session: transaction },
            );
            if (!created[0]) throw new Error("Booking was not created.");
            const message = `Booking created.${availability}`;
            await recordDataImportMutation({
              tenantId,
              sessionId,
              rowId: row._id,
              rowNumber: row.rowNumber,
              entityType: DATA_IMPORT_ENTITY.BOOKINGS,
              mutationKey: importKey,
              operation: importMutationOperation.CREATE,
              importOutcome: "created",
              importMessage: message,
              targetId: created[0]._id,
              affectedFields: BOOKING_CREATE_FIELDS,
              beforeRecord: null,
              afterRecord: created[0],
              actorId,
              transaction,
            });
            outcome = {
              action: "created",
              recordId: created[0]._id,
              message,
            };
          });
          if (!outcome) throw new Error("Booking import transaction failed.");
          await markRow(
            row._id,
            outcome.action === "created"
              ? DATA_IMPORT_ROW_STATUS.CREATED
              : DATA_IMPORT_ROW_STATUS.UPDATED,
            outcome.recordId,
            outcome.message,
          );
        } finally {
          await transaction.endSession();
        }
      } catch (error: any) {
        if (error?.code === 11000) {
          const race = await findCurrentBooking(tenantId, raceNormalized);
          assertImportRecordNotRolledBack(race.record);
          if (race.record) {
            await markRow(
              row._id,
              DATA_IMPORT_ROW_STATUS.SKIPPED,
              race.record._id,
              "A concurrent import already created this booking.",
            );
            continue;
          }
        }
        await markRow(
          row._id,
          DATA_IMPORT_ROW_STATUS.FAILED,
          null,
          safeError(error),
        );
      }
    }
    const [created, updated, skipped, failed] = await Promise.all([
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.CREATED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.UPDATED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.SKIPPED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.FAILED,
      }),
    ]);
    await completeImportWithRollbackAvailability({
      tenantId,
      sessionId,
      claimToken,
      summary: { created, updated, skipped, failed },
    });
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "completed",
      metadata: {
        entityType: DATA_IMPORT_ENTITY.BOOKINGS,
        created,
        updated,
        skipped,
        failed,
      },
    });
    return { created, updated, skipped, failed };
  } catch (error) {
    await DataImportSessionModel.updateOne(
      { _id: session._id, tenant: tenantId, claimToken },
      {
        $set: {
          status: DATA_IMPORT_STATUS.FAILED,
          leaseExpiresAt: null,
          claimToken: null,
          lastError: {
            code: "IMPORT_EXECUTION_FAILED",
            message: safeError(error),
          },
        },
      },
    );
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "failed",
      metadata: {
        entityType: DATA_IMPORT_ENTITY.BOOKINGS,
        code: "IMPORT_EXECUTION_FAILED",
      },
    });
    throw error;
  }
};
