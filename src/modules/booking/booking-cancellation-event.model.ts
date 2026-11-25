import mongoose, { type ClientSession } from "mongoose";

// Cancellation is an operation, not a refund settlement or an updatedAt value.
// Event identities are supplied by the transaction that owns that operation.
const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      immutable: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    actorType: {
      type: String,
      enum: ["customer", "staff"],
      required: true,
      immutable: true,
    },
    source: {
      type: String,
      enum: ["open_studio", "course_participant"],
      required: true,
      immutable: true,
    },
    occurredAt: { type: Date, required: true, immutable: true },
    seats: { type: Number, required: true, min: 0, immutable: true },
  },
  { timestamps: true },
);
schema.index(
  { tenant: 1, customer: 1, occurredAt: 1, location: 1 },
  { name: "booking_cancellation_customer_period" },
);
schema.index(
  { tenant: 1, booking: 1, customer: 1 },
  { name: "booking_cancellation_identity" },
);

export const BookingCancellationEvent: mongoose.Model<any> =
  mongoose.models.BookingCancellationEvent ??
  mongoose.model("BookingCancellationEvent", schema);

export const recordBookingCancellation = async (
  input: {
    operationId: string;
    tenantId: string;
    locationId: string;
    bookingId: string;
    customerId: string;
    orderId?: string;
    actorId: string;
    actorType: "customer" | "staff";
    source: "open_studio" | "course_participant";
    occurredAt: Date;
    seats: number;
  },
  session: ClientSession,
) => {
  const objectId = (value: string) => new mongoose.Types.ObjectId(value);
  await BookingCancellationEvent.updateOne(
    { _id: `${input.tenantId}:${input.operationId}` },
    {
      $setOnInsert: {
        tenant: objectId(input.tenantId),
        location: objectId(input.locationId),
        booking: objectId(input.bookingId),
        customer: objectId(input.customerId),
        order: input.orderId ? objectId(input.orderId) : null,
        actor: objectId(input.actorId),
        actorType: input.actorType,
        source: input.source,
        occurredAt: input.occurredAt,
        seats: input.seats,
      },
    },
    { upsert: true, session, runValidators: true },
  );
};
