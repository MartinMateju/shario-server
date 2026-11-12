import LocationModel from "@/modules/location/location.model.js";
import { notFound } from "@/shared/http/httpErrors.js";

import {
  KNOWLEDGE_ARTICLE_AUDIENCE,
} from "../communications.constants.js";
import { CommunicationKnowledgeArticleModel } from "../communications.models.js";
import {
  buildPublishedKnowledgeVisibilityFilter,
  resolveCustomerKnowledgeEntitlements,
  serializePublishedKnowledgeArticle,
  type KnowledgeAudience,
  type KnowledgeEntitlements,
} from "./knowledge-access.service.js";

type PublishedKnowledgeListInput = {
  search?: string;
  category?: string;
  type?: string;
  language?: string;
  locationId?: string;
  featured?: boolean;
  page: number;
  limit: number;
};

type PublishedKnowledgePrincipal =
  | {
      kind: "public";
      tenantId: string;
    }
  | {
      kind: "customer";
      tenantId: string;
      userId: string;
    };

const assertActiveTenantLocation = async (
  tenantId: string,
  locationId?: string,
) => {
  if (!locationId) return;
  const exists = await LocationModel.exists({
    _id: locationId,
    tenant: tenantId,
    isActive: true,
  });
  if (!exists) notFound("Location not found.");
};

const scopeFor = async (
  principal: PublishedKnowledgePrincipal,
): Promise<{
  audiences: KnowledgeAudience[];
  entitlements: KnowledgeEntitlements;
}> => {
  if (principal.kind === "public") {
    return {
      audiences: [KNOWLEDGE_ARTICLE_AUDIENCE.PUBLIC],
      entitlements: {
        membershipPlanIds: [],
        courseProductIds: [],
      },
    };
  }

  const entitlements = await resolveCustomerKnowledgeEntitlements({
    tenantId: principal.tenantId,
    userId: principal.userId,
  });
  const audiences: KnowledgeAudience[] = [
    KNOWLEDGE_ARTICLE_AUDIENCE.PUBLIC,
    KNOWLEDGE_ARTICLE_AUDIENCE.CUSTOMER,
  ];
  if (entitlements.membershipPlanIds.length > 0) {
    audiences.push(KNOWLEDGE_ARTICLE_AUDIENCE.MEMBER);
  }
  if (entitlements.courseProductIds.length > 0) {
    audiences.push(KNOWLEDGE_ARTICLE_AUDIENCE.COURSE);
  }
  return { audiences, entitlements };
};

const queryFor = async (
  principal: PublishedKnowledgePrincipal,
  input: PublishedKnowledgeListInput,
) => {
  await assertActiveTenantLocation(principal.tenantId, input.locationId);
  const { audiences, entitlements } = await scopeFor(principal);
  return buildPublishedKnowledgeVisibilityFilter({
    tenantId: principal.tenantId,
    audiences,
    membershipPlanIds: entitlements.membershipPlanIds,
    courseProductIds: entitlements.courseProductIds,
    // Without an explicit location, portal reads intentionally return only
    // workspace-wide articles rather than mixing location-specific policies.
    allowedLocationIds: input.locationId ? null : [],
    locationId: input.locationId || null,
    locale: input.language,
    search: input.search,
    category: input.category,
    type: input.type,
    featured: input.featured,
  });
};

export const listPublishedKnowledge = async (
  principal: PublishedKnowledgePrincipal,
  input: PublishedKnowledgeListInput,
) => {
  const filter = await queryFor(principal, input);
  const [articles, total] = await Promise.all([
    CommunicationKnowledgeArticleModel.find(filter)
      .sort({ featured: -1, updatedAt: -1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .select(
        "type title summary category language content transcript customQuestions translations audience tags locationIds sourceUrl videoUrl youtubeVideoId fileUrl featured effectiveFrom effectiveUntil updatedAt",
      )
      .lean(),
    CommunicationKnowledgeArticleModel.countDocuments(filter),
  ]);
  return {
    items: (articles as any[]).map((article) =>
      serializePublishedKnowledgeArticle(article, input.language),
    ),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      pages: Math.ceil(total / input.limit),
    },
  };
};

export const getPublishedKnowledge = async (
  principal: PublishedKnowledgePrincipal,
  articleId: string,
  input: PublishedKnowledgeListInput,
) => {
  const filter = await queryFor(principal, input);
  const article = await CommunicationKnowledgeArticleModel.findOne({
    $and: [filter, { _id: articleId }],
  })
    .select(
      "type title summary category language content transcript customQuestions translations audience tags locationIds sourceUrl videoUrl youtubeVideoId fileUrl featured effectiveFrom effectiveUntil updatedAt",
    )
    .lean();
  if (!article) notFound("Knowledge article not found.");
  return serializePublishedKnowledgeArticle(article, input.language);
};

export const knowledgePortalService = {
  list: listPublishedKnowledge,
  get: getPublishedKnowledge,
};

