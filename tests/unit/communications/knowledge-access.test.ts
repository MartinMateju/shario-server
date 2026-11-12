import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  membershipFind: vi.fn(),
  orderFind: vi.fn(),
  bookingFind: vi.fn(),
  productCount: vi.fn(),
  membershipPlanCount: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.userFindOne },
}));
vi.mock("@/modules/membership/user-membership.model.js", () => ({
  default: { find: mocks.membershipFind },
}));
vi.mock("@/modules/order/order.model.js", () => ({
  default: { find: mocks.orderFind },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { find: mocks.bookingFind },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: { countDocuments: mocks.productCount },
}));
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  default: { countDocuments: mocks.membershipPlanCount },
}));

import {
  assertKnowledgeTargetOwnership,
  buildPublishedKnowledgeVisibilityFilter,
  canManageAllKnowledgeLocations,
  resolveCustomerKnowledgeEntitlements,
  serializePublishedKnowledgeArticle,
} from "@/modules/communications/services/knowledge-access.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const PLAN_ID = "507f1f77bcf86cd799439013";
const BOOKING_ID = "507f1f77bcf86cd799439014";
const COURSE_ID = "507f1f77bcf86cd799439015";
const LOCATION_ID = "507f1f77bcf86cd799439016";
const NOW = new Date("2026-07-28T12:00:00.000Z");

const query = (value: unknown) => ({
  select: vi.fn(() => ({
    lean: vi.fn().mockResolvedValue(value),
  })),
});

describe("knowledge visibility and customer entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindOne.mockReturnValue(query({ _id: USER_ID }));
    mocks.membershipFind.mockReturnValue(query([]));
    mocks.orderFind.mockReturnValue(query([]));
    mocks.bookingFind.mockReturnValue(query([]));
  });

  it("pins every public query to tenant, publication, lifetime and global location", () => {
    const filter = buildPublishedKnowledgeVisibilityFilter({
      tenantId: TENANT_ID,
      audiences: ["public"],
      allowedLocationIds: [],
      now: NOW,
      aiOnly: true,
    }) as { $and: Record<string, any>[] };

    expect(String(filter.$and[0].tenantId)).toBe(TENANT_ID);
    expect(filter.$and).toEqual(
      expect.arrayContaining([
        { audience: { $in: ["public"] } },
        { status: "published" },
        { deletedAt: null },
        { aiEnabled: { $ne: false } },
        {
          $or: [
            { locationIds: { $size: 0 } },
            { locationIds: { $exists: false } },
            { locationIds: { $in: [] } },
          ],
        },
      ]),
    );
  });

  it("matches member and course articles only against derived target IDs", () => {
    const filter = buildPublishedKnowledgeVisibilityFilter({
      tenantId: TENANT_ID,
      audiences: ["public", "customer", "member", "course"],
      membershipPlanIds: [PLAN_ID],
      courseProductIds: [COURSE_ID],
      locationId: LOCATION_ID,
      now: NOW,
    }) as { $and: Record<string, any>[] };

    const audienceBoundary = filter.$and[1] as { $or: any[] };
    expect(audienceBoundary.$or).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          audience: "member",
          $or: [
            { targetMembershipIds: { $size: 0 } },
            {
              targetMembershipIds: {
                $in: [new mongoose.Types.ObjectId(PLAN_ID)],
              },
            },
          ],
        }),
        {
          audience: "course",
          targetCourseIds: {
            $in: [new mongoose.Types.ObjectId(COURSE_ID)],
          },
        },
      ]),
    );
  });

  it("derives course access from this customer's paid order and tenant booking", async () => {
    mocks.membershipFind.mockReturnValue(query([{ plan: PLAN_ID }]));
    mocks.orderFind.mockReturnValue(
      query([{ courseBookings: [{ bookingId: BOOKING_ID }] }]),
    );
    mocks.bookingFind.mockReturnValue(query([{ bookingProduct: COURSE_ID }]));

    await expect(
      resolveCustomerKnowledgeEntitlements({
        tenantId: TENANT_ID,
        userId: USER_ID,
        now: NOW,
      }),
    ).resolves.toEqual({
      membershipPlanIds: [PLAN_ID],
      courseProductIds: [COURSE_ID],
    });

    expect(mocks.userFindOne).toHaveBeenCalledWith({
      _id: USER_ID,
      tenant: TENANT_ID,
      platformRole: "none",
      isAccessGranted: { $ne: false },
    });
    expect(mocks.orderFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        createdBy: USER_ID,
        isPaid: true,
        status: {
          $nin: ["failed_order", "cancelled_order"],
        },
      }),
    );
    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        tag: { $in: ["class", "course"] },
        status: { $ne: "cancelled" },
        paymentStatus: "CONFIRMED",
      }),
    );
  });

  it("rejects course target IDs that are not tenant course products", async () => {
    mocks.productCount.mockResolvedValue(0);
    await expect(
      assertKnowledgeTargetOwnership({
        tenantId: TENANT_ID,
        audience: "course",
        targetCourseIds: [COURSE_ID],
      }),
    ).rejects.toThrow("Every target course must belong to this workspace.");
  });

  it("does not let an A-only editor mutate an article scoped to A and B", () => {
    const hiddenLocation = "507f1f77bcf86cd799439099";
    expect(
      canManageAllKnowledgeLocations(
        [LOCATION_ID, hiddenLocation],
        [LOCATION_ID],
      ),
    ).toBe(false);
    expect(canManageAllKnowledgeLocations([LOCATION_ID], [LOCATION_ID])).toBe(
      true,
    );
    expect(canManageAllKnowledgeLocations([], [LOCATION_ID])).toBe(false);
  });

  it("publishes only whitelisted fields and a canonical no-cookie embed", () => {
    const serialized = serializePublishedKnowledgeArticle({
      _id: "article-a",
      type: "video",
      title: "Wheel basics",
      content: "Center the clay.",
      audience: "customer",
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      youtubeVideoId: "dQw4w9WgXcQ",
      approvedBy: "private-user",
      embeddingError: "private-index-detail",
    });

    expect(serialized.videoEmbedUrl).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
    expect(serialized).not.toHaveProperty("approvedBy");
    expect(serialized).not.toHaveProperty("embeddingError");
  });
});
