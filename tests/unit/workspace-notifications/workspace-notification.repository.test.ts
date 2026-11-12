import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { WORKSPACE_NOTIFICATION_STATUS } from "@/modules/workspace-notifications/workspace-notification.constants.js";
import {
  buildWorkspaceNotificationListQuery,
  buildWorkspaceNotificationVisibilityQuery,
} from "@/modules/workspace-notifications/workspace-notification.repository.js";

const id = () => new mongoose.Types.ObjectId().toString();

describe("workspace notification repository visibility", () => {
  it("always scopes records to the current tenant and recipient", () => {
    const tenantId = id();
    const recipientUserId = id();
    const query = buildWorkspaceNotificationVisibilityQuery({
      tenantId,
      recipientUserId,
      allowedLocationIds: null,
      permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
    });

    expect(String(query.tenant)).toBe(tenantId);
    expect(String(query.recipient)).toBe(recipientUserId);
    expect(query.$and).toEqual([
      {
        $or: [
          { requiredPermission: "" },
          {
            requiredPermission: {
              $in: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
            },
          },
        ],
      },
    ]);
  });

  it("re-scopes every read to current location assignments", () => {
    const assignedLocationId = id();
    const query = buildWorkspaceNotificationVisibilityQuery({
      tenantId: id(),
      recipientUserId: id(),
      allowedLocationIds: [assignedLocationId],
      permissions: [],
    });

    expect(query.$and).toEqual([
      { requiredPermission: "" },
      {
        $or: [
          { location: null },
          {
            location: {
              $in: [expect.objectContaining({})],
            },
          },
        ],
      },
    ]);
    const locationClause = query.$and?.[1] as {
      $or: Array<{ location: unknown }>;
    };
    const selectedLocations = locationClause.$or[1]?.location as {
      $in: mongoose.Types.ObjectId[];
    };
    expect(String(selectedLocations.$in[0])).toBe(assignedLocationId);
  });

  it("shows only tenant-global records when no location is assigned", () => {
    const query = buildWorkspaceNotificationVisibilityQuery({
      tenantId: id(),
      recipientUserId: id(),
      allowedLocationIds: [],
      permissions: [],
    });

    expect(query.$and).toEqual([
      { requiredPermission: "" },
      { location: null },
    ]);
  });

  it("adds status and explicit location filters without dropping visibility", () => {
    const tenantId = id();
    const recipientUserId = id();
    const locationId = id();
    const query = buildWorkspaceNotificationListQuery({
      tenantId,
      recipientUserId,
      allowedLocationIds: [locationId],
      permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
      status: WORKSPACE_NOTIFICATION_STATUS.UNREAD,
      page: 1,
      limit: 20,
      locationId,
    });

    expect(String(query.tenant)).toBe(tenantId);
    expect(String(query.recipient)).toBe(recipientUserId);
    expect(String(query.location)).toBe(locationId);
    expect(query.readAt).toBeNull();
    expect(query.$and).toHaveLength(2);
  });
});
