import {
  BOOKING_STATUS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import { createBookingRepository } from "@/modules/booking/booking.repository.js";
import { createUserRepository } from "@/modules/user/user.repository.js";
import Product from "@/modules/product/product.model.js";
import { snapshotWaitlistProductDefaults } from "@/modules/waitlist/waitlist.policy.js";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";
import validator from "validator";
import { randomUUID } from "node:crypto";

import type { IdLike, PlainObject, TenantId } from "../booking.types.js";

export const createBookingRecords = async ({
  tenantId,
  records,
}: {
  tenantId: TenantId;
  records: PlainObject[];
}) => {
  if (!Array.isArray(records) || records.length === 0) return [];
  const courseProductIds = [
    ...new Set(
      records
        .filter((record) => ["class", "course"].includes(String(record.tag)))
        .map((record) => String(record.bookingProduct ?? ""))
        .filter((id) => validator.isMongoId(id)),
    ),
  ];
  const products = courseProductIds.length
    ? await Product.find({
        _id: { $in: courseProductIds },
        tenant: tenantId,
      })
        .select("_id waitlistDefaults")
        .lean()
        .exec()
    : [];
  const waitlistDefaultsByProduct = new Map(
    products.map((product: any) => [
      String(product._id),
      snapshotWaitlistProductDefaults(product.waitlistDefaults),
    ]),
  );
  const bookingRepository = createBookingRepository({ tenantId });
  const bookings = await bookingRepository.insertMany(
    records.map((record) => ({
      ...record,
      ...(["class", "course"].includes(String(record.tag)) &&
      record.waitlistConfig == null
        ? {
            waitlistConfig:
              waitlistDefaultsByProduct.get(String(record.bookingProduct)) ??
              snapshotWaitlistProductDefaults(),
          }
        : {}),
      paymentStatus: PAYMENT_STATUS.CONFIRMED,
    })),
  );
  return bookings.map((booking) => booking._id);
};

type UpdateBookingByAdminInput = {
  id?: IdLike;
  lecturer?: unknown;
  note?: unknown;
  [key: string]: unknown;
};

const LEGACY_ADMIN_METADATA_FIELDS = new Set(["id", "lecturer", "note"]);

/**
 * The legacy PATCH endpoint is intentionally limited to display metadata.
 * Schedule, capacity, ownership, payment and lifecycle changes must go through
 * workflows that validate capacity, refund state, access-code state and audit
 * side effects atomically.
 */
export function assertSafeLegacyAdminBookingUpdate(
  input: unknown,
): asserts input is UpdateBookingByAdminInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest({
      message: "Booking update payload must be an object.",
      code: "BOOKING_METADATA_INVALID",
    });
  }

  const protectedFields = Object.keys(input).filter(
    (field) => !LEGACY_ADMIN_METADATA_FIELDS.has(field),
  );

  if (protectedFields.length > 0) {
    conflict({
      message:
        "This booking change requires its dedicated cancellation, rescheduling, participant, or payment workflow.",
      code: "BOOKING_UPDATE_REQUIRES_DEDICATED_WORKFLOW",
      details: { fields: protectedFields.sort() },
    });
  }

  for (const field of ["lecturer", "note"] as const) {
    const value = input[field];

    if (value !== undefined && typeof value !== "string") {
      badRequest({
        message: `Booking ${field} must be a string.`,
        code: "BOOKING_METADATA_INVALID",
        details: { field },
      });
    }
  }
}

export const updateBookingByAdmin = async ({
  tenantId,
  actorUserId,
  input,
}: {
  tenantId: TenantId;
  actorUserId: string;
  input: UpdateBookingByAdminInput;
}) => {
  assertSafeLegacyAdminBookingUpdate(input);

  const { id, lecturer, note } = input;
  if (!id) badRequest("Missing mandatory params");
  if (!actorUserId) badRequest("User ID is required");
  if (!validator.isMongoId(actorUserId)) badRequest("Not valid user id");

  const bookingRepository = createBookingRepository({ tenantId });
  const userRepository = createUserRepository({ tenantId });

  const [user, booking] = await Promise.all([
    userRepository.findById(actorUserId, { select: "_id", lean: false }),
    bookingRepository.findById(id, { lean: false }),
  ]);

  if (!user) badRequest("User not found");
  if (!booking) badRequest("Booking not found");

  if (lecturer !== undefined) booking.lecturer = lecturer as string;
  if (note !== undefined) booking.note = note as string;

  return bookingRepository.save(booking);
};

export const updateGuestIncreaseRecords = async ({
  tenantId,
  guestIncreaseIds,
  orderId,
}: {
  tenantId: TenantId;
  guestIncreaseIds: IdLike[];
  orderId: IdLike;
}) => {
  if (!guestIncreaseIds?.length) return false;

  const bookingRepository = createBookingRepository({ tenantId });

  const guestIncreaseBookings = await bookingRepository.findDocuments({
    _id: { $in: guestIncreaseIds },
  });

  if (!guestIncreaseBookings.length) return false;

  const increments = new Map<string, number>();

  for (const booking of guestIncreaseBookings) {
    const numberOfGuests = Number(booking.numberOfGuests) || 0;

    if (numberOfGuests <= 0) continue;

    for (const ref of booking.bookingRefs || []) {
      const refId = ref.booking?.toString();

      if (refId) {
        increments.set(refId, (increments.get(refId) || 0) + numberOfGuests);
      }
    }
  }

  const referenced = await bookingRepository.findDocuments({
    _id: { $in: [...increments.keys()] },
  });

  await Promise.all(
    referenced.map((booking) => {
      const additional = increments.get(String(booking._id)) || 0;
      if (booking.attendanceManaged) {
        booking.financialNumberOfGuests =
          Math.max(
            1,
            Number(booking.financialNumberOfGuests ?? booking.numberOfGuests) ||
              1,
          ) + additional;
        for (let index = 0; index < additional; index += 1) {
          booking.participants.push({
            participantId: randomUUID(),
            firstname: "Unnamed participant",
            lastname: "",
            unnamed: true,
            source: "paid",
            attendanceStatus: "active",
            order: orderId,
          } as any);
        }
      }
      booking.numberOfGuests =
        (Number(booking.numberOfGuests) || 0) + additional;

      return bookingRepository.save(booking);
    }),
  );

  await bookingRepository.updateMany(
    { _id: { $in: guestIncreaseIds } },
    {
      $set: {
        status: BOOKING_STATUS.PROCESSED,
        paymentStatus: PAYMENT_STATUS.CONFIRMED,
        paymentExpiresAt: null,
      },
      $addToSet: { orders: orderId },
    },
  );

  return true;
};
