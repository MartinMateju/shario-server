import { describe, expect, it, vi } from "vitest";
import type { CommunicationEmailLogDocument } from "@/modules/communication-email-logs/communication-email-log.types.js";

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  markQueued: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({ logger: { error: mocks.error } }));
vi.mock("@/infrastructure/queues/communication-email.queue.js", () => {
  throw new Error("Queue connection could not initialize");
});
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.repository.js",
  () => ({ communicationEmailLogRepository: { markQueued: mocks.markQueued } }),
);

import { dispatchBookingLifecycleEmailSafely } from "@/modules/booking/services/booking.customer-notification.service.js";

describe("booking lifecycle queue initialization", () => {
  it("keeps a committed email recoverable when the queue module cannot initialize", async () => {
    const log = {
      _id: "email-1",
      tenant: "tenant-1",
      user: "customer-1",
      relatedEntityId: "booking-1",
      deduplicationKey: "dedupe-1",
      status: "scheduled",
    } as unknown as CommunicationEmailLogDocument;

    await expect(
      dispatchBookingLifecycleEmailSafely(log),
    ).resolves.toBeUndefined();

    expect(mocks.markQueued).not.toHaveBeenCalled();
    expect(log.status).toBe("scheduled");
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tenantId: "tenant-1",
        emailLogId: "email-1",
      }),
      "Booking lifecycle email is persisted; queue recovery will retry dispatch.",
    );
  });
});
