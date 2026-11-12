import { describe, expect, it } from "vitest";

import {
  staffDailyUpdateSchema,
  staffMonthlyPrioritySetSchema,
  staffWeeklyPlanSchema,
} from "@/modules/staff/staff-planning.models.js";

const hasUniqueIndex = (
  indexes: ReturnType<typeof staffDailyUpdateSchema.indexes>,
  keys: Record<string, number>,
) =>
  indexes.some(
    ([fields, options]) =>
      options.unique === true &&
      Object.entries(keys).every(([key, value]) => fields[key] === value),
  );

describe("staff planning persistence invariants", () => {
  it("allows only one daily update and weekly plan per member/calendar key", () => {
    expect(
      hasUniqueIndex(staffDailyUpdateSchema.indexes(), {
        tenantId: 1,
        userId: 1,
        dateKey: 1,
      }),
    ).toBe(true);
    expect(
      hasUniqueIndex(staffWeeklyPlanSchema.indexes(), {
        tenantId: 1,
        userId: 1,
        weekStartKey: 1,
      }),
    ).toBe(true);
  });

  it("keeps monthly sets unique per tenant/month/location", () => {
    expect(
      hasUniqueIndex(staffMonthlyPrioritySetSchema.indexes(), {
        tenantId: 1,
        monthKey: 1,
        locationId: 1,
      }),
    ).toBe(true);
  });
});

