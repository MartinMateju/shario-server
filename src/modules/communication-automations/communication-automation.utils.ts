import mongoose from "mongoose";

import { COMMUNICATION_AUTOMATION_STATUS } from "./communication-automation.constants.js";
import type { UpdateCommunicationAutomationInput } from "./communication-automation.validators.js";

export const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

export const isCommunicationAutomationLocationScopeValid = (scope: {
  appliesToAllLocations?: boolean;
  location?: unknown;
}): boolean => {
  if (scope.appliesToAllLocations !== false) return true;
  const location =
    scope.location && typeof scope.location === "object" && "_id" in scope.location
      ? (scope.location as { _id: unknown })._id
      : scope.location;
  return mongoose.Types.ObjectId.isValid(String(location || ""));
};

export const buildActivationPatch = (
  input: UpdateCommunicationAutomationInput,
  currentIsActive: boolean,
): Record<string, unknown> => {
  if (input.isActive === true && !currentIsActive) {
    return {
      isActive: true,
      automationStatus: COMMUNICATION_AUTOMATION_STATUS.ACTIVE,
      activatedAt: new Date(),
      deactivatedAt: null,
      failedAt: null,
      errorMessage: "",
    };
  }

  if (input.isActive === false && currentIsActive) {
    return {
      isActive: false,
      automationStatus: COMMUNICATION_AUTOMATION_STATUS.INACTIVE,
      deactivatedAt: new Date(),
    };
  }

  return {};
};
