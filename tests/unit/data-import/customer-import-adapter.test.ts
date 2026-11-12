import { describe, expect, it } from "vitest";

import {
  isSupportedCustomerPasswordHash,
  isProtectedWorkspaceUser,
  normalizeCustomerImportRow,
  normalizeImportPhone,
  normalizeImportedMemberNumber,
  validateCustomerImportRow,
} from "@/modules/data-import/adapters/customer-import.adapter.js";

describe("customer import adapter", () => {
  it("supports a single name with no email or password", () => {
    const customer = normalizeCustomerImportRow(
      { Name: "Madonna" },
      { fullName: "Name" },
    );
    expect(customer).toEqual({ firstname: "Madonna", lastname: "" });
    expect(validateCustomerImportRow(customer)).toEqual([
      expect.objectContaining({
        code: "CUSTOMER_EMAIL_MISSING",
        severity: "warning",
      }),
    ]);
  });

  it("normalizes contact identifiers and keeps explicit columns authoritative", () => {
    expect(
      normalizeCustomerImportRow(
        {
          Name: "Anna Novak",
          First: "Anička",
          Email: " ANNA@EXAMPLE.COM ",
          Phone: "+420 777 123 456",
        },
        {
          fullName: "Name",
          firstName: "First",
          email: "Email",
          phone: "Phone",
        },
      ),
    ).toEqual({
      firstname: "Anička",
      lastname: "Novak",
      email: "anna@example.com",
      phone: "+420777123456",
    });
    expect(normalizeImportPhone("(777) 123-456")).toBe("777123456");
    expect(normalizeImportPhone("'+420 777 123 456")).toBe(
      "+420777123456",
    );
    expect(normalizeImportPhone("’ +420 777 123 456")).toBe(
      "+420777123456",
    );
    expect(normalizeImportPhone("+")).toBe("");
  });

  it("normalizes positive member numbers with optional pottery-mark hashes", () => {
    expect(normalizeImportedMemberNumber("#1675")).toEqual({
      provided: true,
      memberNumber: 1675,
    });
    expect(normalizeImportedMemberNumber("1675#")).toEqual({
      provided: true,
      memberNumber: 1675,
    });
    expect(
      normalizeCustomerImportRow(
        { Name: "Anna Novak", "Pottery ID": "#1675" },
        { fullName: "Name", memberNumber: "Pottery ID" },
      ),
    ).toEqual({
      firstname: "Anna",
      lastname: "Novak",
      memberNumberProvided: true,
      memberNumber: 1675,
    });
  });

  it.each(["0", "-1", "1.5", "#", "abc", "1#2"])(
    "rejects invalid member number %s",
    (memberNumber) => {
      const customer = normalizeCustomerImportRow(
        { Name: "Anna", Number: memberNumber },
        { fullName: "Name", memberNumber: "Number" },
      );
      expect(validateCustomerImportRow(customer)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "CUSTOMER_MEMBER_NUMBER_INVALID",
            field: "memberNumber",
            severity: "error",
          }),
        ]),
      );
    },
  );

  it("rejects missing names and malformed email addresses", () => {
    const issues = validateCustomerImportRow({
      firstname: "",
      lastname: "",
      email: "not-an-email",
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CUSTOMER_NAME_REQUIRED" }),
        expect.objectContaining({ code: "CUSTOMER_EMAIL_INVALID" }),
      ]),
    );
  });

  it("accepts only bounded bcrypt hashes and requires email for migration", () => {
    expect(
      isSupportedCustomerPasswordHash(`$2b$12$${"A".repeat(53)}`),
    ).toBe(true);
    expect(
      isSupportedCustomerPasswordHash(`$2b$15$${"A".repeat(53)}`),
    ).toBe(false);
    expect(isSupportedCustomerPasswordHash("plain-text-password")).toBe(false);

    expect(
      validateCustomerImportRow({
        firstname: "Anna",
        lastname: "Novak",
        passwordHashProvided: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CUSTOMER_PASSWORD_HASH_WITHOUT_EMAIL",
          severity: "error",
        }),
      ]),
    );
  });

  it("fails closed for workspace roles even without a membership lookup", () => {
    expect(isProtectedWorkspaceUser({ tenantRole: "admin" })).toBe(true);
    expect(isProtectedWorkspaceUser({ roles: ["9092k"] })).toBe(true);
    expect(
      isProtectedWorkspaceUser({ tenantRole: "customer", roles: ["1023e"] }),
    ).toBe(false);
  });
});
