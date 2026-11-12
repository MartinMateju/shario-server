import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import UserMemberNumberCounterModel from "@/modules/user/user-member-number-counter.model.js";
import UserModel from "@/modules/user/user.model.js";

const userId = new mongoose.Types.ObjectId("111111111111111111111111");
const tenantId = new mongoose.Types.ObjectId("222222222222222222222222");

describe("member-number hooks on partial user saves", () => {
  let persistedMemberNumber: number | undefined;
  let allocationEpoch: number;
  let repairLock: string | null;

  // Keep actual Mongoose validation and save middleware; replace only storage.
  // No database connection or real customer records are needed by these tests.
  beforeEach(() => {
    persistedMemberNumber = 234;
    allocationEpoch = 0;
    repairLock = null;
    vi.spyOn(UserMemberNumberCounterModel, "findOne").mockImplementation(() => {
      const query = {
        select: () => query,
        session: () => query,
        lean: () => query,
        exec: async () => ({ allocationEpoch, repairLock }),
      };
      return query as never;
    });
    vi.spyOn(UserModel.collection, "findOne").mockImplementation(
      async (filter, options) => {
        if (filter["memberNumberHistory.number"]) return null;
        if (Array.isArray(filter.$or)) return null;
        if (options?.projection?.["importMetadata.rolledBackAt"]) {
          return { _id: userId };
        }
        if (options?.sort) return { _id: userId, memberNumber: 234 };
        if (typeof filter.memberNumber === "number") return null;
        return { _id: userId, memberNumber: persistedMemberNumber };
      },
    );
    vi.spyOn(UserModel.collection, "aggregate").mockReturnValue({
      toArray: async () => [],
    } as never);
    vi.spyOn(UserModel.collection, "updateOne").mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    });
    vi.spyOn(UserModel.collection, "insertOne").mockResolvedValue({
      acknowledged: true,
      insertedId: userId,
    });
    vi.spyOn(UserMemberNumberCounterModel, "updateOne").mockReturnValue({
      exec: async () => ({ acknowledged: true, matchedCount: 1 }),
    } as never);
    vi.spyOn(UserMemberNumberCounterModel, "findOneAndUpdate").mockReturnValue({
      exec: async () => ({ value: 235 }),
    } as never);
  });

  const creditProjection = () => {
    const user = UserModel.hydrate(
      { _id: userId, moneyCredits: 100, moneyCreditsMinor: 10000 },
      { _id: 1, moneyCredits: 1, moneyCreditsMinor: 1 },
    );
    // Mirrors the tenant-scoped repository and cancellation refund update.
    user.tenant = tenantId;
    user.moneyCredits = 150;
    user.moneyCreditsMinor = 15000;
    return user;
  };

  it("saves a refund without allocating or changing an unselected member number", async () => {
    const user = creditProjection();

    expect(user.isSelected("memberNumber")).toBe(false);
    await user.save();

    expect(UserModel.collection.updateOne).toHaveBeenCalledWith(
      { _id: userId },
      expect.objectContaining({
        $set: expect.objectContaining({
          moneyCredits: 150,
          moneyCreditsMinor: 15000,
        }),
      }),
      expect.any(Object),
    );
    const update = vi.mocked(UserModel.collection.updateOne).mock.calls[0][1];
    expect(update).not.toHaveProperty("$set.memberNumber");
    expect(update).not.toHaveProperty("$unset");
    expect(UserModel.collection.findOne).not.toHaveBeenCalled();
    expect(UserMemberNumberCounterModel.updateOne).not.toHaveBeenCalled();
    expect(
      UserMemberNumberCounterModel.findOneAndUpdate,
    ).not.toHaveBeenCalled();
  });

  it("still rejects an explicitly changed member number on a partial document", async () => {
    const user = creditProjection();
    user.memberNumber = 235;

    await expect(user.save()).rejects.toThrow(
      "Member number cannot be changed once assigned.",
    );
    expect(UserModel.collection.updateOne).not.toHaveBeenCalled();
    expect(
      UserMemberNumberCounterModel.findOneAndUpdate,
    ).not.toHaveBeenCalled();
  });

  it("keeps an already selected member number during unrelated updates", async () => {
    const user = UserModel.hydrate({
      _id: userId,
      tenant: tenantId,
      firstname: "Synthetic",
      customId: "U-SYNTHETIC",
      memberNumber: 234,
    });
    user.phone = "+420123456789";

    await user.save();

    expect(user.memberNumber).toBe(234);
    expect(UserModel.collection.updateOne).toHaveBeenCalledOnce();
    expect(
      UserMemberNumberCounterModel.findOneAndUpdate,
    ).not.toHaveBeenCalled();
  });

  it("still assigns an unnumbered legacy user when the field was selected", async () => {
    persistedMemberNumber = undefined;
    const user = UserModel.hydrate({
      _id: userId,
      tenant: tenantId,
      firstname: "Synthetic",
      customId: "00234",
      isAccessGranted: true,
    });
    user.phone = "+420123456789";

    await user.save();

    expect(user.isSelected("memberNumber")).toBe(true);
    expect(user.memberNumber).toBe(234);
    expect(UserModel.collection.updateOne).toHaveBeenCalledOnce();
    expect(UserMemberNumberCounterModel.updateOne).toHaveBeenCalledOnce();
    expect(
      UserMemberNumberCounterModel.findOneAndUpdate,
    ).not.toHaveBeenCalled();
  });

  it("still assigns a number to a new user", async () => {
    const user = new UserModel({
      _id: userId,
      tenant: tenantId,
      firstname: "Synthetic",
      customId: "U-SYNTHETIC",
    });

    await user.save();

    expect(user.memberNumber).toBe(235);
    expect(
      UserMemberNumberCounterModel.findOneAndUpdate,
    ).toHaveBeenCalledOnce();
    expect(UserModel.collection.insertOne).toHaveBeenCalledOnce();
  });

  it("still leaves inactive generated guests unnumbered", async () => {
    const user = UserModel.hydrate({
      _id: userId,
      tenant: tenantId,
      firstname: "Guest",
      customId: "G-0123456789abcdefabcd",
      isAccessGranted: false,
    });
    user.phone = "+420123456789";

    await user.save();

    expect(user.memberNumber).toBeUndefined();
    expect(UserModel.collection.updateOne).toHaveBeenCalledOnce();
    expect(
      UserMemberNumberCounterModel.findOneAndUpdate,
    ).not.toHaveBeenCalled();
  });

  it("rejects a delayed save if a repair changed the epoch after allocation", async () => {
    const user = new UserModel({
      tenant: tenantId,
      firstname: "Synthetic",
      customId: "U-DELAYED",
    });
    vi.mocked(UserMemberNumberCounterModel.findOneAndUpdate).mockReturnValue({
      exec: async () => {
        allocationEpoch = 1;
        return { value: 235 };
      },
    } as never);

    await expect(user.save()).rejects.toMatchObject({
      code: "MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED",
      statusCode: 503,
    });
    expect(UserModel.collection.insertOne).not.toHaveBeenCalled();
    expect(user.memberNumber).toBeUndefined();
  });

  it("rejects a delayed save when a repair starts after allocation", async () => {
    const user = new UserModel({
      tenant: tenantId,
      firstname: "Synthetic",
      customId: "U-DELAYED",
    });
    vi.mocked(UserMemberNumberCounterModel.findOneAndUpdate).mockReturnValue({
      exec: async () => {
        repairLock = "synthetic-repair";
        return { value: 235 };
      },
    } as never);

    await expect(user.save()).rejects.toMatchObject({
      code: "MEMBER_NUMBER_ALLOCATION_PAUSED",
      statusCode: 503,
    });
    expect(UserModel.collection.insertOne).not.toHaveBeenCalled();
    expect(user.memberNumber).toBeUndefined();
  });

  it("allows an unrelated update to an existing numbered user while allocation is paused", async () => {
    repairLock = "synthetic-repair";
    const user = creditProjection();

    await user.save();

    expect(UserModel.collection.updateOne).toHaveBeenCalledOnce();
    expect(UserMemberNumberCounterModel.findOne).not.toHaveBeenCalled();
  });
});
