import type { Response } from "express";

import type { PublishedTenantRequest } from "@/modules/setup-center/setup-publication.middleware.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";

import {
  getGuestManagedEntry,
  requestGuestWaitlistVerification,
  verifyGuestWaitlist,
  withdrawWaitlistEntry,
} from "./waitlist.service.js";
import { inspectWaitlistOffer } from "./waitlist.checkout.service.js";
import {
  guestWaitlistCheckoutSchema,
  guestWaitlistRequestSchema,
  waitlistTokenSchema,
} from "./waitlist.validators.js";

const publishedTenant = (req: PublishedTenantRequest) => {
  if (!req.tenant) {
    notFound({
      message: "Workspace not found.",
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });
  }
  return req.tenant;
};

export const requestGuestWaitlist = asyncHandler(
  async (req: PublishedTenantRequest, res: Response) => {
    const input = guestWaitlistRequestSchema.parse(req.body);
    await requestGuestWaitlistVerification({
      tenantId: requireTenantId(req),
      sessionId: input.sessionId,
      identity: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        locale: input.locale,
      },
    });
    res.status(202).json({ verificationRequired: true });
  },
);

export const verifyGuestWaitlistToken = asyncHandler(
  async (req: PublishedTenantRequest, res: Response) => {
    const { token } = waitlistTokenSchema.parse(req.body);
    const result = await verifyGuestWaitlist({
      tenantId: requireTenantId(req),
      token,
    });
    res.status(result.created ? 201 : 200).json({
      entry: result.entry,
      managementToken: result.managementToken,
    });
  },
);

export const manageGuestWaitlist = asyncHandler(
  async (req: PublishedTenantRequest, res: Response) => {
    const { token } = waitlistTokenSchema.parse(req.body);
    const entry = await getGuestManagedEntry({
      tenantId: requireTenantId(req),
      token,
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ entry });
  },
);

export const withdrawGuestWaitlist = asyncHandler(
  async (req: PublishedTenantRequest, res: Response) => {
    const { token } = waitlistTokenSchema.parse(req.body);
    const entry = await withdrawWaitlistEntry({
      tenantId: requireTenantId(req),
      managementToken: token,
    });
    res.json({ entry });
  },
);

export const inspectGuestWaitlistOffer = asyncHandler(
  async (req: PublishedTenantRequest, res: Response) => {
    const { token } = waitlistTokenSchema.parse(req.body);
    publishedTenant(req);
    const offer = await inspectWaitlistOffer({
      tenantId: requireTenantId(req),
      token,
      // Main has no anonymous course-order creator/claim flow. Keep the
      // verified guest queue anonymous, but require sign-in for payment.
      guestCheckoutAllowed: false,
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ offer });
  },
);

export const checkoutGuestWaitlistOffer = asyncHandler(
  async (req: PublishedTenantRequest, res: Response) => {
    const input = guestWaitlistCheckoutSchema.parse(req.body);
    publishedTenant(req);
    // Validate the narrow DTO but never synthesize an inaccessible User. A
    // bearer is resumed after the customer signs in with the verified email.
    void input;
    forbidden({
      message: "Sign in to pay for this waitlist offer.",
      code: "WAITLIST_AUTHENTICATION_REQUIRED",
    });
  },
);
