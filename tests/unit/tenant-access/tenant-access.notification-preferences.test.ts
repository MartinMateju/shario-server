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
import { workspacePreferencesInputSchema } from "@/modules/tenant-access/tenant-access.validators.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

describe("booking creation notification preference", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([undefined, false, true])(
    "defaults new membership storage to off and retains an explicit %s",
    async (bookingCreated) => {
      const membership = new TenantMembershipModel({
        tenant: new mongoose.Types.ObjectId(TENANT_ID),
        user: new mongoose.Types.ObjectId(USER_ID),
        status: "active",
        role: "admin",
        preferences: {
          notifications: bookingCreated === undefined ? {} : { bookingCreated },
        },
        createdBy: new mongoose.Types.ObjectId(USER_ID),
        updatedBy: new mongoose.Types.ObjectId(USER_ID),
      });
      await expect(membership.validate()).resolves.toBeUndefined();
      const persisted = membership.toObject();
      expect(persisted.preferences.notifications.bookingCreated).toBe(bookingCreated ?? false);
      mocks.findMembershipByUser.mockResolvedValue(TenantMembershipModel.hydrate(persisted));

      const access = await resolveWorkspaceAccessForUser({ tenantId: TENANT_ID, userId: USER_ID });
      expect(serializeWorkspaceAccess(access).preferences.notifications).toMatchObject({
        bookingCreated: bookingCreated ?? false,
        bookingAssigned: true,
        bookingCancelled: true,
      });
    },
  );

  it("defaults legacy memberships without the key to off without changing other events", async () => {
    mocks.findMembershipByUser.mockResolvedValue({
      _id: "membership-id",
      tenant: TENANT_ID,
      user: USER_ID,
      status: "active",
      role: "admin",
      preferences: { notifications: { bookingAssigned: true, bookingCancelled: false } },
    });

    const access = await resolveWorkspaceAccessForUser({ tenantId: TENANT_ID, userId: USER_ID });

    expect(access.preferences.notifications).toMatchObject({
      bookingCreated: false,
      bookingAssigned: true,
      bookingCancelled: false,
    });
  });

  it.each([true, false])("accepts the explicit boolean preference %s", (bookingCreated) => {
    expect(workspacePreferencesInputSchema.parse({ notifications: { bookingCreated } })).toEqual({
      notifications: { bookingCreated },
    });
  });

  it.each(["true", 1, null])("rejects a non-boolean preference %j", (bookingCreated) => {
    expect(workspacePreferencesInputSchema.safeParse({ notifications: { bookingCreated } }).success).toBe(false);
  });
});
