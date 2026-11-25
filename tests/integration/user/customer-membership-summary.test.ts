import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import UserMembership from "@/modules/membership/user-membership.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import {
  getCustomerMembershipSummary,
  withCustomerMemberships,
} from "@/modules/user/services/user.membership-summary.service.js";
import { createPlatformBypassAccess } from "@/modules/tenant-access/services/authorization.service.js";

const oid = () => new mongoose.Types.ObjectId();
const tenant = oid(), otherTenant = oid(), studio = oid(), otherStudio = oid();
const now = new Date("2026-11-16T12:00:00Z");
const owner = createPlatformBypassAccess({ tenantId: String(tenant), userId: String(oid()) });
const restricted = {
  ...owner,
  locationAccess: { mode: "selected" as const, locationIds: [String(studio)] },
};
let database: MongoMemoryServer;

const membership = (overrides: Record<string, unknown> = {}) => ({
  _id: oid(), tenant, user: oid(), status: "active", selectedLocation: studio,
  planSnapshot: { name: "Studio membership", locationScope: { type: "selected", locationIds: [studio] } },
  startedAt: new Date("2026-11-01T00:00:00Z"),
  currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
  ...overrides,
});
const insert = async (rows: ReturnType<typeof membership>[]) => {
  await UserMembership.collection.insertMany(rows as any[]);
};
const summary = (access = owner) => getCustomerMembershipSummary({ tenantId: String(tenant), access, now });

beforeAll(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
  await UserMembership.init();
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  await Promise.all([UserMembership.collection.deleteMany({}), Tenant.collection.deleteMany({})]);
  await Tenant.collection.insertOne({ _id: tenant, modules: { memberships: true }, plan: "professional", planVersion: 3 } as any);
});

describe("authoritative customer subscriber summary", () => {
  it("counts shared-selected entitlements without broadening a purchased single-studio membership", async () => {
    const shared = oid(), cancelling = oid(), otherSelected = oid(), otherShared = oid();
    const sharedPlan = { name: "Shared studios", locationScope: { type: "shared_selected", locationIds: [studio, otherStudio] } };
    await insert([
      membership({ user: shared, selectedLocation: null, planSnapshot: sharedPlan }),
      membership({ user: shared }), // The same subscriber still counts only once.
      membership({ user: cancelling, status: "cancel_scheduled", selectedLocation: null, planSnapshot: sharedPlan }),
      membership({ user: otherSelected, selectedLocation: otherStudio,
        planSnapshot: { name: "Choose one studio", locationScope: { type: "selected", locationIds: [studio, otherStudio] } } }),
      membership({ user: otherShared, selectedLocation: null,
        planSnapshot: { name: "Other studios", locationScope: { type: "shared_selected", locationIds: [otherStudio] } } }),
      membership({ tenant: otherTenant, selectedLocation: null, planSnapshot: sharedPlan }),
    ]);
    expect((await summary(restricted)).activeMemberships).toBe(2);
    expect((await summary()).activeMemberships).toBe(4);
    const rows = await withCustomerMemberships({ tenantId: String(tenant), access: restricted, now,
      users: [shared, cancelling, otherSelected, otherShared].map(_id => ({ _id })),
    });
    expect(rows[0].activeMembership).not.toBeNull();
    expect(rows[1].activeMembership).toEqual({ name: "Shared studios", status: "cancel_scheduled" });
    expect(rows.slice(2).map(row => row.activeMembership)).toEqual([null, null]);
  });

  it("deduplicates subscribers and counts shared memberships within the authorized studio", async () => {
    const person = oid();
    await insert([
      membership({ user: person }), membership({ user: person, status: "cancel_scheduled" }),
      membership({ selectedLocation: null, planSnapshot: { locationScope: { type: "all" } } }),
      membership({ selectedLocation: otherStudio }), membership({ tenant: otherTenant }),
      membership({ selectedLocation: null, planSnapshot: { locationScope: { type: "selected", locationIds: [otherStudio] } } }),
    ]);
    expect(await summary(restricted)).toMatchObject({ activeMemberships: 2, membershipScope: "authorized_locations" });
    expect(await summary()).toMatchObject({ activeMemberships: 4, membershipScope: "workspace" });
  });

  it("uses current entitlement boundaries and excludes unpaid, paused and expired access", async () => {
    await insert([
      membership({ currentPeriodEnd: now }),
      membership({ startedAt: now, currentPeriodStart: now }),
      membership({ currentPeriodStart: new Date(now.valueOf() + 1) }),
      membership({ startedAt: new Date(now.valueOf() + 1) }),
      membership({ status: "pending" }), membership({ status: "paused" }),
      membership({ status: "past_due" }), membership({ status: "cancelled" }),
      membership({ status: "cancel_scheduled" }),
    ]);
    expect((await summary()).activeMemberships).toBe(2);
  });

  it("does not present missing dates as a reliable zero", async () => {
    await insert([membership({ currentPeriodEnd: null })]);
    expect((await summary()).activeMemberships).toBeNull();
  });

  it("returns unavailable without the proper tenant and membership read permission", async () => {
    await insert([membership()]);
    expect((await summary({ ...owner, permissions: ["customers.view"] })).activeMemberships).toBeNull();
    expect((await summary({ ...owner, tenantId: String(otherTenant) })).activeMemberships).toBeNull();
    expect((await summary({ ...restricted, locationAccess: { mode: "selected", locationIds: [] } })).activeMemberships).toBe(0);
  });

  it("counts all subscribers independently of the 2000-row customer list ceiling", async () => {
    await insert(Array.from({ length: 2001 }, () => membership()));
    expect((await summary()).activeMemberships).toBe(2001);
  });

  it("honors disabled modules and the reporting entitlement for both summary and row enrichment", async () => {
    const person = oid();
    await insert([membership({ user: person })]);
    await Tenant.collection.updateOne({ _id: tenant }, { $set: { "modules.memberships": false } });
    expect((await summary()).activeMemberships).toBeNull();
    expect((await withCustomerMemberships({ tenantId: String(tenant), access: owner, now, users: [{ _id: person }] }))[0].activeMembership).toBeNull();
    await Tenant.collection.updateOne({ _id: tenant }, { $set: { "modules.memberships": true, plan: "starter" } });
    expect((await summary()).activeMemberships).toBeNull();
    expect((await withCustomerMemberships({ tenantId: String(tenant), access: owner, now, users: [{ _id: person }] }))[0].activeMembership).toBeNull();
  });

  it("enriches only requested customers with authorized active names and statuses", async () => {
    const visible = oid(), shared = oid(), hidden = oid(), expired = oid();
    await insert([
      membership({ user: visible }),
      membership({ user: shared, selectedLocation: null, status: "cancel_scheduled", planSnapshot: { name: "Shared", locationScope: { type: "all" } } }),
      membership({ user: hidden, selectedLocation: otherStudio }),
      membership({ user: expired, currentPeriodEnd: now }),
    ]);
    const users = [visible, shared, hidden, expired].map((_id) => ({ _id }));
    const rows = await withCustomerMemberships({ tenantId: String(tenant), access: restricted, now, users });
    expect(rows.map((row) => row.activeMembership)).toEqual([
      { name: "Studio membership", status: "active" },
      { name: "Shared", status: "cancel_scheduled" }, null, null,
    ]);
    const denied = await withCustomerMemberships({ tenantId: String(tenant), access: { ...owner, permissions: [] }, now, users });
    expect(denied.every((row) => row.activeMembership === null)).toBe(true);
  });
});
