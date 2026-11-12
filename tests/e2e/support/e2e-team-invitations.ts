import { Router } from "express";
import mongoose from "mongoose";
import { assertE2ETestMode, isE2ETestMode } from "@/config/e2e-mode.js";
import TeamInvitationModel from "@/modules/tenant-access/team-invitation.model.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

/** Bounded time scenarios in the disposable Alpha fixture, never a live API. */
export const createE2ETeamInvitationsRouter = (
  key: string,
  tenantId: string,
) => {
  assertE2ETestMode();
  const router = Router();
  router.post(
    "/team-invitation-scenario",
    asyncHandler(async (req, res) => {
      if (!isE2ETestMode()) {
        res.status(404).end();
        return;
      }
      if (req.get("x-e2e-key") !== key) {
        res.status(403).end();
        return;
      }
      if (!/(^|[-_])(e2e|test)([-_]|$)/i.test(mongoose.connection.name)) {
        throw new Error(
          "Invitation scenarios require a disposable E2E database.",
        );
      }
      const { invitationId, scenario } = req.body ?? {};
      if (
        !mongoose.isValidObjectId(invitationId) ||
        !["resend-ready", "expired"].includes(scenario)
      ) {
        res.status(400).json({ message: "Unknown invitation scenario." });
        return;
      }
      const invitation = await TeamInvitationModel.findOne({
        _id: invitationId,
        tenant: new mongoose.Types.ObjectId(tenantId),
        status: "pending",
        email: /@team-invitations\.test$/,
      });
      if (!invitation) {
        res.status(404).end();
        return;
      }
      if (scenario === "resend-ready")
        invitation.lastAttemptAt = new Date(Date.now() - 61_000);
      else invitation.expiresAt = new Date(Date.now() - 1_000);
      await invitation.save();
      res.json({ applied: scenario });
    }),
  );
  return router;
};
