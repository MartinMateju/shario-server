export const EVENT_TYPE = {
  TEAM_BUILDING: "team_building",
  PARTY: "party",
  PRIVATE_WORKSHOP: "private_workshop",
  SCHOOL_GROUP: "school_group",
  CORPORATE: "corporate",
  POPUP: "popup",
  OTHER: "other",
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

export const EVENT_STATUS = {
  INQUIRY: "inquiry",
  PLANNED: "planned",
  CONFIRMED: "confirmed",
  DEPOSIT_PAID: "deposit_paid",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

export const EVENT_TYPES = Object.values(EVENT_TYPE) as [EventType, ...EventType[]];
export const EVENT_STATUSES = Object.values(EVENT_STATUS) as [EventStatus, ...EventStatus[]];

export const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DEFAULT_EVENT_PAGE = 1;
export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 100;
