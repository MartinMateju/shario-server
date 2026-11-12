import { z } from "zod";

import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";
import {
  PRODUCT_TOUR_ENTRY_POINTS,
  PRODUCT_TOUR_STEP,
  PRODUCT_TOUR_STEPS,
  PRODUCT_TOUR_VERSION,
} from "@/modules/product-tour/product-tour.constants.js";
import {
  WORKSPACE_GUIDE_DEFINITIONS,
  WORKSPACE_GUIDE_ENTRY_POINTS,
  WORKSPACE_GUIDE_IDS,
  WORKSPACE_GUIDE_STEP_EVENT,
  isWorkspaceGuideStep,
} from "@/modules/workspace-guides/workspace-guide.constants.js";

import {
  CONTEXTUAL_GUIDE_LAUNCH_EVENTS,
  PRODUCT_TOUR_EVENT_STEP,
  PRODUCT_TOUR_LAUNCH_EVENTS,
  SETUP_LAUNCH_EVENTS,
  SETUP_LAUNCH_EVENT,
  SETUP_LAUNCH_EVENT_SOURCE,
  SETUP_LAUNCH_EVENT_SOURCES,
  SETUP_PRACTICE_ACTIONS,
  SETUP_STEPS,
} from "./setup-center.constants.js";

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

const setupLaunchMetadataSchema = z
  .object({
    requirement: z.enum(["required", "recommended", "optional"]).optional(),
    elapsedMs: z
      .number()
      .finite()
      .nonnegative()
      .max(30 * 24 * 60 * 60 * 1_000)
      .optional(),
    successful: z.boolean().optional(),
    phase: z.enum(["launch", "learning"]).optional(),
    form: z
      .enum([
        "booking_session",
        "communication_sender",
        "communication_settings",
        "inventory_item",
        "membership",
        "membership_plan",
        "product",
        "stripe_connect",
        "studio_location",
        "team_member",
        "workspace_settings",
      ])
      .optional(),
    action: z.enum(["created", "updated", "restore"]).optional(),
    profileKind: z.enum(["firing", "piecePricing", "piece_pricing"]).optional(),
    entity: z.literal("kiln").optional(),
    tourVersion: z.literal(PRODUCT_TOUR_VERSION).optional(),
    tourStep: z.enum(PRODUCT_TOUR_STEPS).optional(),
    tourEntryPoint: z.enum(PRODUCT_TOUR_ENTRY_POINTS).optional(),
    position: z.number().int().min(1).max(6).optional(),
    total: z.number().int().min(1).max(6).optional(),
    studioCount: z.number().int().min(0).max(100).optional(),
    viewport: z.enum(["mobile", "tablet", "desktop"]).optional(),
    guideId: z.enum(WORKSPACE_GUIDE_IDS).optional(),
    guideVersion: z.number().int().positive().optional(),
    guideStep: z.string().trim().min(1).max(80).optional(),
    guideEntryPoint: z.enum(WORKSPACE_GUIDE_ENTRY_POINTS).optional(),
  })
  .strict();

export const setupStepParamsSchema = z
  .object({
    stepId: z.enum(SETUP_STEPS),
  })
  .strict();

export const setupPracticeStartSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(120),
  })
  .strict();

export const setupPracticeConfirmationSchema = z
  .object({
    confirmed: z.literal(true),
    expectedReadinessFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const setupPracticeActionParamsSchema = z
  .object({
    action: z.enum(SETUP_PRACTICE_ACTIONS),
  })
  .strict();

export const setupPracticeActionSchema = z
  .object({
    runId: z.string().trim().min(10).max(80),
  })
  .strict();

export const setupPublicationSchema = z
  .object({
    expectedDefinitionVersion: z.coerce.number().int().positive(),
  })
  .strict();

export const setupAssistantSchema = z
  .object({
    message: z.string().trim().min(1).max(1_000),
    stepId: z.enum(SETUP_STEPS).optional(),
    locale: rolloutEligibleLocaleSchema,
  })
  .strict();

export const setupLaunchEventSchema = z
  .object({
    eventId: z.uuid(),
    sessionId: z
      .string()
      .trim()
      .min(8)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/),
    event: z.enum(SETUP_LAUNCH_EVENTS),
    stepId: z.enum(SETUP_STEPS).optional(),
    source: z.enum(SETUP_LAUNCH_EVENT_SOURCES).optional(),
    metadata: setupLaunchMetadataSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const stepEvent =
      input.event === SETUP_LAUNCH_EVENT.STEP_OPENED ||
      input.event === SETUP_LAUNCH_EVENT.STEP_COMPLETED;

    if (stepEvent && !input.stepId) {
      ctx.addIssue({
        code: "custom",
        path: ["stepId"],
        message: "A step identifier is required for step events.",
      });
    }
    if (!stepEvent && input.stepId) {
      ctx.addIssue({
        code: "custom",
        path: ["stepId"],
        message: "A step identifier is only accepted for step events.",
      });
    }

    const productTourEvent = PRODUCT_TOUR_LAUNCH_EVENTS.includes(
      input.event as (typeof PRODUCT_TOUR_LAUNCH_EVENTS)[number],
    );
    const expectedTourStep =
      PRODUCT_TOUR_EVENT_STEP[
        input.event as keyof typeof PRODUCT_TOUR_EVENT_STEP
      ];
    const metadata = input.metadata;

    const contextualGuideEvent = CONTEXTUAL_GUIDE_LAUNCH_EVENTS.includes(
      input.event as (typeof CONTEXTUAL_GUIDE_LAUNCH_EVENTS)[number],
    );
    const expectedGuideStep =
      WORKSPACE_GUIDE_STEP_EVENT[
        input.event as keyof typeof WORKSPACE_GUIDE_STEP_EVENT
      ];

    if (productTourEvent) {
      if (input.source !== SETUP_LAUNCH_EVENT_SOURCE.PRODUCT_TOUR) {
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message: "Product tour events require the product_tour source.",
        });
      }
      if (metadata?.tourVersion !== PRODUCT_TOUR_VERSION) {
        ctx.addIssue({
          code: "custom",
          path: ["metadata", "tourVersion"],
          message: "Product tour events require the current tour version.",
        });
      }
      if (expectedTourStep && metadata?.tourStep !== expectedTourStep) {
        ctx.addIssue({
          code: "custom",
          path: ["metadata", "tourStep"],
          message: "Product tour step metadata must match the event.",
        });
      }
      if (
        input.event === SETUP_LAUNCH_EVENT.PRODUCT_TOUR_SKIPPED &&
        !metadata?.tourStep
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["metadata", "tourStep"],
          message: "Skipped product tours require the last viewed step.",
        });
      }
      if (
        input.event === SETUP_LAUNCH_EVENT.PRODUCT_TOUR_COMPLETED &&
        metadata?.tourStep !== PRODUCT_TOUR_STEP.SETTINGS
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["metadata", "tourStep"],
          message: "Completed product tours must finish on settings.",
        });
      }
      if (
        metadata?.total !== undefined &&
        metadata.total !== PRODUCT_TOUR_STEPS.length
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["metadata", "total"],
          message: "Product tour totals must match the registered step count.",
        });
      }
    } else if (contextualGuideEvent) {
      if (input.source !== SETUP_LAUNCH_EVENT_SOURCE.CONTEXTUAL_GUIDE) {
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message: "Contextual guide events require the contextual_guide source.",
        });
      }

      const guideId = metadata?.guideId;
      const definition = guideId
        ? WORKSPACE_GUIDE_DEFINITIONS[guideId]
        : null;

      if (!guideId || !definition) {
        ctx.addIssue({
          code: "custom",
          path: ["metadata", "guideId"],
          message: "Contextual guide events require a registered guide.",
        });
      } else {
        if (metadata?.guideVersion !== definition.version) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", "guideVersion"],
            message: "Contextual guide events require the current guide version.",
          });
        }
        if (metadata?.guideEntryPoint === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", "guideEntryPoint"],
            message: "Contextual guide events require an entry point.",
          });
        }
        if (metadata?.total !== definition.steps.length) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", "total"],
            message: "Contextual guide totals must match the registered step count.",
          });
        }
        if (
          metadata?.guideStep !== undefined &&
          !isWorkspaceGuideStep(guideId, metadata.guideStep)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", "guideStep"],
            message: "The contextual guide step is not registered.",
          });
        }
        if (
          expectedGuideStep &&
          (guideId !== expectedGuideStep.guideId ||
            metadata?.guideStep !== expectedGuideStep.guideStep)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", "guideStep"],
            message: "Contextual guide step metadata must match the event.",
          });
        }
        if (
          expectedGuideStep &&
          metadata?.position !==
            (definition.steps as readonly string[]).indexOf(expectedGuideStep.guideStep) + 1
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", "position"],
            message: "Contextual guide positions must match the registered step.",
          });
        }
        if (
          (input.event === SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_COMPLETED ||
            input.event === SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_CTA_OPENED) &&
          metadata?.guideStep !== definition.terminalStep
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", "guideStep"],
            message: "Completed contextual guides must finish on the terminal step.",
          });
        }
        if (
          input.event === SETUP_LAUNCH_EVENT.CONTEXTUAL_GUIDE_SKIPPED &&
          !metadata?.guideStep
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["metadata", "guideStep"],
            message: "Skipped contextual guides require the last viewed step.",
          });
        }
      }
    } else if (
      input.source === SETUP_LAUNCH_EVENT_SOURCE.PRODUCT_TOUR ||
      input.source === SETUP_LAUNCH_EVENT_SOURCE.CONTEXTUAL_GUIDE ||
      metadata?.tourVersion !== undefined ||
      metadata?.tourStep !== undefined ||
      metadata?.tourEntryPoint !== undefined ||
      metadata?.guideId !== undefined ||
      metadata?.guideVersion !== undefined ||
      metadata?.guideStep !== undefined ||
      metadata?.guideEntryPoint !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["event"],
        message: "Tour metadata is only accepted for registered tour events.",
      });
    }
  });
