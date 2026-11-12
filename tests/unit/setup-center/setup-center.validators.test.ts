import { describe, expect, it } from "vitest";

import {
  WORKSPACE_GUIDE_DEFINITIONS,
} from "@/modules/workspace-guides/workspace-guide.constants.js";
import {
  SETUP_ACTIONS,
  SETUP_CENTER_DEFINITION_VERSION,
  SETUP_LAUNCH_EVENT,
  SETUP_PRACTICE_ACTIONS,
  SETUP_STEPS,
} from "@/modules/setup-center/setup-center.constants.js";
import {
  setupAssistantSchema,
  setupLaunchEventSchema,
  setupPracticeActionParamsSchema,
  setupPracticeActionSchema,
  setupPracticeConfirmationSchema,
  setupPracticeStartSchema,
  setupPublicationSchema,
  setupStepParamsSchema,
} from "@/modules/setup-center/setup-center.validators.js";

describe("Setup Center request validation", () => {
  it("requires explicit confirmation of an opaque current fingerprint and rejects identity overrides", () => {
    const input = {
      confirmed: true,
      expectedReadinessFingerprint: "a".repeat(64),
    };
    expect(setupPracticeConfirmationSchema.parse(input)).toEqual(input);
    for (const invalid of [
      { ...input, confirmed: false },
      { ...input, confirmed: "true" },
      { confirmed: true },
      { ...input, expectedReadinessFingerprint: "old-view" },
      { ...input, tenantId: "another-tenant" },
      { ...input, actorUserId: "another-user" },
      { ...input, confirmedAt: "2026-01-01" },
    ]) {
      expect(setupPracticeConfirmationSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("accepts only registered step and Practice Mode action identifiers", () => {
    for (const stepId of SETUP_STEPS) {
      expect(setupStepParamsSchema.parse({ stepId })).toEqual({ stepId });
    }
    for (const action of SETUP_PRACTICE_ACTIONS) {
      expect(setupPracticeActionParamsSchema.parse({ action })).toEqual({
        action,
      });
    }

    expect(
      setupStepParamsSchema.safeParse({ stepId: "arbitrary_step" }).success,
    ).toBe(false);
    expect(
      setupPracticeActionParamsSchema.safeParse({
        action: "charge_real_card",
      }).success,
    ).toBe(false);
  });

  it("strictly bounds idempotency keys and run identities", () => {
    expect(
      setupPracticeStartSchema.parse({
        idempotencyKey: "  setup-run-0001  ",
      }),
    ).toEqual({ idempotencyKey: "setup-run-0001" });
    expect(
      setupPracticeActionSchema.parse({
        runId: "  practice_1234567890  ",
      }),
    ).toEqual({ runId: "practice_1234567890" });

    expect(
      setupPracticeStartSchema.safeParse({ idempotencyKey: "short" }).success,
    ).toBe(false);
    expect(
      setupPracticeStartSchema.safeParse({
        idempotencyKey: "x".repeat(121),
      }).success,
    ).toBe(false);
    expect(
      setupPracticeActionSchema.safeParse({ runId: "practice" }).success,
    ).toBe(false);
    expect(
      setupPracticeActionSchema.safeParse({
        runId: "practice_1234567890",
        tenantId: "507f1f77bcf86cd799439011",
      }).success,
    ).toBe(false);
  });

  it("requires an explicit positive publication definition version", () => {
    expect(
      setupPublicationSchema.parse({
        expectedDefinitionVersion: String(SETUP_CENTER_DEFINITION_VERSION),
      }),
    ).toEqual({
      expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
    });

    for (const value of [undefined, 0, -1, 1.5, "not-a-version"]) {
      expect(
        setupPublicationSchema.safeParse({
          expectedDefinitionVersion: value,
        }).success,
      ).toBe(false);
    }
    expect(
      setupPublicationSchema.safeParse({
        expectedDefinitionVersion: SETUP_CENTER_DEFINITION_VERSION,
        force: true,
      }).success,
    ).toBe(false);
  });

  it("strictly validates deterministic assistant requests", () => {
    expect(
      setupAssistantSchema.parse({
        message: "  What should I configure next?  ",
        stepId: "payments",
        locale: "en",
      }),
    ).toEqual({
      message: "What should I configure next?",
      stepId: "payments",
      locale: "en",
    });
    expect(
      setupAssistantSchema.parse({
        message: "Co mám nastavit dál?",
        locale: "cs",
      }),
    ).toEqual({
      message: "Co mám nastavit dál?",
      locale: "cs",
    });

    for (const [locale, expected] of [
      ["de-DE", "de"],
      ["pl-PL", "pl"],
      ["sk-SK", "sk"],
      ["da-DK", "da"],
      ["fr-FR", "fr"],
      ["es-ES", "es"],
      ["it-IT", "it"],
      ["pt_PT", "pt-PT"],
      ["sv-SE", "sv"],
      ["nb-NO", "nb"],
      ["no-NO", "nb"],
      ["fi-FI", "fi"],
      ["hu-HU", "hu"],
      ["el-GR", "el"],
      ["tr-TR", "tr"],
      ["nl-NL", "nl"],
      ["nl_NL", "nl"],
      ["ro-RO", "ro"],
      ["ro_RO", "ro"],
    ] as const) {
      expect(
        setupAssistantSchema.parse({ message: "Help", locale }).locale,
      ).toBe(expected);
    }

    for (const input of [
      { message: "", locale: "en" },
      { message: "Help", locale: "ja" },
      { message: "Help", locale: "nn-NO" },
      { message: "Help", locale: "pt-BR" },
      { message: "Help", locale: "en", stepId: "unknown_step" },
      { message: "x".repeat(1_001), locale: "en" },
      { message: "Help", locale: "en", mutate: true },
    ]) {
      expect(setupAssistantSchema.safeParse(input).success).toBe(false);
    }
  });

  it("accepts the shared bounded Launch Center analytics payload", () => {
    const payload = {
      eventId: "123e4567-e89b-42d3-a456-426614174000",
      sessionId: "launch_session_01",
      event: SETUP_LAUNCH_EVENT.STEP_COMPLETED,
      stepId: "location",
      source: "guided_form",
      metadata: {
        requirement: "required",
        elapsedMs: 1_250,
        successful: true,
      },
    };

    expect(setupLaunchEventSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    { phase: "launch" },
    { form: "booking_session" },
    { form: "communication_sender" },
    { form: "communication_settings" },
    { form: "inventory_item", action: "restore" },
    { form: "membership" },
    { form: "membership_plan" },
    { form: "product", action: "created" },
    { form: "product", action: "updated" },
    { form: "stripe_connect" },
    { form: "studio_location" },
    { form: "team_member" },
    { form: "workspace_settings" },
    { profileKind: "firing" },
    { profileKind: "piecePricing" },
    { entity: "kiln", action: "restore" },
  ])("accepts the privacy-safe client metadata shape %#", (metadata) => {
    expect(
      setupLaunchEventSchema.safeParse({
        eventId: "123e4567-e89b-42d3-a456-426614174000",
        sessionId: "launch_session_01",
        event: SETUP_LAUNCH_EVENT.STEP_COMPLETED,
        stepId: "location",
        source: "guided_form",
        metadata,
      }).success,
    ).toBe(true);
  });

  it("accepts distinct privacy-safe product tour step events", () => {
    const stepEvents = [
      [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_OVERVIEW_VIEWED, "overview"],
      [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_LAUNCH_CENTER_VIEWED, "launch_center"],
      [
        SETUP_LAUNCH_EVENT.PRODUCT_TOUR_STUDIO_SWITCHER_VIEWED,
        "studio_switcher",
      ],
      [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_NAVIGATION_VIEWED, "navigation"],
      [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_AI_ASSISTANT_VIEWED, "ai_assistant"],
      [SETUP_LAUNCH_EVENT.PRODUCT_TOUR_SETTINGS_VIEWED, "settings"],
    ];

    for (const [index, [event, tourStep]] of stepEvents.entries()) {
      expect(
        setupLaunchEventSchema.safeParse({
          eventId: `123e4567-e89b-42d3-a456-4266141740${String(index).padStart(2, "0")}`,
          sessionId: "tour_session_01",
          event,
          source: "product_tour",
          metadata: {
            tourVersion: 1,
            tourStep,
            tourEntryPoint: "automatic",
            position: index + 1,
            total: 6,
            studioCount: 1,
            viewport: "desktop",
          },
        }).success,
      ).toBe(true);
    }
  });

  it("accepts distinct privacy-safe events for every current guide step", () => {
    let eventCounter = 0;

    for (const [guideId, definition] of Object.entries(
      WORKSPACE_GUIDE_DEFINITIONS,
    )) {
      for (const [index, guideStep] of definition.steps.entries()) {
        eventCounter += 1;
        const event = `contextual_guide_${guideId}_${guideStep}_viewed`;

        expect(
          setupLaunchEventSchema.safeParse({
            eventId: `223e4567-e89b-42d3-a456-${String(eventCounter).padStart(
              12,
              "0",
            )}`,
            sessionId: "guide_session_01",
            event,
            source: "contextual_guide",
            metadata: {
              guideId,
              guideVersion: definition.version,
              guideStep,
              guideEntryPoint: "help_replay",
              position: index + 1,
              total: definition.steps.length,
              viewport: "desktop",
            },
          }).success,
        ).toBe(true);
      }

      eventCounter += 1;
      expect(
        setupLaunchEventSchema.safeParse({
          eventId: `223e4567-e89b-42d3-a456-${String(eventCounter).padStart(
            12,
            "0",
          )}`,
          sessionId: "guide_session_01",
          event: SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_COMPLETED,
          source: "contextual_guide",
          metadata: {
            guideId,
            guideVersion: definition.version,
            guideStep: definition.terminalStep,
            guideEntryPoint: "help_replay",
            total: definition.steps.length,
            viewport: "desktop",
          },
        }).success,
      ).toBe(true);
    }

    expect(eventCounter).toBe(50);
  });

  it("rejects inconsistent contextual guide telemetry", () => {
    const base = {
      eventId: "223e4567-e89b-42d3-a456-426614174098",
      sessionId: "guide_session_01",
      event: "contextual_guide_first_booking_calendar_viewed",
      source: "contextual_guide",
      metadata: {
        guideId: "first_booking",
        guideVersion: 1,
        guideStep: "calendar",
        guideEntryPoint: "contextual_prompt",
        position: 1,
        total: 4,
        viewport: "mobile",
      },
    };

    for (const payload of [
      { ...base, source: "product_tour" },
      {
        ...base,
        metadata: { ...base.metadata, guideVersion: 2 },
      },
      {
        ...base,
        metadata: { ...base.metadata, guideId: "website_builder" },
      },
      {
        ...base,
        metadata: { ...base.metadata, guideStep: "confirmation" },
      },
      {
        ...base,
        metadata: { ...base.metadata, position: 2 },
      },
      {
        ...base,
        metadata: { ...base.metadata, total: 3 },
      },
      {
        ...base,
        event: SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_COMPLETED,
      },
      {
        ...base,
        event: SETUP_LAUNCH_EVENT.STUDIO_READY,
      },
      {
        ...base,
        event: "contextual_guide_studio_flow_register_piece_viewed",
        metadata: {
          guideId: "studio_flow",
          guideVersion: 1,
          guideStep: "register_piece",
          guideEntryPoint: "help_replay",
          position: 1,
          total: 5,
          viewport: "desktop",
        },
      },
      {
        ...base,
        event: "contextual_guide_studio_flow_items_viewed",
        metadata: {
          guideId: "studio_flow",
          guideVersion: 1,
          guideStep: "items",
          guideEntryPoint: "help_replay",
          position: 1,
          total: 4,
          viewport: "desktop",
        },
      },
      {
        ...base,
        event: "contextual_guide_studio_flow_register_piece_viewed",
        metadata: {
          guideId: "studio_flow",
          guideVersion: 2,
          guideStep: "register_piece",
          guideEntryPoint: "help_replay",
          position: 1,
          total: 4,
          viewport: "desktop",
        },
      },
    ]) {
      expect(setupLaunchEventSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("requires a closed and internally consistent product tour contract", () => {
    const base = {
      eventId: "123e4567-e89b-42d3-a456-426614174099",
      sessionId: "tour_session_01",
      event: SETUP_LAUNCH_EVENT.PRODUCT_TOUR_COMPLETED,
      source: "product_tour",
      metadata: {
        tourVersion: 1,
        tourStep: "settings",
      },
    };

    expect(setupLaunchEventSchema.safeParse(base).success).toBe(true);
    expect(
      setupLaunchEventSchema.safeParse({
        ...base,
        source: "launch_center",
      }).success,
    ).toBe(false);
    expect(
      setupLaunchEventSchema.safeParse({
        ...base,
        metadata: { tourVersion: 2, tourStep: "settings" },
      }).success,
    ).toBe(false);
    expect(
      setupLaunchEventSchema.safeParse({
        ...base,
        metadata: { tourVersion: 1, tourStep: "overview" },
      }).success,
    ).toBe(false);
    expect(
      setupLaunchEventSchema.safeParse({
        ...base,
        event: SETUP_LAUNCH_EVENT.STUDIO_READY,
      }).success,
    ).toBe(false);
  });

  it("rejects unbounded, identifying, or structurally inconsistent launch events", () => {
    const base = {
      eventId: "123e4567-e89b-42d3-a456-426614174000",
      sessionId: "launch_session_01",
      event: SETUP_LAUNCH_EVENT.STEP_OPENED,
      stepId: "location",
      source: "launch_center",
    };

    for (const payload of [
      { ...base, eventId: "event-prefixed-not-a-uuid" },
      { ...base, sessionId: "bad session" },
      { ...base, event: "arbitrary_event" },
      { ...base, source: "server" },
      { ...base, tenantId: "507f1f77bcf86cd799439011" },
      { ...base, stepId: undefined },
      {
        ...base,
        event: SETUP_LAUNCH_EVENT.STUDIO_READY,
        stepId: "studio",
      },
      { ...base, metadata: { email: "person@example.com" } },
      { ...base, metadata: { form: "person@example.com" } },
      {
        ...base,
        metadata: Object.fromEntries(
          Array.from({ length: 13 }, (_, index) => [`field${index}`, index]),
        ),
      },
      { ...base, metadata: { nested: { unsafe: true } } },
    ]) {
      expect(setupLaunchEventSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("keeps every server-owned Setup Center destination app-local", () => {
    for (const destination of Object.values(SETUP_ACTIONS)) {
      expect(destination.href).toMatch(/^\/app(?:[/?#]|$)/);
      expect(destination.href).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(destination.href).not.toMatch(/^\/\//);
    }
  });
});
