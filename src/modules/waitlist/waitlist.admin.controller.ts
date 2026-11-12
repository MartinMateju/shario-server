import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import {
  cancelWaitlistEntryByAdmin,
  getWaitlistSettings,
  listAdminWaitlist,
  promoteWaitlistEntry,
  resendWaitlistOffer,
  updateWaitlistSettings,
} from "./waitlist.service.js";
import {
  waitlistAdminActionSchema,
  waitlistAdminRemovalSchema,
  waitlistEntryParamsSchema,
  waitlistSessionParamsSchema,
  waitlistSettingsPatchSchema,
} from "./waitlist.validators.js";

const actor = (
  req: Request,
  input: { reason?: string; overrideFifo?: boolean },
) => ({
  actorUserId: getAuthenticatedUserId(req),
  reason: input.reason,
  overrideFifo: input.overrideFifo,
});

export const getAdminWaitlist = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId } = waitlistSessionParamsSchema.parse(req.params);
    res.set("Cache-Control", "private, no-store");
    res.json(
      await listAdminWaitlist({ tenantId: requireTenantId(req), sessionId }),
    );
  },
);

export const getAdminWaitlistSettings = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId } = waitlistSessionParamsSchema.parse(req.params);
    const settings = await getWaitlistSettings({
      tenantId: requireTenantId(req),
      sessionId,
    });
    res.json({ settings });
  },
);

export const patchAdminWaitlistSettings = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId } = waitlistSessionParamsSchema.parse(req.params);
    const input = waitlistSettingsPatchSchema.parse(req.body);
    const settings = await updateWaitlistSettings({
      tenantId: requireTenantId(req),
      sessionId,
      patch: input,
      actor: actor(req, { reason: "Waitlist settings updated." }),
    });
    res.json({ settings });
  },
);

export const promoteAdminWaitlistEntry = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId, entryId } = waitlistEntryParamsSchema.parse(req.params);
    const input = waitlistAdminActionSchema.parse(req.body ?? {});
    const entry = await promoteWaitlistEntry({
      tenantId: requireTenantId(req),
      sessionId,
      entryId,
      actor: actor(req, input),
    });
    res.json({ entry });
  },
);

export const resendAdminWaitlistOffer = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId, entryId } = waitlistEntryParamsSchema.parse(req.params);
    const input = waitlistAdminRemovalSchema.parse(req.body);
    const entry = await resendWaitlistOffer({
      tenantId: requireTenantId(req),
      sessionId,
      entryId,
      actor: actor(req, input),
    });
    res.json({ entry });
  },
);

export const cancelAdminWaitlistEntry = asyncHandler(
  async (req: Request, res: Response) => {
    const { sessionId, entryId } = waitlistEntryParamsSchema.parse(req.params);
    const input = waitlistAdminRemovalSchema.parse(req.body);
    const entry = await cancelWaitlistEntryByAdmin({
      tenantId: requireTenantId(req),
      sessionId,
      entryId,
      actor: actor(req, input),
    });
    res.json({ entry });
  },
);
