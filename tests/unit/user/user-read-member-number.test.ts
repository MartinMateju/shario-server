import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUserMemberNumber: vi.fn(),
  ensureUserMemberNumbers: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock("@/modules/user/user.repository.js", () => ({
  createUserRepository: () => ({
    findOne: mocks.findOne,
  }),
}));

vi.mock("@/modules/user/user-member-number.assignment.service.js", () => ({
  ensureUserMemberNumber: mocks.ensureUserMemberNumber,
  ensureUserMemberNumbers: mocks.ensureUserMemberNumbers,
}));

import { lookupUser } from "@/modules/user/services/user.read.service.js";

describe("user member-number lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the current member-number owner over a matching legacy customId", async () => {
    const currentOwner = {
      _id: "507f1f77bcf86cd799439011",
      customId: "U-CURRENT",
      memberNumber: 5,
    };
    mocks.findOne.mockResolvedValueOnce(currentOwner);
    mocks.ensureUserMemberNumber.mockResolvedValueOnce(5);

    await expect(
      lookupUser({ tenantId: "507f1f77bcf86cd799439012", search: "#5" }),
    ).resolves.toMatchObject(currentOwner);

    expect(mocks.findOne).toHaveBeenCalledTimes(1);
    expect(mocks.findOne).toHaveBeenCalledWith(
      { memberNumber: 5 }, { includeGuestContact: true },
    );
  });
});
