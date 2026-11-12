import { isNativeInvoicingEnabled } from "@/modules/invoice/invoice.feature.js";
import {
  PRODUCT_TOUR_STEP,
  type ProductTourStep,
} from "@/modules/product-tour/product-tour.constants.js";
import {
  WORKSPACE_GUIDE_STEP_EVENT,
  WORKSPACE_GUIDE_STEP_EVENTS,
  type WorkspaceGuideStepEvent,
} from "@/modules/workspace-guides/workspace-guide.constants.js";

export const SETUP_CENTER_DEFINITION_VERSION = 10;

export const SETUP_CENTER_PHASE = {
  LAUNCH: "launch",
  LEARNING: "learning",
} as const;

export const SETUP_STEP = {
  STUDIO: "studio",
  LOCATION: "location",
  PAYMENTS: "payments",
  BOOKABLE_OFFER: "bookable_offer",
  MEMBERSHIP: "membership",
  INVENTORY: "inventory",
  COMMUNICATIONS: "communications",
  TEAM: "team",
  PUBLIC_SITE: "public_site",
  PUBLISH: "publish",
  PRACTICE_BOOKING: "practice_booking",
} as const;

export const SETUP_STEPS = Object.freeze(Object.values(SETUP_STEP));

/**
 * Stable customer-facing order. In particular, the public website must be
 * reviewed before publication and the customer journey is always the final
 * launch checklist step.
 */
export const SETUP_STEP_ORDER = Object.freeze<readonly (typeof SETUP_STEP)[keyof typeof SETUP_STEP][]>([
  SETUP_STEP.STUDIO,
  SETUP_STEP.PAYMENTS,
  SETUP_STEP.LOCATION,
  SETUP_STEP.BOOKABLE_OFFER,
  SETUP_STEP.MEMBERSHIP,
  SETUP_STEP.INVENTORY,
  SETUP_STEP.COMMUNICATIONS,
  SETUP_STEP.TEAM,
  SETUP_STEP.PUBLIC_SITE,
  SETUP_STEP.PUBLISH,
  SETUP_STEP.PRACTICE_BOOKING,
] satisfies readonly (typeof SETUP_STEP)[keyof typeof SETUP_STEP][]);

export const SETUP_STEP_STATUS = {
  COMPLETE: "complete",
  INCOMPLETE: "incomplete",
  BLOCKED: "blocked",
  NOT_APPLICABLE: "not_applicable",
} as const;

export const SETUP_STEP_REQUIREMENT = {
  REQUIRED: "required",
  RECOMMENDED: "recommended",
  OPTIONAL: "optional",
} as const;

/**
 * Privacy-safe Launch Center product analytics. These identifiers are a closed
 * registry so clients cannot turn the audit collection into arbitrary logging.
 */
export const SETUP_LAUNCH_EVENT = {
  LAUNCH_CENTER_VIEWED: "launch_center_viewed",
  STEP_OPENED: "step_opened",
  STEP_COMPLETED: "step_completed",
  STUDIO_READY: "studio_ready",
  PUBLIC_SITE_OPENED: "public_site_opened",
  TEST_BOOKING_OPENED: "test_booking_opened",
  PRODUCT_TOUR_STARTED: "product_tour_started",
  PRODUCT_TOUR_OVERVIEW_VIEWED: "product_tour_overview_viewed",
  PRODUCT_TOUR_LAUNCH_CENTER_VIEWED: "product_tour_launch_center_viewed",
  PRODUCT_TOUR_STUDIO_SWITCHER_VIEWED: "product_tour_studio_switcher_viewed",
  PRODUCT_TOUR_NAVIGATION_VIEWED: "product_tour_navigation_viewed",
  PRODUCT_TOUR_AI_ASSISTANT_VIEWED: "product_tour_ai_assistant_viewed",
  PRODUCT_TOUR_SETTINGS_VIEWED: "product_tour_settings_viewed",
  PRODUCT_TOUR_COMPLETED: "product_tour_completed",
  PRODUCT_TOUR_SKIPPED: "product_tour_skipped",
  PRODUCT_TOUR_LAUNCH_CENTER_OPENED: "product_tour_launch_center_opened",
  CONTEXTUAL_GUIDE_STARTED: "contextual_guide_started",
  CONTEXTUAL_GUIDE_COMPLETED: "contextual_guide_completed",
  CONTEXTUAL_GUIDE_SKIPPED: "contextual_guide_skipped",
  CONTEXTUAL_GUIDE_CTA_OPENED: "contextual_guide_cta_opened",
} as const;

export const SETUP_LAUNCH_EVENTS = Object.freeze([
  ...Object.values(SETUP_LAUNCH_EVENT),
  ...WORKSPACE_GUIDE_STEP_EVENTS,
]);

export const PRODUCT_TOUR_EVENT_STEP = Object.freeze({
  [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_OVERVIEW_VIEWED]: PRODUCT_TOUR_STEP.OVERVIEW,
  [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_LAUNCH_CENTER_VIEWED]:
    PRODUCT_TOUR_STEP.LAUNCH_CENTER,
  [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_STUDIO_SWITCHER_VIEWED]:
    PRODUCT_TOUR_STEP.STUDIO_SWITCHER,
  [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_NAVIGATION_VIEWED]:
    PRODUCT_TOUR_STEP.NAVIGATION,
  [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_AI_ASSISTANT_VIEWED]:
    PRODUCT_TOUR_STEP.AI_ASSISTANT,
  [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_SETTINGS_VIEWED]: PRODUCT_TOUR_STEP.SETTINGS,
} satisfies Partial<Record<SetupLaunchEvent, ProductTourStep>>);

export const PRODUCT_TOUR_LAUNCH_EVENTS = Object.freeze([
  SETUP_LAUNCH_EVENT.PRODUCT_TOUR_STARTED,
  ...Object.keys(PRODUCT_TOUR_EVENT_STEP),
  SETUP_LAUNCH_EVENT.PRODUCT_TOUR_COMPLETED,
  SETUP_LAUNCH_EVENT.PRODUCT_TOUR_SKIPPED,
  SETUP_LAUNCH_EVENT.PRODUCT_TOUR_LAUNCH_CENTER_OPENED,
] as SetupLaunchEvent[]);

export const CONTEXTUAL_GUIDE_LAUNCH_EVENTS = Object.freeze([
  SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_STARTED,
  ...Object.keys(WORKSPACE_GUIDE_STEP_EVENT),
  SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_COMPLETED,
  SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_SKIPPED,
  SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_CTA_OPENED,
] as SetupLaunchEvent[]);

export const SETUP_LAUNCH_EVENT_SOURCE = {
  LAUNCH_CENTER: "launch_center",
  GUIDED_FORM: "guided_form",
  FINAL_REVIEW: "final_review",
  PUBLIC_SITE: "public_site",
  PRODUCT_TOUR: "product_tour",
  CONTEXTUAL_GUIDE: "contextual_guide",
} as const;

export const SETUP_LAUNCH_EVENT_SOURCES = Object.freeze(
  Object.values(SETUP_LAUNCH_EVENT_SOURCE),
);

export const SETUP_PUBLICATION_STATUS = {
  DRAFT: "draft",
  LIVE: "live",
} as const;

export const SETUP_PRACTICE_STATUS = {
  NOT_STARTED: "not_started",
  IN_PROGRESS: "in_progress",
  COMPLETE: "complete",
  ABANDONED: "abandoned",
  EXPIRED: "expired",
} as const;

export const SETUP_PRACTICE_ACTION = {
  CREATE_BOOKING: "create_booking",
  PREVIEW_INVOICE: "preview_invoice",
  PREVIEW_CONFIRMATION: "preview_confirmation",
  PREVIEW_MEMBERSHIP: "preview_membership",
  CHECK_IN: "check_in",
  CANCEL_BOOKING: "cancel_booking",
} as const;

export const SETUP_PRACTICE_ACTIONS = Object.freeze(
  Object.values(SETUP_PRACTICE_ACTION),
);

export const SETUP_PRACTICE_ACTION_ORDER = Object.freeze([
  SETUP_PRACTICE_ACTION.CREATE_BOOKING,
  SETUP_PRACTICE_ACTION.PREVIEW_INVOICE,
  SETUP_PRACTICE_ACTION.PREVIEW_CONFIRMATION,
  SETUP_PRACTICE_ACTION.PREVIEW_MEMBERSHIP,
  SETUP_PRACTICE_ACTION.CHECK_IN,
  SETUP_PRACTICE_ACTION.CANCEL_BOOKING,
]);

export const getAvailableSetupPracticeActions = () =>
  SETUP_PRACTICE_ACTION_ORDER.filter(
    (action) =>
      action !== SETUP_PRACTICE_ACTION.PREVIEW_INVOICE ||
      isNativeInvoicingEnabled(),
  );

export const SETUP_PRACTICE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * This is the only registry allowed to produce links for Launch Center and the
 * setup assistant. The client and the AI provider send step/action keys, never
 * arbitrary URLs.
 */
export const SETUP_ACTIONS = Object.freeze({
  edit_studio: {
    stepId: SETUP_STEP.STUDIO,
    href: "/app/settings?setupStep=studio",
  },
  complete_studio_profile: {
    stepId: SETUP_STEP.STUDIO,
    href: "/app/onboarding",
  },
  add_location: {
    stepId: SETUP_STEP.LOCATION,
    href: "/app/settings/locations?action=create&setupStep=location",
  },
  review_location: {
    stepId: SETUP_STEP.LOCATION,
    href: "/app/settings/locations?setupStep=location",
  },
  connect_payments: {
    stepId: SETUP_STEP.PAYMENTS,
    href: "/app/settings/payments?setupStep=payments",
  },
  create_offer: {
    stepId: SETUP_STEP.BOOKABLE_OFFER,
    href: "/app/products?action=create&setupStep=bookable_offer",
  },
  review_offer: {
    stepId: SETUP_STEP.BOOKABLE_OFFER,
    href: "/app/products?setupStep=bookable_offer",
  },
  schedule_offer: {
    stepId: SETUP_STEP.BOOKABLE_OFFER,
    href: "/app/bookings/new?setupStep=bookable_offer",
  },
  practice_booking: {
    stepId: SETUP_STEP.PRACTICE_BOOKING,
    href: "/app/setup?step=practice_booking",
  },
  configure_inventory: {
    stepId: SETUP_STEP.INVENTORY,
    href: "/app/operations?section=inventory&action=create&setupStep=inventory",
  },
  review_inventory: {
    stepId: SETUP_STEP.INVENTORY,
    href: "/app/operations?section=inventory&action=review&setupStep=inventory",
  },
  configure_communications: {
    stepId: SETUP_STEP.COMMUNICATIONS,
    href: "/app/communications?section=setup&setupStep=communications",
  },
  verify_sender: {
    stepId: SETUP_STEP.COMMUNICATIONS,
    href: "/app/communications?section=setup&setupStep=communications",
  },
  invite_team: {
    stepId: SETUP_STEP.TEAM,
    href: "/app/settings/team?action=add&setupStep=team",
  },
  review_team: {
    stepId: SETUP_STEP.TEAM,
    href: "/app/settings/team?setupStep=team",
  },
  customize_public_site: {
    stepId: SETUP_STEP.PUBLIC_SITE,
    href: "/app/settings/public-site?setupStep=public_site",
  },
  publish_studio: {
    stepId: SETUP_STEP.PUBLISH,
    href: "/app/setup?step=publish",
  },
  create_membership: {
    stepId: SETUP_STEP.MEMBERSHIP,
    href: "/app/memberships?action=create&setupStep=membership",
  },
  review_membership: {
    stepId: SETUP_STEP.MEMBERSHIP,
    href: "/app/memberships?setupStep=membership",
  },
  configure_reminders: {
    stepId: SETUP_STEP.COMMUNICATIONS,
    href: "/app/communications?section=automations",
  },
  import_customers: {
    stepId: SETUP_STEP.PUBLISH,
    href: "/app/settings/migration?entity=customers",
  },
} as const);

export type SetupStepId = (typeof SETUP_STEP)[keyof typeof SETUP_STEP];
export type SetupStepRequirement =
  (typeof SETUP_STEP_REQUIREMENT)[keyof typeof SETUP_STEP_REQUIREMENT];
export type SetupPracticeAction =
  (typeof SETUP_PRACTICE_ACTION)[keyof typeof SETUP_PRACTICE_ACTION];
export type SetupActionKey = keyof typeof SETUP_ACTIONS;
export type SetupLaunchEvent =
  | (typeof SETUP_LAUNCH_EVENT)[keyof typeof SETUP_LAUNCH_EVENT]
  | WorkspaceGuideStepEvent;
export type SetupLaunchEventSource =
  (typeof SETUP_LAUNCH_EVENT_SOURCE)[keyof typeof SETUP_LAUNCH_EVENT_SOURCE];
