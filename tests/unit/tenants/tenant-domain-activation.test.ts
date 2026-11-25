import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import {
  planTenantDomainActivation,
  serializeDomainActivationSnapshot,
} from "@/modules/tenants/tenant-domain-activation.js";

const tenant = {
  _id: "64b000000000000000000001",
  slug: "common-ground",
  status: "active",
  plan: "studio_plus",
  planVersion: 3,
  domains: [
    {
      hostname: "common-ground.shario.io",
      type: "subdomain",
      status: "active",
      isPrimary: true,
    },
  ],
};
const input = {
  tenant,
  expectedTenantId: tenant._id,
  expectedSlug: tenant.slug,
  hostname: "booking.commonground.example",
};

describe("custom-domain activation plan", () => {
  it("preserves BSON subdocument IDs and dates for activation and an exact rollback", () => {
    const domainId = new mongoose.Types.ObjectId();
    const verifiedAt = new Date("2026-11-18T08:00:00Z");
    const domains = [{ ...tenant.domains[0], _id: domainId, verifiedAt }];
    const plan = planTenantDomainActivation({
      ...input,
      tenant: { ...tenant, domains },
    });
    const restored = mongoose.mongo.BSON.EJSON.parse(
      serializeDomainActivationSnapshot(plan),
      { relaxed: false },
    );
    expect(plan.previousDomains).toEqual(domains);
    expect(restored.previousDomains).toEqual(domains);
    expect(restored.nextDomains).toEqual(plan.nextDomains);
    expect(restored.previousDomains[0]._id).toBeInstanceOf(
      mongoose.Types.ObjectId,
    );
    expect(restored.nextDomains[0]._id.equals(domainId)).toBe(true);
    expect(restored.previousDomains[0].verifiedAt).toBeInstanceOf(Date);
    expect(restored.previousDomains[0].verifiedAt).toEqual(verifiedAt);
    expect(domains[0].isPrimary).toBe(true);
  });
  it("preserves the old working hostname and produces an exact rollback snapshot", () => {
    const plan = planTenantDomainActivation(input);
    expect(plan.previousDomains).toEqual(tenant.domains);
    expect(plan.nextDomains).toEqual([
      { ...tenant.domains[0], isPrimary: false },
      {
        hostname: input.hostname,
        type: "custom",
        status: "active",
        isPrimary: true,
      },
    ]);
    expect(tenant.domains[0].isPrimary).toBe(true);
    expect(plan.changed).toBe(true);
  });

  it("is idempotent after activation", () => {
    const first = planTenantDomainActivation(input);
    expect(
      planTenantDomainActivation({
        ...input,
        tenant: {
          ...tenant,
          domains: first.nextDomains as typeof tenant.domains,
        },
      }).changed,
    ).toBe(false);
  });

  it("rejects another workspace and a suspended or downgraded tenant", () => {
    expect(() =>
      planTenantDomainActivation({
        ...input,
        expectedTenantId: "64b000000000000000000002",
      }),
    ).toThrow("ID and slug");
    expect(() =>
      planTenantDomainActivation({ ...input, expectedSlug: "other-studio" }),
    ).toThrow("ID and slug");
    expect(() =>
      planTenantDomainActivation({
        ...input,
        tenant: { ...tenant, status: "suspended" },
      }),
    ).toThrow("active workspaces");
    expect(() =>
      planTenantDomainActivation({
        ...input,
        tenant: { ...tenant, plan: "starter" },
      }),
    ).toThrow("plan");
  });

  it.each([
    "https://book.example",
    "book.example/path",
    "book.example:443",
    "other.shario.io",
    "book.localhost",
    "127.0.0.1",
    "BOOK.EXAMPLE",
  ])("rejects invalid hostname %s", (hostname) => {
    expect(() => planTenantDomainActivation({ ...input, hostname })).toThrow(
      "hostname",
    );
  });

  it("promotes an existing pending record without leaving duplicate primary domains", () => {
    const plan = planTenantDomainActivation({
      ...input,
      tenant: {
        ...tenant,
        domains: [
          ...tenant.domains,
          {
            hostname: input.hostname,
            type: "custom",
            status: "pending",
            isPrimary: false,
          },
        ],
      },
    });
    expect(plan.nextDomains.filter((domain) => domain.isPrimary)).toHaveLength(
      1,
    );
    expect(
      plan.nextDomains.filter((domain) => domain.hostname === input.hostname),
    ).toHaveLength(1);
  });
});
