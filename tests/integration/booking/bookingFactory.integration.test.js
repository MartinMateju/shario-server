import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bookingFactory } from "../../factories/bookingFactory.js";
import { tenantFactory } from "../../factories/tenantFactory.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

// This optional database-backed suite remains skipped in the default test run.
describe.skip("bookingFactory", () => {
  beforeAll(connectTestDatabase);
  beforeEach(clearTestDatabase);
  afterAll(disconnectTestDatabase);

  it("creates a valid confirmed workshop booking", async () => {
    const tenant = await tenantFactory.create();

    const booking = await bookingFactory.createConfirmedWorkshop({
      tenant: tenant._id,
      location: "grohova",
    });

    expect(booking._id).toBeDefined();
    expect(String(booking.tenant)).toBe(String(tenant._id));
    expect(booking.tag).toBe("workshop");
    expect(booking.paymentStatus).toBe("CONFIRMED");
  });
});
