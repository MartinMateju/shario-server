import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose, { type ClientSession } from "mongoose";

import { sendSystemPostmarkEmail } from "@/infrastructure/email/managed-email.service.js";
import LocationModel from "@/modules/location/location.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import UserModel from "@/modules/user/user.model.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
} from "@/shared/http/httpErrors.js";
import {
  LOCATION_ACCESS_MODE,
  WORKSPACE_ROLE,
  type WorkspaceRole,
} from "../tenant-access.constants.js";
import { WORKSPACE_PERMISSION } from "../tenant-access.permissions.js";
import {
  getBuiltInRoleName,
  getBuiltInRolePermissions,
  isBuiltInWorkspaceRole,
} from "../tenant-access.roles.js";
import { tenantAccessRepository } from "../tenant-access.repository.js";
import TenantCustomRoleModel from "../tenant-custom-role.model.js";
import TenantMembershipModel from "../tenant-membership.model.js";
import TeamInvitationModel, {
  type TeamInvitationDocument,
} from "../team-invitation.model.js";
import {
  newInvitationAccountSchema,
  invitationTokenSchema,
  type AcceptTeamInvitationInput,
  type CreateTeamInvitationInput,
} from "../team-invitation.validators.js";
import { parseTenantAccessInput } from "../tenant-access.validators.js";
import type {
  ResolvedWorkspaceAccess,
  WorkspaceLocationAccess,
} from "../tenant-access.types.js";
import {
  acquireTenantAccessWriteLock,
  addExistingTenantUserToTeam,
  assertActorCanGrantLocationAccess,
  assertLocationAccessIsValid,
  assertPlanSeatLimits,
  resolveAuthoritativeActor,
  resolveCustomRoleId,
  runTenantAccessTransaction,
} from "./team.service.js";

const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const toId = (value: unknown) => new mongoose.Types.ObjectId(String(value));
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const invitationActor = async (
  input: Parameters<typeof resolveAuthoritativeActor>[0],
) => {
  const actor = await resolveAuthoritativeActor(input);
  // Public acceptance does not pass through verifyJWT. Recheck the inviter's
  // account as well as their current membership before honoring a saved grant.
  const user = await UserModel.findOne({
    _id: toId(input.actorUserId),
    tenant: toId(input.tenantId),
  })
    .select("isAccessGranted")
    .session(input.session);
  if (!user || user.isAccessGranted === false)
    forbidden({
      code: "WORKSPACE_PERMISSION_CHANGED",
      message: "The invitation sender no longer has active workspace access.",
    });
  return actor;
};
const invalidInvitation = (): never =>
  badRequest({
    code: "TEAM_INVITATION_INVALID",
    message: "This invitation is invalid, expired, revoked or already used.",
  });
const locationAccessOf = (
  invitation: TeamInvitationDocument,
): WorkspaceLocationAccess => ({
  mode:
    invitation.locationAccess?.mode === LOCATION_ACCESS_MODE.SELECTED
      ? LOCATION_ACCESS_MODE.SELECTED
      : LOCATION_ACCESS_MODE.ALL,
  locationIds: (invitation.locationAccess?.locationIds ?? []).map(String),
});
const roleName = async (invitation: TeamInvitationDocument) => {
  if (isBuiltInWorkspaceRole(invitation.roleKey))
    return getBuiltInRoleName(invitation.roleKey);
  const role = await TenantCustomRoleModel.findOne({
    _id: invitation.customRoleId,
    tenant: invitation.tenant,
  })
    .select("name")
    .lean();
  return role?.name ?? "Custom role";
};
const serializeInvitation = async (invitation: TeamInvitationDocument) => ({
  id: String(invitation._id),
  email: invitation.email,
  mode: invitation.mode,
  roleKey: invitation.roleKey,
  roleName: await roleName(invitation),
  customRoleId: invitation.customRoleId
    ? String(invitation.customRoleId)
    : null,
  locationAccess: locationAccessOf(invitation),
  workspaceProfile: invitation.workspaceProfile,
  status:
    invitation.status === "pending" && invitation.expiresAt <= new Date()
      ? "expired"
      : invitation.status,
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
  lastSentAt: invitation.lastSentAt,
  deliveryStatus: invitation.deliveryStatus,
});

const validateGrant = async ({
  tenantId,
  actor,
  input,
  session,
}: {
  tenantId: string;
  actor: ResolvedWorkspaceAccess;
  input: Pick<
    CreateTeamInvitationInput,
    "roleKey" | "customRoleId" | "locationAccess"
  >;
  session: ClientSession;
}) => {
  if (input.roleKey === WORKSPACE_ROLE.OWNER)
    forbidden({
      code: "TEAM_INVITATION_OWNER_FORBIDDEN",
      message: "Owner access cannot be granted through an invitation.",
    });
  const locationAccess = await assertLocationAccessIsValid({
    tenantId,
    role: input.roleKey,
    locationAccess: input.locationAccess,
    session,
  });
  assertActorCanGrantLocationAccess(actor, locationAccess);
  const customRole = await resolveCustomRoleId({
    tenantId,
    role: input.roleKey,
    requestedCustomRoleId: input.customRoleId,
    session,
  });
  const permissions = isBuiltInWorkspaceRole(input.roleKey)
    ? getBuiltInRolePermissions(input.roleKey)
    : ((
        await tenantAccessRepository.findCustomRoleById(
          tenantId,
          String(customRole),
          { session },
        )
      )?.permissions ?? []);
  if (
    !actor.isPlatformBypass &&
    actor.role !== WORKSPACE_ROLE.OWNER &&
    permissions.some((permission) => !actor.permissions.includes(permission))
  ) {
    forbidden({
      code: "TEAM_INVITATION_ROLE_ESCALATION",
      message: "You cannot invite someone with permissions you do not have.",
    });
  }
  return { customRole, locationAccess };
};

const assertAccountUsable = (user: {
  isAccessGranted?: boolean;
  platformRole?: string;
}) => {
  if (
    user.isAccessGranted === false ||
    (user.platformRole && user.platformRole !== "none")
  ) {
    forbidden({
      code: "TEAM_INVITATION_ACCOUNT_UNAVAILABLE",
      message: "This account cannot accept a team invitation.",
    });
  }
};
const assertSignInMembership = async (
  invitation: TeamInvitationDocument,
  session?: ClientSession,
) => {
  const membership = await TenantMembershipModel.findOne({
    _id: invitation.membership,
    tenant: invitation.tenant,
    status: "active",
    role: { $ne: "owner" },
  }).session(session ?? null);
  if (!membership)
    conflict({
      code: "TEAM_INVITATION_MEMBERSHIP_CHANGED",
      message:
        "This team membership is no longer available. Contact the workspace owner.",
    });
  const user = await UserModel.findOne({
    _id: membership.user,
    tenant: invitation.tenant,
    email: invitation.email,
  })
    .select("+password +platformRole")
    .session(session ?? null);
  if (!user) invalidInvitation();
  assertAccountUsable(user);
  return { membership, user };
};

const invitationUrl = (token: string, locale: string) => {
  // Configuration only: never use Host, Origin, or a caller-provided redirect.
  const origin = new URL(
    process.env.PUBLIC_APP_URL || process.env.CLIENT_URL || "https://shario.io",
  );
  const loopback =
    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.hostname.endsWith(".localhost");
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        loopback &&
        origin.protocol === "http:"
      ))
  ) {
    throw new Error("Invalid platform invitation origin configuration.");
  }
  const url = new URL(`/${locale}/team-invitation`, origin);
  url.searchParams.set("token", token);
  return url.toString();
};
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const deliverInvitation = async (
  invitation: TeamInvitationDocument,
  token: string,
) => {
  let sent = false;
  try {
    const tenant = await TenantModel.findById(invitation.tenant)
      .select("name")
      .lean();
    const name = String(tenant?.name ?? "Workspace")
      .replace(/[\r\n]/g, " ")
      .slice(0, 160);
    const url = invitationUrl(token, invitation.locale ?? "en");
    const cs = invitation.locale === "cs";
    const subject = cs
      ? `${name}: pozvánka do týmu`
      : `${name}: team invitation`;
    const instruction = cs
      ? `Byli jste pozváni do týmu ${name}. Otevřete odkaz a potvrďte přístup. Pokud už máte účet v tomto studiu, použijte své současné heslo; jinak si vytvoříte nové. Odkaz platí 7 dní a lze jej použít pouze jednou.`
      : `You have been invited to the ${name} team. Open the link to confirm access. If you already have an account in this workspace, use your current password; otherwise you will create one. This link expires in 7 days and can only be used once.`;
    await sendSystemPostmarkEmail({
      to: invitation.email,
      subject,
      text: `${instruction}\n\n${url}\n\n${cs ? "Pokud pozvánku neočekáváte, můžete ji ignorovat." : "If you were not expecting this invitation, you can ignore it."}`,
      html: `<p>${escapeHtml(instruction)}</p><p><a href="${escapeHtml(url)}">${cs ? "Přijmout pozvánku" : "Accept invitation"}</a></p>`,
      metadata: {
        tenantId: String(invitation.tenant),
        teamInvitationId: String(invitation._id),
      },
    });
    sent = true;
  } catch {
    // A failure must remain visible and retryable. Never log provider bodies,
    // which may include the credential-bearing invitation link.
  }
  await TeamInvitationModel.updateOne(
    { _id: invitation._id, tokenHash: hashToken(token), status: "pending" },
    {
      $set: {
        deliveryStatus: sent ? "sent" : "failed",
        ...(sent ? { lastSentAt: new Date() } : {}),
      },
    },
  );
  const current = await TeamInvitationModel.findById(invitation._id);
  return serializeInvitation(current!);
};

type ActorContext = { tenantId: string; actorUserId: string };
export const createTeamInvitation = async ({
  tenantId,
  actorUserId,
  input,
}: ActorContext & { input: CreateTeamInvitationInput }) => {
  const token = randomBytes(32).toString("base64url");
  const invitation = await runTenantAccessTransaction(async (session) => {
    const tenant = await acquireTenantAccessWriteLock(tenantId, session);
    const actor = await invitationActor({
      tenantId,
      actorUserId,
      permission: WORKSPACE_PERMISSION.TEAM_MANAGE,
      session,
    });
    const grant = await validateGrant({ tenantId, actor, input, session });
    const email = input.email.trim().toLowerCase();
    const user = await UserModel.findOne({ tenant: tenant._id, email })
      .select("+platformRole +tenantRole")
      .session(session);
    if (user) {
      assertAccountUsable(user);
      if (
        (await tenantAccessRepository.findMembershipByUser(tenantId, user._id, {
          session,
        })) ||
        user.tenantRole !== "customer"
      ) {
        conflict({
          code: "TENANT_MEMBERSHIP_EXISTS",
          message:
            "This account already has team access history. Use its team member controls.",
        });
      }
    }
    if (
      await TeamInvitationModel.exists({
        tenant: tenant._id,
        email,
        status: "pending",
      }).session(session)
    ) {
      conflict({
        code: "TEAM_INVITATION_EXISTS",
        message:
          "An invitation already exists. Resend or revoke it from the invitation list.",
      });
    }
    await assertPlanSeatLimits({
      tenant,
      nextRole: input.roleKey,
      nextStatus: "active",
      session,
    });
    const [created] = await TeamInvitationModel.create(
      [
        {
          tenant: tenant._id,
          email,
          mode: "join",
          roleKey: input.roleKey,
          customRoleId: grant.customRole,
          locationAccess: grant.locationAccess,
          workspaceProfile: input.workspaceProfile,
          locale: input.locale,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS),
          createdBy: toId(actorUserId),
          invitedBy: toId(actorUserId),
          updatedBy: toId(actorUserId),
          lastAttemptAt: new Date(),
        },
      ],
      { session },
    );
    return created;
  });
  return deliverInvitation(invitation, token);
};

export const createTeamSignInInvitation = async ({
  tenantId,
  actorUserId,
  membershipId,
  locale = "en",
}: ActorContext & { membershipId: string; locale?: "cs" | "en" }) => {
  const token = randomBytes(32).toString("base64url");
  const invitation = await runTenantAccessTransaction(async (session) => {
    await acquireTenantAccessWriteLock(tenantId, session);
    const actor = await invitationActor({
      tenantId,
      actorUserId,
      permission: WORKSPACE_PERMISSION.TEAM_MANAGE,
      session,
    });
    const membership = await tenantAccessRepository.findMembershipById(
      tenantId,
      membershipId,
      { session },
    );
    if (!membership || membership.status !== "active")
      notFound("Active team member not found.");
    const input = {
      roleKey: membership.role,
      customRoleId: membership.customRole
        ? String(membership.customRole)
        : null,
      locationAccess: {
        mode: membership.locationAccess.mode,
        locationIds: membership.locationAccess.locationIds.map(String),
      },
    };
    const grant = await validateGrant({ tenantId, actor, input, session });
    const user = await UserModel.findOne({
      _id: membership.user,
      tenant: toId(tenantId),
    })
      .select("+platformRole")
      .session(session);
    if (!user?.email) notFound("Team account not found.");
    assertAccountUsable(user);
    if (
      await TeamInvitationModel.exists({
        tenant: toId(tenantId),
        email: user.email,
        status: "pending",
      }).session(session)
    )
      conflict({
        code: "TEAM_INVITATION_EXISTS",
        message:
          "An invitation already exists. Resend it from the invitation list.",
      });
    const [created] = await TeamInvitationModel.create(
      [
        {
          tenant: toId(tenantId),
          email: user.email,
          mode: "sign_in",
          membership: membership._id,
          roleKey: membership.role,
          customRoleId: grant.customRole,
          locationAccess: grant.locationAccess,
          workspaceProfile: membership.workspaceProfile,
          locale,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS),
          createdBy: toId(actorUserId),
          invitedBy: toId(actorUserId),
          updatedBy: toId(actorUserId),
          lastAttemptAt: new Date(),
        },
      ],
      { session },
    );
    return created;
  });
  return deliverInvitation(invitation, token);
};

export const listTeamInvitations = async ({
  tenantId,
  actorUserId,
}: ActorContext) =>
  runTenantAccessTransaction(async (session) => {
    const actor = await invitationActor({
      tenantId,
      actorUserId,
      permission: WORKSPACE_PERMISSION.TEAM_VIEW,
      session,
    });
    const invitations = await TeamInvitationModel.find({
      tenant: toId(tenantId),
      status: "pending",
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .session(session);
    const permitted = invitations.filter((invitation) => {
      try {
        assertActorCanGrantLocationAccess(actor, locationAccessOf(invitation));
        return true;
      } catch {
        return false;
      }
    });
    return Promise.all(permitted.map(serializeInvitation));
  });

const mutateInvitation = async ({
  tenantId,
  actorUserId,
  invitationId,
  revoke,
}: ActorContext & { invitationId: string; revoke: boolean }) => {
  const token = randomBytes(32).toString("base64url");
  const invitation = await runTenantAccessTransaction(async (session) => {
    await acquireTenantAccessWriteLock(tenantId, session);
    const actor = await invitationActor({
      tenantId,
      actorUserId,
      permission: WORKSPACE_PERMISSION.TEAM_MANAGE,
      session,
    });
    const current = await TeamInvitationModel.findOne({
      _id: toId(invitationId),
      tenant: toId(tenantId),
      status: "pending",
    })
      .select("+tokenHash")
      .session(session);
    if (!current) notFound("Pending invitation not found.");
    assertActorCanGrantLocationAccess(actor, locationAccessOf(current));
    if (revoke) {
      current.status = "revoked";
      current.revokedAt = new Date();
    } else {
      await validateGrant({
        tenantId,
        actor,
        input: {
          roleKey: current.roleKey as WorkspaceRole,
          customRoleId: current.customRoleId
            ? String(current.customRoleId)
            : null,
          locationAccess: locationAccessOf(current),
        },
        session,
      });
      if (current.mode === "sign_in")
        await assertSignInMembership(current, session);
      if (Date.now() - current.lastAttemptAt.getTime() < 60_000)
        tooManyRequests({
          code: "TEAM_INVITATION_RESEND_TOO_SOON",
          message: "Wait a minute before sending this invitation again.",
        });
      current.tokenHash = hashToken(token);
      current.expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
      current.lastAttemptAt = new Date();
      current.deliveryStatus = "pending";
      current.invitedBy = toId(actorUserId);
    }
    current.updatedBy = toId(actorUserId);
    await current.save({ session });
    return current;
  });
  return revoke
    ? serializeInvitation(invitation)
    : deliverInvitation(invitation, token);
};
export const resendTeamInvitation = (
  input: ActorContext & { invitationId: string },
) => mutateInvitation({ ...input, revoke: false });
export const revokeTeamInvitation = (
  input: ActorContext & { invitationId: string },
) => mutateInvitation({ ...input, revoke: true });

const findValidInvitation = async (token: string, session?: ClientSession) => {
  if (!invitationTokenSchema.safeParse(token).success) invalidInvitation();
  const invitation = await TeamInvitationModel.findOne({
    tokenHash: hashToken(token),
    status: "pending",
    expiresAt: { $gt: new Date() },
  })
    .select("+tokenHash")
    .session(session ?? null);
  if (!invitation) invalidInvitation();
  return invitation;
};
export const previewTeamInvitation = async ({ token }: { token: string }) => {
  const invitation = await findValidInvitation(token);
  const tenant = await TenantModel.findById(invitation.tenant)
    .select("name slug")
    .lean();
  if (!tenant) invalidInvitation();
  const user = await UserModel.findOne({
    tenant: invitation.tenant,
    email: invitation.email,
  }).select("+password +platformRole");
  if (user) assertAccountUsable(user);
  if (invitation.mode === "sign_in") await assertSignInMembership(invitation);
  const locationAccess = locationAccessOf(invitation);
  const locations = await LocationModel.find({
    tenant: invitation.tenant,
    ...(locationAccess.mode === "selected"
      ? { _id: { $in: locationAccess.locationIds.map(toId) } }
      : {}),
  })
    .select("name")
    .lean();
  return {
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    email: invitation.email,
    mode: invitation.mode,
    roleKey: invitation.roleKey,
    roleName: await roleName(invitation),
    locationAccess,
    locations: locations.map((location) => ({
      id: String(location._id),
      name: location.name,
    })),
    expiresAt: invitation.expiresAt,
    accountExists: Boolean(user),
    requiresPasswordReset: Boolean(user && !user.password),
  };
};

export const acceptTeamInvitation = async (
  input: AcceptTeamInvitationInput,
) => {
  // Token lookup precedes the tenant lock; read and validate it again inside
  // the transaction so simultaneous accept/resend/revoke has one winner.
  const initial = await findValidInvitation(input.token);
  return runTenantAccessTransaction(async (session) => {
    const tenantId = String(initial.tenant);
    const tenant = await acquireTenantAccessWriteLock(tenantId, session);
    const invitation = await findValidInvitation(input.token, session);
    const actor = await invitationActor({
      tenantId,
      actorUserId: String(invitation.invitedBy),
      permission: WORKSPACE_PERMISSION.TEAM_MANAGE,
      session,
    });
    await validateGrant({
      tenantId,
      actor,
      input: {
        roleKey: invitation.roleKey as WorkspaceRole,
        customRoleId: invitation.customRoleId
          ? String(invitation.customRoleId)
          : null,
        locationAccess: locationAccessOf(invitation),
      },
      session,
    });
    let user = await UserModel.findOne({
      tenant: invitation.tenant,
      email: invitation.email,
    })
      .select("+password +platformRole +tenantRole")
      .session(session);
    if (user) {
      assertAccountUsable(user);
      if (!user.password)
        conflict({
          code: "TEAM_INVITATION_PASSWORD_RESET_REQUIRED",
          message:
            "Set an account password using the existing password recovery flow first.",
        });
      if (!(await bcrypt.compare(input.password, user.password)))
        unauthorized({
          code: "TEAM_INVITATION_CREDENTIALS_INVALID",
          message: "The current account password is incorrect.",
        });
    } else {
      if (invitation.mode !== "join") invalidInvitation();
      const account = parseTenantAccessInput(newInvitationAccountSchema, input);
      [user] = await UserModel.create(
        [
          {
            tenant: invitation.tenant,
            email: invitation.email,
            firstname: account.firstname,
            lastname: account.lastname,
            password: account.password,
            customId: `U-${randomUUID()}`,
            isEmailVerified: true,
            isAccessGranted: true,
            tenantRole: "customer",
            platformRole: "none",
          },
        ],
        { session },
      );
    }
    let membershipId: string;
    if (invitation.mode === "sign_in") {
      const result = await assertSignInMembership(invitation, session);
      // Current scope may have narrowed since the email was sent. Never restore
      // the invitation snapshot or reactivate a suspended/revoked membership.
      assertActorCanGrantLocationAccess(actor, {
        mode: result.membership.locationAccess.mode,
        locationIds: result.membership.locationAccess.locationIds.map(String),
      });
      membershipId = String(result.membership._id);
    } else {
      const existing = await tenantAccessRepository.findMembershipByUser(
        tenantId,
        user._id,
        { session },
      );
      if (existing || user.tenantRole !== "customer")
        conflict({
          code: "TENANT_MEMBERSHIP_EXISTS",
          message:
            "This account's team access changed. Ask the workspace owner for a new sign-in link.",
        });
      const membership = await addExistingTenantUserToTeam({
        tenantId,
        actorUserId: String(invitation.invitedBy),
        actorAccess: actor,
        session,
        input: {
          email: invitation.email,
          roleKey: invitation.roleKey as WorkspaceRole,
          customRoleId: invitation.customRoleId
            ? String(invitation.customRoleId)
            : null,
          locationAccess: locationAccessOf(invitation),
          workspaceProfile: invitation.workspaceProfile ?? undefined,
        },
      });
      membershipId = membership.membershipId;
    }
    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    invitation.acceptedBy = user._id;
    await invitation.save({ session });
    return {
      accepted: true as const,
      tenantSlug: tenant.slug,
      email: invitation.email,
      membershipId,
    };
  });
};
