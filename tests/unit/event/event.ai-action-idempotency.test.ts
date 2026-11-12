import type { Schema } from "mongoose";
import { describe, expect, it } from "vitest";

import { eventSchema } from "@/modules/event/event.schema.js";
import { createEventSchema } from "@/modules/event/event.validators.js";

const hasIndex = (
  schema: Schema,
  fields: Record<string, number | string>,
  options: Record<string, unknown>,
) =>
  schema
    .indexes()
    .some(
      ([indexFields, indexOptions]) =>
        JSON.stringify(indexFields) === JSON.stringify(fields) &&
        Object.entries(options).every(
          ([key, value]) =>
            JSON.stringify((indexOptions as Record<string, unknown>)[key]) ===
            JSON.stringify(value),
        ),
    );

describe("Event AI action idempotency boundary", () => {
  it("keeps the action id private and unique inside one tenant", () => {
    expect(eventSchema.path("aiActionId")?.options.select).toBe(false);
    expect(
      hasIndex(
        eventSchema,
        { tenant: 1, aiActionId: 1 },
        {
          unique: true,
          partialFilterExpression: { aiActionId: { $type: "objectId" } },
        },
      ),
    ).toBe(true);
  });

  it("does not accept an AI action id from the normal event DTO", () => {
    const parsed = createEventSchema.parse({
      title: "Private workshop",
      location: "507f1f77bcf86cd799439011",
      date: "2099-09-15",
      order: null,
      aiActionId: "507f1f77bcf86cd799439099",
    });

    expect(parsed).not.toHaveProperty("aiActionId");
  });
});
