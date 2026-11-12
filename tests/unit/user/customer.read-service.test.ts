import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRepository: vi.fn(),
  ensureUserMemberNumber: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock("@/modules/user/user.repository.js", () => ({
  createUserRepository: mocks.createRepository,
}));

vi.mock("@/modules/user/user-member-number.assignment.service.js", () => ({
  ensureUserMemberNumber: mocks.ensureUserMemberNumber,
  ensureUserMemberNumbers: vi.fn(),
}));

import { getCustomerById } from "@/modules/user/services/user.read.service.js";

const TENANT_ID = "64b000000000000000000201";
const CUSTOMER_ID = "64b000000000000000000203";

describe("customer detail read service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRepository.mockReturnValue({ findOne: mocks.findOne });
    mocks.ensureUserMemberNumber.mockResolvedValue(null);
  });

  it("scopes the canonical lookup to the authenticated tenant and customer role", async () => {
    mocks.ensureUserMemberNumber.mockResolvedValue(42);
    mocks.findOne.mockResolvedValue({
      _id: CUSTOMER_ID,
      tenant: TENANT_ID,
      firstname: "Anna",
      lastname: "Novak",
      email: "anna@example.com",
      phone: "+420 123 456 789",
      customId: "anna-1",
      memberNumber: 42,
      tenantRole: "customer",
      platformRole: "none",
      password: "must-not-leak",
      refreshToken: ["must-not-leak"],
      roles: ["must-not-leak"],
      moneyCredits: 500,
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    const result = await getCustomerById({
      tenantId: TENANT_ID,
      customerId: CUSTOMER_ID,
    });

    expect(mocks.ensureUserMemberNumber).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: CUSTOMER_ID,
    });
    expect(mocks.createRepository).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
    });
    expect(mocks.findOne).toHaveBeenCalledWith(
      {
        _id: CUSTOMER_ID,
        tenantRole: "customer",
        platformRole: { $in: ["none", null] },
      },
      { includeGuestContact: true },
    );
    expect(result).toMatchObject({
      id: CUSTOMER_ID,
      customId: "anna-1",
      memberNumber: 42,
      firstname: "Anna",
      lastname: "Novak",
      email: "anna@example.com",
    });
    for (const forbiddenField of [
      "tenant",
      "tenantRole",
      "platformRole",
      "roles",
      "password",
      "refreshToken",
      "moneyCredits",
    ]) {
      expect(result).not.toHaveProperty(forbiddenField);
    }
  });

  it("returns the same not-found result for a missing or cross-tenant customer", async () => {
    mocks.findOne.mockResolvedValue(null);

    await expect(
      getCustomerById({
        tenantId: TENANT_ID,
        customerId: CUSTOMER_ID,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CUSTOMER_NOT_FOUND",
    });
  });
});
