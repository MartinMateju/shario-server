import type { Response } from "express";

import {
  getAuthenticatedUserEmail,
  getAuthenticatedUserId,
} from "@/modules/auth/auth.utils.js";
import type { CheckoutRequest } from "@/modules/checkout/checkout.types.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import UserModel from "@/modules/user/user.model.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { notFound } from "@/shared/http/httpErrors.js";
import { reconcileGuestEntryToCustomer } from "./waitlist.checkout.service.js";

import {
  joinCustomerWaitlist,
  listCustomerWaitlistEntries,
  withdrawWaitlistEntry,
} from "./waitlist.service.js";
import {
  customerWaitlistEntryParamsSchema,
  customerWaitlistQuerySchema,
  joinCustomerWaitlistSchema,
} from "./waitlist.validators.js";

const customerIdentity = async (req: CheckoutRequest) => {
  const tenantId = requireTenantId(req);
  const user = await UserModel.findOne({
    _id: getAuthenticatedUserId(req),
    tenant: tenantId,
    isAccessGranted: true,
  })
    .select("_id email firstname lastname customId isEmailVerified")
    .lean()
    .exec();
  if (!user) {
    notFound({ message: "Customer not found.", code: "CUSTOMER_NOT_FOUND" });
  }
  // Account ownership is enough to read or withdraw existing entries. Claiming
  // guest entries by email additionally requires proof of that email address.
  if (user.isEmailVerified === true) {
    await reconcileGuestEntryToCustomer({
      tenantId,
      customerId: String(user._id),
      email: String(user.email),
    });
  }
  return { tenantId, user };
};

export const joinWaitlistAsCustomer = asyncHandler(
  async (req: CheckoutRequest, res: Response) => {
    const { sessionId, locale } = joinCustomerWaitlistSchema.parse(req.body);
    const { tenantId, user } = await customerIdentity(req);
    const result = await joinCustomerWaitlist({
      tenantId,
      sessionId,
      customer: {
        customerId: String(user._id || getAuthenticatedUserId(req)),
        email: String(user.email || getAuthenticatedUserEmail(req)),
        firstName: String(user.firstname || "Customer"),
        lastName: String(user.lastname || ""),
        customId: String(user.customId || ""),
        locale,
      },
    });
    res.status(result.created ? 201 : 200).json({ entry: result.entry });
  },
);

export const getMyWaitlist = asyncHandler(
  async (req: CheckoutRequest, res: Response) => {
    const query = customerWaitlistQuerySchema.parse(req.query);
    const { tenantId, user } = await customerIdentity(req);
    const entries = await listCustomerWaitlistEntries({
      tenantId,
      customerId: String(user._id || getAuthenticatedUserId(req)),
      sessionId: query.sessionId,
    });
    res.set("Cache-Control", "private, no-store");
    res.json(query.sessionId ? { entry: entries[0] ?? null } : { entries });
  },
);

export const withdrawMyWaitlistEntry = asyncHandler(
  async (req: CheckoutRequest, res: Response) => {
    const { entryId } = customerWaitlistEntryParamsSchema.parse(req.params);
    const { tenantId, user } = await customerIdentity(req);
    const entry = await withdrawWaitlistEntry({
      tenantId,
      entryId,
      customerId: String(user._id || getAuthenticatedUserId(req)),
    });
    res.json({ entry });
  },
);
