import { describe, expect, it } from "vitest";

import { workspaceNotificationSchema } from "@/modules/workspace-notifications/workspace-notification.schema.js";

describe("workspace notification schema", () => {
  it("enforces recipient-level idempotency and supports grouping", () => {
    const indexes = workspaceNotificationSchema.indexes();

    expect(indexes).toContainEqual([
      { tenant: 1, recipient: 1, deduplicationKey: 1 },
      expect.objectContaining({
        unique: true,
        name: "workspace_notification_recipient_deduplication",
      }),
    ]);
    expect(indexes).toContainEqual([
      { tenant: 1, recipient: 1, category: 1, _id: -1 },
      expect.objectContaining({
        name: "workspace_notification_recipient_category",
      }),
    ]);
    expect(indexes).toContainEqual([
      { tenant: 1, recipient: 1, groupKey: 1, _id: -1 },
      expect.objectContaining({
        name: "workspace_notification_recipient_group",
      }),
    ]);
  });
});
