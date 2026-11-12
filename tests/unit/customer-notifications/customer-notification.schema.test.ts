import { describe, expect, it } from "vitest";

import { customerNotificationSchema } from "@/modules/customer-notifications/customer-notification.schema.js";

describe("customer notification schema", () => {
  it("enforces recipient-level idempotency and inbox query indexes", () => {
    expect(customerNotificationSchema.indexes()).toContainEqual([
      { tenant: 1, recipient: 1, deduplicationKey: 1 },
      expect.objectContaining({
        unique: true,
        name: "customer_notification_recipient_deduplication",
      }),
    ]);
    expect(customerNotificationSchema.indexes()).toContainEqual([
      { tenant: 1, recipient: 1, readAt: 1, _id: -1 },
      expect.objectContaining({
        name: "customer_notification_recipient_unread",
      }),
    ]);
  });
});
