import type { Response } from "express";

import type { AuthenticatedRequest } from "@/modules/auth/auth.types.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { getTenantIdFromRequest } from "../tenant.utils.js";
import {
  completeTenantOnboarding,
  getTenantOnboarding,
  saveTenantOnboardingStep,
} from "./tenant-onboarding.service.js";
import {
  saveTenantOnboardingStepSchema,
  validateOnboardingBody,
} from "./tenant-onboarding.validators.js";
import { normalizeTenantBookingTypes } from "./tenant-onboarding.constants.js";

const serializeTenantOnboarding = (
  tenant: Awaited<ReturnType<typeof getTenantOnboarding>>,
) => {
  const onboarding = tenant.onboarding;

  return {
    tenant: {
      id: String(tenant._id),
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan,
      planVersion: tenant.planVersion,
      modules: tenant.modules,
      limits: tenant.limits,
      settings: tenant.settings,
    },

    onboarding: {
      completed: Boolean(onboarding?.completed),
      currentStep: Number(onboarding?.currentStep ?? 1),
      businessType: onboarding?.businessType ?? null,
      teamSize: onboarding?.teamSize ?? null,
      businessDetails: onboarding?.businessDetails ?? null,
      bookingSetup: onboarding?.bookingSetup
        ? {
            bookingTypes: normalizeTenantBookingTypes(
              onboarding.bookingSetup.bookingTypes ?? [],
            ),
            ...(onboarding.bookingSetup.confirmationMode
              ? {
                  confirmationMode: onboarding.bookingSetup.confirmationMode,
                }
              : {}),
          }
        : null,
      completedAt: onboarding?.completedAt ?? null,
      lastSavedAt: onboarding?.lastSavedAt ?? null,
    },
  };
};

export const getCurrentTenantOnboarding = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = getTenantIdFromRequest(req);

    const tenant = await getTenantOnboarding(tenantId);

    res.status(200).json(serializeTenantOnboarding(tenant));
  },
);

export const saveCurrentTenantOnboarding = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = getTenantIdFromRequest(req);

    const input = validateOnboardingBody(
      saveTenantOnboardingStepSchema,
      req.body,
    );

    const tenant = await saveTenantOnboardingStep({
      tenantId,
      input,
    });

    res.status(200).json(serializeTenantOnboarding(tenant));
  },
);

export const completeCurrentTenantOnboarding = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = getTenantIdFromRequest(req);

    const result = await completeTenantOnboarding(tenantId);

    res.status(200).json({
      ...serializeTenantOnboarding(result.tenant),
      primaryLocation: result.primaryLocation,
    });
  },
);
