import { describe, expect, it } from "vitest";

import { serializeCustomer } from "@/modules/user/user.serializers.js";
import {
  buildUsersFilterQuery,
  buildUsersSortQuery,
} from "@/modules/user/user.query.js";
import { userSchema } from "@/modules/user/user.schema.js";
import {
  areUserMemberIdentifiersEquivalent,
  formatUserMemberNumber,
  isInactiveGeneratedGuest,
  matchesUserMemberIdentifier,
  parseUserMemberNumber,
} from "@/modules/user/user-member-number.service.js";

describe("user member-number contract", () => {
  it("enforces a tenant-scoped partial unique index", () => {
    const index = userSchema
      .indexes()
      .find(
        ([, options]) => options.name === "tenant_1_memberNumber_1_partial",
      );

    expect(index).toEqual([
      { tenant: 1, memberNumber: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: { memberNumber: { $type: "number" } },
      }),
    ]);
    expect(userSchema.path("memberNumber").options).toMatchObject({ min: 1 });
    expect(userSchema.path("memberNumberHistory").options.select).toBe(false);
    expect(
      userSchema
        .indexes()
        .find(
          ([, options]) =>
            options.name === "tenant_1_memberNumberHistory.number_1",
        ),
    ).toEqual([
      { tenant: 1, "memberNumberHistory.number": 1 },
      expect.any(Object),
    ]);
  });

  it("serializes the number additively without changing the legacy ID", () => {
    expect(
      serializeCustomer({
        _id: "user-1",
        customId: "U-LEGACY-QR",
        memberNumber: 234,
      }),
    ).toMatchObject({
      id: "user-1",
      customId: "U-LEGACY-QR",
      memberNumber: 234,
    });

    expect(serializeCustomer({ customId: "U-OLD" }).memberNumber).toBeNull();
  });

  it("finds and numerically sorts member IDs while retaining legacy lookup", () => {
    expect(buildUsersFilterQuery({ customId: "234" })).toMatchObject({
      $and: [
        {
          $or: [
            { customId: { $regex: "234", $options: "i" } },
            { memberNumber: 234 },
            { "memberNumberHistory.number": 234 },
          ],
        },
      ],
    });
    expect(buildUsersFilterQuery({ memberNumber: "#234" })).toMatchObject({
      $and: [
        {
          $or: [
            { customId: { $regex: "#234", $options: "i" } },
            { memberNumber: 234 },
            { "memberNumberHistory.number": 234 },
          ],
        },
      ],
    });
    expect(buildUsersFilterQuery({ customId: "U-LEGACY" })).toMatchObject({
      customId: { $regex: "U-LEGACY", $options: "i" },
    });
    expect(buildUsersSortQuery("customId", "asc")).toMatchObject({
      memberNumber: 1,
    });
  });

  it("defers numbers only for inactive generated guest placeholders", () => {
    expect(
      isInactiveGeneratedGuest({
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: false,
      }),
    ).toBe(true);
    expect(
      isInactiveGeneratedGuest({
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: true,
      }),
    ).toBe(false);
  });

  it("requires the physical member code to match exactly", () => {
    const user = { memberNumber: 234, customId: "U-LEGACY-QR" };

    expect(matchesUserMemberIdentifier(user, "234")).toBe(true);
    expect(matchesUserMemberIdentifier(user, "#234")).toBe(true);
    expect(matchesUserMemberIdentifier(user, "U-LEGACY-QR")).toBe(true);
    expect(matchesUserMemberIdentifier(user, "0234")).toBe(false);
  });

  it("parses and formats the public hash-prefixed ID without coercing padding", () => {
    expect(parseUserMemberNumber("#234")).toBe(234);
    expect(parseUserMemberNumber("234")).toBe(234);
    expect(parseUserMemberNumber("0234")).toBeNull();
    expect(formatUserMemberNumber(234)).toBe("#234");
    expect(formatUserMemberNumber(null)).toBeNull();
    expect(areUserMemberIdentifiersEquivalent("#234", "234")).toBe(true);
    expect(areUserMemberIdentifiersEquivalent("0234", "234")).toBe(false);
  });

  it("recognizes recorded old pottery IDs without treating padded codes as aliases", () => {
    const user = {
      memberNumber: 1622,
      customId: "U-LEGACY-QR",
      memberNumberHistory: [{ number: 9999 }],
    };
    expect(matchesUserMemberIdentifier(user, "9999")).toBe(true);
    expect(matchesUserMemberIdentifier(user, "#9999")).toBe(true);
    expect(matchesUserMemberIdentifier(user, "09999")).toBe(false);
    expect(matchesUserMemberIdentifier(user, "10000")).toBe(false);
  });
});
