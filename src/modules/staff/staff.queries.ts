export const STAFF_MEMBER_POPULATE = [
  { path: "user", select: "firstname lastname email customId" },
  { path: "locations", select: "name slug code" },
  { path: "createdBy", select: "firstname lastname email customId" },
  { path: "updatedBy", select: "firstname lastname email customId" },
] as const;

export const STAFF_TASK_POPULATE = [
  { path: "assignedTo", select: "firstname lastname email customId" },
  { path: "createdBy", select: "firstname lastname email customId" },
  { path: "location", select: "name slug code" },
] as const;
