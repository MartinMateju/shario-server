import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import {
  assertRecoveryApproval,
  maskRecoveryRecipient,
  notificationRecoveryWrite,
  parseNotificationRecoveryArgs,
  planNotificationRecovery,
  type RecoveryDocument,
  type RecoverySelection,
} from "@/modules/order/order.notification-recovery.js";

const tenant = new mongoose.Types.ObjectId();
const id = new mongoose.Types.ObjectId();
const now = new Date("2026-10-19T12:00:00Z");
const selection: RecoverySelection = {
  orderId: String(id),
  reason: "smtp-loopback-refused",
};
const order = (overrides: RecoveryDocument = {}): RecoveryDocument => ({
  _id: id,
  tenant,
  isPaid: true,
  status: "processed_order",
  legacyOrder: false,
  paidAt: new Date("2026-10-10T09:00:00Z"),
  grossAmountMinor: 300000,
  currency: "CZK",
  createdBy: new mongoose.Types.ObjectId(),
  customer: { email: "changed@example.test" },
  credits: { appliedMajor: 3000 },
  paymentAllocations: [{ method: "credits", amountMinor: 300000 }],
  notificationLog: [
    {
      type: "order_confirm",
      status: "FAILED",
      attempt: 3,
      error: "connect ECONNREFUSED 127.0.0.1:1025",
      provider: "exhausted",
      to: "original@example.test",
      sentAt: new Date("2026-10-10T10:00:00Z"),
    },
  ],
  ...overrides,
});
const plan = (row = order(), selected = selection) =>
  planNotificationRecovery({
    tenantId: String(tenant),
    selections: [selected],
    orders: [row],
    now,
  });

describe("controlled order confirmation recovery", () => {
  it("plans only the exact exhausted loopback failure and masks the pinned attempted recipient", () => {
    const row = order();
    const before = JSON.stringify(row);
    const result = plan(row);
    expect(result.counts).toEqual({ requested: 1, eligible: 1, rejected: 0 });
    expect(result.candidates[0]).toMatchObject({
      paidAt: "2026-10-10T09:00:00.000Z",
      paymentMethods: ["credits"],
      recipientMasked: "o***@e***.test",
      amountMinor: 300000,
    });
    expect(result.operations[0].to).toBe("original@example.test");
    expect(JSON.stringify(result.candidates)).not.toContain(
      "original@example.test",
    );
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([
    ["legacy", { legacyOrder: true }],
    ["unpaid", { isPaid: false }],
    ["pending", { status: "pending_order" }],
    ["undated", { paidAt: null }],
    ["recovered", { notificationRecovery: { id: "earlier" } }],
    [
      "locked",
      { notificationLock: { lockedUntil: new Date(now.getTime() + 1000) } },
    ],
    ["foreign", { tenant: new mongoose.Types.ObjectId() }],
  ])("rejects %s orders", (_name, override) => {
    expect(plan(order(override as RecoveryDocument)).counts.eligible).toBe(0);
  });

  it.each([
    { status: "SENT" },
    { status: "UNKNOWN" },
    { status: "AMBIGUOUS" },
    { status: "PROCESSING" },
    { attempt: 2 },
    { attempt: 4 },
    { provider: "resend" },
    { providerMessageId: "accepted-1" },
    { providerStartedAt: now },
    { error: "socket timeout" },
    { error: "EAUTH" },
    { error: "connect ECONNREFUSED 127.0.0.1:25" },
    { error: "connect ECONNREFUSED 127.0.0.1:1025; accepted earlier" },
  ])("rejects an unproven or ineligible failure %j", (changes) => {
    const row = order();
    Object.assign(row.notificationLog[0], changes);
    expect(plan(row).counts.eligible).toBe(0);
  });

  it("rejects duplicate confirmation entries and any historical sent/uncertain event", () => {
    for (const extra of [
      { ...order().notificationLog[0] },
      { type: "course_confirm", status: "SENT" },
      { type: "workshop_confirm", status: "UNKNOWN" },
    ]) {
      const row = order();
      row.notificationLog.push(extra);
      expect(plan(row).counts.eligible).toBe(0);
    }
  });

  it("requires the separate explicit piece selection for an unsent paid piece order", () => {
    const row = order({
      pieceCheckout: {
        state: "paid",
        method: "credits",
        refundedAmountMinor: 0,
      },
      notificationLog: [],
    });
    expect(plan(row).counts.eligible).toBe(0);
    expect(
      plan(row, { ...selection, reason: "piece-confirmation-missing" }).counts
        .eligible,
    ).toBe(1);
    for (const override of [
      { state: "pending" },
      { state: "refunded" },
      { refundedAmountMinor: 1 },
    ]) {
      expect(
        plan(
          { ...row, pieceCheckout: { ...row.pieceCheckout, ...override } },
          { ...selection, reason: "piece-confirmation-missing" },
        ).counts.eligible,
      ).toBe(0);
    }
    expect(
      plan(order(), { ...selection, reason: "piece-confirmation-missing" })
        .counts.eligible,
    ).toBe(0);
  });

  it("uses a tenant-scoped user fallback only when no valid snapshot recipient exists", () => {
    const row = order({
      customer: {},
      notificationLog: [],
      pieceCheckout: { state: "paid", method: "credits" },
    });
    const result = planNotificationRecovery({
      tenantId: String(tenant),
      selections: [{ ...selection, reason: "piece-confirmation-missing" }],
      orders: [row],
      userEmails: new Map([[String(row.createdBy), "buyer@example.test"]]),
      now,
    });
    expect(result.operations[0].to).toBe("buyer@example.test");
    expect(
      plan(row, { ...selection, reason: "piece-confirmation-missing" }).counts
        .eligible,
    ).toBe(0);
  });

  it("preserves every failed event in the audit snapshot and other active events in place", () => {
    const row = order();
    row.notificationLog.push({
      type: "course_confirm",
      status: "FAILED",
      attempt: 1,
    });
    const result = plan(row);
    const write = notificationRecoveryWrite(result.operations[0], {
      tenantId: String(tenant),
      approvalToken: result.approvalToken,
      now,
    });
    expect(write.update.$set.notificationRecovery).toMatchObject({
      requestedAt: now,
      expiresAt: new Date("2026-10-20T12:00:00Z"),
      to: "original@example.test",
      previousEvents: [row.notificationLog[0]],
    });
    expect(write.update.$set.notificationLog).toEqual([row.notificationLog[1]]);
    expect(write.filter.$and).toContainEqual({
      notificationLog: { $eq: row.notificationLog },
    });
    expect(write.filter.tenant).toEqual(tenant);
  });

  it("requires an exact current dry-run token and refuses a partly ineligible selection", () => {
    const row = order();
    const reviewed = plan(row);
    expect(() =>
      assertRecoveryApproval(reviewed, reviewed.approvalToken),
    ).not.toThrow();
    expect(() => assertRecoveryApproval(reviewed, "wrong")).toThrow(/token/);
    const changed = plan({
      ...row,
      customer: { email: "another@example.test" },
    });
    expect(() =>
      assertRecoveryApproval(changed, reviewed.approvalToken),
    ).toThrow(/token/);
    const rejected = plan(order({ isPaid: false }));
    expect(() =>
      assertRecoveryApproval(rejected, rejected.approvalToken),
    ).toThrow(/every/);
  });

  it("requires explicit IDs/tenant, defaults to dry-run, and rejects duplicate/unknown arguments", () => {
    const args = ["--tenant-id", String(tenant), "--order-id", String(id)];
    expect(parseNotificationRecoveryArgs(args).apply).toBe(false);
    expect(() => parseNotificationRecoveryArgs([])).toThrow(/tenant/);
    expect(() =>
      parseNotificationRecoveryArgs(["--tenant-id", String(tenant)]),
    ).toThrow(/explicit/);
    expect(() => parseNotificationRecoveryArgs([...args, "--apply"])).toThrow(
      /approve-plan/,
    );
    expect(() =>
      parseNotificationRecoveryArgs([...args, "--order-id", String(id)]),
    ).toThrow(/Duplicate/);
    expect(() => parseNotificationRecoveryArgs([...args, "--all"])).toThrow(
      /Unsupported/,
    );
    expect(maskRecoveryRecipient("a@b.cz")).toBe("a***@b***.cz");
  });
});
