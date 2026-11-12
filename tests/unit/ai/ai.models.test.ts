import type { Schema } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  aiActionSchema,
  aiActionEventSchema,
  aiAdvisorSnapshotSchema,
  aiBriefingSchema,
  aiConversationSchema,
  aiFeedbackSchema,

  aiMessageSchema,
  aiRunSchema,
  aiSettingsSchema,
  aiUsageLedgerSchema,
  aiUsagePeriodSchema,
} from "@/modules/ai/ai.models.js";
import { normalizeAssistantNavigation } from "@/modules/ai/services/assistant-navigation.service.js";

const hasIndex = (
  schema: Schema,
  fields: Record<string, number | string>,
  options: Record<string, unknown> = {},
) =>
  schema
    .indexes()
    .some(
      ([indexFields, indexOptions]) =>
        JSON.stringify(indexFields) === JSON.stringify(fields) &&
        Object.entries(options).every(
          ([key, value]) =>
            JSON.stringify((indexOptions as Record<string, unknown>)[key]) ===
            JSON.stringify(value),
        ),
    );

describe("AI persistence boundaries", () => {
  it.each([
    aiRunSchema,
    aiUsagePeriodSchema,
    aiUsageLedgerSchema,
    aiConversationSchema,
    aiMessageSchema,
    aiActionSchema,
    aiActionEventSchema,
    aiAdvisorSnapshotSchema,
    aiBriefingSchema,

    aiSettingsSchema,
    aiFeedbackSchema,
  ])("requires tenant identity on every AI schema", (schema) => {
    expect(schema.path("tenant")?.options.required).toBe(true);
  });

  it("indexes tenant-scoped provider health outcomes", () => {
    expect(
      hasIndex(aiRunSchema, { tenant: 1, feature: 1, completedAt: -1 }),
    ).toBe(true);
  });

  it("scopes run and ledger idempotency to one tenant", () => {
    expect(
      hasIndex(aiRunSchema, { tenant: 1, idempotencyKey: 1 }, { unique: true }),
    ).toBe(true);
    expect(
      hasIndex(
        aiUsageLedgerSchema,
        { tenant: 1, idempotencyKey: 1 },
        { unique: true },
      ),
    ).toBe(true);
  });

  it("allows one usage counter per tenant billing period", () => {
    expect(
      hasIndex(
        aiUsagePeriodSchema,
        { tenant: 1, periodKey: 1 },
        { unique: true },
      ),
    ).toBe(true);
  });

  it("keeps public session secrets private and expires public sessions", () => {
    expect(aiConversationSchema.path("publicSessionHash")?.options.select).toBe(
      false,
    );
    expect(
      hasIndex(
        aiConversationSchema,
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
    ).toBe(true);
  });

  it("persists auditable Knowledge Hub provenance and grounding on AI messages", () => {
    for (const path of [
      "citations.sourceId",
      "citations.resourceId",
      "citations.title",
      "citations.sourceHref",
      "citations.version",
      "citations.contentHash",
      "citations.locale",
      "citations.excerpt",
      "citations.updatedAt",
      "citations.retrievedAt",
      "grounding.status",
      "grounding.basis",
      "grounding.insufficientEvidence",
      "grounding.knowledgeStatus",
      "grounding.retrievalMode",
      "grounding.confidence",
      "grounding.sourceCount",
      "grounding.candidateCount",
      "grounding.retrievedAt",
      "suggestedReplies",
      "navigation.kind",
      "navigation.stepId",
      "navigation.label",
      "navigation.href",
    ]) {
      expect(aiMessageSchema.path(path), path).toBeDefined();
    }
    expect(aiMessageSchema.path("grounding.status")?.options.required).toBe(
      true,
    );
    expect(aiMessageSchema.path("grounding.status")?.options.enum).toContain(
      "unavailable",
    );
    expect(aiMessageSchema.path("grounding.basis")?.options.required).toBe(
      true,
    );
    expect(
      aiMessageSchema.path("grounding.knowledgeStatus")?.options.required,
    ).toBe(true);
    expect(aiMessageSchema.path("navigation.kind")?.options.enum).toEqual([
      "setup_step",
      "booking_composer",
    ]);
    expect(aiMessageSchema.path("navigation.stepId")?.options.required).not.toBe(
      true,
    );
  });

  it("normalizes legacy setup navigation and keeps the result stable", () => {
    const legacySubdocument = {
      toObject: () => ({
        stepId: "studio-profile",
        label: "Open studio profile",
        href: "/app/settings/studio?tab=profile",
      }),
    };
    const normalized = normalizeAssistantNavigation([legacySubdocument]);

    expect(normalized).toEqual([
      {
        kind: "setup_step",
        stepId: "studio-profile",
        label: "Open studio profile",
        href: "/app/settings/studio?tab=profile",
      },
    ]);
    expect(normalizeAssistantNavigation(normalized)).toEqual(normalized);
  });

  it("accepts only canonical all-four or unprefilled booking navigation", () => {
    const productId = "507f1f77bcf86cd799439101";
    const locationId = "507f1f77bcf86cd799439102";
    const params = new URLSearchParams({
      productId,
      locationId,
      start: "2026-08-14T07:00:00.000Z",
      end: "2026-08-14T08:00:00.000Z",
      returnTo: "/app/ai",
    });
    const normalized = normalizeAssistantNavigation([
      {
        kind: "booking_composer",
        label: "Review booking",
        href: "/app/bookings/new?" + params.toString(),
      },
      {
        kind: "booking_composer",
        label: "Open blank booking form",
        href: "/app/bookings/new?returnTo=%2Fapp%2Fai",
      },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalizeAssistantNavigation(normalized)).toEqual(normalized);
    expect(
      new URL(normalized[0]!.href, "https://studio.test").searchParams.get(
        "locationId",
      ),
    ).toBe(locationId);
  });

  it("drops malformed, partial, unsafe, and provider-like booking navigation", () => {
    const validProductId = "507f1f77bcf86cd799439101";
    const validLocationId = "507f1f77bcf86cd799439102";
    const malformed = [
      "/app/bookings/new?productId=" +
        validProductId +
        "&returnTo=%2Fapp%2Fai",
      "/app/bookings/new?productId=not-an-id&locationId=" +
        validLocationId +
        "&start=2026-08-14T07%3A00%3A00.000Z&end=2026-08-14T08%3A00%3A00.000Z&returnTo=%2Fapp%2Fai",
      "/app/bookings/new?productId=" +
        validProductId +
        "&locationId=" +
        validLocationId +
        "&start=2026-08-14T08%3A00%3A00.000Z&end=2026-08-14T07%3A00%3A00.000Z&returnTo=%2Fapp%2Fai",
      "/app/bookings/new?returnTo=%2Fapp%2Fai&customerName=Hidden",
      "/app/bookings/new?returnTo=%2Fapp%2Fother",
      "/app/bookings/new?returnTo=%2Fapp%2Fai&returnTo=%2Fapp%2Fai",
      "/app/bookings/new/other?returnTo=%2Fapp%2Fai",
      "https://evil.test/app/bookings/new?returnTo=%2Fapp%2Fai",
    ];

    for (const href of malformed) {
      expect(
        normalizeAssistantNavigation([
          { kind: "booking_composer", label: "Open", href },
        ]),
        href,
      ).toEqual([]);
    }
    expect(
      normalizeAssistantNavigation([
        {
          label: "Provider-like raw booking link",
          href: "/app/bookings/new?returnTo=%2Fapp%2Fai",
        },
      ]),
    ).toEqual([]);
  });

  it("never returns more than the three navigation affordances in the contract", () => {
    const normalized = normalizeAssistantNavigation(
      Array.from({ length: 4 }, (_, index) => ({
        stepId: "step-" + index,
        label: "Step " + index,
        href: "/app/settings/step-" + index,
      })),
    );
    expect(normalized).toHaveLength(3);
  });

  it("deduplicates daily briefings inside tenant, user, day and scope", () => {
    expect(
      hasIndex(
        aiBriefingSchema,
        { tenant: 1, user: 1, dateKey: 1, scopeKey: 1 },
        { unique: true },
      ),
    ).toBe(true);
    expect(aiBriefingSchema.path("accessFingerprint")).toBeDefined();
    expect(aiBriefingSchema.path("snapshotHash")).toBeDefined();
    expect(aiBriefingSchema.path("attention")).toBeDefined();
    expect(aiBriefingSchema.path("suggestedActions")).toBeDefined();
    expect(aiBriefingSchema.path("refreshAfter")).toBeDefined();
    expect(
      hasIndex(aiBriefingSchema, { expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ).toBe(true);
  });

  it("scopes Business Advisor snapshots to actor and authorization boundary", () => {
    expect(
      hasIndex(
        aiAdvisorSnapshotSchema,
        { tenant: 1, user: 1, scopeKey: 1 },
        { unique: true },
      ),
    ).toBe(true);
    for (const path of [
      "accessFingerprint",
      "snapshotHash",
      "recommendations",
      "recommendations.confidence",
      "recommendations.evidence.unit",
      "period",
      "coverage",
      "refreshAfter",
      "adviceExpiresAt",
      "expiresAt",
    ]) {
      expect(aiAdvisorSnapshotSchema.path(path), path).toBeDefined();
    }
    expect(
      hasIndex(
        aiAdvisorSnapshotSchema,
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
    ).toBe(true);
  });

  it("makes action target permission and expiry mandatory", () => {
    expect(aiActionSchema.path("requiredPermission")?.options.required).toBe(
      true,
    );
    expect(aiActionSchema.path("expiresAt")?.options.required).toBe(true);
    expect(aiActionSchema.path("requestedBy")?.options.required).toBe(true);
    expect(aiActionSchema.path("payload")?.options.select).toBe(false);
    expect(aiActionSchema.path("targetSnapshot")?.options.select).toBe(false);
    expect(aiActionSchema.path("error")?.options.select).toBe(false);
    expect(
      hasIndex(
        aiActionSchema,
        { tenant: 1, idempotencyKey: 1 },
        { unique: true },
      ),
    ).toBe(true);
    expect(aiActionEventSchema.path("action")?.options.required).toBe(true);
    expect(aiActionEventSchema.path("actor")?.options.required).toBe(true);
    expect(aiActionEventSchema.path("eventKey")?.options.required).toBe(true);
    expect(
      hasIndex(
        aiActionEventSchema,
        { tenant: 1, action: 1, eventKey: 1 },
        { unique: true },
      ),
    ).toBe(true);
  });
});
