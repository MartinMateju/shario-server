import rateLimit, { MemoryStore } from "express-rate-limit";
import { assertE2ETestMode } from "@/config/e2e-mode.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";

const invitationSendStore = new MemoryStore();

export const createTeamInvitationSendLimiter = (store = new MemoryStore()) =>
  rateLimit({
    store,
    windowMs: 15 * 60 * 1000,
    limit: 20,
    // Mounted only after JWT, workspace and TEAM_MANAGE authorization. The same
    // budget covers create, resend and existing-member sign-in instructions.
    keyGenerator: (req) =>
      `${requireTenantId(req)}:${getAuthenticatedUserId(req)}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      code: "TEAM_INVITATION_RATE_LIMITED",
      message: "Too many team invitations. Please try again in 15 minutes.",
    },
  });

export const teamInvitationSendLimiter =
  createTeamInvitationSendLimiter(invitationSendStore);

export const resetTeamInvitationRateLimitsForE2E = async (): Promise<void> => {
  assertE2ETestMode();
  await invitationSendStore.resetAll();
};
