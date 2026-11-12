import mongoose from "mongoose";

import LocationModel from "@/modules/location/location.model.js";
import { canAccessWorkspaceLocation } from "@/modules/tenant-access/index.js";
import { notFound } from "@/shared/http/httpErrors.js";

import {
  buildWorkspaceAssistantContext,
  buildWorkspaceOperationalContext,
} from "./ai-data.service.js";
import {
  scopeOperationalAccessToEnabledModules,
} from "./operational-context-access.service.js";
import type {
  StudioContextBuildInput,
  StudioContextSnapshot,
} from "../studio-context.types.js";
import { STUDIO_CONTEXT_VERSION } from "../studio-context.types.js";

/**
 * Stable, versioned entry point for every workspace AI capability that needs
 * live studio data. The underlying builder owns tenant, permission, module,
 * location, redaction and prompt-budget enforcement.
 */
export const buildStudioContextSnapshot = async (
  input: StudioContextBuildInput,
): Promise<StudioContextSnapshot> => {
  if (
    input.access.status !== "active" ||
    input.access.tenantId !== input.tenantId ||
    input.access.userId !== input.userId
  ) {
    notFound("Workspace not found.");
  }

  if (input.locationId) {
    const locationId = String(input.locationId);
    if (
      !mongoose.isValidObjectId(locationId) ||
      !canAccessWorkspaceLocation(input.access, locationId)
    ) {
      notFound("Location not found.");
    }
    const exists = await LocationModel.exists({
      _id: locationId,
      tenant: input.tenantId,
    });
    if (!exists) notFound("Location not found.");
  }

  try {
    return await buildWorkspaceAssistantContext(input);
  } catch (error) {
    if (error instanceof Error && error.message === "Workspace not found.") {
      notFound("Workspace not found.");
    }
    throw error;
  }
};

export { scopeOperationalAccessToEnabledModules };

/**
 * Briefing-safe operational entry point. This keeps the same authorization and
 * location boundary as every other Studio Context consumer while returning
 * only aggregated operational facts from the underlying data builder.
 */
export const buildStudioOperationalContextSnapshot = async (
  input: StudioContextBuildInput & {
    includeStaffPlanning?: boolean;
    modules: Record<string, unknown>;
  },
): Promise<Record<string, any>> => {
  if (
    input.access.status !== "active" ||
    input.access.tenantId !== input.tenantId ||
    input.access.userId !== input.userId
  ) {
    notFound("Workspace not found.");
  }

  if (input.locationId) {
    const locationId = String(input.locationId);
    if (
      !mongoose.isValidObjectId(locationId) ||
      !canAccessWorkspaceLocation(input.access, locationId)
    ) {
      notFound("Location not found.");
    }
    const exists = await LocationModel.exists({
      _id: locationId,
      tenant: input.tenantId,
    });
    if (!exists) notFound("Location not found.");
  }

  try {
    const operationalAccess = scopeOperationalAccessToEnabledModules(
      input.access,
      input.modules,
    );
    const operations = await buildWorkspaceOperationalContext({
      tenantId: input.tenantId,
      userId: input.userId,
      access: operationalAccess,
      locationId: input.locationId,
      timezone: input.timezone || "UTC",
      now: input.now,
      includeStaffPlanning: input.includeStaffPlanning,
    });
    return {
      ...operations,
      contextVersion: STUDIO_CONTEXT_VERSION,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Workspace not found.") {
      notFound("Workspace not found.");
    }
    throw error;
  }
};

export { STUDIO_CONTEXT_VERSION };

export const studioContextService = {
  buildSnapshot: buildStudioContextSnapshot,
  buildOperationalSnapshot: buildStudioOperationalContextSnapshot,
};

export default studioContextService;
