import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isAccessCodeNotificationActionable,
  isAccessCodeNotificationDue,
} from "@/modules/access-codes/services/access-code-notification.service.js";

describe("access-code notification timing", () => {
  const now = new Date("2026-07-30T10:00:00.000Z");

  it("becomes due at the location-configured lead time", () => {
    expect(
      isAccessCodeNotificationDue({
        bookingStart: new Date("2026-07-30T10:15:00.000Z"),
        minutesBefore: 15,
        now,
      }),
    ).toBe(true);
    expect(
      isAccessCodeNotificationDue({
        bookingStart: new Date("2026-07-30T10:16:00.000Z"),
        minutesBefore: 15,
        now,
      }),
    ).toBe(false);
  });

  it("uses the safe default and never sends for a booking that has started", () => {
    expect(
      isAccessCodeNotificationDue({
        bookingStart: new Date("2026-07-30T10:15:00.000Z"),
        now,
      }),
    ).toBe(true);
    expect(
      isAccessCodeNotificationDue({
        bookingStart: new Date("2026-07-30T09:59:59.000Z"),
        minutesBefore: 15,
        now,
      }),
    ).toBe(false);
  });

  it("runs the guarded delivery worker every minute", () => {
    const server = fs.readFileSync(
      path.join(process.cwd(), "src/server.ts"),
      "utf8",
    );

    expect(server).toContain(
      'import { sendOutAccessCodes } from "@/modules/access-codes/jobs/access-code-notification.job.js"',
    );
    expect(server).toContain(
      'supervisor.schedule("sendOutAccessCodes", "* * * * *", sendOutAccessCodes)',
    );
  });

  it("backs off failures and never retries an ambiguous delivery", () => {
    expect(
      isAccessCodeNotificationActionable(
        {
          status: "processing",
          leaseExpiresAt: new Date(now.getTime() - 1),
          providerAttemptStartedAt: new Date(now.getTime() - 60_000),
        },
        now,
      ),
    ).toBe(false);
    expect(
      isAccessCodeNotificationActionable(
        {
          status: "failed",
          nextAttemptAt: new Date(now.getTime() + 60_000),
        },
        now,
      ),
    ).toBe(false);
    expect(
      isAccessCodeNotificationActionable(
        {
          status: "failed",
          nextAttemptAt: new Date(now.getTime() - 1),
        },
        now,
      ),
    ).toBe(true);
    expect(
      isAccessCodeNotificationActionable({ status: "delivery_unknown" }, now),
    ).toBe(false);
  });
});
