import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({ sendEmail: vi.fn(), findTenant: vi.fn() }));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendEmail,
}));
vi.mock("@/modules/tenants/tenant.repository.js", async (original) => ({
  ...(await original<
    typeof import("@/modules/tenants/tenant.repository.js")
  >()),
  findTenantById: mocks.findTenant,
}));

import User from "@/modules/user/user.model.js";
import { updateUser } from "@/modules/user/services/user.write.service.js";
import { VerificationToken } from "@/modules/verification/user-verification.model.js";
import { verificationRepository } from "@/modules/verification/user-verification.repository.js";
import { verificationService } from "@/modules/verification/services/user-verification.service.js";
import { hashVerificationToken } from "@/modules/verification/user-verification.utils.js";
import { PasswordReset } from "@/modules/password_reset/password-reset.model.js";
import { createPasswordResetService } from "@/modules/password_reset/services/password-reset.service.js";
import { passwordResetRepository } from "@/modules/password_reset/password-reset.repository.js";
import { hashPasswordResetToken } from "@/modules/password_reset/password-reset.utils.js";
import {
  buildAccessToken,
  buildRefreshToken,
} from "@/modules/auth/auth.utils.js";
import { AUTH_CONTEXT } from "@/modules/auth/auth.constants.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { refreshCustomerAccessToken } from "@/modules/auth/services/auth.service.js";
import { resolveCustomerIdentity } from "@/modules/auth/social/customer-social.service.js";

const tenantId = "64b000000000000000000001";
const tenant = {
  _id: new mongoose.Types.ObjectId(tenantId),
  slug: "email-security",
  name: "Email Security",
  domains: [],
  settings: { defaultLanguage: "en" },
};
const oldEmail = "original@example.test";
const newEmail = "replacement@example.test";
let replica: MongoMemoryReplSet;
const insert = async (overrides: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    tenant: tenant._id,
    firstname: "Test",
    lastname: "Customer",
    email: oldEmail,
    customId: `test-${_id}`,
    memberNumber: 1,
    tenantRole: "customer",
    platformRole: "none",
    isAccessGranted: true,
    isEmailVerified: true,
    sessionVersion: 0,
    refreshToken: ["old-refresh"],
    passwordResetOtpHash: "old-otp",
    passwordResetOtpExpiresAt: new Date(Date.now() + 60000),
    emailToken: "legacy-link",
    ...overrides,
  });
  return String(_id);
};
const stored = (id: string) =>
  User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
const emailToken = (mail = mocks.sendEmail.mock.calls.at(-1)![0]) =>
  new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token")!;
const send = (id: string, email = oldEmail) =>
  verificationService.sendVerificationEmail({ tenant, userId: id, email });
const change = (id: string, email = newEmail) =>
  updateUser({ tenantId, input: { id, email } });
const verify = (token: string) =>
  verificationService.verifyEmail({ tenantId, token });

describe("customer email changes invalidate identity proofs atomically", () => {
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all([
      User.init(),
      VerificationToken.init(),
      PasswordReset.init(),
    ]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await replica.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.connection.collections).map((collection) =>
        collection.deleteMany({}),
      ),
    );
    mocks.sendEmail.mockReset().mockResolvedValue({});
    mocks.findTenant.mockReset().mockResolvedValue(tenant);
  });

  it("changes the address, ends old sessions, sends to the replacement, and verifies only its new link", async () => {
    const id = await insert();
    const user = await User.findById(id).select("+sessionVersion");
    const access = buildAccessToken(
      user!,
      tenant as never,
      null,
      AUTH_CONTEXT.CUSTOMER,
    );
    const refresh = buildRefreshToken(
      user!,
      tenant as never,
      AUTH_CONTEXT.CUSTOMER,
    );
    await User.updateOne({ _id: id }, { $set: { refreshToken: [refresh] } });
    const next = vi.fn();
    await verifyJWT(
      { headers: { authorization: `Bearer ${access}` } } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(await change(id)).toMatchObject({
      emailChanged: true,
      verificationEmailStatus: "sent",
    });
    expect(await stored(id)).toMatchObject({
      email: newEmail,
      isEmailVerified: false,
      sessionVersion: 1,
      refreshToken: [],
    });
    expect((await stored(id))?.passwordResetOtpHash).toBeUndefined();
    expect((await stored(id))?.emailToken).toBeUndefined();
    await expect(
      verifyJWT(
        { headers: { authorization: `Bearer ${access}` } } as never,
        {} as never,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(refreshCustomerAccessToken(refresh)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({
      tenantId,
      to: newEmail,
    });
    await expect(verify(emailToken())).resolves.toMatchObject({
      verified: true,
      userId: id,
    });
    expect((await stored(id))?.isEmailVerified).toBe(true);
    await expect(verify(emailToken())).rejects.toMatchObject({
      code: "INVALID_EMAIL_VERIFICATION",
    });
  });

  it("does not revoke sessions or send mail for a case-only address or non-email edit", async () => {
    const id = await insert({ sessionVersion: 4 });
    await expect(change(id, "ORIGINAL@example.test")).resolves.toMatchObject({
      emailChanged: false,
      verificationEmailStatus: "not_required",
    });
    await updateUser({ tenantId, input: { id, firstname: "Renamed" } });
    expect(await stored(id)).toMatchObject({
      isEmailVerified: true,
      sessionVersion: 4,
      refreshToken: ["old-refresh"],
      firstname: "Renamed",
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("can edit a guest without a login email and verify its first assigned address", async () => {
    const id = await insert({
      isEmailVerified: false,
      guestContact: { email: "guest-contact@example.test", locale: "en" },
    });
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $unset: { email: 1 } },
    );
    await expect(
      updateUser({
        tenantId,
        input: { id, firstname: "Guest renamed", phone: "+420123456789" },
      }),
    ).resolves.toMatchObject({
      emailChanged: false,
      verificationEmailStatus: "not_required",
    });
    expect(await stored(id)).toMatchObject({
      firstname: "Guest renamed",
      phone: "+420123456789",
      sessionVersion: 0,
    });
    expect((await stored(id))?.email).toBeUndefined();
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    await expect(change(id)).resolves.toMatchObject({
      emailChanged: true,
      verificationEmailStatus: "sent",
    });
    expect(await stored(id)).toMatchObject({
      email: newEmail,
      isEmailVerified: false,
      sessionVersion: 1,
      refreshToken: [],
    });
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({ to: newEmail });
    await expect(verify(emailToken())).resolves.toMatchObject({
      verified: true,
      userId: id,
    });
  });

  it("invalidates old email links and password-reset tokens while preserving fresh resend recovery", async () => {
    const id = await insert({ isEmailVerified: false });
    await send(id);
    const oldToken = emailToken();
    const resetToken = "a".repeat(64);
    await PasswordReset.create({
      tenant: tenantId,
      user: id,
      email: oldEmail,
      sessionVersion: 0,
      otpHash: "hash",
      status: "verified",
      resetTokenHash: hashPasswordResetToken(resetToken),
      expiresAt: new Date(Date.now() + 60000),
      resetTokenExpiresAt: new Date(Date.now() + 60000),
    });
    await change(id);
    await expect(verify(oldToken)).rejects.toMatchObject({
      code: "INVALID_EMAIL_VERIFICATION",
    });
    await expect(
      createPasswordResetService({ sendOtpEmail: vi.fn() }).resetPassword({
        tenantId,
        resetToken,
        password: "NewPassword123",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PASSWORD_RESET" });
    await verificationService.requestVerificationEmail({
      tenant,
      email: newEmail,
    });
    await expect(verify(emailToken())).resolves.toMatchObject({
      verified: true,
    });
  });

  it("keeps the new identity unverified and sessions revoked when delivery fails, then supports resend", async () => {
    const id = await insert();
    mocks.sendEmail.mockRejectedValueOnce(
      new Error("synthetic delivery failure"),
    );
    await expect(change(id)).resolves.toMatchObject({
      emailChanged: true,
      verificationEmailStatus: "retry_required",
    });
    expect(await stored(id)).toMatchObject({
      email: newEmail,
      isEmailVerified: false,
      sessionVersion: 1,
      refreshToken: [],
    });
    await verificationService.requestVerificationEmail({
      tenant,
      email: newEmail,
    });
    await expect(verify(emailToken())).resolves.toMatchObject({
      verified: true,
    });
  });

  it.each([
    { label: "absent identity fields", identity: {} },
    {
      label: "null identity fields",
      identity: { email: null, sessionVersion: null },
    },
  ])(
    "resends over a legacy pending token with $label",
    async ({ identity }) => {
      const id = await insert({ isEmailVerified: false });
      const legacyToken = "a".repeat(64);
      const legacy = await VerificationToken.collection.insertOne({
        tenant: tenant._id,
        user: new mongoose.Types.ObjectId(id),
        purpose: "email_verification",
        status: "pending",
        hashedToken: await hashVerificationToken(legacyToken),
        expiresAt: new Date(Date.now() + 60000),
        ...identity,
      });
      await expect(verify(legacyToken)).rejects.toMatchObject({
        code: "INVALID_EMAIL_VERIFICATION",
      });
      await expect(send(id)).resolves.toMatchObject({ sent: true });
      expect(
        await VerificationToken.collection.findOne({ _id: legacy.insertedId }),
      ).toMatchObject({ status: "expired" });
      await expect(verify(emailToken())).resolves.toMatchObject({
        verified: true,
        userId: id,
      });
    },
  );

  it("replaces an older pending slot inserted after email-change cleanup and before the replacement send", async () => {
    const id = await insert({ isEmailVerified: false });
    // Suppress the automatic post-commit send so this exact ordering can be
    // exercised, then use the same issuance service as resend does.
    mocks.findTenant.mockResolvedValue(null);
    const create = verificationRepository.createEmailToken.bind(
      verificationRepository,
    );
    let resume!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let delayed = false;
    vi.spyOn(verificationRepository, "createEmailToken").mockImplementation(
      async (input) => {
        if (!delayed) {
          delayed = true;
          started();
          await gate;
        }
        return create(input);
      },
    );
    const oldRequest = send(id);
    await ready;
    try {
      await change(id);
    } finally {
      resume();
    }
    await expect(oldRequest).resolves.toMatchObject({ sent: true });
    const oldToken = emailToken();
    const older = await VerificationToken.findOne({
      user: id,
      status: "pending",
    }).lean();
    expect(older).toMatchObject({ email: oldEmail, sessionVersion: 0 });
    await expect(send(id, newEmail)).resolves.toMatchObject({ sent: true });
    expect(await VerificationToken.findById(older!._id).lean()).toMatchObject({
      status: "expired",
    });
    await expect(verify(oldToken)).rejects.toMatchObject({
      code: "INVALID_EMAIL_VERIFICATION",
    });
    await expect(verify(emailToken())).resolves.toMatchObject({
      verified: true,
      userId: id,
    });
  });

  it("rejects an old-address verification request that finishes after two email changes", async () => {
    const id = await insert({ isEmailVerified: false });
    mocks.findTenant.mockResolvedValue(null);
    const create = verificationRepository.createEmailToken.bind(
      verificationRepository,
    );
    let continueIssuing!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      continueIssuing = resolve;
    });
    vi.spyOn(verificationRepository, "createEmailToken").mockImplementation(
      async (input) => {
        started();
        await gate;
        return create(input);
      },
    );
    const issuance = send(id);
    await ready;
    await change(id);
    await change(id, oldEmail);
    continueIssuing();
    await issuance;
    await expect(verify(emailToken())).rejects.toMatchObject({
      code: "INVALID_EMAIL_VERIFICATION",
    });
    expect(await stored(id)).toMatchObject({
      email: oldEmail,
      isEmailVerified: false,
      sessionVersion: 2,
    });
  });

  it("cannot verify the replacement address when verification races an email change", async () => {
    const id = await insert({ isEmailVerified: false });
    await send(id);
    const token = emailToken();
    const results = await Promise.allSettled([verify(token), change(id)]);
    expect(results[1].status).toBe("fulfilled");
    expect(await stored(id)).toMatchObject({
      email: newEmail,
      isEmailVerified: false,
      sessionVersion: 1,
    });
  });

  it("keeps a fresh replacement verification link when an old-address request invalidates late", async () => {
    const id = await insert({ isEmailVerified: false });
    const invalidate = verificationRepository.deletePendingEmailTokens.bind(
      verificationRepository,
    );
    let resume!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let delayed = false;
    vi.spyOn(
      verificationRepository,
      "deletePendingEmailTokens",
    ).mockImplementation(async (...args) => {
      // The first nontransactional issuance observed the original identity.
      // Let email-change revocation and the fresh send proceed normally.
      if (!delayed && !args[2]) {
        delayed = true;
        started();
        await gate;
      }
      return invalidate(...args);
    });
    const oldRequest = send(id);
    await ready;
    let freshToken = "";
    try {
      await change(id);
      freshToken = emailToken();
    } finally {
      resume();
    }
    await expect(oldRequest).resolves.toMatchObject({ sent: false });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    await expect(verify(freshToken)).resolves.toMatchObject({
      verified: true,
      userId: id,
    });
  });

  it("keeps the replacement-address reset when an old-address reset request invalidates late", async () => {
    const id = await insert();
    const sender = { sendOtpEmail: vi.fn().mockResolvedValue(undefined) };
    const reset = createPasswordResetService(sender);
    const invalidate = passwordResetRepository.invalidateActiveForUser.bind(
      passwordResetRepository,
    );
    let resume!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let delayed = false;
    vi.spyOn(
      passwordResetRepository,
      "invalidateActiveForUser",
    ).mockImplementation(async (...args) => {
      if (!delayed && !args[2]) {
        delayed = true;
        started();
        await gate;
      }
      return invalidate(...args);
    });
    const oldRequest = reset.requestReset({ tenantId, email: oldEmail });
    await ready;
    let freshOtp = "";
    try {
      await change(id);
      await reset.requestReset({ tenantId, email: newEmail });
      freshOtp = sender.sendOtpEmail.mock.calls.at(-1)![0].otp;
    } finally {
      resume();
    }
    await oldRequest;
    const staleOtp = sender.sendOtpEmail.mock.calls.at(-1)![0].otp;
    const stale = await reset.verifyOtp({
      tenantId,
      email: oldEmail,
      otp: staleOtp,
    });
    await expect(
      reset.resetPassword({
        tenantId,
        resetToken: stale.resetToken,
        password: "NewPassword123",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PASSWORD_RESET" });
    const fresh = await reset.verifyOtp({
      tenantId,
      email: newEmail,
      otp: freshOtp,
    });
    await expect(
      reset.resetPassword({
        tenantId,
        resetToken: fresh.resetToken,
        password: "NewPassword123",
      }),
    ).resolves.toEqual({ status: "SUCCESS" });
    expect(await stored(id)).toMatchObject({
      email: newEmail,
      sessionVersion: 2,
    });
  });

  it("does not let a concurrent verified social claim verify a replacement email", async () => {
    const id = await insert({ isEmailVerified: false });
    const save = User.prototype.save;
    let changed = false;
    vi.spyOn(User.prototype, "save").mockImplementation(async function (
      ...args: any[]
    ) {
      if (!changed && this.$where && String(this._id) === id) {
        changed = true;
        await change(id);
      }
      return save.apply(this, args as never);
    });
    await expect(
      resolveCustomerIdentity({
        tenantId,
        profile: {
          provider: "google",
          subject: "old-owner",
          email: oldEmail,
          emailVerified: true,
          firstname: "Test",
          lastname: "Customer",
        },
      }),
    ).rejects.toThrow();
    expect(await stored(id)).toMatchObject({
      email: newEmail,
      isEmailVerified: false,
      sessionVersion: 1,
    });
  });

  it("preserves identity and credentials when a duplicate replacement address is rejected", async () => {
    const id = await insert();
    await insert({ email: newEmail, memberNumber: 2 });
    await expect(change(id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await stored(id)).toMatchObject({
      email: oldEmail,
      isEmailVerified: true,
      sessionVersion: 0,
      refreshToken: ["old-refresh"],
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
