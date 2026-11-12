import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dailyUpdateMany: vi.fn(),
  weeklyUpdateMany: vi.fn(),
  monthlyUpdateMany: vi.fn(),
  dailySession: vi.fn(),
  weeklySession: vi.fn(),
  monthlySession: vi.fn(),
}));

vi.mock("@/modules/staff/staff-planning.models.js", () => ({
  StaffDailyUpdateModel: { updateMany: mocks.dailyUpdateMany },
  StaffWeeklyPlanModel: { updateMany: mocks.weeklyUpdateMany },
  StaffMonthlyPrioritySetModel: { updateMany: mocks.monthlyUpdateMany },
}));

import { unlinkStaffTaskFromPlanning } from "@/modules/staff/staff-planning-links.service.js";

describe("staff planning task-link cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dailySession.mockResolvedValue({ modifiedCount: 1 });
    mocks.weeklySession.mockResolvedValue({ modifiedCount: 2 });
    mocks.monthlySession.mockResolvedValue({ modifiedCount: 3 });
    mocks.dailyUpdateMany.mockReturnValue({ session: mocks.dailySession });
    mocks.weeklyUpdateMany.mockReturnValue({ session: mocks.weeklySession });
    mocks.monthlyUpdateMany.mockReturnValue({ session: mocks.monthlySession });
  });

  it("tenant-scopes and removes a deleted task from every planning surface", async () => {
    const session = { id: "session-a" } as any;
    const result = await unlinkStaffTaskFromPlanning({
      tenantId: "tenant-a",
      taskId: "507f1f77bcf86cd799439011",
      session,
    });

    expect(mocks.dailyUpdateMany).toHaveBeenCalledWith(
      {
        tenantId: "tenant-a",
        linkedTaskIds: "507f1f77bcf86cd799439011",
      },
      { $pull: { linkedTaskIds: "507f1f77bcf86cd799439011" } },
    );
    expect(mocks.weeklyUpdateMany).toHaveBeenCalledWith(
      {
        tenantId: "tenant-a",
        "outcomes.linkedTaskIds": "507f1f77bcf86cd799439011",
      },
      {
        $pull: {
          "outcomes.$[].linkedTaskIds": "507f1f77bcf86cd799439011",
        },
      },
    );
    expect(mocks.monthlyUpdateMany).toHaveBeenCalledWith(
      {
        tenantId: "tenant-a",
        "priorities.linkedTaskIds": "507f1f77bcf86cd799439011",
      },
      {
        $pull: {
          "priorities.$[].linkedTaskIds":
            "507f1f77bcf86cd799439011",
        },
      },
    );
    expect(mocks.dailySession).toHaveBeenCalledWith(session);
    expect(mocks.weeklySession).toHaveBeenCalledWith(session);
    expect(mocks.monthlySession).toHaveBeenCalledWith(session);
    expect(result).toEqual({ daily: 1, weekly: 2, monthly: 3 });
  });
});
