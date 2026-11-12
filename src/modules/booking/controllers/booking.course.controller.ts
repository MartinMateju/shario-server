import type { Request, Response } from "express";

import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  createCourseBookingRecords as createCourseBookingRecordsService,
  reconcileCourseBookingParticipants as reconcileCourseBookingParticipantsService,
} from "../services/booking.course.service.js";

export const createCourseBookingRecords = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);

    const result = await createCourseBookingRecordsService({
      tenantId,
      input: {
        ...req.body,
        createdBy: getAuthenticatedUserId(req),
      },
    });

    if (result.count > 0) {
      res.status(201).json({
        message: `Created ${result.count} booking(s)`,
        ids: result.ids,
      });

      return;
    }

    res.status(400).json({
      message: "Failed to create new bookings",
    });
  },
);

type ReconcileCourseBookingParticipantsArgs = {
  tenantId?: string | null;
};

export const reconcileCourseBookingParticipants = async ({
  tenantId,
}: ReconcileCourseBookingParticipantsArgs = {}) => {
  if (!tenantId) {
    throw new Error("reconcileCourseBookingParticipants requires tenantId");
  }

  return reconcileCourseBookingParticipantsService({ tenantId });
};
