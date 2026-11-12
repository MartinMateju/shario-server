type EvidenceCitation = {
  sourceId?: unknown;
  resourceId?: unknown;
  title?: unknown;
  type?: unknown;
  category?: unknown;
  audience?: unknown;
  locale?: unknown;
  version?: unknown;
  sourceHref?: unknown;
  sourceUrl?: unknown;
  excerpt?: unknown;
  updatedAt?: unknown;
  retrievedAt?: unknown;
};

type EvidenceGrounding = {
  basis?: unknown;
  insufficientEvidence?: unknown;
  sourceCount?: unknown;
  candidateCount?: unknown;
  retrievedAt?: unknown;
};

export const AI_EVIDENCE_CONTEXT_SOURCE_LIMIT = 500;

const WORKSPACE_CONTEXT_SOURCE_LABELS: readonly [string, string, string][] = [
  [
    "reports.currentPeriod.bookings",
    "booking_trend_report",
    "Booking trend report",
  ],
  ["page.booking", "current_booking", "Current booking"],
  ["reports.currentPeriod", "current_period_reports", "Current-period reports"],
  ["communications.automations", "automations", "Automations"],
  ["communications.deliveryHealth", "delivery_health", "Delivery health"],
  ["courses", "courses", "Courses and sessions"],
  ["operations", "operations", "Operational records"],
  ["publicSite", "public_site", "Website publication"],
  ["memberships", "memberships", "Memberships"],
  ["subscription", "subscription", "Subscription"],
  ["locations", "locations", "Locations and opening hours"],
  ["products", "products", "Products"],
  ["inventory", "inventory", "Inventory"],
  ["customers", "customers", "Customer aggregates"],
  ["invoices", "invoices", "Invoices"],
  ["credits", "credits", "Credits"],
  ["vouchers", "vouchers", "Vouchers"],
  ["team", "team", "Team"],
  ["studio", "studio", "Studio profile"],
  ["actor", "actor", "Current workspace access"],
  ["public_location", "public_location", "Public studio information"],
];

export type AiEvidenceWarning = {
  code: string;
  label?: string;
  question?: string;
  category?: string;
};

const optionalString = (value: unknown): string | undefined => {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
};

const boundedString = (
  value: unknown,
  maximumLength: number,
): string | undefined => optionalString(value)?.slice(0, maximumLength);

const optionalIsoDate = (value: unknown): string | null => {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};

const nonNegativeInteger = (value: unknown): number | undefined => {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
};

/**
 * Stable, allowlisted evidence contract shared by workspace and concierge AI.
 * Unknown citation fields are intentionally discarded so this serializer can
 * never become a path for private model or database properties.
 */
export const buildAiEvidence = ({
  grounding,
  citations,
  generatedAt = new Date().toISOString(),
  contextGeneratedAt,
  contextSourceCount,
  contextSources,
  complete,
  truncated = false,
  warnings = [],
}: {
  grounding?: EvidenceGrounding | null;
  citations?: EvidenceCitation[] | null;
  generatedAt?: unknown;
  contextGeneratedAt?: unknown;
  contextSourceCount?: unknown;
  contextSources?: unknown;
  complete?: boolean;
  truncated?: boolean;
  warnings?: AiEvidenceWarning[];
}) => {
  const insufficientGrounding =
    grounding?.insufficientEvidence === true ||
    String(grounding?.basis || "") === "insufficient";
  const citationSources = (insufficientGrounding ? [] : citations || [])
    .slice(0, 20)
    .flatMap((citation) => {
      const id = boundedString(citation.sourceId, 100);
      const resourceId = boundedString(citation.resourceId, 100);
      const title = boundedString(citation.title, 240);
      const type = boundedString(citation.type, 40);
      const category = boundedString(citation.category, 100);
      const audience = boundedString(citation.audience, 40);
      const locale = boundedString(citation.locale, 10);
      const version = nonNegativeInteger(citation.version);
      const href = boundedString(
        citation.sourceHref || citation.sourceUrl,
        3_000,
      );
      const excerpt = boundedString(citation.excerpt, 1_000);
      const updatedAt = optionalIsoDate(citation.updatedAt);
      const retrievedAt = optionalIsoDate(citation.retrievedAt);
      if (!id || !title) return [];
      return [
        {
          id,
          ...(resourceId ? { resourceId } : {}),
          title,
          ...(type ? { type } : {}),
          ...(category ? { category } : {}),
          ...(audience ? { audience } : {}),
          ...(locale ? { locale } : {}),
          ...(version && version >= 1 ? { version } : {}),
          ...(href ? { href } : {}),
          ...(excerpt ? { excerpt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
          ...(retrievedAt ? { retrievedAt } : {}),
        },
      ];
    });
  const generatedAtIso = optionalIsoDate(generatedAt);
  const freshnessAt =
    optionalIsoDate(contextGeneratedAt) ||
    optionalIsoDate(grounding?.retrievedAt) ||
    generatedAtIso;
  const candidateCount = nonNegativeInteger(grounding?.candidateCount);
  const hasSuppliedContextSources = Array.isArray(contextSources);
  const normalizedContextSources = hasSuppliedContextSources
    ? contextSources.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const seenContextCategories = new Set<string>();
  const contextEvidenceSources = normalizedContextSources.flatMap((source) => {
    const definition = WORKSPACE_CONTEXT_SOURCE_LABELS.find(
      ([prefix]) => source === prefix || source.startsWith(`${prefix}.`),
    );
    if (!definition) return [];
    const [, category, title] = definition;
    if (seenContextCategories.has(category)) return [];
    seenContextCategories.add(category);
    return [
      {
        id: `context:${category}`,
        title,
        type: "context",
        category,
        ...(freshnessAt ? { retrievedAt: freshnessAt } : {}),
      },
    ];
  });
  // The context registry is a fixed allowlist, so every deduplicated category
  // can be returned safely. Knowledge citations remain a separate list.
  const sources = [...contextEvidenceSources, ...citationSources];
  const sourceCount = hasSuppliedContextSources
    ? contextEvidenceSources.length
    : (nonNegativeInteger(contextSourceCount) ?? 0);
  const evidenceWarnings = [...warnings];
  if (insufficientGrounding) {
    evidenceWarnings.unshift({ code: "insufficient_evidence" });
  }
  if (truncated) {
    evidenceWarnings.push({ code: "context_truncated" });
  }

  return {
    generatedAt: generatedAtIso,
    context: {
      basis: boundedString(grounding?.basis, 80) || "insufficient",
      freshnessAt,
      sourceCount: Math.min(sourceCount, AI_EVIDENCE_CONTEXT_SOURCE_LIMIT),
      ...(candidateCount !== undefined ? { candidateCount } : {}),
      ...(typeof complete === "boolean" ? { complete } : {}),
      truncated: Boolean(truncated),
    },
    sources,
    warnings: [
      ...new Map(
        evidenceWarnings.map((warning) => [
          [warning.code, warning.question || "", warning.category || ""].join(
            ":",
          ),
          {
            code: boundedString(warning.code, 120) || "unknown_warning",
            ...(boundedString(warning.label, 300)
              ? { label: boundedString(warning.label, 300) }
              : {}),
            ...(boundedString(warning.question, 500)
              ? { question: boundedString(warning.question, 500) }
              : {}),
            ...(boundedString(warning.category, 100)
              ? { category: boundedString(warning.category, 100) }
              : {}),
          },
        ]),
      ).values(),
    ].slice(0, 20),
  };
};

export const aiEvidenceService = { build: buildAiEvidence };
