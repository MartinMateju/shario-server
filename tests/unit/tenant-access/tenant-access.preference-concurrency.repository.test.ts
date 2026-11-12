import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = {
    exec: vi.fn(),
    session: vi.fn(),
  };
  query.session.mockReturnValue(query);

  return {
    findOneAndUpdate: vi.fn(() => query),
    query,
  };
});

vi.mock(
  "../../../src/modules/tenant-access/tenant-membership.model.js",
  () => ({
    default: {
      findOneAndUpdate: mocks.findOneAndUpdate,
    },
  }),
);

vi.mock(
  "../../../src/modules/tenant-access/tenant-custom-role.model.js",
  () => ({ default: {} }),
);

import { tenantAccessRepository } from "../../../src/modules/tenant-access/tenant-access.repository.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

describe("workspace preference concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.exec.mockResolvedValue(null);
    mocks.query.session.mockReturnValue(mocks.query);
    mocks.findOneAndUpdate.mockReturnValue(mocks.query);
  });

  it("atomically preserves a same-version completed guide from a skipped replay", async () => {
    const setValues = {
      updatedBy: new mongoose.Types.ObjectId(USER_ID),
      "preferences.contextualGuides.first_booking": {
        version: 1,
        status: "skipped",
        lastStep: "calendar",
        updatedAt: new Date("2026-08-11T16:00:00.000Z"),
      },
    };

    await tenantAccessRepository
      .updateActiveMembershipPreferencePathsUnlessGuideCompleted(
        TENANT_ID,
        USER_ID,
        {
          guideId: "first_booking",
          version: 1,
          setValues,
        },
      );

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        tenant: new mongoose.Types.ObjectId(TENANT_ID),
        user: new mongoose.Types.ObjectId(USER_ID),
        status: "active",
        $or: [
          {
            "preferences.contextualGuides.first_booking.status": {
              $ne: "completed",
            },
          },
          {
            "preferences.contextualGuides.first_booking.version": {
              $ne: 1,
            },
          },
        ],
      },
      { $set: setValues },
      { returnDocument: "after", runValidators: true },
    );
  });

  it("allows a current-version skip to replace an older completed version", async () => {
    const setValues = {
      updatedBy: new mongoose.Types.ObjectId(USER_ID),
      "preferences.contextualGuides.memberships": {
        version: 2,
        status: "skipped",
        lastStep: "credits",
        updatedAt: new Date("2026-08-11T16:00:00.000Z"),
      },
    };

    await tenantAccessRepository
      .updateActiveMembershipPreferencePathsUnlessGuideCompleted(
        TENANT_ID,
        USER_ID,
        {
          guideId: "memberships",
          version: 2,
          setValues,
        },
      );

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [
          {
            "preferences.contextualGuides.memberships.status": {
              $ne: "completed",
            },
          },
          {
            "preferences.contextualGuides.memberships.version": {
              $ne: 2,
            },
          },
        ],
      }),
      { $set: setValues },
      { returnDocument: "after", runValidators: true },
    );
  });

});
