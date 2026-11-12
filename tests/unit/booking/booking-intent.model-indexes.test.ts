import { describe, expect, it } from "vitest";

import { BookingIntentModel } from "@/modules/booking-intent/booking-intent.model.js";

describe("booking intent indexes", () => {
  it("declares one TTL index for expiresAt", () => {
    const expiresAtIndexes = BookingIntentModel.schema
      .indexes()
      .filter(([keys]) => Object.keys(keys).length === 1 && keys.expiresAt === 1);

    expect(expiresAtIndexes).toHaveLength(1);
    expect(expiresAtIndexes[0]?.[1]).toMatchObject({
      expireAfterSeconds: 0,
    });
  });
});
