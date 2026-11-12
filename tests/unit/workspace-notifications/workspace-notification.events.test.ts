import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

const publisherMocks = vi.hoisted(() => ({
  publishSafely: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock(
  "@/modules/workspace-notifications/services/workspace-notification-publisher.service.js",
  () => ({
    publishWorkspaceNotificationSafely: publisherMocks.publishSafely,
  }),
);

import { registerWorkspaceNotificationPublisher } from "@/modules/workspace-notifications/workspace-notification.bootstrap.js";
import { emitWorkspaceNotificationEvent } from "@/modules/workspace-notifications/workspace-notification.events.js";
import {
  WORKSPACE_NOTIFICATION_EVENT,
  WORKSPACE_NOTIFICATION_SEVERITY,
} from "@/modules/workspace-notifications/workspace-notification.constants.js";

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.clearAllMocks();
});

describe("workspace notification event bootstrap", () => {
  it("registers one best-effort publisher and emits synchronously", () => {
    unregister = registerWorkspaceNotificationPublisher();
    expect(registerWorkspaceNotificationPublisher()).toBe(unregister);
    const title = { cs: "Nová rezervace", en: "New booking" };

    expect(
      emitWorkspaceNotificationEvent({
        tenantId: new mongoose.Types.ObjectId().toString(),
        eventType: WORKSPACE_NOTIFICATION_EVENT.BOOKING_CREATED,
        severity: WORKSPACE_NOTIFICATION_SEVERITY.INFO,
        title,
        message: { cs: "Rezervace vznikla", en: "Booking created" },
        sourceType: "booking",
        sourceId: "booking-1",
        deduplicationKey: "booking.created:booking-1:v1",
      }),
    ).toBe(true);

    expect(publisherMocks.publishSafely).toHaveBeenCalledTimes(1);
    expect(publisherMocks.publishSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        title: { cs: "Nová rezervace", en: "New booking" },
      }),
    );

    title.en = "mutated after emit";
    expect(publisherMocks.publishSafely.mock.calls[0]?.[0].title.en).toBe(
      "New booking",
    );
  });
});
