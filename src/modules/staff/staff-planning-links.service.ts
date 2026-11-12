import type { ClientSession } from "mongoose";

import {
  StaffDailyUpdateModel,
  StaffMonthlyPrioritySetModel,
  StaffWeeklyPlanModel,
} from "./staff-planning.models.js";

export const unlinkStaffTaskFromPlanning = async ({
  tenantId,
  taskId,
  session,
}: {
  tenantId: string;
  taskId: string;
  session: ClientSession;
}) => {
  const daily = await StaffDailyUpdateModel.updateMany(
    { tenantId, linkedTaskIds: taskId },
    { $pull: { linkedTaskIds: taskId } },
  ).session(session);
  const weekly = await StaffWeeklyPlanModel.updateMany(
    { tenantId, "outcomes.linkedTaskIds": taskId },
    { $pull: { "outcomes.$[].linkedTaskIds": taskId } },
  ).session(session);
  const monthly = await StaffMonthlyPrioritySetModel.updateMany(
    { tenantId, "priorities.linkedTaskIds": taskId },
    { $pull: { "priorities.$[].linkedTaskIds": taskId } },
  ).session(session);

  return {
    daily: daily.modifiedCount,
    weekly: weekly.modifiedCount,
    monthly: monthly.modifiedCount,
  };
};
