import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMembershipByUser: vi.fn(),
  resolveWorkspaceAccessForUser: vi.fn(),
  serializeWorkspaceAccess: vi.fn(),
  updateActiveMembershipPreferencePaths: vi.fn(),
  updateActiveMembershipPreferencePathsUnlessGuideCompleted: vi.fn(),
}));

vi.mock(
  "../../../src/modules/tenant-access/tenant-access.repository.js",
  () => ({
    tenantAccessRepository: {
      findMembershipByUser: mocks.findMembershipByUser,
      updateActiveMembershipPreferencePaths:
        mocks.updateActiveMembershipPreferencePaths,
      updateActiveMembershipPreferencePathsUnlessGuideCompleted:
        mocks.updateActiveMembershipPreferencePathsUnlessGuideCompleted,
    },
  }),
);

vi.mock(
  "../../../src/modules/tenant-access/services/authorization.service.js",
  () => ({
    hasWorkspacePermission: vi.fn(() => true),
    resolveWorkspaceAccessForUser: mocks.resolveWorkspaceAccessForUser,
    serializeWorkspaceAccess: mocks.serializeWorkspaceAccess,
  }),
);

import { updateCurrentWorkspacePreferences } from "../../../src/modules/tenant-access/services/team.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

describe("current workspace guide preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMembershipByUser.mockResolvedValue({
      status: "active",
      locationAccess: { mode: "all", locationIds: [] },
      preferences: { contextualGuides: {} },
    });
    mocks.updateActiveMembershipPreferencePaths.mockResolvedValue({});
    mocks.updateActiveMembershipPreferencePathsUnlessGuideCompleted
      .mockResolvedValue(null);
    const access = { status: "active" };
    mocks.resolveWorkspaceAccessForUser.mockResolvedValue(access);
    mocks.serializeWorkspaceAccess.mockReturnValue({ status: "active" });
  });

  it.each([true, false])("saves booking creation preference %s without overwriting other events", async (bookingCreated) => {
    await updateCurrentWorkspacePreferences({
      tenantId: TENANT_ID,
      userId: USER_ID,
      input: { notifications: { bookingCreated } },
    });

    expect(mocks.updateActiveMembershipPreferencePaths).toHaveBeenCalledExactlyOnceWith(
      TENANT_ID,
      USER_ID,
      {
        updatedBy: expect.any(mongoose.Types.ObjectId),
        "preferences.notifications.bookingCreated": bookingCreated,
      },
    );
  });

  it.each([
    "emailReadyBannerDismissed",
    "overviewAttentionDismissed",
  ] as const)(
    "saves %s only for the current member without replacing other preferences",
    async (preference) => {
      mocks.findMembershipByUser.mockResolvedValue({
        status: "active",
        preferences: {
          language: "cs",
          emailReadyBannerDismissed: true,
          overviewAttentionDismissed: true,
        },
      });

      await updateCurrentWorkspacePreferences({
        tenantId: TENANT_ID,
        userId: USER_ID,
        input: { [preference]: true },
      });

      expect(mocks.findMembershipByUser).toHaveBeenCalledWith(
        TENANT_ID,
        USER_ID,
      );
      expect(
        mocks.updateActiveMembershipPreferencePaths,
      ).toHaveBeenCalledExactlyOnceWith(TENANT_ID, USER_ID, {
        updatedBy: expect.any(mongoose.Types.ObjectId),
        [`preferences.${preference}`]: true,
      });
    },
  );

  it.each([null, { status: "suspended" }])(
    "rejects banner preference changes without an active membership: %j",
    async (membership) => {
      mocks.findMembershipByUser.mockResolvedValue(membership);

      await expect(
        updateCurrentWorkspacePreferences({
          tenantId: TENANT_ID,
          userId: USER_ID,
          input: { emailReadyBannerDismissed: true },
        }),
      ).rejects.toThrow("An active workspace membership is required.");

      expect(
        mocks.updateActiveMembershipPreferencePaths,
      ).not.toHaveBeenCalled();
    },
  );

  it("uses the conditional writer and treats a concurrent completion as a no-op", async () => {
    await expect(
      updateCurrentWorkspacePreferences({
        tenantId: TENANT_ID,
        userId: USER_ID,
        input: {
          contextualGuides: {
            memberships: {
              version: 2,
              status: "skipped",
              lastStep: "credits",
            },
          },
        },
      }),
    ).resolves.toEqual({ status: "active" });

    expect(
      mocks.updateActiveMembershipPreferencePaths,
    ).not.toHaveBeenCalled();
    expect(
      mocks.updateActiveMembershipPreferencePathsUnlessGuideCompleted,
    ).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      {
        guideId: "memberships",
        version: 2,
        setValues: {
          updatedBy: expect.any(mongoose.Types.ObjectId),
          "preferences.contextualGuides.memberships": {
            version: 2,
            status: "skipped",
            lastStep: "credits",
            updatedAt: expect.any(Date),
          },
        },
      },
    );
  });

  it("writes a completed new guide through the normal atomic preference update", async () => {
    await expect(
      updateCurrentWorkspacePreferences({
        tenantId: TENANT_ID,
        userId: USER_ID,
        input: {
          contextualGuides: {
            first_offer: {
              version: 1,
              status: "completed",
              lastStep: "publish",
            },
          },
        },
      }),
    ).resolves.toEqual({ status: "active" });

    expect(
      mocks.updateActiveMembershipPreferencePaths,
    ).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      {
        updatedBy: expect.any(mongoose.Types.ObjectId),
        "preferences.contextualGuides.first_offer": {
          version: 1,
          status: "completed",
          lastStep: "publish",
          updatedAt: expect.any(Date),
        },
      },
    );
    expect(
      mocks.updateActiveMembershipPreferencePathsUnlessGuideCompleted,
    ).not.toHaveBeenCalled();
  });

});
