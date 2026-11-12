import { describe, expect, it } from "vitest";

import {
  getAllowedLegacyCourseReminderUsers,
  getEligibleLegacyCourseReminderUsers,
} from "@/modules/access-codes/services/access-code-reminder-policy.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const OTHER_TENANT_ID = "507f1f77bcf86cd799439012";

const user = (
  id: string,
  overrides: Record<string, unknown> = {},
) => ({
  _id: id,
  tenant: TENANT_ID,
  tenantRole: "customer",
  isAccessGranted: true,
  firstname: "Ada",
  email: `${id}@example.com`,
  ...overrides,
});

const order = (
  id: string,
  overrides: Record<string, unknown> = {},
) => ({
  tenant: TENANT_ID,
  isPaid: true,
  createdBy: user(id),
  ...overrides,
});

describe("legacy course reminder delivery policy", () => {
  it("does not remind a paid purchaser after all their attendance places were removed", () => {
    const orders = [order("removed", { _id: "order-removed" }), order("active", { _id: "order-active" })];
    const booking = {
      attendanceManaged: true,
      participants: [
        { order: "order-removed", attendanceStatus: "removed" },
        { order: "order-active", attendanceStatus: "removed" },
        { order: "order-active", attendanceStatus: "active" },
        { name: "Manual guest" },
      ],
    };
    expect(getEligibleLegacyCourseReminderUsers({ tenantId: TENANT_ID, orders, booking }).map((entry) => entry._id)).toEqual(["active"]);
    expect(getEligibleLegacyCourseReminderUsers({ tenantId: TENANT_ID, orders }).map((entry) => entry._id)).toEqual(["removed", "active"]);
  });
  it("keeps only paid, same-tenant customers with active access", () => {
    const eligible = getEligibleLegacyCourseReminderUsers({
      tenantId: TENANT_ID,
      orders: [
        order("eligible", {
          createdBy: user("eligible", { email: " ADA@Example.com " }),
        }),
        order("unpaid", { isPaid: false }),
        order("foreign-order", { tenant: OTHER_TENANT_ID }),
        order("foreign-user", {
          createdBy: user("foreign-user", { tenant: OTHER_TENANT_ID }),
        }),
        order("staff", {
          createdBy: user("staff", { tenantRole: "staff" }),
        }),
        order("blocked", {
          createdBy: user("blocked", { isAccessGranted: false }),
        }),
        order("duplicate", {
          createdBy: user("duplicate", { email: "ada@example.com" }),
        }),
      ],
    });

    expect(eligible).toEqual([
      expect.objectContaining({ _id: "eligible", email: "ada@example.com" }),
    ]);
  });

  it("honors active suppressions and revoked or expired transactional consent", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const users = [
      user("allowed"),
      user("revoked"),
      user("expired"),
      user("suppressed", { email: "SUPPRESSED@example.com" }),
    ];

    const allowed = getAllowedLegacyCourseReminderUsers({
      users,
      consents: [
        { customerId: "revoked", status: "revoked" },
        {
          customerId: "expired",
          status: "granted",
          expiresAt: "2026-07-31T11:59:59.000Z",
        },
      ],
      suppressions: [
        { identity: "suppressed@example.com", active: true },
      ],
      now,
    });

    expect(allowed.map((item) => item._id)).toEqual(["allowed"]);
  });

  it("does not treat an inactive suppression as a block", () => {
    const users = [user("allowed")];
    expect(
      getAllowedLegacyCourseReminderUsers({
        users,
        consents: [],
        suppressions: [
          { identity: "allowed@example.com", active: false },
        ],
      }),
    ).toEqual(users);
  });
});
