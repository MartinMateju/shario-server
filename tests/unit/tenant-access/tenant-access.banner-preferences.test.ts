import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMembershipByUser: vi.fn() }));

vi.mock("@/modules/tenant-access/tenant-access.repository.js", () => ({
  tenantAccessRepository: { findMembershipByUser: mocks.findMembershipByUser },
}));

import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import {
  resolveWorkspaceAccessForUser,
  serializeWorkspaceAccess,
} from "@/modules/tenant-access/services/authorization.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

describe("persistent workspace banner preferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retains both dismissals in membership storage and refreshed access", async () => {
    const membership = new TenantMembershipModel({
      tenant: new mongoose.Types.ObjectId(TENANT_ID),
      user: new mongoose.Types.ObjectId(USER_ID),
      status: "active",
      role: "admin",
      preferences: {
        emailReadyBannerDismissed: true,
        overviewAttentionDismissed: true,
      },
      createdBy: new mongoose.Types.ObjectId(USER_ID),
      updatedBy: new mongoose.Types.ObjectId(USER_ID),
    });
    await expect(membership.validate()).resolves.toBeUndefined();
    const persisted = membership.toObject();
    expect(persisted.preferences).toMatchObject({
      emailReadyBannerDismissed: true,
      overviewAttentionDismissed: true,
    });
    mocks.findMembershipByUser.mockResolvedValue(
      TenantMembershipModel.hydrate(persisted),
    );

    const access = await resolveWorkspaceAccessForUser({
      tenantId: TENANT_ID,
      userId: USER_ID,
    });

    expect(access).not.toBeNull();
    expect(serializeWorkspaceAccess(access!).preferences).toMatchObject({
      emailReadyBannerDismissed: true,
      overviewAttentionDismissed: true,
    });
    expect(mocks.findMembershipByUser).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      { session: null },
    );
  });

  it("shows banners for legacy memberships with no saved dismissal", async () => {
    mocks.findMembershipByUser.mockResolvedValue({
      _id: "membership-id",
      tenant: TENANT_ID,
      user: USER_ID,
      status: "active",
      role: "admin",
      preferences: {},
    });

    const access = await resolveWorkspaceAccessForUser({
      tenantId: TENANT_ID,
      userId: USER_ID,
    });

    expect(access?.preferences).toMatchObject({
      emailReadyBannerDismissed: false,
      overviewAttentionDismissed: false,
    });
  });
});
