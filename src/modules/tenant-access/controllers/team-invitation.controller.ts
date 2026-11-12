import type { Request, Response } from "express";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { z } from "zod";
import mongoose from "mongoose";
import type { WorkspaceAccessRequest } from "../tenant-access.types.js";
import {
  membershipIdParamsSchema,
  parseTenantAccessInput,
} from "../tenant-access.validators.js";
import {
  acceptTeamInvitationSchema,
  createTeamInvitationSchema,
  invitationLocaleSchema,
  previewTeamInvitationSchema,
} from "../team-invitation.validators.js";
import {
  acceptTeamInvitation,
  createTeamInvitation,
  createTeamSignInInvitation,
  listTeamInvitations,
  previewTeamInvitation,
  resendTeamInvitation,
  revokeTeamInvitation,
} from "../services/team-invitation.service.js";

const context = (req: WorkspaceAccessRequest) => ({
  tenantId: requireTenantId(req),
  actorUserId: getAuthenticatedUserId(req),
});
const invitationIdSchema = z.object({
  invitationId: z
    .string()
    .refine((value) => mongoose.Types.ObjectId.isValid(value)),
});
const privateResponse = (res: Response) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
};

export const listCurrentTeamInvitations = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response) => {
    privateResponse(res);
    res.json({ invitations: await listTeamInvitations(context(req)) });
  },
);
export const createCurrentTeamInvitation = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response) => {
    privateResponse(res);
    const input = parseTenantAccessInput(createTeamInvitationSchema, req.body);
    res
      .status(201)
      .json({
        invitation: await createTeamInvitation({ ...context(req), input }),
      });
  },
);
export const createCurrentTeamSignInInvitation = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response) => {
    privateResponse(res);
    const { membershipId } = parseTenantAccessInput(
      membershipIdParamsSchema,
      req.params,
    );
    const { locale } = parseTenantAccessInput(invitationLocaleSchema, req.body);
    res
      .status(201)
      .json({
        invitation: await createTeamSignInInvitation({
          ...context(req),
          membershipId,
          locale,
        }),
      });
  },
);
export const resendCurrentTeamInvitation = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response) => {
    privateResponse(res);
    const { invitationId } = parseTenantAccessInput(
      invitationIdSchema,
      req.params,
    );
    res.json({
      invitation: await resendTeamInvitation({ ...context(req), invitationId }),
    });
  },
);
export const revokeCurrentTeamInvitation = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response) => {
    privateResponse(res);
    const { invitationId } = parseTenantAccessInput(
      invitationIdSchema,
      req.params,
    );
    res.json({
      invitation: await revokeTeamInvitation({ ...context(req), invitationId }),
    });
  },
);
export const previewPublicTeamInvitation = asyncHandler(
  async (req: Request, res: Response) => {
    privateResponse(res);
    const input = parseTenantAccessInput(previewTeamInvitationSchema, req.body);
    res.json({ invitation: await previewTeamInvitation(input) });
  },
);
export const acceptPublicTeamInvitation = asyncHandler(
  async (req: Request, res: Response) => {
    privateResponse(res);
    const input = parseTenantAccessInput(acceptTeamInvitationSchema, req.body);
    res.json(await acceptTeamInvitation(input));
  },
);
