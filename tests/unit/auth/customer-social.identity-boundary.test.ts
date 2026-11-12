import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identityFindOne: vi.fn(),
  identityCreate: vi.fn(),
  identityUpdateOne: vi.fn(),
  membershipExists: vi.fn(),
  userFindOne: vi.fn(),
  userCreate: vi.fn(),
}));

const leanQuery = (value: unknown) => ({
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});

const selectedQuery = (value: unknown) => ({
  select: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});

vi.mock("@/modules/auth/social/customer-social-identity.schema.js", () => ({
  default: {
    findOne: mocks.identityFindOne,
    create: mocks.identityCreate,
    updateOne: mocks.identityUpdateOne,
  },
}));

vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: {
    exists: mocks.membershipExists,
  },
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: mocks.userFindOne,
    create: mocks.userCreate,
  },
}));

import { resolveCustomerIdentity } from "@/modules/auth/social/customer-social.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const profile = {
  provider: "google" as const,
  subject: "google-subject",
  email: "customer@example.test",
  emailVerified: true as const,
  firstname: "Ada",
  lastname: "Lovelace",
};

const socialUser = (overrides: Record<string, unknown> = {}) => ({
  _id: "507f1f77bcf86cd799439012",
  tenantRole: "customer",
  platformRole: "none",
  customId: "U-CUSTOMER-1",
  isAccessGranted: true,
  isEmailVerified: false,
  save: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("customer social identity context boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identityFindOne.mockReturnValue(leanQuery(null));
    mocks.identityCreate.mockResolvedValue({});
    mocks.identityUpdateOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    });
    mocks.membershipExists.mockResolvedValue(null);
  });

  it.each([
    { tenantRole: "owner", platformRole: "none" },
    { tenantRole: "staff", platformRole: "none" },
  ])("allows an existing non-platform workspace identity in explicit customer mode %j", async (roles) => {
    const user = socialUser(roles);
    mocks.userFindOne.mockReturnValue(selectedQuery(user));

    await expect(
      resolveCustomerIdentity({ tenantId, profile }),
    ).resolves.toBe(user);

    expect(user.save).toHaveBeenCalledOnce();
    expect(mocks.identityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: tenantId,
        user: user._id,
      }),
    );
    expect(mocks.membershipExists).not.toHaveBeenCalled();
  });

  it("rejects a platform identity from customer mode", async () => {
    const user = socialUser({
      tenantRole: "owner",
      platformRole: "support",
    });
    mocks.userFindOne.mockReturnValue(selectedQuery(user));

    await expect(
      resolveCustomerIdentity({ tenantId, profile }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "CUSTOMER_SOCIAL_PLATFORM_ACCOUNT_FORBIDDEN",
    });
    expect(user.save).not.toHaveBeenCalled();
    expect(mocks.identityCreate).not.toHaveBeenCalled();
  });

  it("claims only the explicit generated G-hex guest and preserves its user id", async () => {
    const user = socialUser({
      customId: "G-0123456789abcdefabcd",
      isAccessGranted: false,
    });
    mocks.userFindOne.mockReturnValue(selectedQuery(user));

    const resolved = await resolveCustomerIdentity({
      tenantId,
      profile,
    });

    expect(resolved).toBe(user);
    expect(resolved._id).toBe("507f1f77bcf86cd799439012");
    expect(resolved.isAccessGranted).toBe(true);
    expect(resolved.isEmailVerified).toBe(true);
    expect(user.save).toHaveBeenCalledOnce();
    expect(mocks.identityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: tenantId,
        user: user._id,
        provider: "google",
        subject: "google-subject",
      }),
    );
  });

  it.each(["U-SUSPENDED-1", "G-NOT-A-GENERATED-ID", "G-0123456789abcdefabc"])(
    "does not reactivate a suspended customer with custom id %s",
    async (customId) => {
      const user = socialUser({
        customId,
        isAccessGranted: false,
      });
      mocks.userFindOne.mockReturnValue(selectedQuery(user));

      await expect(
        resolveCustomerIdentity({ tenantId, profile }),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: "CUSTOMER_SOCIAL_ACCOUNT_DISABLED",
      });
      expect(user.save).not.toHaveBeenCalled();
      expect(mocks.identityCreate).not.toHaveBeenCalled();
    },
  );
});
