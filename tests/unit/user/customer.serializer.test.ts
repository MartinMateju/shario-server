import { describe, expect, it } from "vitest";

import { serializeCustomer } from "@/modules/user/user.serializers.js";

describe("customer serializer", () => {
  it("uses an allow-list even for a newly-created credential-bearing document", () => {
    const customer = serializeCustomer({
      _id: "64b000000000000000000203",
      firstname: "Anna",
      lastname: "Novak",
      email: "ANNA@example.com",
      phone: "+420123456789",
      customId: "anna-1",
      password: "$2b$12$secret",
      refreshToken: ["secret"],
      emailToken: "secret",
      platformRole: "none",
      tenantRole: "customer",
      roles: ["1023e"],
      tenant: "64b000000000000000000201",
    });

    expect(customer).toMatchObject({
      id: "64b000000000000000000203",
      firstname: "Anna",
      lastname: "Novak",
      email: "ANNA@example.com",
      customId: "anna-1",
    });
    expect(customer).not.toHaveProperty("password");
    expect(customer).not.toHaveProperty("refreshToken");
    expect(customer).not.toHaveProperty("emailToken");
    expect(customer).not.toHaveProperty("platformRole");
    expect(customer).not.toHaveProperty("tenantRole");
    expect(customer).not.toHaveProperty("roles");
    expect(customer).not.toHaveProperty("tenant");
  });
});
