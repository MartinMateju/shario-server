import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

const TENANT_ID = "64b64c8f4f1c2a3b4c5d6e70";
const LOCATION_ID = "64b64c8f4f1c2a3b4c5d6e71";

const mocks = vi.hoisted(() => ({
  getTenantOrThrow: vi.fn(),
  countActive: vi.fn(),
  findPrimary: vi.fn(),
  findFirstActive: vi.fn(),
  identityExists: vi.fn(),
  create: vi.fn(),
  tenantUpdateOne: vi.fn(),
}));

vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { updateOne: mocks.tenantUpdateOne },
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));

vi.mock("@/modules/location/location.repository.js", () => ({
  locationRepository: {
    countActive: mocks.countActive,
    findPrimary: mocks.findPrimary,
    findFirstActive: mocks.findFirstActive,
    identityExists: mocks.identityExists,
    create: mocks.create,
  },
}));

import {
  ensureTenantPrimaryLocation,
  locationService,
} from "@/modules/location/services/location.service.js";

const tenant = ({
  bookings,
  courses,
  legacyBookingTypes = [],
}: {
  bookings: boolean;
  courses: boolean;
  legacyBookingTypes?: string[];
}) =>
  ({
    _id: TENANT_ID,
    name: "Studio Emilka",
    plan: "professional",
    modules: {
      [TENANT_MODULE.BOOKINGS]: bookings,
      [TENANT_MODULE.COURSES]: courses,
      [TENANT_MODULE.CUSTOMERS]: true,
    },
    limits: { locations: 3 },
    settings: { timezone: "Europe/Prague" },
    onboarding: {
      businessDetails: {
        country: "Czech Republic",
        city: "Brno",
        address: "Studio Street 1",
        phone: "+420123456789",
      },
      bookingSetup: { bookingTypes: legacyBookingTypes },
    },
  }) as any;

describe("location bootstrap workflow defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantUpdateOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    });
    mocks.countActive.mockResolvedValue(0);
    mocks.findPrimary.mockResolvedValue(null);
    mocks.findFirstActive.mockResolvedValue(null);
    mocks.identityExists.mockResolvedValue(false);
    mocks.create.mockImplementation(
      async (_tenantId: string, input: any, options: any) => ({
        _id: LOCATION_ID,
        ...input,
        isActive: true,
        isPrimary: options.isPrimary,
      }),
    );
  });

  it.each([
    { bookings: true, courses: false },
    { bookings: false, courses: true },
  ])(
    "enables booking for a selected booking workflow: $bookings/$courses",
    async ({ bookings, courses }) => {
      await ensureTenantPrimaryLocation(tenant({ bookings, courses }));

      expect(mocks.create).toHaveBeenCalledWith(
        TENANT_ID,
        expect.objectContaining({
          booking: expect.objectContaining({ enabled: true }),
        }),
        expect.objectContaining({ isPrimary: true }),
      );
    },
  );

  it("keeps the legacy default-enabled behavior when bookings is absent", async () => {
    const legacyTenant = tenant({ bookings: true, courses: false });
    delete legacyTenant.modules[TENANT_MODULE.BOOKINGS];

    await ensureTenantPrimaryLocation(legacyTenant);

    expect(mocks.create).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        booking: expect.objectContaining({ enabled: true }),
      }),
      expect.objectContaining({ isPrimary: true }),
    );
  });

  it("does not enable booking from obsolete onboarding booking types", async () => {
    await ensureTenantPrimaryLocation(
      tenant({
        bookings: false,
        courses: false,
        legacyBookingTypes: ["open_studio"],
      }),
    );

    expect(mocks.create).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        booking: expect.objectContaining({ enabled: false }),
      }),
      expect.any(Object),
    );
  });

  it("preserves an intentionally disabled existing primary location", async () => {
    const existing = {
      _id: LOCATION_ID,
      isActive: true,
      isPrimary: true,
      booking: { enabled: false },
    };
    mocks.findPrimary.mockResolvedValue(existing);

    await expect(
      ensureTenantPrimaryLocation(tenant({ bookings: true, courses: true })),
    ).resolves.toBe(existing);

    expect(mocks.countActive).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("uses the tenant workflow when bootstrapping through the public service", async () => {
    const currentTenant = tenant({ bookings: true, courses: false });
    const session = {
      withTransaction: vi.fn(async (task: (session: unknown) => unknown) =>
        task(session),
      ),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValueOnce(session as never);
    mocks.getTenantOrThrow.mockResolvedValue(currentTenant);

    const result = await locationService.bootstrap(TENANT_ID);

    expect(mocks.getTenantOrThrow).toHaveBeenCalledWith(TENANT_ID, { session });
    expect(result).toMatchObject({
      booking: { enabled: true },
      isPrimary: true,
    });
    expect(session.endSession).toHaveBeenCalledOnce();
  });
});
