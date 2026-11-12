import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(process.cwd(), "src/modules/user/user.routes.ts"),
  "utf8",
);

describe("customer admin route contract", () => {
  it("requires both customer and booking visibility for customer history", () => {
    expect(source).toContain(
      "const canViewUsers = requirePermission(WORKSPACE_PERMISSION.CUSTOMERS_VIEW)",
    );
    expect(source).toContain(
      "const canViewBookings = requirePermission(WORKSPACE_PERMISSION.BOOKINGS_VIEW)",
    );
    expect(source).toMatch(
      /"\/:id\/bookings",\s*canViewUsers,\s*canViewBookings,\s*getCustomerBookingHistory/s,
    );
  });

  it("registers canonical by-id routes before the legacy two-parameter lookup", () => {
    const history = source.indexOf('"/:id/bookings"');
    const detail = source.indexOf('"/:id"');
    const legacy = source.indexOf('"/:customId/:userId"');

    expect(history).toBeGreaterThan(-1);
    expect(detail).toBeGreaterThan(-1);
    expect(history).toBeLessThan(legacy);
    expect(detail).toBeLessThan(legacy);
  });
});
