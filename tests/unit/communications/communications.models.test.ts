import type { Schema } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  auditSchema,
  communicationSettingsSchema,
  consentSchema,
  conversationSchema,
  deliverySchema,
  inboundEventSchema,
  knowledgeArticleSchema,
  messageSchema,
  satisfactionSurveySchema,
  suppressionSchema,
} from "@/modules/communications/communications.models.js";

const hasIndex = (
  schema: Schema,
  fields: Record<string, number | string>,
  options: Record<string, unknown> = {},
) =>
  schema.indexes().some(([indexFields, indexOptions]) =>
    JSON.stringify(indexFields) === JSON.stringify(fields) &&
    Object.entries(options).every(
      ([key, value]) =>
        JSON.stringify((indexOptions as Record<string, unknown>)[key]) ===
        JSON.stringify(value),
    ),
  );

describe("communications persistence boundaries", () => {
  it.each([
    conversationSchema,
    messageSchema,
    deliverySchema,
    consentSchema,
    suppressionSchema,
    auditSchema,
    inboundEventSchema,
    satisfactionSurveySchema,
  ])("requires tenant identity on every customer-data schema", (schema) => {
    expect(schema.path("tenantId")?.options.required).toBe(true);
  });

  it("enforces one delivery idempotency key per tenant", () => {
    expect(
      hasIndex(
        deliverySchema,
        { tenantId: 1, idempotencyKey: 1 },
        { unique: true },
      ),
    ).toBe(true);
  });

  it("deduplicates provider messages within a tenant and channel", () => {
    expect(
      hasIndex(
        messageSchema,
        { tenantId: 1, channel: 1, provider: 1, providerMessageId: 1 },
        { unique: true },
      ),
    ).toBe(true);
  });

  it("deduplicates inbound provider events without crossing tenants", () => {
    expect(
      hasIndex(
        inboundEventSchema,
        { tenantId: 1, channel: 1, provider: 1, eventId: 1 },
        { unique: true },
      ),
    ).toBe(true);
  });

  it("keeps consent and suppression uniqueness tenant-scoped", () => {
    expect(
      hasIndex(
        consentSchema,
        { tenantId: 1, customerId: 1, channel: 1, purpose: 1 },
        { unique: true },
      ),
    ).toBe(true);
    expect(
      hasIndex(
        suppressionSchema,
        { tenantId: 1, channel: 1, identity: 1 },
        { unique: true },
      ),
    ).toBe(true);
  });

  it("uses an explicit audit expiry TTL for retention", () => {
    expect(
      hasIndex(auditSchema, { expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ).toBe(true);
  });

  it("makes owner-wide inbox visibility immutable in communication settings", () => {
    const path = communicationSettingsSchema.path("inbox.ownerCanViewAll");

    expect(path?.options.default).toBe(true);
    expect(path?.options.immutable).toBe(true);
  });

  it("keeps one Instagram account tenant-bound and credentials excluded by default", () => {
    expect(
      hasIndex(
        communicationSettingsSchema,
        { "channels.instagram.instagramAccountId": 1 },
        { unique: true },
      ),
    ).toBe(true);
    expect(
      communicationSettingsSchema.path(
        "channels.instagram.encryptedAccessToken",
      )?.options.select,
    ).toBe(false);
    expect(
      communicationSettingsSchema.path(
        "channels.instagram.oauthStateHash",
      )?.options.select,
    ).toBe(false);
  });

  it("stores internal notes as an explicit message privacy flag", () => {
    expect(messageSchema.path("isInternal")?.options.default).toBe(false);
    expect(messageSchema.path("direction")?.options.required).toBe(true);
  });

  it("indexes knowledge audiences and target arrays without parallel multikey fields", () => {
    expect(
      hasIndex(knowledgeArticleSchema, {
        tenantId: 1,
        status: 1,
        audience: 1,
        deletedAt: 1,
        targetCourseIds: 1,
      }),
    ).toBe(true);
    expect(
      hasIndex(knowledgeArticleSchema, {
        tenantId: 1,
        status: 1,
        audience: 1,
        deletedAt: 1,
        targetMembershipIds: 1,
      }),
    ).toBe(true);
    expect(knowledgeArticleSchema.path("embeddingVector")?.options.select)
      .toBe(false);
  });

  it("allows only one CSAT survey per tenant conversation", () => {
    expect(
      hasIndex(
        satisfactionSurveySchema,
        { tenantId: 1, conversationId: 1 },
        { unique: true },
      ),
    ).toBe(true);
  });
});
