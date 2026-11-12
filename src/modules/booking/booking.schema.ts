import { Schema } from "mongoose";

import {
  BOOKING_LANGUAGE,
  BOOKING_STATUS,
  BOOKING_TAG,
  BOOKING_TYPE,
  NOTIFICATION_CHANNEL,
  PAYMENT_STATUS,
  PLANNED_ACTIVITY,
} from "./booking.constants.js";

const { ObjectId, Decimal128 } = Schema.Types;

export const participantSchema = new Schema(
  {
    // Stable attendance identity; older rows are assigned deterministic IDs by
    // the staff editor. Paid order references survive attendance removal.
    participantId: { type: String, trim: true },
    customer: { type: ObjectId, ref: "User" },
    name: { type: String, trim: true, maxlength: 160 },
    email: { type: String, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 40 },
    // Preserve historical participant snapshots until attendance is edited.
    unnamed: { type: Boolean },
    source: { type: String, enum: ["paid", "staff", "legacy"] },
    attendanceStatus: { type: String, enum: ["active", "removed"] },
    removedAt: { type: Date },
    removedBy: { type: ObjectId, ref: "User" },
    firstname: { type: String, required: true, trim: true },
    lastname: { type: String, default: "", trim: true },
    customId: { type: String, trim: true },
    memberNumber: {
      type: Number,
      min: 1,
      validate: Number.isSafeInteger,
    },
    order: { type: ObjectId, ref: "Order" },
  },
  { _id: false },
);

export const bookingRefSchema = new Schema(
  {
    booking: { type: ObjectId, ref: "Booking" },
    idx: { type: Number },
  },
  { _id: false },
);

export const capacityReservationSchema = new Schema(
  {
    order: {
      type: ObjectId,
      ref: "Order",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: false,
    },
  },
  { _id: false },
);

export const waitlistCapacityHoldSchema = new Schema(
  {
    entry: {
      type: ObjectId,
      ref: "WaitlistEntry",
      required: true,
    },
    offerGeneration: {
      type: Number,
      required: true,
      min: 1,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { _id: false },
);

export const waitlistConfigSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    autoPromote: { type: Boolean, default: true },
    offerWindowHours: { type: Number, default: 24, min: 1, max: 168 },
    cutoffHours: { type: Number, default: 2, min: 0, max: 168 },
  },
  { _id: false },
);

export const bookingAuthorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    customId: { type: String, required: true, trim: true },
    memberNumber: {
      type: Number,
      min: 1,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false },
);

const bookingImportMetadataSchema = new Schema(
  {
    source: { type: String, enum: ["csv", "xlsx"], required: true },
    importId: { type: String, required: true, maxlength: 64 },
    importKey: { type: String, required: true, maxlength: 160 },
    externalId: { type: String, default: undefined, maxlength: 120 },
    fingerprint: { type: String, required: true, maxlength: 64 },
    sourceStatus: { type: String, default: "", maxlength: 120 },
    importedAt: { type: Date, required: true },
    importedBy: { type: ObjectId, ref: "User", required: true },
    rolledBackAt: { type: Date, default: null },
    rolledBackBy: { type: ObjectId, ref: "User", default: null },
    rollbackMutationKey: { type: String, default: undefined, maxlength: 200 },
  },
  { _id: false },
);

export const bookingSchema = new Schema(
  {
    tenant: {
      type: ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    location: {
      type: ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },

    participants: {
      type: [participantSchema],
      default: [],
    },

    createdBy: {
      type: ObjectId,
      ref: "User",
      required: true,
    },

    orders: [
      {
        type: ObjectId,
        ref: "Order",
      },
    ],

    extensionFor: { type: ObjectId, ref: "Booking", index: true },
    extensionOriginalStart: { type: Date },
    extensionQuoteVersion: { type: String },
    extensionApplied: { type: Boolean, default: false },
    extensionBaseEnd: { type: Date },
    extensionBaseDurationMinutes: { type: Number },
    extensionPaymentPendingUntil: { type: Date, default: null },
    extensionPaymentOrder: { type: ObjectId, ref: "Order", default: null },

    start: {
      type: Date,
      required: true,
    },

    end: {
      type: Date,
      required: true,
    },

    bookingProduct: {
      type: ObjectId,
      ref: "Product",
      required: true,
    },

    author: {
      type: bookingAuthorSchema,
      required: true,
    },

    numberOfHours: {
      type: Decimal128,
      required: true,
    },

    lecturer: {
      type: String,
      default: "",
      trim: true,
    },

    bookingType: {
      type: String,
      enum: Object.values(BOOKING_TYPE),
      default: BOOKING_TYPE.PRIVATE,
    },

    /**
     * Canonical snapshot of the customer's resolved Open Studio booking mode.
     * `bookingType` remains during rollout for older readers.
     */
    bookingMode: {
      type: String,
      enum: Object.values(BOOKING_TYPE),
      default: null,
    },

    // Preserve the public total-attendee promise even if the product is edited.
    publicCapacityLimit: {
      type: Number,
      min: 1,
      validate: {
        validator: (value: number | null) =>
          value == null || Number.isSafeInteger(value),
      },
      default: null,
    },
    customerChoiceBooking: { type: Boolean, default: false },

    language: {
      type: String,
      enum: Object.values(BOOKING_LANGUAGE),
      default: BOOKING_LANGUAGE.CZ,
    },

    description: {
      type: String,
      default: "",
      trim: true,
    },

    archive: {
      type: Boolean,
      default: false,
    },

    note: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: Object.values(BOOKING_STATUS),
      default: BOOKING_STATUS.PENDING,
    },

    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      required: true,
      default: PAYMENT_STATUS.PENDING_PAYMENT,
    },

    plannedActivity: {
      type: String,
      enum: Object.values(PLANNED_ACTIVITY),
      default: PLANNED_ACTIVITY.UNDEFINED,
    },

    // Only an explicit false means a class uses no studio equipment.
    // Unspecified legacy classes retain conservative equipment reservations.
    courseEquipmentRequired: { type: Boolean, default: undefined },

    paymentExpiresAt: Date,

    paymentConfirmedAt: Date,

    tag: {
      type: String,
      enum: Object.values(BOOKING_TAG),
      required: true,
    },

    bookingRefs: {
      type: [bookingRefSchema],
      default: [],
    },

    /**
     * Temporary, server-created seat holds for unpaid course and paid guest-
     * increase Checkout Sessions. Each hold is ignored after expiry and
     * explicitly removed when the Session expires or its paid order consumes
     * the reservation.
     */
    capacityReservations: {
      type: [capacityReservationSchema],
      default: [],
    },

    /**
     * One-seat FIFO offer holds. Checkout transfers a hold to the normal
     * order-backed capacityReservations array in one transaction, so the
     * seat is never briefly released or counted twice.
     */
    waitlistCapacityHolds: {
      type: [waitlistCapacityHoldSchema],
      default: [],
    },

    /** Session snapshot; missing legacy records resolve to disabled. */
    waitlistConfig: {
      type: waitlistConfigSchema,
      default: undefined,
    },

    // Serializes full-only waitlist joins against capacity releases and
    // participant mutations on this same session document.
    waitlistJoinRevision: { type: Number, min: 0, default: 0 },

    isRoot: {
      type: Boolean,
      default: false,
    },

    numberOfGuests: {
      type: Number,
      default: 0,
      min: 0,
    },

    attendanceManaged: { type: Boolean, default: false },
    // Commercial quantity is independent of staff attendance adjustments.
    // Existing records snapshot it before the first adjustment.
    financialNumberOfGuests: { type: Number, min: 0, default: undefined },
    attendanceUpdatedBy: { type: ObjectId, ref: "User" },

    wasReminderSent: {
      type: Boolean,
      default: false,
    },

    // Issued or externally owned access remains a customer modification lock
    // even when an authorized staff move rearms delivery for a new date.
    accessCodeCustomerModificationLockedAt: { type: Date, default: null },
    accessCodeStaffRescheduledStart: { type: Date, default: null },
    scheduleChangeHistory: {
      type: [
        new Schema(
          {
            transitionId: { type: String, required: true },
            actor: { type: ObjectId, ref: "User", required: true },
            changedAt: { type: Date, required: true },
            previousStart: { type: Date, required: true },
            previousEnd: { type: Date, required: true },
            nextStart: { type: Date, required: true },
            nextEnd: { type: Date, required: true },
            priorAccessDeliveryStatus: { type: String, required: true },
            legacyAccessSuppressed: { type: Boolean, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
      select: false,
    },

    accessCodeDelivery: {
      status: {
        type: String,
        enum: ["idle", "processing", "sent", "delivery_unknown", "cancelled"],
        default: "idle",
      },
      claimToken: {
        type: String,
        trim: true,
        default: "",
      },
      leaseExpiresAt: {
        type: Date,
        default: null,
      },
      deliveredAt: {
        type: Date,
        default: null,
      },
    },

    // Private import provenance also prevents replaying legacy access messages.
    atelierKleiMigration: {
      type: Schema.Types.Mixed,
      select: false,
      default: undefined,
    },

    confirmationSentAt: Date,

    lastNotificationChannel: {
      type: String,
      enum: [...Object.values(NOTIFICATION_CHANNEL), null],
      default: null,
    },

    importMetadata: {
      type: bookingImportMetadataSchema,
      default: undefined,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * Visible calendar / availability queries
 */
bookingSchema.index({
  tenant: 1,
  location: 1,
  paymentStatus: 1,
  start: 1,
});

/**
 * Booking history by location
 */
bookingSchema.index({
  tenant: 1,
  location: 1,
  start: -1,
});

/**
 * Future course / workshop listing
 */
bookingSchema.index({
  tenant: 1,
  tag: 1,
  archive: 1,
  start: 1,
});

/**
 * User upcoming workshop bookings
 */
bookingSchema.index({
  tenant: 1,
  createdBy: 1,
  tag: 1,
  status: 1,
  paymentStatus: 1,
  start: 1,
});

/**
 * Product / course admin filters
 */
bookingSchema.index({
  tenant: 1,
  bookingProduct: 1,
  start: -1,
});

/**
 * Admin payment status filter
 */
bookingSchema.index({
  tenant: 1,
  paymentStatus: 1,
  start: -1,
});

/**
 * Expired payment cleanup by paymentExpiresAt
 */
bookingSchema.index({
  tenant: 1,
  paymentStatus: 1,
  paymentExpiresAt: 1,
});

bookingSchema.index({
  tenant: 1,
  "capacityReservations.expiresAt": 1,
});

bookingSchema.index({
  tenant: 1,
  "waitlistCapacityHolds.expiresAt": 1,
});

bookingSchema.index({
  tenant: 1,
  "waitlistConfig.enabled": 1,
  start: 1,
});

/**
 * Expired temp booking cleanup fallback by createdAt
 */
bookingSchema.index({
  tenant: 1,
  paymentStatus: 1,
  createdAt: 1,
});

/**
 * Processed bookings delivery cron
 */
bookingSchema.index({
  tenant: 1,
  status: 1,
  start: 1,
});

/**
 * Archive listing
 */
bookingSchema.index({
  tenant: 1,
  archive: 1,
  start: -1,
});

bookingSchema.index(
  { tenant: 1, "importMetadata.importKey": 1 },
  {
    unique: true,
    name: "tenant_1_booking_importKey_1",
    partialFilterExpression: {
      "importMetadata.importKey": { $type: "string" },
    },
  },
);
bookingSchema.index(
  { tenant: 1, "importMetadata.externalId": 1 },
  {
    unique: true,
    name: "tenant_1_booking_externalId_1",
    partialFilterExpression: {
      "importMetadata.externalId": { $type: "string" },
    },
  },
);
bookingSchema.index(
  { tenant: 1, "importMetadata.fingerprint": 1 },
  {
    unique: true,
    name: "tenant_1_booking_fingerprint_1",
    partialFilterExpression: {
      "importMetadata.fingerprint": { $type: "string" },
    },
  },
);
