import { describe, expect, it } from "vitest";

import {
  WORKSPACE_GUIDE_DEFINITIONS,
  WORKSPACE_GUIDE_IDS,
} from "@/modules/workspace-guides/workspace-guide.constants.js";
import { createPlatformBypassAccess } from "@/modules/tenant-access/services/authorization.service.js";

describe("platform workspace guide defaults", () => {
  it("acknowledges every guide at its current version and terminal step", () => {
    const access = createPlatformBypassAccess({
      tenantId: "507f1f77bcf86cd799439011",
      userId: "507f1f77bcf86cd799439012",
    });
    const contextualGuides = access.preferences.contextualGuides;

    expect(Object.keys(contextualGuides)).toEqual(WORKSPACE_GUIDE_IDS);

    for (const guideId of WORKSPACE_GUIDE_IDS) {
      const definition = WORKSPACE_GUIDE_DEFINITIONS[guideId];

      expect(contextualGuides[guideId]).toEqual({
        version: definition.version,
        status: "completed",
        lastStep: definition.terminalStep,
        updatedAt: null,
      });
    }
  });
});
