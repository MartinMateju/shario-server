import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  invalidateActiveForUser:
    vi.fn(),
  create: vi.fn(),
  findLatestPendingByEmail:
    vi.fn(),
  incrementAttemptsIfPending:
    vi.fn(),
  verifyPending: vi.fn(),
  expirePending: vi.fn(),
  consumeVerified: vi.fn(),
  sendOtpEmail: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock(
  "@/modules/user/user.repository.js",
  () => ({
    createUserRepository: () => ({
      findByEmail:
        mocks.findByEmail,
    }),
  }),
);

vi.mock(
  "@/modules/user/user.model.js",
  () => ({
    default: {
      updateOne:
        mocks.updateOne,
    },
  }),
);

vi.mock(
  "@/modules/password_reset/password-reset.repository.js",
  () => ({
    passwordResetRepository: {
      invalidateActiveForUser:
        mocks.invalidateActiveForUser,
      create: mocks.create,
      findLatestPendingByEmail:
        mocks.findLatestPendingByEmail,
      incrementAttemptsIfPending:
        mocks.incrementAttemptsIfPending,
      verifyPending:
        mocks.verifyPending,
      expirePending:
        mocks.expirePending,
      consumeVerified:
        mocks.consumeVerified,
    },
  }),
);

import { createPasswordResetService } from "@/modules/password_reset/services/password-reset.service.js";
import { hashPasswordResetToken } from "@/modules/password_reset/password-reset.utils.js";

const TENANT_A =
  "64b000000000000000000011";
const TENANT_B =
  "64b000000000000000000012";
const USER_ID =
  "64b000000000000000000013";

const service =
  createPasswordResetService({
    sendOtpEmail:
      mocks.sendOtpEmail,
  });

const updateResult = (
  matchedCount = 1,
) => {
  const query = {
    session: vi.fn(),
    exec: vi
      .fn()
      .mockResolvedValue({
        matchedCount,
      }),
  };
  query.session.mockReturnValue(
    query,
  );
  return query;
};

const installTransaction = () => {
  const session = {
    withTransaction: vi.fn(
      async (
        callback: () =>
          Promise<void>,
      ) => callback(),
    ),
    endSession: vi
      .fn()
      .mockResolvedValue(undefined),
  };

  vi.spyOn(
    mongoose,
    "startSession",
  ).mockResolvedValue(
    session as never,
  );

  return session;
};

describe("tenant-bound password recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invalidateActiveForUser.mockResolvedValue(
      undefined,
    );
    mocks.create.mockResolvedValue(
      {},
    );
    mocks.sendOtpEmail.mockResolvedValue(
      undefined,
    );
    mocks.updateOne.mockReturnValue(
      updateResult(),
    );
  });

  it("returns the same pending state for an unknown email without creating a challenge", async () => {
    mocks.findByEmail.mockResolvedValue(
      null,
    );

    await expect(
      service.requestReset({
        tenantId: TENANT_A,
        email:
          "missing@example.com",
        studioName:
          "Studio Alpha",
      }),
    ).resolves.toEqual({
      status: "PENDING",
    });

    expect(
      mocks.create,
    ).not.toHaveBeenCalled();
    expect(
      mocks.sendOtpEmail,
    ).not.toHaveBeenCalled();
  });

  it("invalidates previous challenges before sending a tenant-branded OTP", async () => {
    mocks.findByEmail.mockResolvedValue(
      {
        _id: USER_ID,
        email:
          "customer@example.com",
      },
    );

    await service.requestReset({
      tenantId: TENANT_A,
      email:
        "customer@example.com",
      locale: "en",
      studioName: "Studio Alpha",
    });

    expect(
      mocks.invalidateActiveForUser,
    ).toHaveBeenCalledWith(
      TENANT_A,
      USER_ID,
    );
    expect(
      mocks.create,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        userId: USER_ID,
        email:
          "customer@example.com",
        otpHash:
          expect.any(String),
        expiresAt:
          expect.any(Date),
      }),
    );
    expect(
      mocks.sendOtpEmail,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        to:
          "customer@example.com",
        otp:
          expect.stringMatching(
            /^\d{6}$/,
          ),
        locale: "en",
        studioName:
          "Studio Alpha",
      }),
    );
  });

  it("mints only one reset token from a challenge", async () => {
    const otpHash =
      await bcrypt.hash(
        "123456",
        4,
      );
    const challenge = {
      _id:
        "64b000000000000000000014",
      user: USER_ID,
      otpHash,
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(
        Date.now() + 60_000,
      ),
    };
    mocks.findLatestPendingByEmail.mockResolvedValue(
      challenge,
    );
    mocks.verifyPending
      .mockResolvedValueOnce(
        challenge,
      )
      .mockResolvedValueOnce(
        null,
      );

    const first =
      await service.verifyOtp({
        tenantId: TENANT_A,
        email:
          "customer@example.com",
        otp: "123456",
      });

    expect(first).toMatchObject({
      status: "VERIFIED",
      resetToken:
        expect.stringMatching(
          /^[a-f0-9]{64}$/,
        ),
    });

    await expect(
      service.verifyOtp({
        tenantId: TENANT_A,
        email:
          "customer@example.com",
        otp: "123456",
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code:
        "INVALID_PASSWORD_RESET",
    });
  });

  it("binds reset-token consumption to the requested tenant", async () => {
    installTransaction();
    mocks.consumeVerified.mockResolvedValue(
      null,
    );
    const resetToken =
      "d".repeat(64);

    await expect(
      service.resetPassword({
        tenantId: TENANT_B,
        resetToken,
        password:
          "NewPassword123",
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code:
        "INVALID_PASSWORD_RESET",
    });

    expect(
      mocks.consumeVerified,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_B,
        resetTokenHash:
          hashPasswordResetToken(
            resetToken,
          ),
      }),
    );
    expect(
      mocks.updateOne,
    ).not.toHaveBeenCalled();
  });

  it("atomically consumes the reset token, changes the scoped password, and revokes every refresh session", async () => {
    installTransaction();
    const resetToken =
      "e".repeat(64);
    mocks.consumeVerified
      .mockResolvedValueOnce({
        _id:
          "64b000000000000000000015",
        tenant: TENANT_A,
        user: USER_ID,
      })
      .mockResolvedValueOnce(
        null,
      );

    await expect(
      service.resetPassword({
        tenantId: TENANT_A,
        resetToken,
        password:
          "NewPassword123",
      }),
    ).resolves.toEqual({
      status: "SUCCESS",
    });

    expect(
      mocks.updateOne,
    ).toHaveBeenCalledWith(
      {
        _id: USER_ID,
        tenant: TENANT_A,
      },
      {
        $set: {
          password:
            expect.any(String),
          refreshToken: [],
        },
        $inc: {
          sessionVersion: 1,
        },
      },
    );
    expect(
      mocks.invalidateActiveForUser,
    ).toHaveBeenCalledWith(
      TENANT_A,
      USER_ID,
      expect.any(Object),
    );

    await expect(
      service.resetPassword({
        tenantId: TENANT_A,
        resetToken,
        password:
          "AnotherPassword456",
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code:
        "INVALID_PASSWORD_RESET",
    });
    expect(
      mocks.updateOne,
    ).toHaveBeenCalledOnce();
  });
});
