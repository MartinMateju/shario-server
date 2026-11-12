import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import UserMemberNumberCounterModel from "@/modules/user/user-member-number-counter.model.js";
import { ensureUserMemberNumbers } from "@/modules/user/user-member-number.assignment.service.js";
import { migrateUserMemberNumbers } from "@/modules/user/user-member-number.migration.js";
import {
  allocateUserMemberNumber,
  ensureUserMemberNumberCounterAtLeast,
  readUserMemberNumberAllocationEpoch,
  USER_MEMBER_NUMBER_COUNTER_KEY,
  USER_MEMBER_NUMBER_HISTORY_REASON,
} from "@/modules/user/user-member-number.service.js";
import UserModel from "@/modules/user/user.model.js";

type AssignmentPath = "save" | "lazy" | "migration";

describe("member-number allocation across an audited counter repair", () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      UserMemberNumberCounterModel.syncIndexes(),
      UserModel.syncIndexes(),
    ]);
  });

  beforeEach(async () => {
    await UserMemberNumberCounterModel.deleteMany({});
    await UserModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const counterId = (tenantId: mongoose.Types.ObjectId) =>
    `${USER_MEMBER_NUMBER_COUNTER_KEY}:${tenantId.toHexString()}`;

  const counterFilter = (tenantId: mongoose.Types.ObjectId) => ({
    tenant: tenantId,
    key: USER_MEMBER_NUMBER_COUNTER_KEY,
  });

  const insertCounter = async (
    tenantId: mongoose.Types.ObjectId,
    values: Record<string, unknown>,
  ) => {
    await UserMemberNumberCounterModel.collection.insertOne({
      _id: counterId(tenantId),
      tenant: tenantId,
      key: USER_MEMBER_NUMBER_COUNTER_KEY,
      ...values,
    } as any);
  };

  const insertUser = async (
    tenantId: mongoose.Types.ObjectId,
    values: Record<string, unknown> = {},
  ) => {
    const _id = new mongoose.Types.ObjectId();
    await UserModel.collection.insertOne({
      _id,
      tenant: tenantId,
      firstname: "Legacy",
      lastname: "Maker",
      customId: `U-${_id.toHexString()}`,
      isAccessGranted: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      ...values,
    } as any);
    return _id;
  };

  const history = (number: number) => [
    {
      number,
      replacedAt: new Date("2026-10-25T00:00:00.000Z"),
      reason: USER_MEMBER_NUMBER_HISTORY_REASON.MEMBER_NUMBER_REPAIR,
    },
  ];

  const assign = async (
    path: AssignmentPath,
    tenantId: mongoose.Types.ObjectId,
    userId: mongoose.Types.ObjectId,
  ) => {
    if (path === "save") {
      const user = await UserModel.findById(userId).exec();
      user!.phone = "+420123456789";
      await user!.save();
    } else if (path === "lazy") {
      await ensureUserMemberNumbers({ tenantId, userIds: [userId] });
    } else {
      await migrateUserMemberNumbers({ apply: true });
    }
    return UserModel.collection.findOne({ _id: userId });
  };

  it("continues a legacy counter that has no allocation epoch", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    await insertCounter(tenantId, { value: 1_623 });

    await expect(
      readUserMemberNumberAllocationEpoch({ tenantId }),
    ).resolves.toBe(0);
    await expect(allocateUserMemberNumber({ tenantId })).resolves.toBe(1_624);
    await expect(
      UserMemberNumberCounterModel.collection.findOne(counterFilter(tenantId)),
    ).resolves.toMatchObject({ value: 1_624 });
  });

  it("skips historical numbers without reserving them for another tenant", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const otherTenantId = new mongoose.Types.ObjectId();
    await insertUser(tenantId, {
      memberNumber: 1_622,
      memberNumberHistory: history(9_999),
    });
    await insertUser(tenantId, {
      memberNumber: 1_623,
      memberNumberHistory: history(10_000),
    });
    await insertCounter(tenantId, { value: 9_998, allocationEpoch: 1 });
    await insertCounter(otherTenantId, { value: 9_998, allocationEpoch: 1 });

    await expect(allocateUserMemberNumber({ tenantId })).resolves.toBe(10_001);
    await expect(
      UserMemberNumberCounterModel.collection.findOne(counterFilter(tenantId)),
    ).resolves.toMatchObject({ value: 10_001, allocationEpoch: 1 });
    await expect(
      allocateUserMemberNumber({ tenantId: otherTenantId }),
    ).resolves.toBe(9_999);
    await expect(
      UserMemberNumberCounterModel.collection.findOne(
        counterFilter(otherTenantId),
      ),
    ).resolves.toMatchObject({ value: 9_999, allocationEpoch: 1 });
  });

  it.each<AssignmentPath>(["save", "lazy", "migration"])(
    "%s never adopts another customer's historical member number",
    async (path) => {
      const tenantId = new mongoose.Types.ObjectId();
      await insertUser(tenantId, {
        memberNumber: 1622,
        memberNumberHistory: history(9999),
      });
      const candidateId = await insertUser(tenantId, { customId: "9999" });
      if (path === "lazy") {
        // An unproven numeric legacy ID still reserves its floor, but cannot
        // become this customer's current ID when history owns the mark.
        await expect(
          assign(path, tenantId, candidateId),
        ).resolves.toMatchObject({ memberNumber: 10000 });
      } else {
        await expect(assign(path, tenantId, candidateId)).rejects.toThrow();
        expect(
          (await UserModel.collection.findOne({ _id: candidateId }))
            ?.memberNumber,
        ).toBeUndefined();
      }
    },
  );

  it.each<AssignmentPath>(["save", "lazy", "migration"])(
    "%s ignores only the proven retired alias while retaining it for lookup",
    async (path) => {
      const tenantId = new mongoose.Types.ObjectId();
      const retiredUserId = await insertUser(tenantId, {
        customId: "10001",
        memberNumber: 1_623,
        memberNumberHistory: history(10_001),
      });
      const newUserId = await insertUser(tenantId);
      await insertCounter(tenantId, { value: 1_623, allocationEpoch: 1 });

      await expect(assign(path, tenantId, newUserId)).resolves.toMatchObject({
        memberNumber: 1_624,
      });
      await expect(
        UserMemberNumberCounterModel.collection.findOne(
          counterFilter(tenantId),
        ),
      ).resolves.toMatchObject({ value: 1_624, allocationEpoch: 1 });
      await expect(
        UserModel.collection.findOne({ _id: retiredUserId }),
      ).resolves.toMatchObject({
        customId: "10001",
        memberNumber: 1_623,
        memberNumberHistory: history(10_001),
      });
    },
  );

  it.each([
    ["no history", { memberNumber: 1_623 }],
    [
      "unrelated history",
      { memberNumber: 1_623, memberNumberHistory: history(9_999) },
    ],
    ["no current number", { memberNumberHistory: history(10_001) }],
    [
      "unchanged current number",
      { memberNumber: 10_001, memberNumberHistory: history(10_001) },
    ],
  ])(
    "keeps an unproven numeric alias reserved with %s",
    async (_label, values) => {
      const tenantId = new mongoose.Types.ObjectId();
      await insertUser(tenantId, { customId: "10001", ...(values as object) });
      const newUserId = await insertUser(tenantId);
      await insertCounter(tenantId, { value: 1_623, allocationEpoch: 1 });

      const preview = await migrateUserMemberNumbers();
      expect(preview.tenants[0].legacyCustomIdHighWaterMark).toBe(10_001);
      await expect(assign("save", tenantId, newUserId)).resolves.toMatchObject({
        memberNumber: 10_002,
      });
      await expect(
        UserMemberNumberCounterModel.collection.findOne(
          counterFilter(tenantId),
        ),
      ).resolves.toMatchObject({ value: 10_002 });
    },
  );

  it.each([
    [
      "active repair lock",
      {
        repairLock: "audited-repair",
        allocationPausedUntil: new Date("2999-01-01"),
      },
    ],
    [
      "expired repair lock",
      {
        repairLock: "audited-repair",
        allocationPausedUntil: new Date("2000-01-01"),
      },
    ],
    ["timed pause", { allocationPausedUntil: new Date("2999-01-01") }],
  ])(
    "fails closed under an %s without changing a user or counter",
    async (_label, barrier) => {
      const tenantId = new mongoose.Types.ObjectId();
      const userId = await insertUser(tenantId);
      await insertCounter(tenantId, {
        value: 1_623,
        allocationEpoch: 1,
        ...(barrier as object),
      });
      const beforeCounter =
        await UserMemberNumberCounterModel.collection.findOne(
          counterFilter(tenantId),
        );
      const beforeUser = await UserModel.collection.findOne({ _id: userId });
      const paused = {
        code: "MEMBER_NUMBER_ALLOCATION_PAUSED",
        statusCode: 503,
      };

      await expect(
        allocateUserMemberNumber({ tenantId }),
      ).rejects.toMatchObject(paused);
      await expect(
        ensureUserMemberNumberCounterAtLeast({
          tenantId,
          minimum: 10_001,
          expectedEpoch: 1,
        }),
      ).rejects.toMatchObject(paused);
      for (const path of ["save", "lazy", "migration"] as const) {
        await expect(assign(path, tenantId, userId)).rejects.toMatchObject(
          paused,
        );
      }

      await expect(
        UserMemberNumberCounterModel.collection.findOne(
          counterFilter(tenantId),
        ),
      ).resolves.toEqual(beforeCounter);
      await expect(
        UserModel.collection.findOne({ _id: userId }),
      ).resolves.toEqual(beforeUser);
    },
  );

  it("rejects an old epoch before a stale floor or allocation can change the repaired counter", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    await insertCounter(tenantId, { value: 10_001, allocationEpoch: 0 });
    const staleEpoch = await readUserMemberNumberAllocationEpoch({ tenantId });
    await UserMemberNumberCounterModel.collection.updateOne(
      counterFilter(tenantId),
      { $set: { value: 1_623, allocationEpoch: 1 } },
    );
    const repaired = await UserMemberNumberCounterModel.collection.findOne(
      counterFilter(tenantId),
    );
    const changed = {
      code: "MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED",
      statusCode: 503,
    };

    await expect(
      ensureUserMemberNumberCounterAtLeast({
        tenantId,
        minimum: 10_001,
        expectedEpoch: staleEpoch,
      }),
    ).rejects.toMatchObject(changed);
    await expect(
      allocateUserMemberNumber({
        tenantId,
        minimum: 10_001,
        expectedEpoch: staleEpoch,
      }),
    ).rejects.toMatchObject(changed);
    await expect(
      UserMemberNumberCounterModel.collection.findOne(counterFilter(tenantId)),
    ).resolves.toEqual(repaired);
  });

  it("rejects a repair that lands between raising the floor and incrementing", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    await insertCounter(tenantId, { value: 10_001, allocationEpoch: 0 });
    const original =
      UserMemberNumberCounterModel.collection.findOneAndUpdate.bind(
        UserMemberNumberCounterModel.collection,
      );
    vi.spyOn(
      UserMemberNumberCounterModel.collection,
      "findOneAndUpdate",
    ).mockImplementationOnce(async (...args: any[]) => {
      await UserMemberNumberCounterModel.collection.updateOne(
        counterFilter(tenantId),
        { $set: { value: 1_623, allocationEpoch: 1 } },
      );
      return (original as any)(...args);
    });

    await expect(
      allocateUserMemberNumber({ tenantId, minimum: 10_001, expectedEpoch: 0 }),
    ).rejects.toMatchObject({
      code: "MEMBER_NUMBER_ALLOCATION_EPOCH_CHANGED",
    });
    await expect(
      UserMemberNumberCounterModel.collection.findOne(counterFilter(tenantId)),
    ).resolves.toMatchObject({ value: 1_623, allocationEpoch: 1 });
  });

  it.each<AssignmentPath>(["save", "lazy"])(
    "%s recomputes a high-water read made before the repair",
    async (path) => {
      const tenantId = new mongoose.Types.ObjectId();
      const repairedUserId = await insertUser(tenantId, {
        customId: "10001",
        memberNumber: 10_001,
      });
      const newUserId = await insertUser(tenantId);
      await insertCounter(tenantId, { value: 10_001, allocationEpoch: 0 });
      const original = UserModel.collection.findOne.bind(UserModel.collection);
      let repaired = false;
      let floorReads = 0;
      vi.spyOn(UserModel.collection, "findOne").mockImplementation(
        async (...args: any[]) => {
          const result = await (original as any)(...args);
          if (args[1]?.sort?.memberNumber === -1) {
            floorReads += 1;
            if (!repaired) {
              repaired = true;
              await UserModel.collection.updateOne(
                { _id: repairedUserId },
                {
                  $set: {
                    memberNumber: 1_623,
                    memberNumberHistory: history(10_001),
                  },
                },
              );
              await UserMemberNumberCounterModel.collection.updateOne(
                counterFilter(tenantId),
                { $set: { value: 1_623, allocationEpoch: 1 } },
              );
            }
          }
          return result;
        },
      );

      await expect(assign(path, tenantId, newUserId)).resolves.toMatchObject({
        memberNumber: 1_624,
      });
      expect(floorReads).toBeGreaterThanOrEqual(2);
      await expect(
        UserMemberNumberCounterModel.collection.findOne(
          counterFilter(tenantId),
        ),
      ).resolves.toMatchObject({ value: 1_624, allocationEpoch: 1 });
    },
  );
});
