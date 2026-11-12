import { describe, expect, it } from "vitest";

import {
  WORKSPACE_GUIDE_DEFINITIONS,
  WORKSPACE_GUIDE_IDS,
  WORKSPACE_GUIDE_STEP_EVENT,
  WORKSPACE_GUIDE_STEP_EVENTS,
  getWorkspaceGuideDefinitionForVersion,
} from "@/modules/workspace-guides/workspace-guide.constants.js";

const EXPECTED_GUIDES = {
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

describe("workspace guide registry", () => {
  it("keeps the current guide contract closed and explicit", () => {
    expect(WORKSPACE_GUIDE_DEFINITIONS).toEqual(EXPECTED_GUIDES);
    expect(WORKSPACE_GUIDE_IDS).toEqual(Object.keys(EXPECTED_GUIDES));
  });

  it("registers one unique low-cardinality event per current guide step", () => {
    const expectedCount = Object.values(EXPECTED_GUIDES).reduce(
      (count, definition) => count + definition.steps.length,
      0,
    );

    expect(expectedCount).toBe(40);
    expect(WORKSPACE_GUIDE_STEP_EVENTS).toHaveLength(expectedCount);
    expect(new Set(WORKSPACE_GUIDE_STEP_EVENTS).size).toBe(expectedCount);

    for (const [guideId, definition] of Object.entries(EXPECTED_GUIDES)) {
      for (const guideStep of definition.steps) {
        const event = `contextual_guide_${guideId}_${guideStep}_viewed`;

        expect(WORKSPACE_GUIDE_STEP_EVENT[event]).toEqual({
          guideId,
          guideStep,
        });
      }
    }
  });

  it("resolves only registered current and historical versions", () => {
    expect(getWorkspaceGuideDefinitionForVersion("studio_flow", 1)).toBeNull();
    expect(
      getWorkspaceGuideDefinitionForVersion("memberships", 1),
    ).toEqual({
      steps: ["catalog", "plans", "customers", "vouchers"],
      terminalStep: "vouchers",
    });
    expect(
      getWorkspaceGuideDefinitionForVersion("studio_flow", 2),
    ).toBeNull();
    expect(
      getWorkspaceGuideDefinitionForVersion("memberships", 2),
    ).toBe(WORKSPACE_GUIDE_DEFINITIONS.memberships);
    expect(
      getWorkspaceGuideDefinitionForVersion("first_offer", 0),
    ).toBeNull();
    expect(
      getWorkspaceGuideDefinitionForVersion("first_offer", 2),
    ).toBeNull();
    expect(
      getWorkspaceGuideDefinitionForVersion("unknown", 1),
    ).toBeNull();
  });
});
