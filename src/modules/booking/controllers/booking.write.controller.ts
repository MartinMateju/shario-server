import type { Request, Response } from "express";
import mongoose, { type Types } from "mongoose";

import Booking from "../booking.model.js";
import { PAYMENT_STATUS } from "../booking.constants.js";
import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  canAccessWorkspaceLocation,
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { WorkspacePermission } from "@/modules/tenant-access/tenant-access.permissions.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import { cancelBookingWithRefund } from "../services/booking.refund.service.js";
import {
  assertSafeLegacyAdminBookingUpdate,
  createBookingRecords,
  updateBookingByAdmin,
  updateGuestIncreaseRecords as updateGuestIncreaseService,
} from "../services/booking.write.service.js";

type BookingRecordInput = Record<string, unknown>;

type CreateBookingRecordResult = Array<Types.ObjectId | string>;

const assertBookingLocationAccess = async ({
  req,
  tenantId,
  bookingId,
}: {
  req: Request;
  tenantId: string;
  bookingId: unknown;
}): Promise<void> => {
  if (!mongoose.isValidObjectId(bookingId)) {
    notFound("Booking not found.");
  }

  const currentUserId = getAuthenticatedUserId(req);
  const workspaceAccess = await resolveWorkspaceAccessForUser({
    tenantId,
    userId: currentUserId,
  });

  // Customers do not have workspace memberships. Their ownership is checked
  // by the booking service instead of an employee location assignment.
  if (!workspaceAccess) return;

  const booking = await Booking.findOne({
    _id: bookingId,
    tenant: tenantId,
  })
    .select("location")
    .lean()
    .exec();

  if (
    !booking ||
    !canAccessWorkspaceLocation(workspaceAccess, booking.location)
  ) {
    notFound("Booking not found.");
  }
};

const requireSelfOrBookingPermissions = async ({
  req,
  tenantId,
  targetUserId,
  permissions,
}: {
  req: Request;
  tenantId: string;
  targetUserId: string;
  permissions: readonly WorkspacePermission[];
}): Promise<string> => {
  const currentUserId = getAuthenticatedUserId(req);

  if (currentUserId === targetUserId) {
    return currentUserId;
  }

  const workspaceAccess = await resolveWorkspaceAccessForUser({
    tenantId,
    userId: currentUserId,
  });

  const isAllowed = permissions.every((permission) =>
    hasWorkspacePermission(workspaceAccess, permission),
  );

  if (!isAllowed) {
    forbidden("You cannot change another customer's booking.");
  }

  return targetUserId;
};

export const createBookingRecord = async (
  records: BookingRecordInput[],
  tenantId: string | null = null,
): Promise<CreateBookingRecordResult> => {
  if (!tenantId) {
    const normalized = Array.isArray(records)
      ? records.map((record) => ({
          ...record,
          paymentStatus: PAYMENT_STATUS.CONFIRMED,
        }))
      : [];

    if (!normalized.length) return [];

    const bookings = await Booking.insertMany(normalized, {
      ordered: false,
    });

    return bookings.map((booking) => booking._id);
  }

  return createBookingRecords({ tenantId, records });
};

export const updateBooking = asyncHandler(
  async (req: Request, res: Response) => {
    // Reject workflow-owned fields before reading or writing the booking. The
    // service repeats this assertion so non-HTTP callers cannot bypass it.
    assertSafeLegacyAdminBookingUpdate(req.body);

    const tenantId = requireTenantId(req);
    await assertBookingLocationAccess({
      req,
      tenantId,
      bookingId: req.body.id,
    });

    const booking = await updateBookingByAdmin({
      tenantId,
      actorUserId: getAuthenticatedUserId(req),
      input: req.body,
    });

    res.json({
      message: `Booking: ${booking._id} was updated`,
      booking,
    });
  },
);

export const cancelBooking = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    await assertBookingLocationAccess({
      req,
      tenantId,
      bookingId: req.body.id,
    });
    const userId = await requireSelfOrBookingPermissions({
      req,
      tenantId,
      targetUserId: String(req.body.userId ?? getAuthenticatedUserId(req)),
      // The cancellation service also restores or refunds payment. Acting on
      // another user's booking therefore requires both capabilities.
      permissions: [
        WORKSPACE_PERMISSION.BOOKINGS_CANCEL,
        WORKSPACE_PERMISSION.BOOKINGS_REFUND,
      ],
    });

    const result = await cancelBookingWithRefund({
      tenantId,
      bookingId: req.body.id,
      userId,
      actorUserId: getAuthenticatedUserId(req),
    });

    res.json(result);
  },
);

export const updateGuestIncreaseRecords = (
  guestIncreaseIds: string[],
  orderId: string,
  tenantId: string,
) => {
  if (!tenantId) {
    throw new Error("updateGuestIncreaseRecords now requires tenantId");
  }

  return updateGuestIncreaseService({
    tenantId,
    guestIncreaseIds,
    orderId,
  });
};
