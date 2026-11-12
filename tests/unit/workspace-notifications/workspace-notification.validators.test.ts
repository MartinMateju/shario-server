import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  WORKSPACE_NOTIFICATION_CATEGORY,
  WORKSPACE_NOTIFICATION_STATUS,
} from "@/modules/workspace-notifications/workspace-notification.constants.js";
import {
  isSafeWorkspaceNotificationActionUrl,
  listWorkspaceNotificationsSchema,
} from "@/modules/workspace-notifications/workspace-notification.validators.js";

describe("workspace notification validation", () => {
  it.each([
    "",
    "/app",
    "/app/notifications",
    "/app/bookings/booking-1?from=notifications",
    "/app?panel=notifications",
    "/app#notifications",
  ])("accepts the safe in-app action URL %j", (value) => {
    expect(isSafeWorkspaceNotificationActionUrl(value)).toBe(true);
  });

  it.each([
    "https://example.com/app",
    "//example.com/app",
    "/application",
    "/app\\evil",
    "/app/notifications\nhttps://example.com",
    "javascript:alert(1)",
  ])("rejects the unsafe action URL %j", (value) => {
    expect(isSafeWorkspaceNotificationActionUrl(value)).toBe(false);
  });

  it("parses the page/status contract and applies safe defaults", () => {
    expect(listWorkspaceNotificationsSchema.parse({})).toEqual({
      status: WORKSPACE_NOTIFICATION_STATUS.ALL,
      page: 1,
      limit: 20,
    });

    const locationId = new mongoose.Types.ObjectId().toString();
    expect(
      listWorkspaceNotificationsSchema.parse({
        category: WORKSPACE_NOTIFICATION_CATEGORY.BOOKINGS,
        locationId,
        status: WORKSPACE_NOTIFICATION_STATUS.UNREAD,
        page: "2",
        limit: "8",
      }),
    ).toEqual({
      category: WORKSPACE_NOTIFICATION_CATEGORY.BOOKINGS,
      locationId,
      status: WORKSPACE_NOTIFICATION_STATUS.UNREAD,
      page: 2,
      limit: 8,
    });
  });

  it("rejects legacy or unbounded list inputs", () => {
    expect(
      listWorkspaceNotificationsSchema.safeParse({ unread: "true" }).success,
    ).toBe(false);
    expect(
      listWorkspaceNotificationsSchema.safeParse({ limit: 51 }).success,
    ).toBe(false);
    expect(
      listWorkspaceNotificationsSchema.safeParse({ status: "archived" })
        .success,
    ).toBe(false);
  });
});
