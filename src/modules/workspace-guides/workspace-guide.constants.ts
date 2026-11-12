export const WORKSPACE_GUIDE_STATUS = {
  COMPLETED: "completed",
  SKIPPED: "skipped",
} as const;

export const WORKSPACE_GUIDE_STATUSES = Object.freeze(
  Object.values(WORKSPACE_GUIDE_STATUS),
);

export const WORKSPACE_GUIDE_ENTRY_POINT = {
  CONTEXTUAL_PROMPT: "contextual_prompt",
  HELP_REPLAY: "help_replay",
} as const;

export const WORKSPACE_GUIDE_ENTRY_POINTS = Object.freeze(
  Object.values(WORKSPACE_GUIDE_ENTRY_POINT),
);

export const WORKSPACE_GUIDE_DEFINITIONS = {
  first_booking: {
    version: 1,
    steps: ["calendar", "create_action", "booking_details", "confirmation"],
    terminalStep: "confirmation",
  },
  website_builder: {
    version: 1,
    steps: ["editor_sections", "live_preview", "branding", "publish"],
    terminalStep: "publish",
  },
  memberships: {
    version: 2,
    steps: ["plans", "customers", "credits", "vouchers"],
    terminalStep: "vouchers",
  },
  ai_reports: {
    version: 1,
    steps: ["assistant", "advisor", "report_filters", "report_insights"],
    terminalStep: "report_insights",
  },
  team_management: {
    version: 1,
    steps: ["members", "invite", "roles", "location_access"],
    terminalStep: "location_access",
  },
  first_offer: {
    version: 1,
    steps: ["offer_types", "create_offer", "price_capacity", "publish"],
    terminalStep: "publish",
  },
  test_customer_journey: {
    version: 1,
    steps: [
      "public_site",
      "test_booking",
      "confirmation_email",
      "customer_portal",
    ],
    terminalStep: "customer_portal",
  },
  payments_setup: {
    version: 1,
    steps: [
      "connection_status",
      "stripe_onboarding",
      "payment_capabilities",
      "verify_payment",
    ],
    terminalStep: "verify_payment",
  },
  data_import: {
    version: 1,
    steps: [
      "choose_importer",
      "template_upload",
      "validation",
      "history_rollback",
    ],
    terminalStep: "history_rollback",
  },
  customer_communications: {
    version: 1,
    steps: ["templates", "reminders", "test_email", "delivery_history"],
    terminalStep: "delivery_history",
  },
} as const;

export type WorkspaceGuideId = keyof typeof WORKSPACE_GUIDE_DEFINITIONS;
export type WorkspaceGuideDefinition =
  (typeof WORKSPACE_GUIDE_DEFINITIONS)[WorkspaceGuideId];
export type WorkspaceGuideStep = WorkspaceGuideDefinition["steps"][number];

export type WorkspaceGuideVersionDefinition = {
  readonly steps: readonly string[];
  readonly terminalStep: string;
};

export const WORKSPACE_GUIDE_LEGACY_DEFINITIONS = {
  memberships: {
    1: {
      steps: ["catalog", "plans", "customers", "vouchers"],
      terminalStep: "vouchers",
    },
  },
} as const satisfies Partial<
  Record<
    WorkspaceGuideId,
    Readonly<Record<number, WorkspaceGuideVersionDefinition>>
  >
>;

type WorkspaceGuideLegacyDefinition = {
  [GuideId in keyof typeof WORKSPACE_GUIDE_LEGACY_DEFINITIONS]: (typeof WORKSPACE_GUIDE_LEGACY_DEFINITIONS)[GuideId][keyof (typeof WORKSPACE_GUIDE_LEGACY_DEFINITIONS)[GuideId]];
}[keyof typeof WORKSPACE_GUIDE_LEGACY_DEFINITIONS];

export type WorkspaceGuidePersistedStep =
  | WorkspaceGuideStep
  | WorkspaceGuideLegacyDefinition["steps"][number];

export type WorkspaceGuideStatus =
  (typeof WORKSPACE_GUIDE_STATUS)[keyof typeof WORKSPACE_GUIDE_STATUS];
export type WorkspaceGuideEntryPoint =
  (typeof WORKSPACE_GUIDE_ENTRY_POINT)[keyof typeof WORKSPACE_GUIDE_ENTRY_POINT];
export type WorkspaceGuideStepEvent =
  `contextual_guide_${WorkspaceGuideId}_${WorkspaceGuideStep}_viewed`;

export const WORKSPACE_GUIDE_IDS = Object.freeze(
  Object.keys(WORKSPACE_GUIDE_DEFINITIONS) as WorkspaceGuideId[],
);

export const WORKSPACE_GUIDE_STEP_EVENT = Object.freeze(
  Object.fromEntries(
    WORKSPACE_GUIDE_IDS.flatMap((guideId) =>
      WORKSPACE_GUIDE_DEFINITIONS[guideId].steps.map((guideStep) => [
        `contextual_guide_${guideId}_${guideStep}_viewed`,
        { guideId, guideStep },
      ]),
    ),
  ) as Record<
    WorkspaceGuideStepEvent,
    { guideId: WorkspaceGuideId; guideStep: WorkspaceGuideStep }
  >,
);

export const WORKSPACE_GUIDE_STEP_EVENTS = Object.freeze(
  Object.keys(WORKSPACE_GUIDE_STEP_EVENT) as WorkspaceGuideStepEvent[],
);

export const getWorkspaceGuideDefinition = (
  guideId: unknown,
): WorkspaceGuideDefinition | null => {
  if (
    typeof guideId !== "string" ||
    !Object.prototype.hasOwnProperty.call(WORKSPACE_GUIDE_DEFINITIONS, guideId)
  ) {
    return null;
  }

  return WORKSPACE_GUIDE_DEFINITIONS[guideId as WorkspaceGuideId];
};

export const getWorkspaceGuideDefinitionForVersion = (
  guideId: unknown,
  version: unknown,
): WorkspaceGuideVersionDefinition | null => {
  const currentDefinition = getWorkspaceGuideDefinition(guideId);

  if (
    !currentDefinition ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return null;
  }

  if (currentDefinition.version === version) {
    return currentDefinition;
  }

  const legacyDefinitions = (
    WORKSPACE_GUIDE_LEGACY_DEFINITIONS as Partial<
      Record<
        WorkspaceGuideId,
        Readonly<Record<number, WorkspaceGuideVersionDefinition>>
      >
    >
  )[guideId as WorkspaceGuideId];

  return legacyDefinitions?.[version] ?? null;
};

export const isWorkspaceGuideStep = (
  guideId: WorkspaceGuideId,
  step: unknown,
): step is WorkspaceGuideStep =>
  typeof step === "string" &&
  (WORKSPACE_GUIDE_DEFINITIONS[guideId].steps as readonly string[]).includes(
    step,
  );
