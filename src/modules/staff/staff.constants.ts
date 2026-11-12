// staff.constants.ts

export const STAFF_ROLE = {
  OWNER: "owner",
  MANAGER: "manager",
  INSTRUCTOR: "instructor",
  TECHNICIAN: "technician",
  BARISTA: "barista",
  RECEPTIONIST: "receptionist",
  ASSISTANT: "assistant",
  OTHER: "other",
} as const;

export type StaffRole = (typeof STAFF_ROLE)[keyof typeof STAFF_ROLE];
export const STAFF_ROLES = Object.values(STAFF_ROLE);

export const EMPLOYMENT_TYPE = {
  EMPLOYEE: "employee",
  CONTRACTOR: "contractor",
  OWNER: "owner",
  VOLUNTEER: "volunteer",
} as const;

export type EmploymentType =
  (typeof EMPLOYMENT_TYPE)[keyof typeof EMPLOYMENT_TYPE];

export const EMPLOYMENT_TYPES = Object.values(EMPLOYMENT_TYPE);

export const STAFF_TASK_STATUS = {
  TODO: "todo",
  IN_PROGRESS: "in-progress",
  WAITING: "waiting",
  // Legacy value retained for existing records and explicit blockers.
  DONE: "done",
  BLOCKED: "blocked",
} as const;

export type StaffTaskStatus =
  (typeof STAFF_TASK_STATUS)[keyof typeof STAFF_TASK_STATUS];

export const STAFF_TASK_STATUSES = Object.values(STAFF_TASK_STATUS);

export const STAFF_TASK_PRIORITY = {
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
  URGENT: "urgent",
} as const;

export type StaffTaskPriority =
  (typeof STAFF_TASK_PRIORITY)[keyof typeof STAFF_TASK_PRIORITY];

export const STAFF_TASK_PRIORITIES = Object.values(STAFF_TASK_PRIORITY);

export const STAFF_TASK_CATEGORY = {
  GENERAL: "general",
  CLEANING: "cleaning",
  BOOKINGS: "bookings",
  ORDERS: "orders",
  INVENTORY: "inventory",
  CUSTOMER_SUPPORT: "customer-support",
} as const;

export type StaffTaskCategory =
  (typeof STAFF_TASK_CATEGORY)[keyof typeof STAFF_TASK_CATEGORY];

export const STAFF_TASK_CATEGORIES = Object.values(STAFF_TASK_CATEGORY);

export const STAFF_TASK_LINK_TYPE = {
  BOOKING: "booking",
  COURSE: "course",
  CUSTOMER: "customer",
  INVENTORY_ITEM: "inventory-item",
  REORDER_REQUEST: "reorder-request",
} as const;

export type StaffTaskLinkType =
  (typeof STAFF_TASK_LINK_TYPE)[keyof typeof STAFF_TASK_LINK_TYPE];

export const STAFF_TASK_LINK_TYPES = Object.values(STAFF_TASK_LINK_TYPE);

export const STAFF_ATTENTION_STATUS = {
  NONE: "none",
  NEEDS_ATTENTION: "needs-attention",
  ACKNOWLEDGED: "acknowledged",
  RESOLVED: "resolved",
} as const;

export const STAFF_ATTENTION_STATUSES = Object.values(STAFF_ATTENTION_STATUS);

export const DEFAULT_PLANNING_WEEKDAYS = [1, 2, 3, 4, 5] as const;
export const DEFAULT_PLANNING_EXPECTED_UPDATE_TIME = "09:00";
export const MAX_WEEKLY_OUTCOMES = 3;
export const MAX_MONTHLY_PRIORITIES = 5;

export const DEFAULT_STAFF_LIMIT = 50;
export const MAX_STAFF_LIMIT = 100;

export const DEFAULT_STAFF_COLOR = "#74869a";
