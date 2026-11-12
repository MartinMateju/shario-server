import type { NextFunction, Request, Response } from "express";
import { AUTH_CONTEXT } from "@/modules/auth/auth.constants.js";
import { getRequestAuthContext } from "@/modules/auth/middleware/requireAuthContext.js";
import { getTenantOrThrow } from "../services/tenant.service.js";
import { requireTenantId } from "../tenant.utils.js";
import { CUSTOMER_MY_WORK_DISABLED } from "../tenant-customer-capabilities.js";
import { getTenantCustomerCapabilities } from "../customer-piece-access.service.js";
import { forbidden } from "@/shared/http/httpErrors.js";

/** Staff records remain available; customer access follows the saved choice. */
export const requireCustomerMyWork = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (getRequestAuthContext(req) === AUTH_CONTEXT.CUSTOMER) {
      // Subscription middleware can serve a cached tenant. Read the current
      // choice so changing pricing mode takes effect on the next request.
      const tenant = await getTenantOrThrow(requireTenantId(req));
      if (!(await getTenantCustomerCapabilities(tenant)).myWork)
        forbidden(CUSTOMER_MY_WORK_DISABLED);
    }
    next();
  } catch (error) {
    next(error);
  }
};
