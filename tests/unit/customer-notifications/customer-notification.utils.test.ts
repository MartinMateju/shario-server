import { describe, expect, it } from "vitest";

import {
  isSafeCustomerNotificationActionUrl,
  toCustomerNotificationDailyGroupKey,
} from "@/modules/customer-notifications/customer-notification.utils.js";

describe("customer notification action URLs", () => {
  it.each([
    "",
    "/portal",
    "/portal/bookings",
    "/portal?tab=bookings",
    "/portal#latest",
    "/portal/work?id=123#piece",
  ])("accepts the portal-local path %s", (path) => {
    expect(isSafeCustomerNotificationActionUrl(path)).toBe(true);
  });

  it.each([
    "https://evil.example/portal",
    "//evil.example/portal",
    "/app/bookings",
    "/portal\\evil",
    "/portal/../app",
    "/portal/%2e%2e/app",
    "/portal/\u0000evil",
  ])("rejects unsafe path %s", (path) => {
    expect(isSafeCustomerNotificationActionUrl(path)).toBe(false);
  });

  it("buckets compatible group keys once per UTC day", () => {
    const occurredAt = new Date("2026-08-13T23:30:00.000Z");
    expect(
      toCustomerNotificationDailyGroupKey("booking.created", occurredAt),
    ).toBe("booking.created:2026-08-13");
    expect(
      toCustomerNotificationDailyGroupKey(
        "booking.created:2026-08-13",
        occurredAt,
      ),
    ).toBe("booking.created:2026-08-13");
  });
});
