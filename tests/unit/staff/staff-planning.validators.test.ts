import { describe, expect, it } from "vitest";

import {
  dailyUpdateInputSchema,
  monthlyPriorityInputSchema,
  weeklyPlanInputSchema,
} from "@/modules/staff/staff-planning.validators.js";
import {
  createStaffTaskSchema,
  updateStaffMemberSchema,
  updateStaffTaskSchema,
} from "@/modules/staff/staff.validators.js";
import {
  staffPlanningEntityId,
  staffPlanningDocumentId,
  staffPlanningMemberOverlapsLocations,
} from "@/modules/staff/staff-planning.service.js";

const ID = "507f1f77bcf86cd799439011";

describe("staff planning request contracts", () => {
  it("keeps board quick-create title-only and accepts both location wire names", () => {
    expect(createStaffTaskSchema.parse({ title: "Clean shelves" })).toMatchObject({
      title: "Clean shelves",
      dueDate: null,
      location: null,
      appliesToAllLocations: false,
    });
    expect(
      createStaffTaskSchema.parse({
        title: "Load kiln",
        locationId: ID,
      }).locationId,
    ).toBe(ID);
    expect(
      createStaffTaskSchema.parse({
        title: "Load kiln",
        location: ID,
      }).location,
    ).toBe(ID);
    expect(
      updateStaffTaskSchema.safeParse({
        location: ID,
        locationId: "507f1f77bcf86cd799439012",
      }).success,
    ).toBe(false);
  });

  it("does not apply create defaults to a partial task update", () => {
    expect(updateStaffTaskSchema.parse({ status: "done" })).toEqual({
      status: "done",
    });
  });

  it("does not apply create defaults to a partial staff-member update", () => {
    expect(updateStaffMemberSchema.parse({ bio: "Kiln specialist" })).toEqual({
      bio: "Kiln specialist",
    });
  });

  it("requires a focus unless not working and requires a described attention item", () => {
    expect(dailyUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(
      dailyUpdateInputSchema.safeParse({ notWorkingToday: true }).success,
    ).toBe(true);
    expect(
      dailyUpdateInputSchema.safeParse({
        focusToday: "Prepare class",
        needsOwnerAttention: true,
      }).success,
    ).toBe(false);
  });

  it("enforces weekly and monthly limits at the API boundary", () => {
    expect(
      weeklyPlanInputSchema.safeParse({
        outcomes: Array.from({ length: 4 }, (_, index) => ({
          title: `Outcome ${index}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      monthlyPriorityInputSchema.safeParse({
        priorities: Array.from({ length: 6 }, (_, index) => ({
          title: `Priority ${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  it("allows stable row ids while leaving hidden task links omitted", () => {
    expect(
      weeklyPlanInputSchema.parse({
        outcomes: [{ id: ID, title: "Prepare workshop" }],
      }).outcomes[0],
    ).toEqual({
      id: ID,
      title: "Prepare workshop",
      completed: false,
    });
    expect(
      monthlyPriorityInputSchema.parse({
        priorities: [{ id: ID, title: "Improve kiln flow" }],
      }).priorities[0],
    ).toEqual({
      id: ID,
      title: "Improve kiln flow",
      ownerUserId: null,
      completed: false,
    });
  });

  it("rejects duplicate stable row ids", () => {
    expect(
      weeklyPlanInputSchema.safeParse({
        outcomes: [
          { id: ID, title: "First" },
          { id: ID, title: "Second" },
        ],
      }).success,
    ).toBe(false);
    expect(
      monthlyPriorityInputSchema.safeParse({
        priorities: [
          { id: ID, title: "First" },
          { id: ID, title: "Second" },
        ],
      }).success,
    ).toBe(false);
  });

  it("normalizes populated membership users to their stable id", () => {
    expect(
      staffPlanningEntityId({
        _id: ID,
        firstname: "Anna",
        lastname: "Nováková",
      }),
    ).toBe(ID);
    expect(staffPlanningDocumentId(undefined)).toBe("");
  });

  it("treats an empty selected reader scope as no roster visibility", () => {
    expect(
      staffPlanningMemberOverlapsLocations(
        { locationAccess: { mode: "all", locationIds: [] } },
        [],
      ),
    ).toBe(false);
  });
});
