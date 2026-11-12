import mongoose from "mongoose";
import { z } from "zod";

import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

import {
  COMMUNICATION_CHANNELS,
  CONSENT_PURPOSES,
  CONSENT_STATUSES,
  CONVERSATION_CATEGORIES,
  CONVERSATION_PRIORITIES,
  CONVERSATION_STATUSES,
  DEFAULT_COMMUNICATION_PAGE_SIZE,
  DELIVERY_STATUSES,
  KNOWLEDGE_ARTICLE_AUDIENCES,
  KNOWLEDGE_ARTICLE_STATUSES,
  KNOWLEDGE_ARTICLE_TYPES,
  MAX_COMMUNICATION_PAGE_SIZE,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  ROUTING_MATCH_OPERATORS,
} from "./communications.constants.js";
import { normalizeYouTubeUrl } from "./knowledge-youtube.js";

const objectIdSchema = (name = "id") =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.isValidObjectId(value), {
      message: `Invalid ${name}.`,
    });

const nullableObjectIdSchema = (name = "id") =>
  z
    .union([objectIdSchema(name), z.literal(""), z.null()])
    .transform((value) => (value ? String(value) : null));

const booleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

const normalizedEmailSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.email(),
);

const httpUrlSchema = z
  .string()
  .trim()
  .max(3000)
  .url()
  .refine(
    (value) => {
      // Zod can run refinements even when `.url()` has already failed,
      // including the empty-string branch of an optional URL union.
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    },
    {
      message: "Only credential-free http and https URLs are supported.",
    },
  );

const youtubeUrlSchema = z
  .string()
  .trim()
  .max(3000)
  .transform((value, context) => {
    const normalized = normalizeYouTubeUrl(value);
    if (!normalized) {
      context.addIssue({
        code: "custom",
        message: "A valid HTTPS YouTube video URL is required.",
      });
      return z.NEVER;
    }
    return normalized;
  });

const uniqueObjectIdArray = (name: string, maximum = 100) =>
  z
    .array(objectIdSchema(name))
    .max(maximum)
    .transform((values) => [...new Set(values.map(String))]);

const ianaTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA timezone." },
  );

const timeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm in 24-hour format.");

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const contactIdentitySchema = z.object({
  name: z.string().trim().max(180).default(""),
  email: z.union([normalizedEmailSchema, z.literal("")]).default(""),
  phone: z.string().trim().max(50).default(""),
  whatsappId: z.string().trim().max(160).default(""),
  instagramScopedId: z.string().trim().max(160).default(""),
  instagramUsername: z.string().trim().max(160).default(""),
  externalId: z.string().trim().max(240).default(""),
});

const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  contentType: z.string().trim().max(160).default("application/octet-stream"),
  size: z.coerce.number().int().min(0).max(25_000_000).default(0),
  url: z.string().trim().url().max(3000),
  checksum: z.string().trim().max(128).default(""),
});

const relatedEntitySchema = z.object({
  type: z.enum([
    "booking",
    "course",
    "order",
    "invoice",
    "payment",


    "membership",
    "task",
    "other",
  ]),
  id: objectIdSchema("related entity id"),
  label: z.string().trim().max(240).default(""),
});

export const communicationIdParamsSchema = z.object({
  id: objectIdSchema(),
});

export const customerIdParamsSchema = z.object({
  customerId: objectIdSchema("customer id"),
});

export const satisfactionTokenParamsSchema = z.object({
  token: z.string().trim().min(32).max(256),
});

export const webhookParamsSchema = z.object({
  channel: z.enum(COMMUNICATION_CHANNELS),
  tenantKey: z.string().trim().min(24).max(128),
});

export const instagramOAuthCallbackSchema = z.object({
  code: z.string().trim().min(1).max(4096).optional(),
  state: z.string().trim().min(40).max(4096),
  error: z.string().trim().max(200).optional(),
});

export const listConversationsSchema = z
  .object({
    search: z.string().trim().max(200).default(""),
    direction: z.literal("outbound").optional(),
    status: z.enum(CONVERSATION_STATUSES).optional(),
    category: z.enum(CONVERSATION_CATEGORIES).optional(),
    priority: z.enum(CONVERSATION_PRIORITIES).optional(),
    channel: z.enum(COMMUNICATION_CHANNELS).optional(),
    locationId: objectIdSchema("location id").optional(),
    assignedTo: objectIdSchema("assigned user id").optional(),
    customerId: objectIdSchema("customer id").optional(),
    view: z
      .enum([
        "all",
        "mine",
        "unassigned",
        "needs_review",
        "unmatched",
        "urgent",
        "closed",
      ])
      .default("all"),
    unreadOnly: booleanSchema.default(false),
    includeRestricted: booleanSchema.default(true),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_COMMUNICATION_PAGE_SIZE)
      .default(DEFAULT_COMMUNICATION_PAGE_SIZE),
  })
  .superRefine((value, context) => {
    if (value.direction === "outbound" && value.channel !== "email") {
      context.addIssue({
        code: "custom",
        path: ["channel"],
        message: "Outbound history requires channel=email.",
      });
    }
  });

export const communicationOverviewSchema = z.object({
  locationId: objectIdSchema("location id").optional(),
});

export const listMessagesSchema = z.object({
  before: z.coerce.date().optional(),
  after: z.coerce.date().optional(),
  includeInternal: booleanSchema.default(true),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

export const createConversationSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  channel: z.enum(["email", "in_app"]).default("email"),
  customerId: nullableObjectIdSchema("customer id").default(null),
  contact: contactIdentitySchema.optional(),
  locationId: nullableObjectIdSchema("location id").default(null),
  assignedTo: nullableObjectIdSchema("assigned user id").default(null),
  assignedTeam: z.string().trim().max(120).default(""),
  priority: z.enum(CONVERSATION_PRIORITIES).default("normal"),
  category: z.enum(CONVERSATION_CATEGORIES).default("general"),
  language: z.string().trim().max(24).default(""),
  restricted: booleanSchema.default(false),
  allowedUserIds: z
    .array(objectIdSchema("allowed user id"))
    .max(100)
    .default([]),
  relatedEntities: z.array(relatedEntitySchema).max(20).default([]),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
});

export const updateConversationSchema = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  status: z.enum(CONVERSATION_STATUSES).optional(),
  priority: z.enum(CONVERSATION_PRIORITIES).optional(),
  category: z.enum(CONVERSATION_CATEGORIES).optional(),
  language: z.string().trim().max(24).optional(),
  customerId: nullableObjectIdSchema("customer id").optional(),
  locationId: nullableObjectIdSchema("location id").optional(),
  assignedTo: nullableObjectIdSchema("assigned user id").optional(),
  assignedTeam: z.string().trim().max(120).optional(),
  restricted: booleanSchema.optional(),
  allowedUserIds: z
    .array(objectIdSchema("allowed user id"))
    .max(100)
    .optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  snoozedUntil: z.coerce.date().nullable().optional(),
  relatedEntities: z.array(relatedEntitySchema).max(20).optional(),
});

const messageContentSchema = z
  .object({
    channel: z.enum(["email", "in_app"]).default("email"),
    subject: z.string().trim().max(300).default(""),
    text: z.string().trim().max(50000).default(""),
    html: z.string().max(250000).default(""),
    attachments: z.array(attachmentSchema).max(20).default([]),
    whatsappTemplate: z
      .object({
        name: z.string().trim().min(1).max(512),
        languageCode: z.string().trim().min(2).max(35),
        components: z
          .array(z.record(z.string(), z.unknown()))
          .max(20)
          .default([]),
      })
      .optional(),
    purpose: z.enum(CONSENT_PURPOSES).default("support"),
    idempotencyKey: z.string().trim().min(8).max(300).optional(),
    sendAt: z.coerce.date().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.whatsappTemplate) {
      ctx.addIssue({
        code: "custom",
        path: ["whatsappTemplate"],
        message: "WhatsApp delivery is not available yet.",
      });
    }
    if (value.channel === "email" && value.attachments.length) {
      ctx.addIssue({
        code: "custom",
        path: ["attachments"],
        message: "Attachments are not enabled for managed email yet.",
      });
    }
    if (
      !value.text &&
      !value.html &&
      !value.attachments.length &&
      !value.whatsappTemplate
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "Message content or an attachment is required.",
      });
    }
  });

export const composeMessageSchema = z
  .object({
    conversationId: objectIdSchema("conversation id").optional(),
    customerId: nullableObjectIdSchema("customer id").default(null),
    // Direct Inbox messages are deliberately one-recipient. Group/broadcast
    // sends must fan out into private per-recipient deliveries.
    to: z.array(contactIdentitySchema).min(1).max(1),
    locationId: nullableObjectIdSchema("location id").default(null),
    category: z.enum(CONVERSATION_CATEGORIES).default("general"),
    priority: z.enum(CONVERSATION_PRIORITIES).default("normal"),
    language: z.string().trim().max(24).default(""),
  })
  .and(messageContentSchema)
  .superRefine((value, ctx) => {
    if (value.channel !== "email") {
      ctx.addIssue({
        code: "custom",
        path: ["channel"],
        message: "Manual compose supports email only.",
      });
    }
    // "support" remains a one-release compatibility alias for clients that
    // predate managed outbound email. The controller normalizes it before use.
    if (!["transactional", "support"].includes(value.purpose)) {
      ctx.addIssue({
        code: "custom",
        path: ["purpose"],
        message: "Manual compose is limited to operational transactional email.",
      });
    }
    if (value.channel === "email" && !value.to[0]?.email) {
      ctx.addIssue({
        code: "custom",
        path: ["to", 0, "email"],
        message: "An email recipient is required.",
      });
    }
  });

export const replyMessageSchema = messageContentSchema.and(
  z.object({
    replyToMessageId: nullableObjectIdSchema("reply-to message id").default(
      null,
    ),
  }),
);

export const internalNoteSchema = z.object({
  text: z.string().trim().min(1).max(50000),
  mentions: z.array(objectIdSchema("mentioned user id")).max(50).default([]),
});

export const assignConversationSchema = z.object({
  assignedTo: nullableObjectIdSchema("assigned user id").default(null),
  assignedTeam: z.string().trim().max(120).default(""),
  locationId: nullableObjectIdSchema("location id").optional(),
});

export const resolveConversationSchema = z.object({
  resolutionNote: z.string().trim().max(3000).default(""),
  sendSatisfactionSurvey: booleanSchema.default(false),
  satisfactionChannel: z.literal("email").default("email"),
});

export const actionParamsSchema = z.object({
  id: objectIdSchema("conversation id"),
  actionId: objectIdSchema("action id"),
});

export const actionDecisionSchema = z
  .object({
    decision: z.enum(["approve", "dismiss"]),
  })
  .strict();

export const createConversationTaskSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  description: z.string().trim().max(3000).default(""),
  assignedTo: nullableObjectIdSchema("assigned user id").default(null),
  dueDate: z.coerce.date().nullable().default(null),
  priority: z.enum(CONVERSATION_PRIORITIES).default("normal"),
  appliesToAllLocations: booleanSchema.optional(),
});

export const analyzeConversationSchema = z.object({
  force: booleanSchema.default(false),
});

export const aiDraftSchema = z.object({
  instructions: z.string().trim().max(3000).default(""),
  tone: z
    .enum(["warm", "professional", "concise", "apologetic"])
    .default("warm"),
  language:
    rolloutEligibleLocaleSchema.optional(),
  channel: z.enum(["email", "in_app"]).optional(),
});

export const translateMessageSchema = z.object({
  targetLanguage: z.string().trim().min(2).max(24),
});

export const transcribeMessageSchema = z.object({
  transcriptHint: z.string().trim().max(50000).default(""),
  languageHint: z.string().trim().max(24).optional(),
});

const knowledgeQuestionSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(10_000),
});

const knowledgeArticleFields = z.object({
  type: z.enum(KNOWLEDGE_ARTICLE_TYPES).default("guide"),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().max(1_000).default(""),
  slug: slugSchema.optional(),
  category: z.string().trim().min(1).max(100).default("general"),
  audience: z.enum(KNOWLEDGE_ARTICLE_AUDIENCES).default("staff"),
  language: z.string().trim().min(2).max(24).default("cs"),
  content: z.string().trim().max(100_000).default(""),
  transcript: z.string().trim().max(100_000).default(""),
  customQuestions: z.array(knowledgeQuestionSchema).max(50).default([]),
  translations: z.record(z.string(), z.string().max(100000)).default({}),
  status: z.enum(KNOWLEDGE_ARTICLE_STATUSES).default("draft"),
  sourceUrl: z.union([httpUrlSchema, z.literal("")]).default(""),
  videoUrl: z.union([youtubeUrlSchema, z.literal("")]).default(""),
  fileUrl: z.union([httpUrlSchema, z.literal("")]).default(""),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  locationIds: uniqueObjectIdArray("location id").default([]),
  targetCourseIds: uniqueObjectIdArray("course id").default([]),
  targetMembershipIds: uniqueObjectIdArray("membership plan id").default([]),
  // The owner audience is role-based. The frontend sends an empty legacy
  // placeholder, but selecting individual owners is deliberately unsupported.
  targetOwnerIds: z.array(objectIdSchema("owner id")).max(0).default([]),
  featured: z.boolean().default(false),
  aiEnabled: z.boolean().default(true),
  effectiveFrom: z.coerce.date().nullable().default(null),
  effectiveUntil: z.coerce.date().nullable().default(null),
});

export const knowledgeArticleSchema = knowledgeArticleFields.superRefine(
  (value, context) => {
    if (
      value.effectiveFrom &&
      value.effectiveUntil &&
      value.effectiveUntil.getTime() <= value.effectiveFrom.getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["effectiveUntil"],
        message: "Effective-until must be after effective-from.",
      });
    }

    if (value.audience === "course" && value.targetCourseIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["targetCourseIds"],
        message: "At least one course is required for the course audience.",
      });
    }
    if (value.audience !== "course" && value.targetCourseIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["targetCourseIds"],
        message: "Course targets are only valid for the course audience.",
      });
    }
    if (value.audience !== "member" && value.targetMembershipIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["targetMembershipIds"],
        message: "Membership targets are only valid for the member audience.",
      });
    }

    const requiredFieldByType = {
      video: ["videoUrl", value.videoUrl],
      guide: ["content", value.content],
      link: ["sourceUrl", value.sourceUrl],
      file: ["fileUrl", value.fileUrl],
    } as const;
    const required =
      requiredFieldByType[value.type as keyof typeof requiredFieldByType];
    if (required && !required[1]) {
      context.addIssue({
        code: "custom",
        path: [required[0]],
        message: `A ${required[0]} value is required for ${value.type} knowledge.`,
      });
    }
    if (
      value.type === "faq" &&
      !value.content &&
      value.customQuestions.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["customQuestions"],
        message: "FAQ knowledge requires content or at least one question.",
      });
    }
  },
);

export const updateKnowledgeArticleSchema = knowledgeArticleFields.partial();

export const listKnowledgeSchema = z.object({
  search: z.string().trim().max(200).default(""),
  status: z.enum(KNOWLEDGE_ARTICLE_STATUSES).optional(),
  category: z.string().trim().max(100).optional(),
  audience: z.enum(KNOWLEDGE_ARTICLE_AUDIENCES).optional(),
  type: z.enum(KNOWLEDGE_ARTICLE_TYPES).optional(),
  language: z.string().trim().max(24).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export const listPublishedKnowledgeSchema = z.object({
  search: z.string().trim().max(200).default(""),
  category: z.string().trim().max(100).optional(),
  type: z.enum(KNOWLEDGE_ARTICLE_TYPES).optional(),
  language: z.string().trim().min(2).max(24).optional(),
  locationId: objectIdSchema("location id").optional(),
  featured: booleanSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

export const routingRuleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).default(""),
  enabled: booleanSchema.default(true),
  order: z.coerce.number().int().min(0).max(100000).default(100),
  matchOperator: z.enum(ROUTING_MATCH_OPERATORS).default("all"),
  conditions: z
    .object({
      categories: z.array(z.enum(CONVERSATION_CATEGORIES)).default([]),
      channels: z.array(z.enum(COMMUNICATION_CHANNELS)).default([]),
      priorities: z.array(z.enum(CONVERSATION_PRIORITIES)).default([]),
      languages: z.array(z.string().trim().min(2).max(24)).default([]),
      locationIds: z.array(objectIdSchema("location id")).default([]),
      keywords: z.array(z.string().trim().min(1).max(100)).default([]),
      unmatchedOnly: booleanSchema.default(false),
      outsideBusinessHours: booleanSchema.default(false),
    })
    .default({
      categories: [],
      channels: [],
      priorities: [],
      languages: [],
      locationIds: [],
      keywords: [],
      unmatchedOnly: false,
      outsideBusinessHours: false,
    }),
  action: z.object({
    assignTo: nullableObjectIdSchema("assigned user id").default(null),
    assignTeam: z.string().trim().max(120).default(""),
    locationId: nullableObjectIdSchema("location id").default(null),
    priority: z.enum(CONVERSATION_PRIORITIES).nullable().default(null),
    addTags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    notifyOwner: booleanSchema.default(false),
  }),
});

const businessIntervalSchema = z.object({
  enabled: booleanSchema.default(false),
  open: timeSchema.default("09:00"),
  close: timeSchema.default("17:00"),
});

const businessHoursSchema = z.object({
  timezone: ianaTimezoneSchema.default("Europe/Prague"),
  monday: businessIntervalSchema,
  tuesday: businessIntervalSchema,
  wednesday: businessIntervalSchema,
  thursday: businessIntervalSchema,
  friday: businessIntervalSchema,
  saturday: businessIntervalSchema,
  sunday: businessIntervalSchema,
  holidays: z.array(z.iso.date()).max(400).default([]),
});

export const communicationSettingsSchema = z
  .object({
    inbox: z
      .object({
        defaultAssignee: nullableObjectIdSchema(
          "default assignee id",
        ).optional(),
      })
      .strict()
      .optional(),
    channels: z
      .object({
        email: z
          .object({
            enabled: booleanSchema.optional(),
          })
          .strict()
          .optional(),
        inApp: z.object({ enabled: booleanSchema.optional() }).optional(),
      })
      .strict()
      .optional(),
    ai: z
      .object({
        enabled: booleanSchema.optional(),
        autoCategorize: booleanSchema.optional(),
        autoRoute: booleanSchema.optional(),
        draftReplies: booleanSchema.optional(),
        autoApplyConfidence: z.coerce.number().min(0.5).max(1).optional(),
        preferredStaffLanguage: z.string().trim().min(2).max(24).optional(),
      })
      .optional(),
    businessHours: businessHoursSchema.partial().optional(),
    absence: z
      .object({
        enabled: booleanSchema.optional(),
        message: z.string().trim().max(5000).optional(),
        repeatAfterHours: z.coerce.number().int().min(1).max(168).optional(),
      })
      .optional(),
    quietHours: z
      .object({
        enabled: booleanSchema.optional(),
        start: timeSchema.optional(),
        end: timeSchema.optional(),
        allowUrgent: booleanSchema.optional(),
      })
      .optional(),
    delivery: z
      .object({
        maxAttempts: z.coerce.number().int().min(1).max(8).optional(),
        retryBaseSeconds: z.coerce.number().int().min(5).max(86400).optional(),
        fallbackOrder: z
          .array(z.enum(["email", "in_app"]))
          .min(1)
          .max(2)
          .optional(),
      })
      .optional(),
    retention: z
      .object({
        days: z.coerce
          .number()
          .int()
          .min(MIN_RETENTION_DAYS)
          .max(MAX_RETENTION_DAYS)
          .optional(),
        redactInsteadOfDelete: booleanSchema.optional(),
        retainAuditDays: z.coerce
          .number()
          .int()
          .min(MIN_RETENTION_DAYS)
          .max(MAX_RETENTION_DAYS)
          .optional(),
      })
      .optional(),
    satisfaction: z
      .object({
        enabled: booleanSchema.optional(),
        sendForCategories: z.array(z.enum(CONVERSATION_CATEGORIES)).optional(),
        cooldownDays: z.coerce.number().int().min(1).max(365).optional(),
      })
      .optional(),
  })
  .strict();

export const consentSchema = z
  .object({
    preferences: z
      .array(
        z.object({
          channel: z.enum(COMMUNICATION_CHANNELS),
          purpose: z.enum(CONSENT_PURPOSES),
          status: z.enum(CONSENT_STATUSES),
          source: z.string().trim().min(1).max(120).default("manual"),
          evidence: z.string().trim().max(3000).default(""),
          expiresAt: z.coerce.date().nullable().default(null),
        }),
      )
      .min(1)
      .max(30),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.preferences.forEach((preference, index) => {
      const key = `${preference.channel}:${preference.purpose}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["preferences", index],
          message: "Each channel and purpose combination may only appear once.",
        });
      }
      seen.add(key);
    });
  });

export const listAuditSchema = z.object({
  action: z.string().trim().max(100).optional(),
  resourceType: z.string().trim().max(100).optional(),
  conversationId: objectIdSchema("conversation id").optional(),
  actorId: objectIdSchema("actor id").optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const satisfactionResponseSchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(3000).default(""),
});

export const listSatisfactionSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  locationId: objectIdSchema("location id").optional(),
  category: z.enum(CONVERSATION_CATEGORIES).optional(),
});

export const retryDeliverySchema = z.object({
  force: booleanSchema.default(false),
});

export const fallbackDeliverySchema = z.object({
  channel: z.enum(["email", "in_app"]).optional(),
});

export const inboundWebhookSchema = z.object({
  provider: z.string().trim().min(1).max(80).default("generic"),
  eventId: z.string().trim().min(1).max(300),
  eventType: z.enum([
    "message.received",
    "message.sent",
    "delivery.sent",
    "delivery.delivered",
    "delivery.read",
    "delivery.failed",
    "delivery.bounced",
  ]),
  providerMessageId: z.string().trim().max(300).default(""),
  providerThreadId: z.string().trim().max(300).default(""),
  providerAccountId: z.string().trim().max(160).default(""),
  occurredAt: z.coerce.date().default(() => new Date()),
  sender: contactIdentitySchema.default({
    name: "",
    email: "",
    phone: "",
    whatsappId: "",
    instagramScopedId: "",
    instagramUsername: "",
    externalId: "",
  }),
  recipients: z.array(contactIdentitySchema).max(50).default([]),
  subject: z.string().trim().max(300).default(""),
  text: z.string().max(50000).default(""),
  html: z.string().max(250000).default(""),
  kind: z.enum(["text", "html", "voice"]).default("text"),
  attachments: z.array(attachmentSchema).max(20).default([]),
  locationId: nullableObjectIdSchema("location id").default(null),
  relatedEntities: z.array(relatedEntitySchema).max(20).default([]),
  deliveryStatus: z.enum(DELIVERY_STATUSES).optional(),
  failure: z
    .object({
      code: z.string().trim().max(120).default(""),
      message: z.string().trim().max(2000).default(""),
      permanent: booleanSchema.default(false),
    })
    .optional(),
  providerContext: z.record(z.string(), z.unknown()).default({}),
  raw: z.unknown().optional(),
});

export type ListConversationsInput = z.infer<typeof listConversationsSchema>;
export type ComposeMessageInput = z.infer<typeof composeMessageSchema>;
export type InboundWebhookInput = z.infer<typeof inboundWebhookSchema>;
