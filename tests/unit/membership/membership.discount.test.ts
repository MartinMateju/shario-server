import { afterEach, describe, expect, it, vi } from "vitest";

import { membershipRepository } from "@/modules/membership/membership.repository.js";
import {
  resolveMembershipProductDiscount,
  selectBestProductDiscountBenefit,
} from "@/modules/membership/services/membership-discount.service.js";

const LOCATION_ID = "507f1f77bcf86cd799439030";

const activeMembership = (overrides: Record<string, unknown> = {}) => ({
  _id: "507f1f77bcf86cd799439011",
  tenant: "507f1f77bcf86cd799439010",
  user: "507f1f77bcf86cd799439020",
  plan: "507f1f77bcf86cd799439012",
  planVersion: "507f1f77bcf86cd799439013",
  status: "active",
  selectedLocation: null,
  currentPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
  planSnapshot: {
    version: 3,
    locationScope: { type: "all", locationIds: [] },
    benefits: [
      {
        key: "products_10",
        label: "Products 10%",
        type: "percentage",
        appliesTo: "products",
        percentageBps: 1_000,
      },
      {
        key: "products_15",
        label: "Products 15%",
        type: "percentage",
        appliesTo: "products",
        percentageBps: 1_500,
      },
    ],
  },
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("membership product discount resolution", () => {
  it("selects the greatest eligible product percentage", () => {
    expect(
      selectBestProductDiscountBenefit(
        activeMembership().planSnapshot.benefits,
      )?.key,
    ).toBe("products_15");
  });

  it("returns an immutable identity from a current paid membership", async () => {
    vi.spyOn(
      membershipRepository,
      "findActiveUserMembership",
    ).mockResolvedValue(activeMembership() as any);

    await expect(
      resolveMembershipProductDiscount({
        tenantId: "507f1f77bcf86cd799439010",
        userId: "507f1f77bcf86cd799439020",
        now: new Date("2026-07-23T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      membershipId: "507f1f77bcf86cd799439011",
      planVersion: 3,
      benefitKey: "products_15",
      percentageBps: 1_500,
    });
  });

  it("does not grant a discount for past-due, paused or ended periods", async () => {
    for (const membership of [
      activeMembership({ status: "past_due" }),
      activeMembership({ status: "paused" }),
      activeMembership({ currentPeriodStart: null, currentPeriodEnd: null }),
      activeMembership({ currentPeriodStart: null }),
      activeMembership({ currentPeriodEnd: null }),
      activeMembership({ currentPeriodStart: new Date("invalid") }),
      activeMembership({
        currentPeriodEnd: new Date("2026-07-22T00:00:00.000Z"),
      }),
    ]) {
      vi.spyOn(
        membershipRepository,
        "findActiveUserMembership",
      ).mockResolvedValueOnce(membership as any);

      await expect(
        resolveMembershipProductDiscount({
          tenantId: "507f1f77bcf86cd799439010",
          userId: "507f1f77bcf86cd799439020",
          now: new Date("2026-07-23T00:00:00.000Z"),
        }),
      ).resolves.toBeNull();
    }
  });

  it("enforces selected-location scope", async () => {
    const membership = activeMembership({
      selectedLocation: LOCATION_ID,
      planSnapshot: {
        ...activeMembership().planSnapshot,
        locationScope: { type: "selected", locationIds: [LOCATION_ID] },
      },
    });
    vi.spyOn(
      membershipRepository,
      "findActiveUserMembership",
    ).mockResolvedValue(membership as any);

    await expect(
      resolveMembershipProductDiscount({
        tenantId: "507f1f77bcf86cd799439010",
        userId: "507f1f77bcf86cd799439020",
        orderLocationIds: ["507f1f77bcf86cd799439099"],
        now: new Date("2026-07-23T00:00:00.000Z"),
      }),
    ).resolves.toBeNull();

    await expect(
      resolveMembershipProductDiscount({
        tenantId: "507f1f77bcf86cd799439010",
        userId: "507f1f77bcf86cd799439020",
        orderLocationIds: [LOCATION_ID],
        now: new Date("2026-07-23T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ selectedLocationId: LOCATION_ID });
  });
});
