import { describe, expect, it } from "vitest";

import { buildAiEvidence } from "@/modules/ai/services/ai-evidence.service.js";

describe("AI evidence contract", () => {
  it("normalizes source provenance and context freshness into a stable shape", () => {
    const evidence = buildAiEvidence({
      generatedAt: "2026-08-05T10:01:00.000Z",
      contextGeneratedAt: "2026-08-05T10:00:00.000Z",
      grounding: {
        basis: "mixed",
        insufficientEvidence: false,
        candidateCount: 7,
        retrievedAt: "2026-08-05T09:59:00.000Z",
      },
      citations: [
        {
          sourceId: "article-1:1:0:hash",
          resourceId: "article-1",
          title: "Cancellation policy",
          type: "guide",
          category: "bookings",
          audience: "customer",
          locale: "en",
          version: 4,
          sourceHref: "/app/knowledge?resource=article-1",
          excerpt: "Bookings may be cancelled within the stated window.",
          updatedAt: "2026-08-01T12:00:00.000Z",
          retrievedAt: "2026-08-05T09:59:00.000Z",
        },
      ],
      complete: true,
    });

    expect(evidence).toEqual({
      generatedAt: "2026-08-05T10:01:00.000Z",
      context: {
        basis: "mixed",
        freshnessAt: "2026-08-05T10:00:00.000Z",
        sourceCount: 0,
        candidateCount: 7,
        complete: true,
        truncated: false,
      },
      sources: [
        {
          id: "article-1:1:0:hash",
          resourceId: "article-1",
          title: "Cancellation policy",
          type: "guide",
          category: "bookings",
          audience: "customer",
          locale: "en",
          version: 4,
          href: "/app/knowledge?resource=article-1",
          excerpt: "Bookings may be cancelled within the stated window.",
          updatedAt: "2026-08-01T12:00:00.000Z",
          retrievedAt: "2026-08-05T09:59:00.000Z",
        },
      ],
      warnings: [],
    });
  });

  it("allowlists source fields and never serializes unknown private records", () => {
    const evidence = buildAiEvidence({
      grounding: {
        basis: "knowledge",
        insufficientEvidence: false,
      },
      citations: [
        {
          sourceId: "safe-source",
          title: "Safe public guide",
          sourceHref: `/${"x".repeat(4_000)}`,
          excerpt: "e".repeat(1_100),
          customerBooking: "PRIVATE_BOOKING_SENTINEL_42",
          creditBalance: "PRIVATE_CREDIT_BALANCE_999",
          invoice: "PRIVATE_INVOICE_SENTINEL_77",
        } as any,
      ],
    });

    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_");
    expect(evidence.sources).toEqual([
      expect.objectContaining({
        id: "safe-source",
        title: "Safe public guide",
      }),
    ]);
    expect(evidence.sources[0]).toMatchObject({
      href: `/${"x".repeat(2_999)}`,
      excerpt: "e".repeat(1_000),
    });
  });

  it("counts authorized workspace context independently from citations", () => {
    const evidence = buildAiEvidence({
      grounding: {
        basis: "workspace_facts",
        insufficientEvidence: false,
      },
      citations: [],
      contextSourceCount: 600,
      contextGeneratedAt: "2026-08-05T10:00:00.000Z",
      contextSources: [
        "actor",
        "studio",
        "credits",
        "reports.currentPeriod",
        "private.untrusted-source-name",
      ],
      complete: true,
    });

    expect(evidence.context.sourceCount).toBe(4);
    expect(evidence.sources).toEqual([
      expect.objectContaining({
        id: "context:actor",
        title: "Current workspace access",
        type: "context",
      }),
      expect.objectContaining({ id: "context:studio" }),
      expect.objectContaining({ id: "context:credits" }),
      expect.objectContaining({ id: "context:current_period_reports" }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain("private.untrusted");
  });

  it("returns every deduplicated allowlisted context category and reports the displayed count", () => {
    const evidence = buildAiEvidence({
      grounding: {
        basis: "workspace_facts",
        insufficientEvidence: false,
      },
      citations: [],
      contextSourceCount: 600,
      contextGeneratedAt: "2026-08-05T10:00:00.000Z",
      contextSources: [
        "actor",
        "communications.deliveryHealth",
        "courses.sessions",
        "customers",
        "inventory",
        "invoices",
        "locations",
        "memberships",
        "operations",
        "products",
        "publicSite",
        "reports.currentPeriod",
        "studio",
        "subscription",
        "team",
        "vouchers",
        "credits",
        "courses.catalog",
        "private.untrusted-source-name",
      ],
      complete: true,
    });

    expect(evidence.context.sourceCount).toBe(17);
    expect(evidence.sources).toHaveLength(17);
    expect(evidence.sources.map((source) => source.id)).toEqual(
      expect.arrayContaining([
        "context:actor",
        "context:delivery_health",
        "context:courses",
        "context:customers",
        "context:inventory",
        "context:invoices",
        "context:locations",
        "context:memberships",
        "context:operations",
        "context:products",
        "context:public_site",
        "context:current_period_reports",
        "context:studio",
        "context:subscription",
        "context:team",
        "context:vouchers",
        "context:credits",
      ]),
    );
    expect(JSON.stringify(evidence)).not.toContain("private.untrusted");
  });

  it("labels page and trend sources without falling through to generic reports", () => {
    const freshnessAt = "2026-08-14T09:00:00.000Z";
    const evidence = buildAiEvidence({
      grounding: {
        basis: "workspace_facts",
        insufficientEvidence: false,
      },
      citations: [],
      contextGeneratedAt: freshnessAt,
      contextSources: [
        "page.booking",
        "reports.currentPeriod.bookings",
        "reports.currentPeriod.bookings.series",
      ],
      complete: true,
    });

    expect(evidence.context).toMatchObject({
      freshnessAt,
      sourceCount: 2,
    });
    expect(evidence.sources).toEqual([
      expect.objectContaining({
        id: "context:current_booking",
        title: "Current booking",
        category: "current_booking",
        retrievedAt: freshnessAt,
      }),
      expect.objectContaining({
        id: "context:booking_trend_report",
        title: "Booking trend report",
        category: "booking_trend_report",
        retrievedAt: freshnessAt,
      }),
    ]);
    expect(
      evidence.sources.some(
        ({ id }) => id === "context:current_period_reports",
      ),
    ).toBe(false);
  });

  it("surfaces insufficient and truncated context as explicit warnings", () => {
    const evidence = buildAiEvidence({
      grounding: {
        basis: "insufficient",
        insufficientEvidence: true,
        sourceCount: 1,
      },
      citations: [
        {
          sourceId: "related-but-not-supporting",
          title: "Related article",
        },
      ],
      truncated: true,
      complete: false,
    });

    expect(evidence.context).toMatchObject({
      basis: "insufficient",
      sourceCount: 0,
      complete: false,
      truncated: true,
    });
    expect(evidence.sources).toEqual([]);
    expect(evidence.warnings.map((warning) => warning.code)).toEqual([
      "insufficient_evidence",
      "context_truncated",
    ]);
  });
});
