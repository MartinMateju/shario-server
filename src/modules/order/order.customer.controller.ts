import type { Request, Response } from "express";
import { z } from "zod";

import {
  getAuthenticatedUserId,
} from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { getMyOrderConfirmation } from "./order.customer.service.js";

const paramsSchema = z
  .object({
    orderId: z.string().trim().min(1).max(80),
  })
  .strict();

export const getCustomerOrderConfirmation = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = paramsSchema.parse(req.params);
    const result = await getMyOrderConfirmation({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      orderId,
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json(result);
  },
);
