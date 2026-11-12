import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  customerNotificationSummarySchema,
  listCustomerNotificationsSchema,
  readAllCustomerNotificationsSchema,
} from "@/modules/customer-notifications/customer-notification.validators.js";

describe("customer notification validators", () => {
  it("applies safe list defaults and caps page size", () => {
    expect(listCustomerNotificationsSchema.parse({})).toEqual({
      status: "all",
      page: 1,
      limit: 20,
    });
    expect(() =>
      listCustomerNotificationsSchema.parse({ limit: 51 }),
    ).toThrow();
  });

  it("rejects caller-controlled audience and tenant filters", () => {
    expect(() =>
      listCustomerNotificationsSchema.parse({
        tenantId: new mongoose.Types.ObjectId().toString(),
      }),
    ).toThrow();
    expect(() =>
      readAllCustomerNotificationsSchema.parse({ recipientUserId: "other" }),
    ).toThrow();
    expect(() =>
      customerNotificationSummarySchema.parse({ tenantId: "foreign" }),
    ).toThrow();
  });
});
