import mongoose from "mongoose";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantBySlug: vi.fn(),
  getTenantByHostname: vi.fn(),
  createTenantWithPlan: vi.fn(),
  createPendingTenantSubscription: vi.fn(),
  findByEmailWithSecrets: vi.fn(),
  createTenantUser: vi.fn(),
  createOwnerMembership: vi.fn(),
}));

vi.mock(
  "@/modules/tenants/services/tenant.service.js",
  () => ({
    getTenantBySlug: mocks.getTenantBySlug,
    getTenantByHostname: mocks.getTenantByHostname,
    createTenantWithPlan: mocks.createTenantWithPlan,
  }),
);

vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    createPendingTenantSubscription:
      mocks.createPendingTenantSubscription,
  }),
);

vi.mock(
  "@/modules/auth/auth.repository.js",
  () => ({
    createAuthRepository: vi.fn(() => ({
      findByEmailWithSecrets:
        mocks.findByEmailWithSecrets,
      createTenantUser:
        mocks.createTenantUser,
    })),
  }),
);

vi.mock(
  "@/modules/tenant-access/index.js",
  () => ({
    createOwnerMembership:
      mocks.createOwnerMembership,
  }),
);

import { registerTenant } from "@/modules/auth/services/register.service.js";

const TENANT_ID =
  "64b000000000000000000401";
const OWNER_ID =
  "64b000000000000000000402";

const input = {
  firstname: " Martin ",
  lastname: " Mateju ",
  email: " MARTIN@EXAMPLE.TEST ",
  password: "secure-password-123",
  tenantName: " Studio Olivka ",
  slug: " Studio-Olivka ",
};

const workspaceAccess = {
  membershipId:
    "64b000000000000000000403",
  tenantId: TENANT_ID,
  userId: OWNER_ID,
  status: "active",
  role: "owner",
  customRoleId: null,
  customRoleName: null,
  permissions: [],
  locationAccess: {
    mode: "all",
    locationIds: [],
  },
  workspaceProfile: {
    jobTitle: "",
    displayName: "",
    calendarColor: "#74869a",
  },
  preferences: {
    language: null,
    displayTimezone: null,
    defaultLocation: null,
    defaultCalendarView: "week",
    weekStartsOn: 1,
    defaultLandingPage: "/app",
    notifications: {
      bookingAssigned: true,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: true,
      inApp: true,
    },
  },
  accessVersion: 1,
  isPlatformBypass: false,
};

const tenant = {
  _id: TENANT_ID,
  name: "Studio Olivka",
  slug: "studio-olivka",
  plan: "starter",
  onboarding: {
    completed: false,
    currentStep: 1,
  },
};

const owner = {
  _id: OWNER_ID,
  tenant: TENANT_ID,
  firstname: "Martin",
  lastname: "Mateju",
  email: "martin@example.test",
  tenantRole: "owner",
};

describe("new tenant registration bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getTenantBySlug.mockResolvedValue(null);
    mocks.getTenantByHostname.mockResolvedValue(null);
    mocks.createTenantWithPlan.mockResolvedValue(tenant);
    mocks.createPendingTenantSubscription.mockResolvedValue({
      status: "pending",
    });
    mocks.findByEmailWithSecrets.mockResolvedValue(null);
    mocks.createTenantUser.mockResolvedValue(owner);
    mocks.createOwnerMembership.mockResolvedValue(
      workspaceAccess,
    );
  });

  it("atomically creates an incomplete workspace, pending subscription and owner membership", async () => {
    const session = {
      withTransaction: vi.fn(
        async (task: () => Promise<void>) => task(),
      ),
      endSession: vi.fn(),
    };
    vi.spyOn(
      mongoose,
      "startSession",
    ).mockResolvedValueOnce(session as never);

    const result = await registerTenant({ input });

    expect(
      mocks.createTenantWithPlan,
    ).toHaveBeenCalledWith(
      {
        name: "Studio Olivka",
        slug: "studio-olivka",
        hostname: undefined,
        plan: undefined,
        settings: {
          currency: "USD",
          timezone: "UTC",
          adminLanguage: "en",
          publicDefaultLanguage: "en",
          supportedPublicLanguages: ["en"],
        },
        country: "",
      },
      { session },
    );
    expect(
      mocks.createPendingTenantSubscription,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      session,
    });
    expect(
      mocks.createTenantUser,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        firstname: "Martin",
        lastname: "Mateju",
        email: "martin@example.test",
        password:
          "secure-password-123",
        tenantRole: "owner",
        platformRole: "none",
        roles: [],
        isAccessGranted: true,
        isEmailVerified: false,
      }),
    );
    expect(
      mocks.createOwnerMembership,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: OWNER_ID,
      session,
    });
    expect(result).toEqual({
      tenant,
      owner,
      workspaceAccess,
    });
    expect(
      result?.tenant.onboarding,
    ).toEqual({
      completed: false,
      currentStep: 1,
    });
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("does not require a published public site before creating the workspace", async () => {
    const session = {
      withTransaction: vi.fn(
        async (task: () => Promise<void>) => task(),
      ),
      endSession: vi.fn(),
    };
    vi.spyOn(
      mongoose,
      "startSession",
    ).mockResolvedValueOnce(session as never);

    await expect(
      registerTenant({ input }),
    ).resolves.toMatchObject({
      tenant: {
        slug: "studio-olivka",
      },
      owner: {
        tenantRole: "owner",
      },
    });
  });

  it("persists the confirmed signup preferences without replacing currency with the country's default", async () => {
    const session = {
      withTransaction: vi.fn(async (task: () => Promise<void>) => task()),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValueOnce(session as never);

    await registerTenant({ input: {
      ...input,
      locale: "pl",
      country: "PL",
      currency: "EUR",
      timezone: "Europe/Warsaw",
    } });

    expect(mocks.createTenantWithPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        country: "PL",
        settings: {
          currency: "EUR",
          timezone: "Europe/Warsaw",
          adminLanguage: "pl",
          publicDefaultLanguage: "pl",
          supportedPublicLanguages: ["pl"],
        },
      }),
      { session },
    );
    // A signup hint is not a separate billing override: later onboarding
    // settings remain authoritative until the tenant explicitly chooses one.
    expect(mocks.createPendingTenantSubscription).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      session,
    });
  });

  it("returns a stable conflict when a concurrent request wins the slug index race", async () => {
    const session = {
      withTransaction: vi.fn(
        async (task: () => Promise<void>) => task(),
      ),
      endSession: vi.fn(),
    };
    vi.spyOn(
      mongoose,
      "startSession",
    ).mockResolvedValueOnce(session as never);
    mocks.createTenantWithPlan.mockRejectedValueOnce({
      code: 11000,
      keyPattern: { slug: 1 },
    });

    await expect(
      registerTenant({ input }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "TENANT_ADDRESS_TAKEN",
    });
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("does not misreport an unrelated duplicate-key failure as a tenant address conflict", async () => {
    const session = {
      withTransaction: vi.fn(
        async (task: () => Promise<void>) => task(),
      ),
      endSession: vi.fn(),
    };
    vi.spyOn(
      mongoose,
      "startSession",
    ).mockResolvedValueOnce(session as never);
    const duplicateUserError = {
      code: 11000,
      keyPattern: { tenant: 1, customId: 1 },
    };
    mocks.createTenantUser.mockRejectedValueOnce(duplicateUserError);

    await expect(
      registerTenant({ input }),
    ).rejects.toBe(duplicateUserError);
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("stops before opening a transaction when the slug is already taken", async () => {
    mocks.getTenantBySlug.mockResolvedValueOnce({
      _id: "existing",
    });
    const startSession = vi.spyOn(
      mongoose,
      "startSession",
    );

    await expect(
      registerTenant({ input }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(startSession).not.toHaveBeenCalled();
    expect(
      mocks.createTenantWithPlan,
    ).not.toHaveBeenCalled();
  });
});
