import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";

const buildMembership = (
  contextualGuides: Record<string, Record<string, unknown>>,
) => {
  const tenantId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  return new TenantMembershipModel({
    tenant: tenantId,
    user: userId,
    status: "active",
    role: "admin",
    preferences: { contextualGuides },
    createdBy: userId,
    updatedBy: userId,
  });
};

const UPDATED_AT = new Date("2026-08-11T12:00:00.000Z");

describe("tenant membership contextual guide persistence", () => {
  it("keeps completed v1 states valid after current guides advance to v2", async () => {
    const membership = buildMembership({
      memberships: {
        version: 1,
        status: "completed",
        lastStep: "vouchers",
        updatedAt: UPDATED_AT,
      },
    });

    await expect(membership.validate()).resolves.toBeUndefined();
  });

  it("accepts the current v2 terminal states", async () => {
    const membership = buildMembership({
      memberships: {
        version: 2,
        status: "completed",
        lastStep: "vouchers",
        updatedAt: UPDATED_AT,
      },
    });

    await expect(membership.validate()).resolves.toBeUndefined();
  });

  it.each([
    {
      memberships: {
        version: 3,
        status: "skipped",
        lastStep: "credits",
        updatedAt: UPDATED_AT,
      },
    },
    {
      memberships: {
        version: 1,
        status: "skipped",
        lastStep: "credits",
        updatedAt: UPDATED_AT,
      },
    },
    {
      memberships: {
        version: 1,
        status: "completed",
        lastStep: "catalog",
        updatedAt: UPDATED_AT,
      },
    },
    {
      memberships: {
        version: 1,
        status: "skipped",
        lastStep: "credits",
        updatedAt: UPDATED_AT,
      },
    },
  ])(
    "rejects future, cross-version, and nonterminal persisted states %#",
    async (contextualGuides) => {
      const membership = buildMembership(contextualGuides);

      await expect(membership.validate()).rejects.toBeDefined();
    },
  );
});
