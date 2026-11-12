import mongoose from "mongoose";

import BookingModel from "@/modules/booking/booking.model.js";
import {
  BOOKING_STATUS,
  CLASS_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import MembershipPlanModel from "@/modules/membership/membership-plan.model.js";
import { MEMBERSHIP_STATUS } from "@/modules/membership/membership.constants.js";
import UserMembershipModel from "@/modules/membership/user-membership.model.js";
import OrderModel from "@/modules/order/order.model.js";
import { ORDER_STATUS } from "@/modules/order/order.constants.js";
import ProductModel from "@/modules/product/product.model.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";
import UserModel from "@/modules/user/user.model.js";
import { PLATFORM_ROLE } from "@/modules/user/user.constants.js";
import { badRequest, notFound } from "@/shared/http/httpErrors.js";

import {
  KNOWLEDGE_ARTICLE_AUDIENCE,
  KNOWLEDGE_ARTICLE_AUDIENCES,
} from "../communications.constants.js";
import { getYouTubeEmbedUrl } from "../knowledge-youtube.js";

export type KnowledgeAudience = (typeof KNOWLEDGE_ARTICLE_AUDIENCES)[number];

export type KnowledgeEntitlements = {
  membershipPlanIds: string[];
  courseProductIds: string[];
};

export type KnowledgeVisibilityInput = {
  tenantId: string;
  audiences: readonly KnowledgeAudience[];
  membershipPlanIds?: readonly string[];
  courseProductIds?: readonly string[];
  includeAllTargets?: boolean;
  includeLegacyStaff?: boolean;
  allowedLocationIds?: readonly string[] | null;
  locationId?: string | null;
  locale?: string;
  now?: Date;
  aiOnly?: boolean;
  search?: string;
  category?: string;
  type?: string;
  featured?: boolean;
};

export const canManageAllKnowledgeLocations = (
  locationIds: readonly unknown[],
  allowedLocationIds: readonly string[] | null | undefined,
): boolean => {
  if (allowedLocationIds === null || allowedLocationIds === undefined) {
    return true;
  }
  if (locationIds.length === 0) return false;
  const allowed = new Set(allowedLocationIds.map(String));
  return locationIds.every((locationId) => allowed.has(String(locationId)));
};

const objectIds = (values: readonly string[]): mongoose.Types.ObjectId[] =>
  values.map((value) => new mongoose.Types.ObjectId(value));

const directAudienceClause = (
  audiences: readonly KnowledgeAudience[],
  includeLegacyStaff: boolean,
): Record<string, unknown>[] => {
  const direct = audiences.filter(
    (audience) =>
      audience !== KNOWLEDGE_ARTICLE_AUDIENCE.MEMBER &&
      audience !== KNOWLEDGE_ARTICLE_AUDIENCE.COURSE,
  );
  const clauses: Record<string, unknown>[] = direct.length
    ? [{ audience: { $in: [...direct] } }]
    : [];
  if (
    includeLegacyStaff &&
    audiences.includes(KNOWLEDGE_ARTICLE_AUDIENCE.STAFF)
  ) {
    clauses.push({ audience: { $exists: false } });
  }
  return clauses;
};

/**
 * Builds the mandatory publication and audience boundary shared by portal
 * reads and AI retrieval. Target IDs in this function must come from trusted
 * server-side entitlement resolution, never from request input.
 */
export const buildPublishedKnowledgeVisibilityFilter = ({
  tenantId,
  audiences,
  membershipPlanIds = [],
  courseProductIds = [],
  includeAllTargets = false,
  includeLegacyStaff = false,
  allowedLocationIds = null,
  locationId = null,
  locale,
  now = new Date(),
  aiOnly = false,
  search,
  category,
  type,
  featured,
}: KnowledgeVisibilityInput): Record<string, unknown> => {
  const audienceClauses = directAudienceClause(audiences, includeLegacyStaff);

  if (audiences.includes(KNOWLEDGE_ARTICLE_AUDIENCE.MEMBER)) {
    if (includeAllTargets) {
      audienceClauses.push({
        audience: KNOWLEDGE_ARTICLE_AUDIENCE.MEMBER,
      });
    } else if (membershipPlanIds.length > 0) {
      audienceClauses.push({
        audience: KNOWLEDGE_ARTICLE_AUDIENCE.MEMBER,
        $or: [
          { targetMembershipIds: { $size: 0 } },
          {
            targetMembershipIds: {
              $in: objectIds(membershipPlanIds),
            },
          },
        ],
      });
    }
  }

  if (audiences.includes(KNOWLEDGE_ARTICLE_AUDIENCE.COURSE)) {
    if (includeAllTargets) {
      audienceClauses.push({
        audience: KNOWLEDGE_ARTICLE_AUDIENCE.COURSE,
      });
    } else if (courseProductIds.length > 0) {
      audienceClauses.push({
        audience: KNOWLEDGE_ARTICLE_AUDIENCE.COURSE,
        targetCourseIds: {
          $in: objectIds(courseProductIds),
        },
      });
    }
  }

  // No recognized audience should be an impossible query rather than a
  // missing audience predicate that could widen to the whole tenant.
  const audienceBoundary = audienceClauses.length
    ? audienceClauses.length === 1
      ? audienceClauses[0]!
      : { $or: audienceClauses }
    : { _id: { $exists: false } };

  const clauses: Record<string, unknown>[] = [
    { tenantId: new mongoose.Types.ObjectId(tenantId) },
    audienceBoundary,
    { status: "published" },
    { deletedAt: null },
    {
      $or: [
        { effectiveFrom: null },
        { effectiveFrom: { $lte: now } },
        { effectiveFrom: { $exists: false } },
      ],
    },
    {
      $or: [
        { effectiveUntil: null },
        { effectiveUntil: { $gt: now } },
        { effectiveUntil: { $exists: false } },
      ],
    },
  ];

  if (aiOnly) clauses.push({ aiEnabled: { $ne: false } });
  if (category) clauses.push({ category });
  if (type) clauses.push({ type });
  if (typeof featured === "boolean") clauses.push({ featured });
  if (search) clauses.push({ $text: { $search: search } });

  if (locale) {
    clauses.push({
      $or: [
        { language: locale },
        { [`translations.${locale}`]: { $type: "string", $ne: "" } },
      ],
    });
  }

  if (locationId) {
    clauses.push({
      $or: [
        { locationIds: { $size: 0 } },
        { locationIds: { $exists: false } },
        { locationIds: new mongoose.Types.ObjectId(locationId) },
      ],
    });
  } else if (allowedLocationIds !== null) {
    clauses.push({
      $or: [
        { locationIds: { $size: 0 } },
        { locationIds: { $exists: false } },
        {
          locationIds: {
            $in: objectIds(allowedLocationIds),
          },
        },
      ],
    });
  }

  return { $and: clauses };
};

export const resolveCustomerKnowledgeEntitlements = async ({
  tenantId,
  userId,
  now = new Date(),
}: {
  tenantId: string;
  userId: string;
  now?: Date;
}): Promise<KnowledgeEntitlements> => {
  const user = await UserModel.findOne({
    _id: userId,
    tenant: tenantId,
    platformRole: PLATFORM_ROLE.NONE,
    isAccessGranted: { $ne: false },
  })
    .select("_id")
    .lean();
  if (!user) notFound("Customer not found.");

  const [memberships, orders] = await Promise.all([
    UserMembershipModel.find({
      tenant: tenantId,
      user: userId,
      isOpen: true,
      status: {
        $in: [MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED],
      },
      $or: [{ currentPeriodEnd: null }, { currentPeriodEnd: { $gt: now } }],
    })
      .select("plan")
      .lean(),
    OrderModel.find({
      tenant: tenantId,
      createdBy: userId,
      isPaid: true,
      status: {
        $nin: [ORDER_STATUS.FAILED, ORDER_STATUS.CANCELLED],
      },
      courseBookings: { $exists: true, $ne: [] },
    })
      .select("courseBookings.bookingId")
      .lean(),
  ]);

  const bookingIds = [
    ...new Set(
      (orders as any[])
        .flatMap((order) => order.courseBookings || [])
        .map((slot) => String(slot?.bookingId || ""))
        .filter((value) => mongoose.isValidObjectId(value)),
    ),
  ];
  const courseBookings = bookingIds.length
    ? await BookingModel.find({
        _id: { $in: objectIds(bookingIds) },
        tenant: tenantId,
        tag: { $in: CLASS_BOOKING_TAGS },
        status: { $ne: BOOKING_STATUS.CANCELLED },
        paymentStatus: PAYMENT_STATUS.CONFIRMED,
      })
        .select("bookingProduct")
        .lean()
    : [];

  return {
    membershipPlanIds: [
      ...new Set(
        (memberships as any[])
          .map((membership) => String(membership.plan || ""))
          .filter(Boolean),
      ),
    ],
    courseProductIds: [
      ...new Set(
        (courseBookings as any[])
          .map((booking) => String(booking.bookingProduct || ""))
          .filter(Boolean),
      ),
    ],
  };
};

export const assertKnowledgeTargetOwnership = async ({
  tenantId,
  audience,
  targetCourseIds = [],
  targetMembershipIds = [],
}: {
  tenantId: string;
  audience: KnowledgeAudience;
  targetCourseIds?: readonly string[];
  targetMembershipIds?: readonly string[];
}): Promise<void> => {
  if (audience === KNOWLEDGE_ARTICLE_AUDIENCE.COURSE) {
    const count = await ProductModel.countDocuments({
      _id: { $in: objectIds(targetCourseIds) },
      tenant: tenantId,
      type: { $in: COURSE_PRODUCT_TYPES },
    });
    if (count !== targetCourseIds.length) {
      badRequest("Every target course must belong to this workspace.");
    }
  }

  if (
    audience === KNOWLEDGE_ARTICLE_AUDIENCE.MEMBER &&
    targetMembershipIds.length > 0
  ) {
    const count = await MembershipPlanModel.countDocuments({
      _id: { $in: objectIds(targetMembershipIds) },
      tenant: tenantId,
    });
    if (count !== targetMembershipIds.length) {
      badRequest("Every target membership plan must belong to this workspace.");
    }
  }
};

export const serializePublishedKnowledgeArticle = (
  article: any,
  locale?: string,
) => {
  const translated = locale
    ? article.translations?.[locale] || article.translations?.get?.(locale)
    : "";
  return {
    id: String(article._id),
    type: String(article.type || "guide"),
    title: String(article.title || ""),
    summary: String(article.summary || ""),
    category: String(article.category || "general"),
    language: String(article.language || ""),
    content: String(translated || article.content || ""),
    transcript: String(article.transcript || ""),
    customQuestions: (article.customQuestions || []).map((entry: any) => ({
      question: String(entry?.question || ""),
      answer: String(entry?.answer || ""),
    })),
    audience: String(article.audience || "staff"),
    tags: (article.tags || []).map(String),
    locationIds: (article.locationIds || []).map(String),
    sourceUrl: String(article.sourceUrl || ""),
    videoUrl: String(article.videoUrl || ""),
    youtubeVideoId: String(article.youtubeVideoId || ""),
    videoEmbedUrl: getYouTubeEmbedUrl(article.youtubeVideoId) || "",
    fileUrl: String(article.fileUrl || ""),
    featured: article.featured === true,
    effectiveFrom: article.effectiveFrom || null,
    effectiveUntil: article.effectiveUntil || null,
    updatedAt: article.updatedAt,
  };
};
