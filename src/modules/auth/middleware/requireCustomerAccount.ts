import type { NextFunction, Request, Response } from "express";

import UserModel from "@/modules/user/user.model.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import { AUTH_CONTEXT } from "@/modules/auth/auth.constants.js";
import { assertAuthContext } from "./requireAuthContext.js";

/** Recheck account access and platform status in the database for commerce. */
export const createCustomerAccountGate = ({
  requireEmailVerification = false,
}: { requireEmailVerification?: boolean } = {}) => async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    assertAuthContext(req, AUTH_CONTEXT.CUSTOMER);
    const user = await UserModel.findOne({
      _id: getAuthenticatedUserId(req),
      tenant: requireTenantId(req),
      isAccessGranted: true,
    })
      .select("isEmailVerified +tenantRole +platformRole")
      .lean()
      .exec();

    if (!user) {
      notFound({
        message: "Customer account not found.",
        code: "CUSTOMER_ACCOUNT_NOT_FOUND",
      });
    }

    if (String(user.platformRole || "none") !== "none") {
      forbidden({
        message: "Platform accounts cannot use the customer portal.",
        code: "CUSTOMER_CONTEXT_PLATFORM_ACCOUNT_FORBIDDEN",
      });
    }

    if (requireEmailVerification && user.isEmailVerified !== true) {
      forbidden({
        message: "Verify your email address before completing this booking.",
        code: "EMAIL_VERIFICATION_REQUIRED",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Booking checkout requires an active customer account, not email verification.
export const requireCustomerAccount = createCustomerAccountGate();

export default requireCustomerAccount;
