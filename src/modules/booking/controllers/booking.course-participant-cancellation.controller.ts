import type { Request, Response } from "express";
import { z } from "zod";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { cancelPaidCourseParticipants } from "../services/booking.course-participant-cancellation.service.js";

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const paramsSchema = z
  .object({ sessionId: objectId, orderId: objectId })
  .strict();
const bodySchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

export const cancelCourseOrderParticipants = asyncHandler(
  async (req: Request, res: Response) => {
    const params = paramsSchema.parse(req.params);
    const body = bodySchema.parse(req.body);
    const result = await cancelPaidCourseParticipants({
      tenantId: requireTenantId(req),
      actorUserId: getAuthenticatedUserId(req),
      sessionId: params.sessionId,
      orderId: params.orderId,
      reason: body.reason,
    });
    res.json(result);
  },
);
