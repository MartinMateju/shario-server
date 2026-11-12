import { z } from "zod";

const boundedString = (maximum: number) => z.string().max(maximum);
const messageIdSchema = z.string().trim().min(1).max(300);
const providerEventIdSchema = z.union([
  z.string().trim().regex(/^\d+$/).max(30),
  z.number().int().nonnegative(),
]);
const emailSchema = z.string().trim().toLowerCase().max(254).email();
const isoDateSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Expected an ISO-8601 timestamp.",
  });
const metadataSchema = z
  .record(z.string().max(120), z.string().max(1_000))
  .refine((value) => Object.keys(value).length <= 30, {
    message: "Too many metadata entries.",
  });

const forbiddenContentShape = {
  Content: z.never().optional(),
  RawEmail: z.never().optional(),
  TextBody: z.never().optional(),
  HtmlBody: z.never().optional(),
  Attachments: z.never().optional(),
};

const deliverySchema = z
  .object({
    ...forbiddenContentShape,
    RecordType: z.literal("Delivery"),
    MessageID: messageIdSchema,
    Recipient: emailSchema,
    DeliveredAt: isoDateSchema,
    Details: boundedString(10_000).optional(),
    Tag: boundedString(1_000).optional(),
    ServerID: z.number().int().positive(),
    Metadata: metadataSchema.optional(),
    MessageStream: z.string().trim().min(1).max(100),
  })
  .strip();

const bounceSchema = z
  .object({
    ...forbiddenContentShape,
    RecordType: z.literal("Bounce"),
    MessageID: messageIdSchema,
    MessageStream: z.string().trim().min(1).max(100),
    ID: providerEventIdSchema,
    Type: boundedString(120),
    TypeCode: z.number().int().nonnegative(),
    Name: boundedString(500).optional(),
    Tag: boundedString(1_000).optional(),
    Metadata: metadataSchema.optional(),
    ServerID: z.number().int().positive(),
    Description: boundedString(10_000).optional(),
    Details: boundedString(10_000).optional(),
    Email: emailSchema,
    From: emailSchema.optional(),
    BouncedAt: isoDateSchema,
    DumpAvailable: z.boolean().optional(),
    Inactive: z.boolean().optional(),
    CanActivate: z.boolean().optional(),
    Subject: boundedString(1_000).optional(),
  })
  .strip();

const spamComplaintSchema = z
  .object({
    ...forbiddenContentShape,
    RecordType: z.literal("SpamComplaint"),
    MessageID: messageIdSchema,
    MessageStream: z.string().trim().min(1).max(100),
    ID: providerEventIdSchema,
    Type: boundedString(120).optional(),
    TypeCode: z.number().int().nonnegative().optional(),
    Name: boundedString(500).optional(),
    Tag: boundedString(1_000).optional(),
    Metadata: metadataSchema.optional(),
    ServerID: z.number().int().positive(),
    Description: boundedString(10_000).optional(),
    Details: boundedString(10_000).optional(),
    Email: emailSchema,
    From: emailSchema.optional(),
    BouncedAt: isoDateSchema,
    DumpAvailable: z.boolean().optional(),
    Inactive: z.boolean().optional(),
    CanActivate: z.boolean().optional(),
    Subject: boundedString(1_000).optional(),
  })
  .strip();

export const postmarkOutboundWebhookPayloadSchema = z.discriminatedUnion(
  "RecordType",
  [deliverySchema, bounceSchema, spamComplaintSchema],
);

export type PostmarkOutboundWebhookPayload = z.infer<
  typeof postmarkOutboundWebhookPayloadSchema
>;
