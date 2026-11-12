import { describe, expect, it } from "vitest";

import { buildLegacyWorkspaceIntentMigrationFilter } from "@/modules/tenants/tenant-workspace-intent.js";

describe("workspace intent legacy migration boundary", () => {
  it("uses onboarding completion time before legacy timestamp fallbacks", () => {
    const cutoff = new Date("2026-08-02T12:00:00.000Z");

    expect(buildLegacyWorkspaceIntentMigrationFilter(cutoff)).toEqual({
      "onboarding.completed": true,
      workspaceIntent: { $exists: false },
      $or: [
        { "onboarding.completedAt": { $lte: cutoff } },
        {
          $and: [
            { "onboarding.completedAt": { $exists: false } },
            {
              $or: [
                { createdAt: { $lte: cutoff } },
                {
                  $and: [
                    { createdAt: { $exists: false } },
                    { updatedAt: { $lte: cutoff } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });
});
