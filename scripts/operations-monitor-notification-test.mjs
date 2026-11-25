// Sends one clearly marked test to the explicitly configured owner. This does
// not poll production, change monitor state, or modify any customer records.
import { createHash } from "node:crypto";
import {
  MonitorError,
  readNotificationConfiguration,
  sendNotification,
} from "./operations-monitor.mjs";

try {
  const config = readNotificationConfiguration();
  const now = new Date().toISOString();
  await sendNotification(config, {
    kind: "test",
    startedAt: now,
    notifications: 0,
    fingerprint: createHash("sha256")
      .update("synthetic-owner-delivery-test")
      .digest("hex"),
    failures: ["synthetic.delivery-check"],
  });
  console.log(
    "OPERATIONS_MONITOR_TEST SMTP_ACCEPTED (inbox receipt remains unverified)",
  );
} catch (error) {
  console.error(
    `OPERATIONS_MONITOR_TEST_FAILED ${error instanceof MonitorError ? error.code : "notification-failed"}`,
  );
  process.exitCode = 2;
}
