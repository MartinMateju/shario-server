import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  buildCustomerNotificationListQuery,
  buildCustomerNotificationVisibilityQuery,
} from "@/modules/customer-notifications/customer-notification.repository.js";

const id = () => new mongoose.Types.ObjectId().toString();

describe("customer notification repository isolation", () => {
  it("always scopes reads and writes to tenant plus recipient", () => {
    const tenantId = id();
    const recipientUserId = id();
    const query = buildCustomerNotificationVisibilityQuery({
      tenantId,
      recipientUserId,
    });

    expect(String(query.tenant)).toBe(tenantId);
    expect(String(query.recipient)).toBe(recipientUserId);
    expect(Object.keys(query).sort()).toEqual(["recipient", "tenant"]);
  });

  it("adds category and read state without dropping audience scope", () => {
    const tenantId = id();
    const recipientUserId = id();
    const query = buildCustomerNotificationListQuery({
      tenantId,
      recipientUserId,
      category: "bookings",
      status: "unread",
      page: 1,
      limit: 20,
    });

    expect(String(query.tenant)).toBe(tenantId);
    expect(String(query.recipient)).toBe(recipientUserId);
    expect(query.category).toBe("bookings");
    expect(query.readAt).toBeNull();
  });
});
