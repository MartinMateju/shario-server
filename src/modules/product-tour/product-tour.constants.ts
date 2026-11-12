export const PRODUCT_TOUR_VERSION = 1;

export const PRODUCT_TOUR_STATUS = {
  COMPLETED: "completed",
  SKIPPED: "skipped",
} as const;

export const PRODUCT_TOUR_STATUSES = Object.freeze(
  Object.values(PRODUCT_TOUR_STATUS),
);

export const PRODUCT_TOUR_STEP = {
  OVERVIEW: "overview",
  LAUNCH_CENTER: "launch_center",
  STUDIO_SWITCHER: "studio_switcher",
  NAVIGATION: "navigation",
  AI_ASSISTANT: "ai_assistant",
  SETTINGS: "settings",
} as const;

export const PRODUCT_TOUR_STEPS = Object.freeze(
  Object.values(PRODUCT_TOUR_STEP),
);

export const PRODUCT_TOUR_ENTRY_POINT = {
  AUTOMATIC: "automatic",
  HELP_REPLAY: "help_replay",
} as const;

export const PRODUCT_TOUR_ENTRY_POINTS = Object.freeze(
  Object.values(PRODUCT_TOUR_ENTRY_POINT),
);

export type ProductTourStatus =
  (typeof PRODUCT_TOUR_STATUS)[keyof typeof PRODUCT_TOUR_STATUS];
export type ProductTourStep =
  (typeof PRODUCT_TOUR_STEP)[keyof typeof PRODUCT_TOUR_STEP];
export type ProductTourEntryPoint =
  (typeof PRODUCT_TOUR_ENTRY_POINT)[keyof typeof PRODUCT_TOUR_ENTRY_POINT];
