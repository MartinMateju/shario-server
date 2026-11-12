export const LOCATION_ACTIVITY = {
  WORKSTATION: "WORKSTATION",
  SHARED_TABLE: "SHARED_TABLE",
  GENERAL: "GENERAL",
} as const;

export type LocationActivity =
  (typeof LOCATION_ACTIVITY)[keyof typeof LOCATION_ACTIVITY];

export const LOCATION_ACTIVITIES = Object.values(LOCATION_ACTIVITY) as [
  LocationActivity,
  ...LocationActivity[],
];

export const LOCATION_ACTIVITY_SELECTION_MODE = {
  REQUIRED: "REQUIRED",
  OPTIONAL: "OPTIONAL",
  HIDDEN: "HIDDEN",
} as const;

export type LocationActivitySelectionMode =
  (typeof LOCATION_ACTIVITY_SELECTION_MODE)[keyof typeof LOCATION_ACTIVITY_SELECTION_MODE];

export const LOCATION_ACTIVITY_SELECTION_MODES = Object.values(
  LOCATION_ACTIVITY_SELECTION_MODE,
) as [LocationActivitySelectionMode, ...LocationActivitySelectionMode[]];

/** New locations ask customers to choose an activity unless configured otherwise. */
export const DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE =
  LOCATION_ACTIVITY_SELECTION_MODE.REQUIRED;

/** Missing historical values retain the pre-setting behavior. */
export const LEGACY_LOCATION_ACTIVITY_SELECTION_MODE =
  LOCATION_ACTIVITY_SELECTION_MODE.OPTIONAL;

export const WEEKDAY = {
  MONDAY: "monday",
  TUESDAY: "tuesday",
  WEDNESDAY: "wednesday",
  THURSDAY: "thursday",
  FRIDAY: "friday",
  SATURDAY: "saturday",
  SUNDAY: "sunday",
} as const;

export type Weekday = (typeof WEEKDAY)[keyof typeof WEEKDAY];

export const WEEKDAYS = Object.values(WEEKDAY) as [Weekday, ...Weekday[]];

export const SLOT_STEP_MINUTES = [15, 30, 60] as const;

export type SlotStepMinutes = (typeof SLOT_STEP_MINUTES)[number];

export const DEFAULT_TIMEZONE = "Europe/Prague";
export const DEFAULT_COUNTRY = "CZ";

export const DEFAULT_LOCATION_PAGE = 1;
export const DEFAULT_LOCATION_LIMIT = 50;
export const MAX_LOCATION_LIMIT = 100;
