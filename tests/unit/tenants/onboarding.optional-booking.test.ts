import { describe, expect, it } from "vitest";

import { saveTenantOnboardingStepSchema } from "@/modules/tenants/onboarding/tenant-onboarding.validators.js";

describe("tenant onboarding launch essentials", () => {
  it("accepts a studio profile without optional team metadata", () => {
    expect(
      saveTenantOnboardingStepSchema.parse({
        step: 1,
        tenantName: " Studio Olivka ",
        businessType: "coworking_space",
      }),
    ).toEqual({
      step: 1,
      tenantName: "Studio Olivka",
      businessType: "coworking_space",
    });
  });

  it("accepts country, timezone and currency without address details", () => {
    expect(
      saveTenantOnboardingStepSchema.parse({
        step: 2,
        businessDetails: {
          country: "CZ",
        },
        settings: {
          currency: "czk",
          timezone: "Europe/Prague",
        },
      }),
    ).toEqual({
      step: 2,
      businessDetails: {
        country: "CZ",
      },
      settings: {
        currency: "CZK",
        timezone: "Europe/Prague",
      },
    });
  });

  it("continues accepting the former optional profile fields", () => {
    expect(
      saveTenantOnboardingStepSchema.parse({
        step: 1,
        tenantName: "Studio Olivka",
        businessType: "coworking_space",
        teamSize: "2_5",
      }),
    ).toMatchObject({ teamSize: "2_5" });

    expect(
      saveTenantOnboardingStepSchema.parse({
        step: 2,
        businessDetails: {
          country: "CZ",
          city: "Prague",
          address: "Studio Street 1",
          phone: "+420123456789",
        },
        settings: {
          currency: "CZK",
          timezone: "Europe/Prague",
        },
      }),
    ).toMatchObject({
      businessDetails: {
        city: "Prague",
        address: "Studio Street 1",
        phone: "+420123456789",
      },
    });
  });
});

describe("tenant onboarding booking setup", () => {
  it("accepts an empty booking selection as legacy metadata", () => {
    expect(
      saveTenantOnboardingStepSchema.parse({
        step: 3,
        bookingSetup: {
          bookingTypes: [],
          confirmationMode: "instant",
        },
      }),
    ).toEqual({
      step: 3,
      bookingSetup: {
        bookingTypes: [],
        confirmationMode: "instant",
      },
    });
  });

  it("accepts a compatibility step without a booking workflow choice", () => {
    expect(saveTenantOnboardingStepSchema.parse({ step: 3 })).toEqual({
      step: 3,
      bookingSetup: { bookingTypes: [] },
    });
  });

  it("accepts and persists the canonical Open Studio and Class names", () => {
    expect(
      saveTenantOnboardingStepSchema.parse({
        step: 3,
        bookingSetup: {
          bookingTypes: ["open_studio", "class"],
          confirmationMode: "manual",
        },
      }),
    ).toEqual({
      step: 3,
      bookingSetup: {
        bookingTypes: ["open_studio", "class"],
        confirmationMode: "manual",
      },
    });
  });

  it("dual-reads and normalizes historical onboarding names", () => {
    expect(
      saveTenantOnboardingStepSchema.parse({
        step: 3,
        bookingSetup: {
          bookingTypes: [
            "private_sessions",
            "classes_courses",
            "events",
            "open_studio",
          ],
        },
      }),
    ).toEqual({
      step: 3,
      bookingSetup: {
        bookingTypes: ["open_studio", "class"],
      },
    });
  });
});
