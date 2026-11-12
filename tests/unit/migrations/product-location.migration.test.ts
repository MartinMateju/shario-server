import { describe, expect, it } from "vitest";
import {
  planProductLocationMigration,
  productLocationMigrationFilter,
} from "@/modules/product/product-location.migration.js";

const tenant = "100000000000000000000001";
const otherTenant = "100000000000000000000002";
const a = "200000000000000000000001";
const b = "200000000000000000000002";
const product = { _id: "300000000000000000000001", tenant, kind: "open-studio", type: "workshop", name: "Studio" };
const locations = [{ _id: a, tenant, isActive: true }, { _id: b, tenant, isActive: true }];
const plan = (overrides: Record<string, unknown> = {}) => planProductLocationMigration({ product, locations, historicalLocationIds: [], ...overrides });

describe("studio product location migration", () => {
  it("uses a single historical booking/order location without rewriting IDs or prices", () => {
    expect(plan({ historicalLocationIds: [a, a] })).toMatchObject({ action: "assign", locationId: a });
    expect(product).toEqual({ _id: "300000000000000000000001", tenant, kind: "open-studio", type: "workshop", name: "Studio" });
  });
  it("only infers a sole active tenant location when no history conflicts", () => {
    expect(plan({ locations: [locations[0], { ...locations[1], tenant: otherTenant }] })).toMatchObject({ action: "assign", locationId: a });
    expect(plan({ locations: [locations[0]], historicalLocationIds: [b] }).action).toBe("manual-review");
    expect(plan().action).toBe("manual-review");
  });
  it("does not guess for products used at multiple locations", () => {
    expect(plan({ historicalLocationIds: [a, b] }).action).toBe("manual-review");
    expect(plan({ historicalLocationIds: [a, b], explicitLocationId: b })).toMatchObject({ action: "assign", locationId: b });
  });
  it("rejects foreign, missing, and inactive explicit locations", () => {
    expect(plan({ explicitLocationId: "bad" }).action).toBe("manual-review");
    expect(plan({ locations: [{ ...locations[0], tenant: otherTenant }], explicitLocationId: a }).action).toBe("manual-review");
    expect(plan({ locations: [{ ...locations[0], isActive: false }], explicitLocationId: a }).action).toBe("manual-review");
  });
  it("is idempotent and never moves a previously assigned product", () => {
    expect(plan({ product: { ...product, location: a } })).toEqual({ action: "already-assigned", locationId: a });
    expect(plan({ product: { ...product, location: a }, explicitLocationId: b }).action).toBe("manual-review");
  });
  it("retains legacy studio support without scoping classes, vouchers or memberships", () => {
    expect(plan({ product: { ...product, kind: undefined, type: "blocker" }, historicalLocationIds: [b] })).toMatchObject({ action: "assign", locationId: b });
    for (const [kind, type] of [["class", "course"], ["voucher", "coupon"], ["membership", "membership"]]) {
      expect(plan({ product: { ...product, kind, type } })).toEqual({ action: "skip" });
    }
  });
  it("guards against concurrent assignment and taxonomy changes", () => {
    expect(productLocationMigrationFilter(product)).toEqual({ _id: product._id, tenant, kind: "open-studio", type: "workshop", location: null });
  });
});
