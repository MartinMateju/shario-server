import mongoose, { type ClientSession } from "mongoose";

import { ensureTenantPrimaryLocation } from "@/modules/location/services/location.service.js";
import { startTenantTrial } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import { updateTenantPlan } from "@/modules/tenants/services/tenant.service.js";
import { assertTenantOperationalCurrencyCanChange } from "@/modules/tenants/services/tenant-currency.service.js";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";

import {
  findTenantForOnboarding,
  updateTenantOnboarding,
} from "./tenant-onboarding.repository.js";
import type { SaveTenantOnboardingStepInput } from "./tenant-onboarding.validators.js";

const TOTAL_ONBOARDING_STEPS = 4;
const FIRST_OPTIONAL_ONBOARDING_STEP = 3;

const getTenantOrThrow = async (
  tenantId: string,
  options: { session?: ClientSession | null } = {},
) => {
  const tenant = await findTenantForOnboarding(tenantId, options);

  if (!tenant) {
    return notFound("Tenant not found.");
  }

  return tenant;
};

export const getTenantOnboarding = async (tenantId: string) => {
  return getTenantOrThrow(tenantId);
};

export const saveTenantOnboardingStep = async ({
  tenantId,
  input,
}: {
  tenantId: string;
  input: SaveTenantOnboardingStepInput;
}) => {
  const tenant = await getTenantOrThrow(tenantId);

  if (tenant.onboarding?.completed) {
    conflict("Launch setup has already been completed.");
  }

  const currentStep = Math.min(
    Math.max(Number(tenant.onboarding?.currentStep || 1), 1),
    TOTAL_ONBOARDING_STEPS,
  );

  if (input.step > currentStep) {
    badRequest("Launch setup steps cannot be skipped.");
  }

  const nextStep = Math.max(
    currentStep,
    Math.min(input.step + 1, TOTAL_ONBOARDING_STEPS),
  );

  const patch: Record<string, unknown> = {
    "onboarding.currentStep": nextStep,
    "onboarding.lastSavedAt": new Date(),
  };

  if (input.step === 1) {
    patch.name = input.tenantName;
    patch["onboarding.businessType"] = input.businessType;
    if (input.teamSize) {
      patch["onboarding.teamSize"] = input.teamSize;
    }
  }

  if (input.step === 2) {
    await assertTenantOperationalCurrencyCanChange({
      tenantId,
      currentCurrency: tenant.settings.currency,
      requestedCurrency: input.settings.currency,
    });

    patch["onboarding.businessDetails.country"] = input.businessDetails.country;
    if (input.businessDetails.city !== undefined) {
      patch["onboarding.businessDetails.city"] = input.businessDetails.city;
    }
    if (input.businessDetails.address !== undefined) {
      patch["onboarding.businessDetails.address"] =
        input.businessDetails.address;
    }
    if (input.businessDetails.phone !== undefined) {
      patch["onboarding.businessDetails.phone"] = input.businessDetails.phone;
    }
    patch["settings.currency"] = input.settings.currency;
    patch["settings.timezone"] = input.settings.timezone;
  }

  if (input.step === 3) {
    patch["onboarding.bookingSetup"] = input.bookingSetup;
  }

  const updatedTenant = await updateTenantOnboarding(tenantId, patch);

  if (!updatedTenant) {
    return notFound("Tenant not found.");
  }

  return updatedTenant;
};

const getMissingCompletionFields = (
  tenant: Awaited<ReturnType<typeof getTenantOrThrow>>,
) => {
  const onboarding = tenant.onboarding;
  const missing: string[] = [];

  if (!tenant.name?.trim()) missing.push("tenantName");
  if (!onboarding?.businessType) missing.push("businessType");
  if (!onboarding?.businessDetails?.country?.trim()) missing.push("country");

  return missing;
};

export const completeTenantOnboarding = async (tenantId: string) => {
  const session = await mongoose.startSession();

  try {
    let result: Awaited<ReturnType<typeof getTenantOrThrow>> | undefined;
    let primaryLocation:
      Awaited<ReturnType<typeof ensureTenantPrimaryLocation>> | undefined;

    await session.withTransaction(async () => {
      const tenant = await getTenantOrThrow(tenantId, { session });

      if (!tenant.onboarding?.completed) {
        const currentStep = Number(tenant.onboarding?.currentStep || 1);

        if (currentStep < FIRST_OPTIONAL_ONBOARDING_STEP) {
          badRequest("Complete the required launch details first.");
        }

        const missingFields = getMissingCompletionFields(tenant);

        if (missingFields.length) {
          badRequest({
            message: "Launch setup is missing required information.",
            details: { missingFields },
          });
        }

        const completedAt = new Date();
        const updatedTenant = await updateTenantOnboarding(
          tenantId,
          {
            "onboarding.completed": true,
            "onboarding.currentStep": TOTAL_ONBOARDING_STEPS,
            "onboarding.completedAt": completedAt,
            "onboarding.lastSavedAt": completedAt,
          },
          { session },
        );

        if (!updatedTenant) {
          return notFound("Tenant not found.");
        }

        result = updatedTenant;
      } else {
        result = tenant;
      }

      if (!result) {
        return notFound("Tenant not found.");
      }

      const trial = await startTenantTrial({ tenantId, session });

      if (trial.started) {
        // Newly entitled capabilities default on. Legacy booking answers are
        // metadata only and must not silently alter workspace selection.
        await updateTenantPlan(result, TENANT_PLAN.PROFESSIONAL, { session });
      }

      primaryLocation = await ensureTenantPrimaryLocation(result, { session });
    });

    if (!result) {
      return notFound("Tenant not found.");
    }

    if (!primaryLocation) {
      return notFound("Primary studio location could not be created.");
    }

    return {
      tenant: result,
      primaryLocation,
    };
  } finally {
    await session.endSession();
  }
};
