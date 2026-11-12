import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../src/app/routes.ts", import.meta.url),
  "utf8",
);

describe("workspace route module gates", () => {
  const expected = [
    ["/bookings", "bookingWorkflowModule"],
    ["/users", "customersModule"],
    ["/tenant-payments/connect", "paymentsModule"],
    ["/orders", "paymentsModule"],
    ["/invoices", "paymentsModule"],
    ["/credits", "creditsModule"],
    ["/memberships", "membershipsModule"],
    ["/coupons", "vouchersModule"],
    ["/access-codes", "accessCodesModule"],
    ["/events", "coursesModule"],
    ["/supply-orders", "inventoryModule"],
    ["/inventory", "inventoryModule"],
    ["/staff-planning", "staffTasksModule"],
    ["/communication-automations", "automationsModule"],
    ["/communication-email-logs", "communicationsModule"],
    ["/communications", "communicationsModule"],
    ["/registered-sender-emails", "communicationsModule"],
    ["/email-templates", "communicationsModule"],
    ["/ai", "aiModule"],
  ] as const;

  it.each(expected)("gates %s with %s", (path, middleware) => {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(source).toMatch(
      new RegExp(
        `apiRouter\\.use\\(\\s*"${escapedPath}"\\s*,(?:\\s*requireWorkspaceSession\\s*,)?\\s*${middleware}`,
      ),
    );
  });

  it("requires communications as well as automations for automation routes", () => {
    expect(source).toMatch(
      /apiRouter\.use\(\s*"\/communication-automations"\s*,\s*requireWorkspaceSession\s*,\s*automationsModule\s*,\s*communicationsModule/,
    );
  });

  it("keeps customer history routes before the subscription boundary", () => {
    const boundary = source.indexOf(
      "apiRouter.use(verifyJWT, requireTenantSubscriptionAccess)",
    );

    expect(boundary).toBeGreaterThan(-1);
    for (const router of [
      "customerBookingRouter",
      "customerInvoiceRouter",
      "customerOrderRouter",
      "customerMembershipRouter",
      "customerCouponRouter",
    ]) {
      const index = source.lastIndexOf(router);
      expect(index, `${router} mount`).toBeGreaterThan(-1);
      expect(index).toBeLessThan(boundary);
    }
  });
});

