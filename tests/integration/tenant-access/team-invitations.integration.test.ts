import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import Location from "@/modules/location/location.model.js";
import Membership from "@/modules/tenant-access/tenant-membership.model.js";
import CustomRole from "@/modules/tenant-access/tenant-custom-role.model.js";
import Invitation from "@/modules/tenant-access/team-invitation.model.js";
import { createTeamInvitationSchema } from "@/modules/tenant-access/team-invitation.validators.js";
import {
  acceptTeamInvitation,
  createTeamInvitation,
  createTeamSignInInvitation,
  listTeamInvitations,
  previewTeamInvitation,
  resendTeamInvitation,
  revokeTeamInvitation,
} from "@/modules/tenant-access/services/team-invitation.service.js";
import { loginUser } from "@/modules/auth/services/auth.service.js";
import {
  acceptPublicTeamInvitation,
  previewPublicTeamInvitation,
} from "@/modules/tenant-access/controllers/team-invitation.controller.js";

const delivery = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock(
  "@/infrastructure/email/managed-email.service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/infrastructure/email/managed-email.service.js")
    >()),
    sendSystemPostmarkEmail: delivery.send,
  }),
);
vi.mock("@/infrastructure/redis/cache.js", () => ({
  deleteCache: vi.fn().mockResolvedValue(undefined),
  deleteCacheKeys: vi.fn().mockResolvedValue(undefined),
}));

const CURRENT_PASSWORD = "Current-password!123";
const NEW_PASSWORD = "Invited-password!456";
const EMAIL = "teammate@example.test";
let replica: MongoMemoryReplSet;
let passwordHash: string;
let userSequence = 0;

const seedUser = async (tenantId: string, email: string, role = "customer") => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    tenant: new mongoose.Types.ObjectId(tenantId),
    customId: `INVITATION-TEST-${_id}`,
    email,
    firstname: "Existing",
    lastname: "Person",
    password: passwordHash,
    tenantRole: role,
    platformRole: "none",
    isAccessGranted: true,
    isEmailVerified: true,
    memberNumber: ++userSequence,
    memberNumberHistory: [],
    refreshToken: [],
    sessionVersion: 0,
    credits: 75,
  } as any);
  return String(_id);
};

const seedWorkspace = async (slug = "invitations-alpha") => {
  const tenant = await Tenant.create({
    name: "Invitations studio",
    slug,
    status: "active",
    plan: "studio_plus",
    planVersion: 3,
    limits: { staffMembers: 10, admins: 10 },
  });
  const tenantId = String(tenant._id);
  const actorUserId = await seedUser(tenantId, `owner@${slug}.test`, "owner");
  const ownerMembership = await Membership.create({
    tenant: tenantId,
    user: actorUserId,
    role: "owner",
    status: "active",
    createdBy: actorUserId,
    updatedBy: actorUserId,
  });
  return { tenant, tenantId, actorUserId, ownerMembership };
};
type Workspace = Awaited<ReturnType<typeof seedWorkspace>>;

const latestToken = () => {
  const message = delivery.send.mock.calls.at(-1)?.[0];
  expect(message?.to).toBeTruthy();
  const links = String(message?.text ?? "").match(/https?:\/\/[^\s<>]+/g) ?? [];
  const link = links
    .map((value) => new URL(value))
    .find((value) => value.searchParams.has("token"));
  expect(
    link,
    "The delivered email must contain the actual invitation link",
  ).toBeDefined();
  const token = link!.searchParams.get("token")!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return token;
};

const invite = async (
  context: Workspace,
  email = EMAIL,
  fields: Record<string, unknown> = {},
) => {
  const result = await createTeamInvitation({
    tenantId: context.tenantId,
    actorUserId: context.actorUserId,
    input: createTeamInvitationSchema.parse({
      email,
      roleKey: "staff",
      locationAccess: { mode: "all", locationIds: [] },
      locale: "en",
      ...fields,
    }),
  });
  const saved = await Invitation.findOne({
    tenant: context.tenantId,
    email,
    status: "pending",
  })
    .select("+tokenHash")
    .lean();
  expect(saved).not.toBeNull();
  return {
    result,
    saved: saved!,
    invitationId: String(saved!._id),
    token: latestToken(),
  };
};

const acceptNew = (token: string) =>
  acceptTeamInvitation({
    token,
    password: NEW_PASSWORD,
    firstname: "Invited",
    lastname: "Teammate",
  });

const allowResend = (invitationId: string) =>
  Invitation.updateOne(
    { _id: invitationId },
    { $set: { lastAttemptAt: new Date(Date.now() - 120_000) } },
  );

const publicApi = () => {
  const app = express();
  app.use(express.json());
  app.post("/preview", previewPublicTeamInvitation);
  app.post("/accept", acceptPublicTeamInvitation);
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(error.statusCode ?? 500)
        .json({ code: error.code, message: error.message });
    },
  );
  return app;
};

describe("team invitations with real tenant transactions", () => {
  beforeAll(async () => {
    vi.stubEnv("PUBLIC_APP_URL", "http://shario.localhost:3000");
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri("team-invitations-test"));
    await Promise.all(
      [Tenant, User, Location, Membership, CustomRole, Invitation].map(
        (model) => model.init(),
      ),
    );
    passwordHash = await bcrypt.hash(CURRENT_PASSWORD, 10);
  }, 60_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(
      collections.map((collection) => collection.deleteMany({})),
    );
    userSequence = 0;
    delivery.send
      .mockReset()
      .mockResolvedValue({
        provider: "postmark",
        providerMessageId: "isolated-invitation",
        status: "sent",
      });
  });

  it("keeps pending access inert and stores only a hash of the emailed token", async () => {
    const context = await seedWorkspace();
    const created = await invite(context);
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
    expect(await Membership.countDocuments({ tenant: context.tenantId })).toBe(
      1,
    );
    expect(created.saved.tokenHash).toBe(
      createHash("sha256").update(created.token).digest("hex"),
    );
    expect(
      created.saved.expiresAt.getTime() - created.saved.createdAt.getTime(),
    ).toBeGreaterThan(7 * 24 * 60 * 60 * 1_000 - 5_000);
    expect(
      created.saved.expiresAt.getTime() - created.saved.createdAt.getTime(),
    ).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1_000);
    expect(JSON.stringify(created.saved)).not.toContain(created.token);
    expect(JSON.stringify(created.result)).not.toContain(created.token);
    expect(JSON.stringify(await listTeamInvitations(context))).not.toContain(
      created.saved.tokenHash,
    );
    expect(delivery.send.mock.calls[0][0].text).toContain(
      "http://shario.localhost:3000/en/team-invitation?token=",
    );
    await previewTeamInvitation({ token: created.token });
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
    expect(
      await Invitation.countDocuments({
        _id: created.invitationId,
        status: "pending",
      }),
    ).toBe(1);
  });

  it("accepts once, creates a scoped account, and supports a real workspace password login", async () => {
    const context = await seedWorkspace();
    const { token, invitationId } = await invite(context);
    await acceptNew(token);
    const user = await User.findOne({ tenant: context.tenantId, email: EMAIL })
      .select("+password +tenantRole")
      .lean();
    expect(user).toMatchObject({
      firstname: "Invited",
      lastname: "Teammate",
      tenantRole: "staff",
      isEmailVerified: true,
    });
    expect(user!.password).not.toBe(NEW_PASSWORD);
    expect(await bcrypt.compare(NEW_PASSWORD, user!.password!)).toBe(true);
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        user: user!._id,
        role: "staff",
        status: "active",
      }),
    ).toBe(1);
    expect(
      await Invitation.countDocuments({
        _id: invitationId,
        status: "accepted",
      }),
    ).toBe(1);
    const login = await loginUser({
      input: { email: EMAIL, password: NEW_PASSWORD },
      tenant: context.tenant,
    });
    expect(login.authContext).toBe("workspace");
    expect(login.workspaceAccess).toMatchObject({
      tenantId: context.tenantId,
      role: "staff",
      status: "active",
    });
    await expect(acceptNew(token)).rejects.toThrow();
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        user: user!._id,
      }),
    ).toBe(1);
  });

  it("requires the existing account password and preserves that identity and balance", async () => {
    const context = await seedWorkspace();
    const userId = await seedUser(context.tenantId, EMAIL);
    const { token } = await invite(context);
    await expect(
      acceptTeamInvitation({
        token,
        password: NEW_PASSWORD,
        firstname: "Overwrite",
        lastname: "Attempt",
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        user: userId,
      }),
    ).toBe(0);
    await acceptTeamInvitation({
      token,
      password: CURRENT_PASSWORD,
      firstname: "Overwrite",
      lastname: "Attempt",
    });
    const after = await User.findById(userId).select("+password").lean();
    expect(after).toMatchObject({
      firstname: "Existing",
      lastname: "Person",
      password: passwordHash,
      credits: 75,
    });
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(1);
    const login = await loginUser({
      input: { email: EMAIL, password: CURRENT_PASSWORD },
      tenant: context.tenant,
    });
    expect(login.authContext).toBe("workspace");
  });

  it("never adopts or changes another tenant's same-email identity", async () => {
    const alpha = await seedWorkspace();
    const beta = await seedWorkspace("invitations-beta");
    const betaUserId = await seedUser(beta.tenantId, EMAIL);
    const before = await User.findById(betaUserId)
      .select("+password +tenantRole")
      .lean();
    const { token } = await invite(alpha);
    await acceptNew(token);
    const after = await User.findById(betaUserId)
      .select("+password +tenantRole")
      .lean();
    expect(after).toEqual(before);
    expect(
      await Membership.countDocuments({
        tenant: beta.tenantId,
        user: betaUserId,
      }),
    ).toBe(0);
    expect(await User.countDocuments({ email: EMAIL })).toBe(2);
  });

  it("invalidates the previous link on resend and the newest link on revocation", async () => {
    const context = await seedWorkspace();
    const created = await invite(context);
    await allowResend(created.invitationId);
    await resendTeamInvitation({
      ...context,
      invitationId: created.invitationId,
    });
    const replacement = latestToken();
    expect(replacement).not.toBe(created.token);
    await expect(acceptNew(created.token)).rejects.toThrow();
    await revokeTeamInvitation({
      ...context,
      invitationId: created.invitationId,
    });
    await expect(acceptNew(replacement)).rejects.toThrow();
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
    expect(
      await Invitation.countDocuments({
        _id: created.invitationId,
        status: "revoked",
      }),
    ).toBe(1);
  });

  it("rejects expired and fabricated tokens without creating account access", async () => {
    const context = await seedWorkspace();
    const { token, invitationId } = await invite(context);
    await Invitation.updateOne(
      { _id: invitationId },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
    await expect(previewTeamInvitation({ token })).rejects.toThrow();
    await expect(acceptNew(token)).rejects.toThrow();
    await expect(acceptNew("a".repeat(43))).rejects.toThrow();
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
  });

  it("serializes simultaneous token consumption into one account and membership", async () => {
    const context = await seedWorkspace();
    const { token } = await invite(context);
    const results = await Promise.allSettled([
      acceptNew(token),
      acceptNew(token),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(1);
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        role: "staff",
        status: "active",
      }),
    ).toBe(1);
  });

  it("keeps old pending and expired invitations visible when newer history fills the list", async () => {
    const context = await seedWorkspace();
    const pending = await invite(context);
    const expired = await invite(context, "expired@example.test");
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await Invitation.collection.updateMany(
      { _id: { $in: [pending.saved._id, expired.saved._id] } },
      { $set: { createdAt: oldDate } },
    );
    await Invitation.updateOne(
      { _id: expired.saved._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    // Historical records represent previous completed/revoked invitations;
    // seeding them must not send any additional email or create memberships.
    await Invitation.collection.insertMany(
      Array.from({ length: 200 }, (_, index) => ({
        ...pending.saved,
        _id: new mongoose.Types.ObjectId(),
        email: `history-${index}@example.test`,
        tokenHash: createHash("sha256")
          .update(`history-${index}`)
          .digest("hex"),
        status: index % 2 ? "accepted" : "revoked",
        createdAt: new Date(),
      })),
    );

    const listed = await listTeamInvitations(context);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pending.invitationId,
          status: "pending",
        }),
        expect.objectContaining({
          id: expired.invitationId,
          status: "expired",
        }),
      ]),
    );
    expect(delivery.send).toHaveBeenCalledTimes(2);
  });

  it("does not let another tenant's owner list, resend, revoke or create invitations", async () => {
    const alpha = await seedWorkspace();
    const beta = await seedWorkspace("invitations-beta");
    const { invitationId, token } = await invite(alpha);
    const impostor = {
      tenantId: alpha.tenantId,
      actorUserId: beta.actorUserId,
    };
    await expect(listTeamInvitations(impostor)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      resendTeamInvitation({ ...impostor, invitationId }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      revokeTeamInvitation({ ...impostor, invitationId }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createTeamInvitation({
        ...impostor,
        input: createTeamInvitationSchema.parse({
          email: "foreign@example.test",
          roleKey: "staff",
        }),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await previewTeamInvitation({ token });
    expect(delivery.send).toHaveBeenCalledTimes(1);
  });

  it("rechecks the inviter's current authority before acceptance", async () => {
    const context = await seedWorkspace();
    const { token } = await invite(context);
    await Membership.updateOne(
      { _id: context.ownerMembership._id },
      { $set: { status: "suspended" } },
    );
    await expect(acceptNew(token)).rejects.toThrow();
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
  });

  it.each(["blocked", "deleted"])(
    "rejects a %s inviter even while their membership remains active",
    async (state) => {
      const context = await seedWorkspace();
      const { token } = await invite(context);
      if (state === "blocked") {
        await User.updateOne(
          { _id: context.actorUserId },
          { $set: { isAccessGranted: false } },
        );
      } else {
        await User.deleteOne({ _id: context.actorUserId });
      }
      await expect(acceptNew(token)).rejects.toMatchObject({
        statusCode: 403,
        code: "WORKSPACE_PERMISSION_CHANGED",
      });
      expect(
        await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
      ).toBe(0);
      expect(
        await Membership.countDocuments({ tenant: context.tenantId }),
      ).toBe(1);
    },
  );

  it("does not grant an owner role from an administrator invitation", async () => {
    const context = await seedWorkspace();
    await Membership.updateOne(
      { _id: context.ownerMembership._id },
      { $set: { role: "admin" } },
    );
    await expect(
      invite(context, EMAIL, { roleKey: "owner" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await Invitation.countDocuments({ tenant: context.tenantId })).toBe(
      0,
    );
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it("cannot grant or accept location scope outside the inviter's current assignment", async () => {
    const context = await seedWorkspace();
    const location = await Location.create({
      tenant: context.tenantId,
      name: "Assigned studio",
    });
    await Membership.updateOne(
      { _id: context.ownerMembership._id },
      {
        $set: {
          role: "admin",
          locationAccess: { mode: "selected", locationIds: [location._id] },
        },
      },
    );
    await expect(invite(context)).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKSPACE_LOCATION_SCOPE_ESCALATION",
    });
    const { token } = await invite(context, EMAIL, {
      locationAccess: { mode: "selected", locationIds: [String(location._id)] },
    });
    await Membership.updateOne(
      { _id: context.ownerMembership._id },
      { $set: { "locationAccess.locationIds": [] } },
    );
    await expect(acceptNew(token)).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKSPACE_LOCATION_SCOPE_ESCALATION",
    });
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
  });

  it("rejects a custom role deactivated after the invitation was sent", async () => {
    const context = await seedWorkspace();
    const role = await CustomRole.create({
      tenant: context.tenantId,
      name: "Calendar reader",
      permissions: [],
      createdBy: context.actorUserId,
      updatedBy: context.actorUserId,
    });
    const { token } = await invite(context, EMAIL, {
      roleKey: "custom",
      customRoleId: String(role._id),
    });
    await CustomRole.updateOne(
      { _id: role._id },
      { $set: { isActive: false } },
    );
    await expect(acceptNew(token)).rejects.toMatchObject({
      code: "CUSTOM_ROLE_INACTIVE",
    });
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
  });

  it("enforces the last team seat when two different recipients accept concurrently", async () => {
    const context = await seedWorkspace();
    await Tenant.updateOne(
      { _id: context.tenantId },
      {
        $set: { "limits.staffMembers": 2, "limits.admins": 2, planVersion: 3 },
      },
    );
    const first = await invite(context, "first@example.test");
    const second = await invite(context, "second@example.test");
    const outcomes = await Promise.allSettled([
      acceptNew(first.token),
      acceptNew(second.token),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "TEAM_ACCOUNT_LIMIT_REACHED" },
    });
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        status: "active",
      }),
    ).toBe(2);
    // The losing transaction must also roll back the newly-created user.
    expect(
      await User.countDocuments({
        tenant: context.tenantId,
        email: { $in: ["first@example.test", "second@example.test"] },
      }),
    ).toBe(1);
  });

  it("returns a retryable failed delivery without granting access or exposing a token", async () => {
    const context = await seedWorkspace();
    delivery.send.mockRejectedValueOnce(
      new Error("Isolated provider unavailable"),
    );
    const failed = await invite(context);
    expect(failed.result).toMatchObject({
      status: "pending",
      deliveryStatus: "failed",
    });
    expect(JSON.stringify(failed.result)).not.toContain(failed.token);
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
    await expect(
      resendTeamInvitation({ ...context, invitationId: failed.invitationId }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: "TEAM_INVITATION_RESEND_TOO_SOON",
    });
    await allowResend(failed.invitationId);
    const retried = await resendTeamInvitation({
      ...context,
      invitationId: failed.invitationId,
    });
    expect(retried).toMatchObject({
      status: "pending",
      deliveryStatus: "sent",
    });
    await expect(acceptNew(failed.token)).rejects.toMatchObject({
      code: "TEAM_INVITATION_INVALID",
    });
    await acceptNew(latestToken());
  });

  it("does not issue duplicate pending invitations under simultaneous requests", async () => {
    const context = await seedWorkspace();
    const input = createTeamInvitationSchema.parse({
      email: EMAIL,
      roleKey: "staff",
      locale: "en",
    });
    const outcomes = await Promise.allSettled([
      createTeamInvitation({ ...context, input }),
      createTeamInvitation({ ...context, input }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected"),
    ).toMatchObject({ reason: { code: "TEAM_INVITATION_EXISTS" } });
    expect(
      await Invitation.countDocuments({
        tenant: context.tenantId,
        email: EMAIL,
        status: "pending",
      }),
    ).toBe(1);
    expect(delivery.send).toHaveBeenCalledTimes(1);
  });

  it("serializes acceptance racing with revocation into a consistent final outcome", async () => {
    const context = await seedWorkspace();
    const { token, invitationId } = await invite(context);
    const outcomes = await Promise.allSettled([
      acceptNew(token),
      revokeTeamInvitation({ ...context, invitationId }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const invitation = await Invitation.findById(invitationId).lean();
    expect(["accepted", "revoked"]).toContain(invitation!.status);
    const accepted = invitation!.status === "accepted";
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(Number(accepted));
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        role: "staff",
      }),
    ).toBe(Number(accepted));
    await expect(acceptNew(token)).rejects.toMatchObject({
      code: "TEAM_INVITATION_INVALID",
    });
  });

  it("cannot revive a suspended member through an earlier sign-in link", async () => {
    const context = await seedWorkspace();
    const userId = await seedUser(context.tenantId, EMAIL, "staff");
    const membership = await Membership.create({
      tenant: context.tenantId,
      user: userId,
      role: "staff",
      status: "active",
      createdBy: context.actorUserId,
      updatedBy: context.actorUserId,
    });
    await createTeamSignInInvitation({
      ...context,
      membershipId: String(membership._id),
      locale: "en",
    });
    const token = latestToken();
    await Membership.updateOne(
      { _id: membership._id },
      { $set: { status: "suspended" } },
    );
    await expect(
      acceptTeamInvitation({ token, password: CURRENT_PASSWORD }),
    ).rejects.toMatchObject({ code: "TEAM_INVITATION_MEMBERSHIP_CHANGED" });
    expect((await Membership.findById(membership._id).lean())!.status).toBe(
      "suspended",
    );
    expect(
      (await User.findById(userId).select("+password").lean())!.password,
    ).toBe(passwordHash);
  });

  it("requires normal password recovery for an existing passwordless account", async () => {
    const context = await seedWorkspace();
    const userId = await seedUser(context.tenantId, EMAIL);
    await User.updateOne({ _id: userId }, { $unset: { password: 1 } });
    const { token } = await invite(context);
    expect(await previewTeamInvitation({ token })).toMatchObject({
      accountExists: true,
      requiresPasswordReset: true,
    });
    await expect(acceptNew(token)).rejects.toMatchObject({
      statusCode: 409,
      code: "TEAM_INVITATION_PASSWORD_RESET_REQUIRED",
    });
    expect(
      (await User.findById(userId).select("+password").lean())!.password,
    ).toBeUndefined();
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        user: userId,
      }),
    ).toBe(0);
  });

  it("keeps preview inert over HTTP and rejects caller-supplied tenant or role authority", async () => {
    const context = await seedWorkspace();
    const { token } = await invite(context);
    const app = publicApi();
    const preview = await request(app)
      .post("/preview")
      .send({ token })
      .expect(200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.headers["referrer-policy"]).toBe("no-referrer");
    expect(preview.body.invitation).toMatchObject({
      tenantSlug: context.tenant.slug,
      email: EMAIL,
      accountExists: false,
      roleKey: "staff",
    });
    expect(JSON.stringify(preview.body)).not.toContain(token);
    await request(app)
      .post("/accept")
      .send({
        token,
        password: NEW_PASSWORD,
        firstname: "Invited",
        lastname: "Teammate",
        tenantId: new mongoose.Types.ObjectId().toString(),
        roleKey: "owner",
      })
      .expect(400);
    expect(
      await User.countDocuments({ tenant: context.tenantId, email: EMAIL }),
    ).toBe(0);
    const accepted = await request(app)
      .post("/accept")
      .send({
        token,
        password: NEW_PASSWORD,
        firstname: "Invited",
        lastname: "Teammate",
      })
      .expect(200);
    expect(accepted.body).toMatchObject({
      accepted: true,
      tenantSlug: context.tenant.slug,
      email: EMAIL,
    });
    expect(accepted.headers["set-cookie"]).toBeUndefined();
    expect(accepted.body.accessToken).toBeUndefined();
    expect(accepted.body.refreshToken).toBeUndefined();
  });

  it("rejects foreign locations and custom roles before sending email", async () => {
    const alpha = await seedWorkspace();
    const beta = await seedWorkspace("invitations-beta");
    const location = await Location.create({
      tenant: beta.tenantId,
      name: "Other studio",
    });
    const role = await CustomRole.create({
      tenant: beta.tenantId,
      name: "Other role",
      permissions: [],
      createdBy: beta.actorUserId,
      updatedBy: beta.actorUserId,
    });
    await expect(
      invite(alpha, EMAIL, {
        locationAccess: {
          mode: "selected",
          locationIds: [String(location._id)],
        },
      }),
    ).rejects.toThrow();
    await expect(
      invite(alpha, EMAIL, {
        roleKey: "custom",
        customRoleId: String(role._id),
      }),
    ).rejects.toThrow();
    expect(await Invitation.countDocuments({ tenant: alpha.tenantId })).toBe(0);
    expect(delivery.send).not.toHaveBeenCalled();
  });

  it("leaves existing blocked accounts blocked", async () => {
    const context = await seedWorkspace();
    const userId = await seedUser(context.tenantId, EMAIL);
    const { token } = await invite(context);
    await User.updateOne({ _id: userId }, { $set: { isAccessGranted: false } });
    await expect(
      acceptTeamInvitation({ token, password: CURRENT_PASSWORD }),
    ).rejects.toThrow();
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        user: userId,
      }),
    ).toBe(0);
    expect((await User.findById(userId).lean())!.isAccessGranted).toBe(false);
  });

  it("sends an active member sign-in instructions without resetting their password or role", async () => {
    const context = await seedWorkspace();
    const userId = await seedUser(context.tenantId, EMAIL, "staff");
    const membership = await Membership.create({
      tenant: context.tenantId,
      user: userId,
      role: "viewer",
      status: "active",
      createdBy: context.actorUserId,
      updatedBy: context.actorUserId,
    });
    await createTeamSignInInvitation({
      ...context,
      membershipId: String(membership._id),
      locale: "en",
    });
    const token = latestToken();
    const before = await Membership.findById(membership._id).lean();
    await expect(
      acceptTeamInvitation({ token, password: NEW_PASSWORD }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await acceptTeamInvitation({ token, password: CURRENT_PASSWORD });
    expect(await Membership.findById(membership._id).lean()).toEqual(before);
    expect(
      (await User.findById(userId).select("+password").lean())!.password,
    ).toBe(passwordHash);
    await expect(
      acceptTeamInvitation({ token, password: CURRENT_PASSWORD }),
    ).rejects.toThrow();
  });
});
