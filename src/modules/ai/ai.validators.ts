import mongoose from "mongoose";
import { z } from "zod";

import {
  AI_ACTION_STATUS,
  AI_FEEDBACK_RATING,
  MAX_AI_MESSAGE_LENGTH,
  MAX_PUBLIC_AI_MESSAGE_LENGTH,
} from "./ai.constants.js";
import { SETUP_STEPS } from "@/modules/setup-center/setup-center.constants.js";
import { reportQuerySchema } from "@/modules/reports/reports.validators.js";

import { AI_LOCALES, normalizeAiLocale } from "./ai-locale.js";

const objectId = (label = "id") =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.isValidObjectId(value), {
      message: `Invalid ${label}.`,
    });

export const aiLocaleSchema = z.preprocess(
  (value) => normalizeAiLocale(value) ?? value,
  z.enum(AI_LOCALES),
);

export const aiConversationIdParamsSchema = z.object({
  id: objectId("AI conversation id"),
});

export const aiActionParamsSchema = z.object({
  id: objectId("AI conversation id"),
  actionId: objectId("AI action id"),
});

export const aiActionIdParamsSchema = z.object({
  actionId: objectId("AI action id"),
});

export const listAiActionsSchema = z
  .object({
    scope: z.enum(["mine", "workspace"]).default("mine"),
    status: z.enum(Object.values(AI_ACTION_STATUS)).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(30),
  })
  .strict();

export const getAiActionSchema = z
  .object({
    scope: z.enum(["mine", "workspace"]).default("mine"),
  })
  .strict();

export const publicTenantAiParamsSchema = z.object({
  tenantSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const createAiConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    locale: aiLocaleSchema.default("en"),
    locationId: objectId("location id").nullable().optional(),
  })
  .strict();

export const listAiConversationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

const safeWorkspaceRoute = z
  .string()
  .trim()
  .max(300)
  .regex(/^\/app(?:[/?#]|$)/);

const assistantWorkspacePageEntitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("booking"),
      id: objectId("booking id"),
    })
    .strict(),
]);
export const businessAdvisorRecommendationIdSchema = z
  .string()
  .trim()
  .regex(/^adv_[a-f0-9]{24}$/);

export const sendAiMessageSchema = z
  .object({
    message: z.string().trim().min(1).max(MAX_AI_MESSAGE_LENGTH),
    locale: aiLocaleSchema.optional(),
    context: z
      .discriminatedUnion("surface", [
        z
          .object({
            surface: z.literal("setup_center"),
            setupStepId: z.enum(SETUP_STEPS).optional(),
            route: safeWorkspaceRoute.optional(),
          })
          .strict(),
        z
          .object({
            surface: z.literal("dashboard"),
            route: safeWorkspaceRoute.optional(),
          })
          .strict(),
        z
          .object({
            surface: z.literal("command_center"),
            route: safeWorkspaceRoute.optional(),
          })
          .strict(),
        z
          .object({
            surface: z.literal("workspace"),
            route: z.literal("/app/bookings"),
            entity: assistantWorkspacePageEntitySchema,
          })
          .strict(),
        z
          .object({
            surface: z.literal("knowledge_hub"),
            knowledgeSourceId: objectId("knowledge source id"),
            route: z.literal("/app/knowledge").optional(),
          })
          .strict(),
        z
          .object({
            surface: z.literal("business_advisor"),
            recommendationId: businessAdvisorRecommendationIdSchema,
            route: z.literal("/app/ai").optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export const publicConciergeSchema = z
  .object({
    message: z.string().trim().min(1).max(MAX_PUBLIC_AI_MESSAGE_LENGTH),
    locale: aiLocaleSchema.default("en"),
    locationId: objectId("location id").nullable().optional(),
    conversationId: objectId("AI conversation id").optional(),
    sessionToken: z.string().trim().min(32).max(300).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.conversationId) !== Boolean(value.sessionToken)) {
      context.addIssue({
        code: "custom",
        path: [value.conversationId ? "sessionToken" : "conversationId"],
        message: "Conversation id and session token must be supplied together.",
      });
    }
  });

export const customerConciergeSchema = z
  .object({
    message: z.string().trim().min(1).max(MAX_AI_MESSAGE_LENGTH),
    locale: aiLocaleSchema.default("en"),
    locationId: objectId("location id").nullable().optional(),
    conversationId: objectId("AI conversation id").optional(),
  })
  .strict();

export const knowledgeCoverageQuerySchema = z
  .object({
    locale: aiLocaleSchema.default("en"),
    locationId: objectId("location id").optional(),
  })
  .strict();

export const briefingGenerateSchema = z
  .object({
    force: z.boolean().default(false),
    locale: aiLocaleSchema.optional(),
    locationId: objectId("location id").nullable().optional(),
  })
  .strict();

export const briefingLatestQuerySchema = z
  .object({
    locale: aiLocaleSchema.optional(),
    locationId: objectId("location id").nullable().optional(),
  })
  .strict();

export const businessAdvisorRecommendationsQuerySchema = z
  .object({
    locale: aiLocaleSchema.optional(),
    locationId: objectId("location id").nullable().optional(),
  })
  .strict();

export const businessAdvisorGenerateSchema = z
  .object({
    force: z.boolean().default(false),
    locale: aiLocaleSchema.optional(),
    locationId: objectId("location id").nullable().optional(),
  })
  .strict();

export const aiSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    communicationsCopilotEnabled: z.boolean().optional(),
    assistantEnabled: z.boolean().optional(),
    dailyBriefingEnabled: z.boolean().optional(),
    businessAdvisorEnabled: z.boolean().optional(),
    reportInsightsEnabled: z.boolean().optional(),
    staffPlanningEnabled: z.boolean().optional(),
    customerConciergeEnabled: z.boolean().optional(),
    publicConciergeEnabled: z.boolean().optional(),
    publicConciergeHandoffEnabled: z.boolean().optional(),
    firingIntelligenceEnabled: z.literal(false).optional(),
    knowledgeBaseEnabled: z.boolean().optional(),
    moderationEnabled: z.boolean().optional(),
    defaultLocale: aiLocaleSchema.optional(),
    briefingTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
  })
  .strict();

export const aiFeedbackSchema = z
  .object({
    runId: objectId("AI run id").nullable().optional(),
    conversationId: objectId("AI conversation id").nullable().optional(),
    rating: z.enum(Object.values(AI_FEEDBACK_RATING)),
    comment: z.string().trim().max(2_000).default(""),
  })
  .strict()
  .refine((value) => value.runId || value.conversationId, {
    message: "A run or conversation id is required.",
  });

export const createTaskActionPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    description: z.string().trim().max(3_000).default(""),
    locationId: objectId("location id").nullable().default(null),
    appliesToAllLocations: z.boolean().default(false),
    dueDate: z.string().datetime().nullable().default(null),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.appliesToAllLocations && value.locationId) {
      context.addIssue({
        code: "custom",
        path: ["locationId"],
        message: "An all-location task cannot also target one location.",
      });
    }
    if (!value.appliesToAllLocations && !value.locationId) {
      context.addIssue({
        code: "custom",
        path: ["locationId"],
        message:
          "A location is required unless all-location scope is explicit.",
      });
    }
  });

export const completeTaskActionPayloadSchema = z
  .object({
    taskId: objectId("staff task id"),
  })
  .strict();

export const createInventoryReorderActionPayloadSchema = z
  .object({
    itemId: objectId("inventory item id"),
    locationId: objectId("location id"),
    requestedQuantity: z.coerce.number().finite().positive().max(1_000_000),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    note: z.string().trim().max(2_000).default(""),
  })
  .strict();

const eventActionDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format.")
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return (
        Number.isFinite(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    },
    { message: "Date must be a valid calendar date." },
  );

const eventActionTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be in HH:mm format.");

export const createEventActionPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    locationId: objectId("location id"),
    date: eventActionDateSchema,
    startTime: eventActionTimeSchema,
    endTime: eventActionTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startTime >= value.endTime) {
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must be later than start time.",
      });
    }
  });

export const assistantActionSchema = z.union([
  z
    .object({
      key: z.literal("create_task"),
      payload: createTaskActionPayloadSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("complete_task"),
      payload: completeTaskActionPayloadSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("create_inventory_reorder_request"),
      payload: createInventoryReorderActionPayloadSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("create_event"),
      payload: createEventActionPayloadSchema,
    })
    .strict(),
]);

export const assistantProviderOutputSchema = z
  .object({
    answer: z.string().trim().min(1).max(20_000),
    grounding: z
      .object({
        basis: z.enum([
          "workspace_facts",
          "knowledge",
          "mixed",
          "general_knowledge",
          "insufficient",
        ]),
        insufficientEvidence: z.boolean(),
      })
      .strict(),
    citations: z
      .array(
        z
          .object({
            sourceId: z.string().trim().min(1).max(100),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    actions: z.array(assistantActionSchema).max(3).default([]),
    suggestedReplies: z
      .array(z.string().trim().min(1).max(240))
      .max(4)
      .default([]),
    navigation: z
      .array(
        z
          .object({
            stepId: z.enum(SETUP_STEPS),
            label: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(3)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ["knowledge", "mixed"].includes(value.grounding.basis) &&
      value.citations.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["citations"],
        message: "Knowledge-grounded answers require at least one citation.",
      });
    }
    if (
      value.grounding.basis === "insufficient" &&
      value.grounding.insufficientEvidence !== true
    ) {
      context.addIssue({
        code: "custom",
        path: ["grounding", "insufficientEvidence"],
        message: "Insufficient answers must be marked explicitly.",
      });
    }
    if (value.grounding.basis === "general_knowledge") {
      if (value.grounding.insufficientEvidence) {
        context.addIssue({
          code: "custom",
          path: ["grounding", "insufficientEvidence"],
          message: "General-knowledge answers cannot be marked insufficient.",
        });
      }
      if (value.citations.length) {
        context.addIssue({
          code: "custom",
          path: ["citations"],
          message: "General-knowledge answers cannot cite workspace sources.",
        });
      }
      if (value.actions.length) {
        context.addIssue({
          code: "custom",
          path: ["actions"],
          message:
            "General-knowledge answers cannot propose workspace actions.",
        });
      }
      if (value.navigation.length) {
        context.addIssue({
          code: "custom",
          path: ["navigation"],
          message:
            "General-knowledge answers cannot propose workspace navigation.",
        });
      }
    }
  });

export const conciergeProviderOutputSchema = z
  .object({
    answer: z.string().trim().min(1).max(20_000),
    grounding: z
      .object({
        basis: z.enum(["knowledge", "public_facts", "mixed", "insufficient"]),
        insufficientEvidence: z.boolean(),
      })
      .strict(),
    citations: z
      .array(
        z
          .object({
            sourceId: z.string().trim().min(1).max(100),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    handoffRecommended: z.boolean().default(false),
    handoffReason: z.string().trim().max(500).default(""),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ["knowledge", "mixed"].includes(value.grounding.basis) &&
      value.citations.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["citations"],
        message: "Knowledge-grounded answers require at least one citation.",
      });
    }
    if (
      value.grounding.basis === "insufficient" &&
      value.grounding.insufficientEvidence !== true
    ) {
      context.addIssue({
        code: "custom",
        path: ["grounding", "insufficientEvidence"],
        message: "Insufficient answers must be marked explicitly.",
      });
    }
  });

export const briefingProviderOutputSchema = z
  .object({
    headline: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(8_000),
    attentionIds: z
      .array(z.string().trim().min(1).max(100))
      .max(10)
      .default([]),
  })
  .strict();

export const businessAdvisorProviderOutputSchema = z
  .object({
    headline: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(4_000),
    rankedRecommendationIds: z
      .array(businessAdvisorRecommendationIdSchema)
      .max(5)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.rankedRecommendationIds.length !==
      new Set(value.rankedRecommendationIds).size
    ) {
      context.addIssue({
        code: "custom",
        path: ["rankedRecommendationIds"],
        message: "Recommendation ids must be unique.",
      });
    }
  });

export const reportBriefingSchema = reportQuerySchema
  .extend({
    locale: aiLocaleSchema.optional(),
  })
  .strict();

export const staffPlanningBriefingSchema = z
  .object({
    cadence: z.enum(["day", "week", "month"]).default("day"),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    locationId: objectId("location id").nullable().optional(),
    locale: aiLocaleSchema.optional(),
  })
  .strict();

export const staffPlanningDailyDraftSchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    locationId: objectId("location id").nullable().optional(),
    locale: aiLocaleSchema.optional(),
  })
  .strict();

export const reportBriefingProviderOutputSchema = z
  .object({
    headline: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(8_000),
    highlights: z
      .array(z.string().trim().min(1).max(1_000))
      .max(10)
      .default([]),
    attention: z.array(z.string().trim().min(1).max(1_000)).max(10).default([]),
    recommendations: z
      .array(z.string().trim().min(1).max(1_000))
      .max(10)
      .default([]),
    dataLimitations: z
      .array(z.string().trim().min(1).max(1_000))
      .max(20)
      .default([]),
  })
  .strict();

export const staffPlanningBriefingProviderOutputSchema = z
  .object({
    highlightIds: z
      .array(z.string().trim().min(1).max(100))
      .max(10)
      .default([]),
    attentionIds: z
      .array(z.string().trim().min(1).max(100))
      .max(10)
      .default([]),
    recommendationIds: z
      .array(z.string().trim().min(1).max(100))
      .max(10)
      .default([]),
  })
  .strict();

export const staffPlanningDailyDraftProviderOutputSchema = z
  .object({
    focusToday: z.string().trim().max(4_000).default(""),
    completedSinceLast: z.string().trim().max(4_000).default(""),
    blockers: z.string().trim().max(4_000).default(""),
    focusTaskIds: z.array(objectId("task id")).max(10).default([]),
    completedTaskIds: z.array(objectId("task id")).max(10).default([]),
    blockerTaskIds: z.array(objectId("task id")).max(10).default([]),
    dataLimitations: z
      .array(z.string().trim().min(1).max(1_000))
      .max(10)
      .default([]),
  })
  .strict();

export const firingProviderOutputSchema = z
  .object({
    riskLevel: z.enum(["low", "medium", "high", "unknown"]),
    summary: z.string().trim().min(1).max(8_000),
    recommendations: z
      .array(z.string().trim().min(1).max(1_000))
      .max(12)
      .default([]),
    cautions: z.array(z.string().trim().min(1).max(1_000)).max(12).default([]),
    dataLimitations: z
      .array(z.string().trim().min(1).max(1_000))
      .max(12)
      .default([]),
  })
  .strict();

export type AssistantProviderOutput = z.infer<
  typeof assistantProviderOutputSchema
>;
export type ConciergeProviderOutput = z.infer<
  typeof conciergeProviderOutputSchema
>;
export type BriefingProviderOutput = z.infer<
  typeof briefingProviderOutputSchema
>;
export type BusinessAdvisorProviderOutput = z.infer<
  typeof businessAdvisorProviderOutputSchema
>;
export type ReportBriefingProviderOutput = z.infer<
  typeof reportBriefingProviderOutputSchema
>;
export type StaffPlanningBriefingProviderOutput = z.infer<
  typeof staffPlanningBriefingProviderOutputSchema
>;
export type StaffPlanningDailyDraftProviderOutput = z.infer<
  typeof staffPlanningDailyDraftProviderOutputSchema
>;
export type FiringProviderOutput = z.infer<typeof firingProviderOutputSchema>;
