import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRunnablePage: vi.fn(), claimEventScan: vi.fn(), completeEventScan: vi.fn(),
  releaseRun: vi.fn(), bookingFind: vi.fn(), orderFind: vi.fn(), tenantFind: vi.fn(),
  settingsFind: vi.fn(), materialize: vi.fn(),
}));
vi.mock("@/config/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/modules/booking/booking.model.js", () => ({ default: { find: mocks.bookingFind } }));
vi.mock("@/modules/order/order.model.js", () => ({ default: { find: mocks.orderFind } }));
vi.mock("@/modules/pottery-piece/pottery-piece.model.js", () => ({ PotteryPiece: {} }));
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/modules/tenants/tenant.model.js", () => ({ default: { find: mocks.tenantFind } }));
vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationSettingsModel: { find: mocks.settingsFind },
}));
vi.mock("@/modules/communication-automations/communication-automation.repository.js", () => ({
  communicationAutomationRepository: mocks,
}));
vi.mock("@/modules/communication-automations/services/communication-automation-delivery.service.js", () => ({
  materializeAutomationDeliveries: mocks.materialize,
}));

import { runAutomatedCommunications } from "@/modules/communication-automations/services/communication-automation-runner.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const locationId = "507f1f77bcf86cd799439012";
const now = new Date("2026-10-12T10:05:00Z");
const paidAt = new Date("2026-10-12T10:00:00Z");
const order = {
  _id: "507f1f77bcf86cd799439015", tenant: tenantId, isPaid: true, paidAt,
  status: "processed_order", createdBy: { _id: "507f1f77bcf86cd799439016", email: "customer@example.com" },
};
const booking = {
  _id: "507f1f77bcf86cd799439013", tenant: tenantId, location: locationId,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  start: new Date("2026-10-31T05:00:00Z"), end: new Date("2026-10-31T07:00:00Z"),
  tag: "class", paymentStatus: "CONFIRMED", status: "processed", orders: [order._id],
};
const automation = {
  _id: "507f1f77bcf86cd799439014", tenant: tenantId,
  scheduleType: "afterBookingCreated", minutesOffset: 2, connectedProductType: "booking",
  appliesToAllLocations: false, location: locationId,
  activatedAt: new Date("2026-10-12T09:00:00Z"),
  lastRunAt: new Date("2026-10-12T10:04:00Z"),
};
const chain = (values: unknown[]) => {
  const query: any = { lean: vi.fn().mockResolvedValue(values) };
  for (const method of ["select", "sort", "limit", "populate"]) {
    query[method] = vi.fn().mockReturnValue(query);
  }
  return query;
};

describe("booking automation scanning", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listRunnablePage.mockResolvedValue([automation]);
    mocks.claimEventScan.mockResolvedValue(automation);
    mocks.tenantFind.mockReturnValue(chain([{ _id: tenantId }]));
    mocks.settingsFind.mockReturnValue(chain([]));
    mocks.bookingFind.mockReturnValue(chain([booking]));
    mocks.orderFind.mockReturnValue(chain([order]));
    mocks.materialize.mockResolvedValue({ queued: 1, suppressed: 0, existing: 0 });
  });

  it("queues a new customer's paid booking into an old class, with payment and activation gates", async () => {
    expect(await runAutomatedCommunications(now)).toMatchObject({ queued: 1, failed: 0 });
    expect(mocks.bookingFind).toHaveBeenCalledWith(expect.objectContaining({
      tenant: tenantId, location: locationId, archive: { $ne: true },
      status: { $nin: ["cancelled", "canceled"] }, paymentStatus: "CONFIRMED", orders: order._id,
    }));
    expect(mocks.orderFind).toHaveBeenCalledWith(expect.objectContaining({
      tenant: tenantId, isPaid: true, status: "processed_order",
      paidAt: { $gte: automation.activatedAt, $gt: expect.any(Date), $lte: new Date("2026-10-12T10:03:00Z") },
      $or: expect.arrayContaining([{ updatedAt: { $gt: new Date("2026-10-12T09:59:00Z") } }]),
    }));
    expect(mocks.materialize).toHaveBeenCalledWith(expect.objectContaining({
      scheduledFor: new Date("2026-10-12T10:02:00Z"),
      occurrenceKey: `afterBookingCreated:${booking._id}:${order._id}:${paidAt.toISOString()}`,
      booking: expect.objectContaining({ orders: [order] }),
      source: expect.objectContaining({ entityType: "booking", scheduledAt: paidAt, orderId: order._id }),
    }));
  });

  it("keeps the order occurrence key stable across repeated scans and session reschedules", async () => {
    await runAutomatedCommunications(now);
    const firstKey = mocks.materialize.mock.calls[0][0].occurrenceKey;
    mocks.bookingFind.mockReturnValue(chain([{
      ...booking, start: new Date("2026-11-01T05:00:00Z"), end: new Date("2026-11-01T07:00:00Z"),
    }]));
    mocks.materialize.mockResolvedValue({ queued: 0, suppressed: 0, existing: 1 });
    expect(await runAutomatedCommunications(now)).toMatchObject({ queued: 0, skipped: 1 });
    expect(mocks.materialize.mock.calls[1][0].occurrenceKey).toBe(firstKey);
  });

  it("does not materialize confirmations before their delay or without a valid payment timestamp", async () => {
    mocks.orderFind.mockReturnValue(chain([
      { ...order, paidAt: new Date("2026-10-12T10:04:00Z") },
      { ...order, paidAt: undefined },
    ]));
    expect(await runAutomatedCommunications(now)).toMatchObject({ queued: 0, skipped: 2 });
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("keeps different customers and orders separate for the same session", async () => {
    const secondOrder = { ...order, _id: "507f1f77bcf86cd799439017", createdBy: {
      _id: "507f1f77bcf86cd799439018", email: "other@example.com",
    } };
    mocks.orderFind.mockReturnValue(chain([order, secondOrder]));
    expect(await runAutomatedCommunications(now)).toMatchObject({ queued: 2 });
    const [first, second] = mocks.materialize.mock.calls.map(([input]) => input);
    expect(first.occurrenceKey).not.toBe(second.occurrenceKey);
    expect(first.booking.orders).toEqual([order]);
    expect(second.booking.orders).toEqual([secondOrder]);
  });

  it.each([
    ["workshop", ["open-studio", "workshop"]],
    ["course", ["class", "course"]],
    ["private-session", ["private-studio", "private-session"]],
  ])("includes current and historical booking tags for the %s filter", async (type, tags) => {
    const filtered = { ...automation, connectedProductType: type };
    mocks.listRunnablePage.mockResolvedValue([filtered]);
    mocks.claimEventScan.mockResolvedValue(filtered);
    await runAutomatedCommunications(now);
    expect(mocks.bookingFind).toHaveBeenCalledWith(expect.objectContaining({ tag: { $in: tags } }));
  });

  it("preserves the existing afterBooking session-end anchor", async () => {
    const afterSession = { ...automation, scheduleType: "afterBooking" };
    mocks.listRunnablePage.mockResolvedValue([afterSession]);
    mocks.claimEventScan.mockResolvedValue(afterSession);
    mocks.bookingFind.mockReturnValue(chain([{ ...booking, end: paidAt }]));
    await runAutomatedCommunications(now);
    const query = mocks.bookingFind.mock.calls[0][0];
    expect(query).toHaveProperty("end");
    expect(query).not.toHaveProperty("createdAt");
    expect(mocks.materialize).toHaveBeenCalledWith(expect.objectContaining({
      scheduledFor: new Date("2026-10-12T10:02:00Z"),
      occurrenceKey: `afterBooking:${booking._id}:${paidAt.toISOString()}`,
    }));
  });

  it.each(["beforeBooking", "afterBooking", "afterBookingCreated"])(
    "does not enqueue migration-suppressed bookings for %s", async (scheduleType) => {
      const selected = { ...automation, scheduleType };
      mocks.listRunnablePage.mockResolvedValue([selected]);
      mocks.claimEventScan.mockResolvedValue(selected);
      const imported = {
        ...booking,
        start: scheduleType === "beforeBooking"
          ? new Date("2026-10-12T10:06:00Z") : new Date("2026-10-12T09:00:00Z"),
        end: scheduleType === "beforeBooking"
          ? new Date("2026-10-12T11:00:00Z") : paidAt,
        atelierKleiMigration: { suppressHistoricalNotifications: true },
      };
      mocks.bookingFind.mockImplementation((query) => chain(
        query["atelierKleiMigration.suppressHistoricalNotifications"]?.$ne === true
          ? [] : [imported],
      ));

      expect(await runAutomatedCommunications(now)).toMatchObject({ queued: 0, failed: 0 });
      expect(mocks.bookingFind).toHaveBeenCalled();
      expect(mocks.materialize).not.toHaveBeenCalled();
      expect(mocks.completeEventScan).toHaveBeenCalled();
    },
  );
});
