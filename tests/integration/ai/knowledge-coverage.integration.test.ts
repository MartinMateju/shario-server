import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  requireEntitlement: vi.fn(),
}));

vi.mock("../../../src/modules/ai/services/ai-access.service.js", () => ({
  requireAiEntitlement: mocks.requireEntitlement,
}));

import { CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS } from "../../../src/modules/ai/ai-evaluation.catalog.js";
import { getKnowledgeCoverageHealth } from "../../../src/modules/ai/services/knowledge-coverage.service.js";
import { CommunicationKnowledgeArticleModel } from "../../../src/modules/communications/communications.models.js";
import LocationModel from "../../../src/modules/location/location.model.js";
import { WORKSPACE_PERMISSION } from "../../../src/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "../../../src/modules/tenant-access/tenant-access.types.js";
import TenantModel from "../../../src/modules/tenants/tenant.model.js";
import UserModel from "../../../src/modules/user/user.model.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const describeMongoIntegration =
  process.env.RUN_MONGO_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const workspaceAccess = ({
  tenantId,
  userId,
  locationIds,
  allLocations = false,
}: {
  tenantId: string;
  userId: string;
  locationIds: string[];
  allLocations?: boolean;
}): ResolvedWorkspaceAccess => ({
  membershipId: new mongoose.Types.ObjectId().toString(),
  tenantId,
  userId,
  status: "active",
  role: "owner",
  customRoleId: null,
  customRoleName: null,
  permissions: [WORKSPACE_PERMISSION.KNOWLEDGE_VIEW],
  locationAccess: allLocations
    ? { mode: "all", locationIds: [] }
    : { mode: "selected", locationIds },
  workspaceProfile: {
    jobTitle: "Owner",
    displayName: "Coverage Owner",
    calendarColor: "",
  },
  preferences: {
    language: "en",
    displayTimezone: "Europe/Prague",
    defaultLocation: locationIds[0] || null,
    defaultCalendarView: "month",
    weekStartsOn: 1,
    defaultLandingPage: "",
    contextualGuides: {},
    notifications: {
      bookingAssigned: true,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: true,
      inApp: true,
    },
  },
  accessVersion: 1,
  isPlatformBypass: false,
});

const contextFor = ({
  tenantId,
  userId,
  access,
}: {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
}) =>
  ({
    tenantId,
    userId,
    audience: "workspace",
    access,
    allowedLocationIds:
      access.locationAccess.mode === "all"
        ? null
        : access.locationAccess.locationIds,
    locale: "en",
  }) as const;

describeMongoIntegration("Knowledge coverage visibility", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all([
      LocationModel.syncIndexes(),
      CommunicationKnowledgeArticleModel.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    await clearTestDatabase();
    mocks.requireEntitlement.mockReset();
    mocks.requireEntitlement.mockResolvedValue({});
  });

  afterAll(disconnectTestDatabase);

  it("scores only published, effective, AI-enabled general knowledge in the authorized location scope", async () => {
    const [tenantA, tenantB] = await TenantModel.create([
      { name: "Coverage Studio", slug: "coverage-studio" },
      { name: "Private Other Studio", slug: "private-other-studio" },
    ]);
    const [ownerA, ownerB] = await UserModel.create([
      {
        tenant: tenantA._id,
        firstname: "Coverage",
        lastname: "Owner",
        email: "coverage-owner@example.test",
        password: "safe-password-123",
        customId: "U-AI-COVERAGE-1",
        tenantRole: "owner",
      },
      {
        tenant: tenantB._id,
        firstname: "Other",
        lastname: "Owner",
        email: "other-coverage-owner@example.test",
        password: "safe-password-123",
        customId: "U-AI-COVERAGE-2",
        tenantRole: "owner",
      },
    ]);
    const [visibleLocation, hiddenLocation, otherTenantLocation] =
      await LocationModel.create([
        {
          tenant: tenantA._id,
          name: "Visible location",
          slug: "visible-location",
          code: "VISIBLE",
          isPrimary: true,
        },
        {
          tenant: tenantA._id,
          name: "Unauthorized location",
          slug: "unauthorized-location",
          code: "UNAUTHORIZED",
          isPrimary: false,
        },
        {
          tenant: tenantB._id,
          name: "Other tenant location",
          slug: "other-tenant-location",
          code: "OTHER",
          isPrimary: true,
        },
      ]);

    const includedQuestionIds = ["booking_price", "booking_cancellation"];
    const excludedQuestions = CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.filter(
      (question) => !includedQuestionIds.includes(question.id),
    );
    const excludedAnswers = excludedQuestions
      .map((question) => question.representativeAnswer.en)
      .join("\n\n");
    const answerFor = (id: string) =>
      CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.find(
        (question) => question.id === id,
      )!.representativeAnswer.en;
    const yesterday = new Date(Date.now() - 86_400_000);
    const tomorrow = new Date(Date.now() + 86_400_000);
    const article = ({
      tenantId = tenantA._id,
      actorId = ownerA._id,
      slug,
      content = excludedAnswers,
      audience = "public",
      status = "published",
      locationIds = [],
      targetMembershipIds = [],
      targetCourseIds = [],
      aiEnabled = true,
      effectiveFrom = yesterday,
      effectiveUntil = tomorrow,
      deletedAt = null,
    }: {
      tenantId?: mongoose.Types.ObjectId;
      actorId?: mongoose.Types.ObjectId;
      slug: string;
      content?: string;
      audience?: string;
      status?: string;
      locationIds?: mongoose.Types.ObjectId[];
      targetMembershipIds?: mongoose.Types.ObjectId[];
      targetCourseIds?: mongoose.Types.ObjectId[];
      aiEnabled?: boolean;
      effectiveFrom?: Date | null;
      effectiveUntil?: Date | null;
      deletedAt?: Date | null;
    }) => ({
      tenantId,
      title: slug.replaceAll("-", " "),
      slug,
      audience,
      language: "en",
      content,
      status,
      locationIds,
      targetMembershipIds,
      targetCourseIds,
      aiEnabled,
      effectiveFrom,
      effectiveUntil,
      deletedAt,
      createdBy: actorId,
      updatedBy: actorId,
    });

    await CommunicationKnowledgeArticleModel.create([
      article({
        slug: "published-global-price",
        content: answerFor("booking_price"),
      }),
      article({
        slug: "published-location-cancellation",
        content: answerFor("booking_cancellation"),
        audience: "customer",
        locationIds: [visibleLocation._id],
      }),
      article({
        slug: "unauthorized-location",
        locationIds: [hiddenLocation._id],
      }),
      article({ slug: "draft-global", status: "draft" }),
      article({ slug: "internal-global", audience: "staff" }),
      article({ slug: "ai-disabled-global", aiEnabled: false }),
      article({
        slug: "not-yet-effective",
        effectiveFrom: tomorrow,
        effectiveUntil: null,
      }),
      article({
        slug: "expired",
        effectiveFrom: null,
        effectiveUntil: yesterday,
      }),
      article({
        slug: "deleted",
        deletedAt: yesterday,
      }),
      article({
        slug: "targeted-membership",
        audience: "member",
        targetMembershipIds: [new mongoose.Types.ObjectId()],
      }),
      article({
        slug: "targeted-course",
        audience: "course",
        targetCourseIds: [new mongoose.Types.ObjectId()],
      }),
      article({
        tenantId: tenantB._id,
        actorId: ownerB._id,
        slug: "other-tenant-private-canary",
        content: `${excludedAnswers}\nPRIVATE_CROSS_TENANT_KNOWLEDGE_CANARY`,
      }),
    ]);
    // Legacy data may predate the current audience/target validation. Insert
    // malformed general-audience rows directly so the query's defense-in-depth
    // target clauses are exercised against real Mongo semantics.
    await CommunicationKnowledgeArticleModel.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        tenantId: tenantA._id,
        title: "legacy public membership target",
        slug: "legacy-public-membership-target",
        audience: "public",
        language: "en",
        content: excludedAnswers,
        status: "published",
        locationIds: [],
        targetMembershipIds: [new mongoose.Types.ObjectId()],
        targetCourseIds: [],
        aiEnabled: true,
        effectiveFrom: yesterday,
        effectiveUntil: tomorrow,
        deletedAt: null,
        createdBy: ownerA._id,
        updatedBy: ownerA._id,
        createdAt: yesterday,
        updatedAt: yesterday,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        tenantId: tenantA._id,
        title: "legacy customer course target",
        slug: "legacy-customer-course-target",
        audience: "customer",
        language: "en",
        content: excludedAnswers,
        status: "published",
        locationIds: [visibleLocation._id],
        targetMembershipIds: [],
        targetCourseIds: [new mongoose.Types.ObjectId()],
        aiEnabled: true,
        effectiveFrom: yesterday,
        effectiveUntil: tomorrow,
        deletedAt: null,
        createdBy: ownerA._id,
        updatedBy: ownerA._id,
        createdAt: yesterday,
        updatedAt: yesterday,
      },
    ]);

    const access = workspaceAccess({
      tenantId: String(tenantA._id),
      userId: String(ownerA._id),
      locationIds: [String(visibleLocation._id)],
    });
    const context = contextFor({
      tenantId: String(tenantA._id),
      userId: String(ownerA._id),
      access,
    });

    const locationCoverage = await getKnowledgeCoverageHealth({
      context,
      locale: "en",
      locationId: String(visibleLocation._id),
    });

    expect(locationCoverage).toMatchObject({
      answeredCount: includedQuestionIds.length,
      totalCount: CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.length,
      score: Math.round(
        (includedQuestionIds.length /
          CUSTOMER_KNOWLEDGE_COVERAGE_QUESTIONS.length) *
          100,
      ),
      complete: true,
      truncated: false,
    });
    expect(locationCoverage.warnings.map((warning) => warning.id)).toEqual(
      excludedQuestions.map((question) => question.id),
    );
    expect(Number.isNaN(Date.parse(locationCoverage.generatedAt))).toBe(false);
    expect(mocks.requireEntitlement).toHaveBeenCalledWith(
      String(tenantA._id),
      "knowledgeBaseEnabled",
    );
    expect(JSON.stringify(locationCoverage)).not.toContain(
      "PRIVATE_CROSS_TENANT_KNOWLEDGE_CANARY",
    );

    const globalCoverage = await getKnowledgeCoverageHealth({
      context,
      locale: "en",
    });
    expect(globalCoverage.answeredCount).toBe(1);
    expect(globalCoverage.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "booking_cancellation" }),
      ]),
    );

    await expect(
      getKnowledgeCoverageHealth({
        context,
        locale: "en",
        locationId: String(hiddenLocation._id),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const allLocationsAccess = workspaceAccess({
      tenantId: String(tenantA._id),
      userId: String(ownerA._id),
      locationIds: [],
      allLocations: true,
    });
    await expect(
      getKnowledgeCoverageHealth({
        context: contextFor({
          tenantId: String(tenantA._id),
          userId: String(ownerA._id),
          access: allLocationsAccess,
        }),
        locale: "en",
        locationId: String(otherTenantLocation._id),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
