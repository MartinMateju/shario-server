import mongoose from "mongoose";
import { z } from "zod";

import {
  COMMUNICATION_AUTOMATION_STATUS,
  SHARIO_COMMUNICATION_SCHEDULE_TYPES,
  SHARIO_COMMUNICATION_PRODUCT_TYPES,
  COMMUNICATION_CONNECTED_PRODUCT_TYPE,
  COMMUNICATION_DAY_OF_WEEK,
  COMMUNICATION_SCHEDULE_TYPE,
  DEFAULT_DAY_OF_MONTH,
  DEFAULT_DAY_OF_WEEK,
  DEFAULT_MINUTES_OFFSET,
  DEFAULT_SEND_TIME,
  MAX_RECIPIENTS_PER_AUTOMATION,
  MAX_AUTOMATION_OFFSET_MINUTES,
  COMMUNICATION_CONTENT_LOCALE,
  COMMUNICATION_AUTOMATION_PURPOSE,
  RECURRING_COMMUNICATION_SCHEDULE_TYPES,
  BOOKING_COMMUNICATION_SCHEDULE_TYPES,
  TIME_REGEX,
} from "./communication-automation.constants.js";
import { getUnknownEmailTemplateVariables } from "@/modules/email-template/email-template.rendering.js";
import {
  EMAIL_TEMPLATE_FORMAT,
  EMAIL_TEMPLATE_FORMATS,
} from "@/modules/email-template/email-template.constants.js";

const enumValues = <T extends Record<string, string>>(values: T) =>
  Object.values(values) as [T[keyof T], ...T[keyof T][]];

export const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .min(1, `${fieldName} is required.`)
    .refine(
      (value) => mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}.`,
    );

const optionalObjectIdSchema = (fieldName = "id") =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") return null;
      return value;
    },
    objectIdSchema(fieldName).nullable(),
  );

const optionalEmailSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return "";
    return String(value).trim().toLowerCase();
  },
  z.union([z.string().email(), z.literal("")]),
);

const contentLocaleSchema = z.enum(enumValues(COMMUNICATION_CONTENT_LOCALE));

const localizedContentSchema = z.object({
  subject: z.string().trim().max(240).default(""),
  htmlContent: z.string().trim().max(250_000).default(""),
  body: z.string().max(100_000).default(""),
  format: z.enum(EMAIL_TEMPLATE_FORMATS as ["html", "plain"]).default(
    EMAIL_TEMPLATE_FORMAT.HTML,
  ),
});

export const communicationRecipientSchema = z
  .object({
    user: optionalObjectIdSchema("user").optional(),
    email: optionalEmailSchema.default(""),
    customId: z.string().trim().default(""),
    name: z.string().trim().default(""),
    locale: contentLocaleSchema.default(COMMUNICATION_CONTENT_LOCALE.CS),
  })
  .superRefine((recipient, ctx) => {
    if (!recipient.user && !recipient.email && !recipient.customId) {
      ctx.addIssue({
        code: "custom",
        message: "Recipient must include a user, email, or customId.",
      });
    }
  })
  .transform((recipient) => ({
    user: recipient.user || null,
    email: recipient.email || "",
    customId: recipient.customId || "",
    name: recipient.name || "",
    locale: recipient.locale,
  }));

const automationObjectSchema = z.object({
  name: z.string().trim().min(1).max(160),

  scheduleType: z.enum(SHARIO_COMMUNICATION_SCHEDULE_TYPES as [string, ...string[]]),

  connectedProductType: z
    .enum(SHARIO_COMMUNICATION_PRODUCT_TYPES as [string, ...string[]])
    .default(COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL),

  automationStatus: z
    .enum(enumValues(COMMUNICATION_AUTOMATION_STATUS))
    .default(COMMUNICATION_AUTOMATION_STATUS.WAITING_TO_ACTIVATE),

  minutesOffset: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_AUTOMATION_OFFSET_MINUTES)
    .default(DEFAULT_MINUTES_OFFSET),

  sendTime: z
    .string()
    .trim()
    .regex(TIME_REGEX, "sendTime must be in HH:mm format.")
    .default(DEFAULT_SEND_TIME),

  oneTimeSendAt: z.coerce.date().nullable().optional(),

  dayOfWeek: z
    .enum(enumValues(COMMUNICATION_DAY_OF_WEEK))
    .default(DEFAULT_DAY_OF_WEEK),

  dayOfMonth: z.coerce
    .number()
    .int()
    .min(1)
    .max(31)
    .default(DEFAULT_DAY_OF_MONTH),

  senderEmail: objectIdSchema("senderEmail"),

  sendToAllRecipients: z.coerce.boolean().default(false),

  recipients: z
    .array(communicationRecipientSchema)
    .max(MAX_RECIPIENTS_PER_AUTOMATION)
    .default([]),

  subject: z.string().trim().max(240).default(""),

  htmlContent: z.string().trim().max(250_000).default(""),

  body: z.string().max(100_000).default(""),

  format: z.enum(EMAIL_TEMPLATE_FORMATS as ["html", "plain"]).default(
    EMAIL_TEMPLATE_FORMAT.HTML,
  ),

  contentVariants: z
    .object({
      cs: localizedContentSchema.optional(),
      en: localizedContentSchema.optional(),
    })
    .default({}),

  defaultLocale: contentLocaleSchema.default(COMMUNICATION_CONTENT_LOCALE.CS),

  purpose: z
    .enum(enumValues(COMMUNICATION_AUTOMATION_PURPOSE))
    .default(COMMUNICATION_AUTOMATION_PURPOSE.TRANSACTIONAL),

  templateId: optionalObjectIdSchema("templateId").optional(),

  respectQuietHours: z.coerce.boolean().default(true),

  cancelOnReschedule: z.coerce.boolean().default(true),

  isActive: z.coerce.boolean().default(false),

  location: optionalObjectIdSchema("location").optional(),

  locationId: optionalObjectIdSchema("locationId").optional(),

  appliesToAllLocations: z.coerce.boolean().default(true),
});

const normalizeCreateAutomation = <T extends {
  body?: string;
  htmlContent?: string;
  sendToAllRecipients?: boolean;
  recipients?: unknown[];
  appliesToAllLocations?: boolean;
  location?: string | null;
  locationId?: string | null;
}>(input: T) => ({
  ...input,
  body: input.body || input.htmlContent || "",
  recipients: input.sendToAllRecipients ? [] : input.recipients || [],
  location: input.appliesToAllLocations
    ? null
    : input.location || input.locationId || null,
  locationId: undefined,
});

const normalizeUpdateAutomation = <T extends {
  body?: string;
  htmlContent?: string;
  sendToAllRecipients?: boolean;
  recipients?: unknown[];
  appliesToAllLocations?: boolean;
  location?: string | null;
  locationId?: string | null;
}>(input: T) => ({
  ...input,
  ...(input.body !== undefined || input.htmlContent !== undefined
    ? { body: input.body || input.htmlContent || "" }
    : {}),
  ...(input.sendToAllRecipients === true
    ? { recipients: [] }
    : input.recipients !== undefined
      ? { recipients: input.recipients }
      : {}),
  ...(input.appliesToAllLocations === true
    ? { location: null }
    : input.location !== undefined
      ? { location: input.location || null }
      : input.locationId !== undefined
        ? { location: input.locationId || null }
      : {}),
  locationId: undefined,
});

const addContentIssues = (
  input: {
    subject?: string;
    htmlContent?: string;
    body?: string;
    contentVariants?: { cs?: z.infer<typeof localizedContentSchema>; en?: z.infer<typeof localizedContentSchema> };
    templateId?: string | null;
  },
  ctx: z.RefinementCtx,
) => {
  const variants = Object.values(input.contentVariants ?? {});
  const hasInlineContent = Boolean(
    (input.subject && (input.htmlContent || input.body)) ||
    variants.some((variant) => variant?.subject && (variant.htmlContent || variant.body)),
  );

  if (!hasInlineContent && !input.templateId) {
    ctx.addIssue({
      code: "custom",
      path: ["htmlContent"],
      message: "An inline localized message or email template is required.",
    });
  }

  const unknown = getUnknownEmailTemplateVariables(
    input.subject,
    input.htmlContent,
    input.body,
    ...variants.flatMap((variant) => [variant?.subject, variant?.htmlContent, variant?.body]),
  );
  if (unknown.length) {
    ctx.addIssue({
      code: "custom",
      path: ["contentVariants"],
      message: `Unsupported email variables: ${unknown.join(", ")}.`,
    });
  }
};

const refineCreateAutomation = (
  input: z.infer<typeof automationObjectSchema>,
  ctx: z.RefinementCtx,
) => {
  addTriggerCompatibilityIssues(input, ctx);
  if (!input.appliesToAllLocations && !input.location && !input.locationId) {
    ctx.addIssue({
      code: "custom",
      path: ["location"],
      message:
        "Location is required when automation does not apply to all locations.",
    });
  }

  if (
    RECURRING_COMMUNICATION_SCHEDULE_TYPES.has(input.scheduleType) &&
    !input.sendToAllRecipients &&
    input.recipients.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["recipients"],
      message:
        "Recipients are required unless sendToAllRecipients is enabled.",
    });
  }

  if (
    input.scheduleType === COMMUNICATION_SCHEDULE_TYPE.ONE_TIME_EMAIL &&
    !input.oneTimeSendAt
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["oneTimeSendAt"],
      message: "oneTimeSendAt is required for a one-time email.",
    });
  }

  addContentIssues(input, ctx);
};

const BOOKING_PRODUCT_TYPES = new Set<string>([
  COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL,
  COMMUNICATION_CONNECTED_PRODUCT_TYPE.BOOKING,
  COMMUNICATION_CONNECTED_PRODUCT_TYPE.WORKSHOP,
  COMMUNICATION_CONNECTED_PRODUCT_TYPE.COURSE,
  COMMUNICATION_CONNECTED_PRODUCT_TYPE.PRIVATE_SESSION,
]);

const POTTERY_EVENT_TYPES = new Set<string>([
  COMMUNICATION_SCHEDULE_TYPE.AFTER_ITEM_REGISTERED,
  COMMUNICATION_SCHEDULE_TYPE.AFTER_BISQUE_FIRING,
  COMMUNICATION_SCHEDULE_TYPE.AFTER_FINAL_FIRING,
]);

const addTriggerCompatibilityIssues = (
  input: {
    scheduleType?: string;
    connectedProductType?: string;
    appliesToAllLocations?: boolean;
    purpose?: string;
  },
  ctx: z.RefinementCtx,
) => {
  if (input.purpose === COMMUNICATION_AUTOMATION_PURPOSE.MARKETING) {
    ctx.addIssue({
      code: "custom",
      path: ["purpose"],
      message:
        "Marketing automations are unavailable until customer unsubscribe management is enabled.",
    });
  }
  if (
    input.appliesToAllLocations === false &&
    (RECURRING_COMMUNICATION_SCHEDULE_TYPES.has(
      String(input.scheduleType || ""),
    ) ||
      input.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_REGISTRATION)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["appliesToAllLocations"],
      message:
        "Broadcast and registration automations must apply to all locations.",
    });
  }
  if (input.scheduleType === COMMUNICATION_SCHEDULE_TYPE.PASSWORD_RESET) {
    ctx.addIssue({
      code: "custom",
      path: ["scheduleType"],
      message: "Password reset email delivery is managed by authentication and cannot be configured as an automation.",
    });
  }
  if (
    input.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_BISQUE_FIRING ||
    input.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_FINAL_FIRING
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["scheduleType"],
      message: "Firing notifications are managed by the grouped firing workflow and cannot be configured as per-item automations.",
    });
  }
  if (
    input.scheduleType &&
    BOOKING_COMMUNICATION_SCHEDULE_TYPES.has(input.scheduleType) &&
    input.connectedProductType &&
    !BOOKING_PRODUCT_TYPES.has(input.connectedProductType)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["connectedProductType"],
      message: "This product type is not supported by booking automations.",
    });
  }
  if (
    input.scheduleType &&
    POTTERY_EVENT_TYPES.has(input.scheduleType) &&
    input.connectedProductType &&
    ![
      COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL,
      COMMUNICATION_CONNECTED_PRODUCT_TYPE.POTTERY_ITEM,
    ].includes(input.connectedProductType as never)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["connectedProductType"],
      message: "Pottery event automations support only all products or pottery items.",
    });
  }
  if (
    input.scheduleType === COMMUNICATION_SCHEDULE_TYPE.AFTER_REGISTRATION &&
    input.connectedProductType &&
    input.connectedProductType !== COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["connectedProductType"],
      message: "Registration automations must apply to all products.",
    });
  }
};

// Zod 4 applies defaults inside optional fields. Check for undefined first so
// PATCH requests validate supplied values without inserting create defaults.
const updateAutomationShape = Object.fromEntries(
  Object.entries(automationObjectSchema.shape).map(([field, schema]) => [
    field,
    z.union([z.undefined(), schema]).optional(),
  ]),
) as {
  [Field in keyof typeof automationObjectSchema.shape]: z.ZodOptional<
    z.ZodUnion<[
      z.ZodUndefined,
      (typeof automationObjectSchema.shape)[Field],
    ]>
  >;
};

const updateAutomationObjectSchema = z.object(updateAutomationShape).extend({
  id: objectIdSchema("automation id"),
});

const refineUpdateAutomation = (
  input: z.infer<typeof updateAutomationObjectSchema>,
  ctx: z.RefinementCtx,
) => {
  addTriggerCompatibilityIssues(input, ctx);
  if (
    input.appliesToAllLocations === false &&
    !input.location &&
    !input.locationId
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["location"],
      message:
        "Location is required when automation does not apply to all locations.",
    });
  }

  if (
    input.scheduleType !== undefined &&
    RECURRING_COMMUNICATION_SCHEDULE_TYPES.has(input.scheduleType) &&
    input.sendToAllRecipients === false &&
    input.recipients !== undefined &&
    input.recipients.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["recipients"],
      message:
        "Recipients are required unless sendToAllRecipients is enabled.",
    });
  }

  if (
    input.subject !== undefined ||
    input.htmlContent !== undefined ||
    input.body !== undefined ||
    input.contentVariants !== undefined
  ) {
    const unknown = getUnknownEmailTemplateVariables(
      input.subject,
      input.htmlContent,
      input.body,
      ...Object.values(input.contentVariants ?? {}).flatMap((variant) => [
        variant?.subject,
        variant?.htmlContent,
        variant?.body,
      ]),
    );
    if (unknown.length) {
      ctx.addIssue({
        code: "custom",
        path: ["contentVariants"],
        message: `Unsupported email variables: ${unknown.join(", ")}.`,
      });
    }
  }
};

export const createCommunicationAutomationSchema = automationObjectSchema
  .superRefine(refineCreateAutomation)
  .transform((input) => ({
    ...normalizeCreateAutomation(input),
    isActive: false,
    automationStatus: COMMUNICATION_AUTOMATION_STATUS.WAITING_TO_ACTIVATE,
  }));

export const updateCommunicationAutomationSchema = updateAutomationObjectSchema
  .superRefine(refineUpdateAutomation)
  .transform(normalizeUpdateAutomation);

export const communicationAutomationIdParamsSchema = z.object({
  id: objectIdSchema("automation id"),
});

export const listCommunicationAutomationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),

  limit: z.coerce.number().int().positive().max(100).default(50),

  search: z.string().trim().default(""),

  scheduleType: z.enum(enumValues(COMMUNICATION_SCHEDULE_TYPE)).optional(),

  connectedProductType: z
    .enum(enumValues(COMMUNICATION_CONNECTED_PRODUCT_TYPE))
    .optional(),

  automationStatus: z
    .enum(enumValues(COMMUNICATION_AUTOMATION_STATUS))
    .optional(),

  isActive: z.coerce.boolean().optional(),

  senderEmail: objectIdSchema("senderEmail").optional(),
});

export type CreateCommunicationAutomationInput = z.infer<
  typeof createCommunicationAutomationSchema
>;

export type UpdateCommunicationAutomationInput = z.infer<
  typeof updateCommunicationAutomationSchema
>;

export type ListCommunicationAutomationsInput = z.infer<
  typeof listCommunicationAutomationsSchema
>;
