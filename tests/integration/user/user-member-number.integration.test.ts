import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import UserMemberNumberCounterModel from "@/modules/user/user-member-number-counter.model.js";
import {
  ensureUserMemberNumbers,
  transitionUserMemberNumber,
} from "@/modules/user/user-member-number.assignment.service.js";
import {
  migrateUserMemberNumbers,
  UserMemberNumberMigrationConflictError,
} from "@/modules/user/user-member-number.migration.js";
import {
  allocateUserMemberNumber,
  USER_MEMBER_NUMBER_HISTORY_REASON,
} from "@/modules/user/user-member-number.service.js";
import { TENANT_ROLE } from "@/modules/user/user.constants.js";
import UserModel from "@/modules/user/user.model.js";

describe("tenant member-number allocation", () => {
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

  it("allocates one unique monotonic sequence under concurrency", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const numbers = await Promise.all(
      Array.from({ length: 50 }, () => allocateUserMemberNumber({ tenantId })),
    );

    expect(new Set(numbers).size).toBe(50);
    expect([...numbers].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
  });

  it("starts an independent sequence for each tenant", async () => {
    const firstTenant = new mongoose.Types.ObjectId();
    const secondTenant = new mongoose.Types.ObjectId();

    await expect(
      Promise.all([
        allocateUserMemberNumber({ tenantId: firstTenant }),
        allocateUserMemberNumber({ tenantId: secondTenant }),
      ]),
    ).resolves.toEqual([1, 1]);
  });

  it("repairs a missing or stale counter above a persisted high-water mark", async () => {
    const tenantId = new mongoose.Types.ObjectId();

    await expect(
      allocateUserMemberNumber({ tenantId, minimum: 1_675 }),
    ).resolves.toBe(1_676);
    await expect(allocateUserMemberNumber({ tenantId })).resolves.toBe(1_677);
  });

  it("allocates above numeric legacy IDs even before the backfill runs", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const createdAt = new Date("2020-01-01T00:00:00.000Z");

    const legacyUserId = new mongoose.Types.ObjectId();
    await UserModel.collection.insertOne({
      _id: legacyUserId,
      tenant: tenantId,
      firstname: "Legacy",
      lastname: "Maker",
      customId: "001675",
      isAccessGranted: true,
      createdAt,
      updatedAt: createdAt,
    });

    const legacyUser = await UserModel.findById(legacyUserId).exec();
    expect(legacyUser).not.toBeNull();
    legacyUser!.phone = "+420123456789";
    await legacyUser!.save();
    expect(legacyUser!.memberNumber).toBe(1_675);

    const user = await UserModel.create({
      tenant: tenantId,
      firstname: "New",
      lastname: "Maker",
      customId: "U-NEW",
    });

    expect(user.memberNumber).toBe(1_676);
  });

  it("assigns every real user and numbers an anonymous guest when claimed", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const first = await UserModel.create({
      tenant: tenantId,
      firstname: "Ada",
      lastname: "Lovelace",
      email: "ada@example.test",
      customId: "U-LEGACY-ADA",
    });
    const guest = await UserModel.create({
      tenant: tenantId,
      firstname: "Guest",
      lastname: "",
      customId: "G-0123456789abcdefabcd",
      isAccessGranted: false,
    });

    expect(first.memberNumber).toBe(1);
    expect(guest.memberNumber).toBeUndefined();

    guest.isAccessGranted = true;
    await guest.save();
    expect(guest.memberNumber).toBe(2);
  });

  it("lazily backfills old real users but leaves inactive generated guests unnumbered", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const legacyUserId = new mongoose.Types.ObjectId();
    const guestId = new mongoose.Types.ObjectId();
    const rolledBackImportId = new mongoose.Types.ObjectId();
    const createdAt = new Date("2020-01-01T00:00:00.000Z");

    await UserModel.collection.insertMany([
      {
        _id: legacyUserId,
        tenant: tenantId,
        firstname: "Legacy",
        lastname: "Maker",
        customId: "U-OLD",
        isAccessGranted: true,
        createdAt,
        updatedAt: createdAt,
      },
      {
        _id: guestId,
        tenant: tenantId,
        firstname: "Guest",
        lastname: "",
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: false,
        createdAt,
        updatedAt: createdAt,
      },
      {
        _id: rolledBackImportId,
        tenant: tenantId,
        firstname: "Rolled back",
        lastname: "Import",
        customId: "IMP-ARCHIVED",
        isAccessGranted: false,
        importMetadata: { rolledBackAt: createdAt },
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    const firstPass = await ensureUserMemberNumbers({
      tenantId,
      userIds: [legacyUserId, guestId, rolledBackImportId],
    });
    const secondPass = await ensureUserMemberNumbers({
      tenantId,
      userIds: [legacyUserId, guestId, rolledBackImportId],
    });

    expect(firstPass.get(String(legacyUserId))).toBe(1);
    expect(firstPass.get(String(guestId))).toBeNull();
    expect(firstPass.get(String(rolledBackImportId))).toBeNull();
    expect(secondPass).toEqual(firstPass);
    await expect(
      UserModel.findById(legacyUserId).lean().exec(),
    ).resolves.toMatchObject({ memberNumber: 1 });
    await expect(
      UserModel.findById(guestId).lean().exec(),
    ).resolves.not.toHaveProperty("memberNumber");
    await expect(
      UserModel.findById(rolledBackImportId).lean().exec(),
    ).resolves.not.toHaveProperty("memberNumber");

    // importMetadata is private by default, so this exercises the persisted
    // rollback guard rather than relying on the field being present in memory.
    const archivedImport = await UserModel.findById(rolledBackImportId).exec();
    expect(archivedImport).not.toBeNull();
    archivedImport!.lastname = "Archive updated";
    await archivedImport!.save();
    expect(archivedImport!.memberNumber).toBeUndefined();
    await expect(
      UserModel.findById(rolledBackImportId).lean().exec(),
    ).resolves.not.toHaveProperty("memberNumber");
  });

  it("moves a customer number through the guarded CAS seam and records history", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const importSessionId = new mongoose.Types.ObjectId();
    const changedBy = new mongoose.Types.ObjectId();
    const customer = await UserModel.create({
      tenant: tenantId,
      firstname: "Existing",
      lastname: "Customer",
      customId: "U-EXISTING",
      tenantRole: TENANT_ROLE.CUSTOMER,
    });

    const result = await transitionUserMemberNumber({
      tenantId,
      userId: customer._id,
      expectedMemberNumber: customer.memberNumber ?? null,
      nextMemberNumber: 25,
      reason: USER_MEMBER_NUMBER_HISTORY_REASON.CUSTOMER_IMPORT_CONFLICT,
      importSessionId,
      changedBy,
    });

    expect(result.beforeRecord.memberNumber).toBe(1);
    expect(result.afterRecord).toMatchObject({
      memberNumber: 25,
      memberNumberHistory: [
        {
          number: 1,
          reason:
            USER_MEMBER_NUMBER_HISTORY_REASON.CUSTOMER_IMPORT_CONFLICT,
          importSession: importSessionId,
          changedBy,
        },
      ],
    });
    expect(
      result.afterRecord.memberNumberHistory?.[0]?.replacedAt,
    ).toBeInstanceOf(Date);
    await expect(allocateUserMemberNumber({ tenantId })).resolves.toBe(26);
  });

  it("allows an unprotected legacy customer whose tenant role is missing", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const createdAt = new Date("2020-01-01T00:00:00.000Z");
    await UserModel.collection.insertOne({
      _id: userId,
      tenant: tenantId,
      firstname: "Legacy",
      lastname: "Customer",
      customId: "U-LEGACY",
      memberNumber: 1,
      isAccessGranted: true,
      createdAt,
      updatedAt: createdAt,
    });

    await expect(
      transitionUserMemberNumber({
        tenantId,
        userId,
        expectedMemberNumber: 1,
        nextMemberNumber: 25,
        reason: USER_MEMBER_NUMBER_HISTORY_REASON.CUSTOMER_IMPORT_CONFLICT,
      }),
    ).resolves.toMatchObject({
      afterRecord: { memberNumber: 25 },
    });
  });

  it("never lets a customer import displace a workspace team account", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const staff = await UserModel.create({
      tenant: tenantId,
      firstname: "Studio",
      lastname: "Staff",
      customId: "U-STAFF",
      tenantRole: TENANT_ROLE.STAFF,
    });

    await expect(
      transitionUserMemberNumber({
        tenantId,
        userId: staff._id,
        expectedMemberNumber: staff.memberNumber ?? null,
        nextMemberNumber: 25,
        reason: USER_MEMBER_NUMBER_HISTORY_REASON.CUSTOMER_IMPORT_CONFLICT,
      }),
    ).rejects.toMatchObject({
      code: "MEMBER_NUMBER_TEAM_ACCOUNT_PROTECTED",
    });

    await expect(
      UserModel.findById(staff._id).lean().exec(),
    ).resolves.toMatchObject({ memberNumber: staff.memberNumber });
  });

  it("reports normalized legacy identity collisions and refuses apply before writing", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const paddedLegacyOwnerId = new mongoose.Types.ObjectId();
    const legacyOwnerId = new mongoose.Types.ObjectId();
    const memberNumberOwnerId = new mongoose.Types.ObjectId();
    const createdAt = new Date("2020-01-01T00:00:00.000Z");

    await UserModel.collection.insertMany([
      {
        _id: paddedLegacyOwnerId,
        tenant: tenantId,
        firstname: "Padded",
        lastname: "Legacy",
        customId: "0952",
        isAccessGranted: true,
        createdAt,
        updatedAt: createdAt,
      },
      {
        _id: legacyOwnerId,
        tenant: tenantId,
        firstname: "Plain",
        lastname: "Legacy",
        customId: "952",
        isAccessGranted: true,
        createdAt,
        updatedAt: createdAt,
      },
      {
        _id: memberNumberOwnerId,
        tenant: tenantId,
        firstname: "Assigned",
        lastname: "Member",
        customId: "U-ASSIGNED",
        memberNumber: 952,
        isAccessGranted: true,
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    const preview = await migrateUserMemberNumbers();

    expect(preview).toMatchObject({
      apply: false,
      refused: false,
      totals: { conflicts: 1 },
      tenants: [
        {
          existingMemberNumberHighWaterMark: 952,
          legacyCustomIdHighWaterMark: 952,
          existingHighWaterMark: 952,
          conflicts: [
            {
              memberNumber: 952,
              owners: expect.arrayContaining([
                expect.objectContaining({
                  userId: String(paddedLegacyOwnerId),
                  customId: "0952",
                  sources: ["customId"],
                }),
                expect.objectContaining({
                  userId: String(legacyOwnerId),
                  customId: "952",
                  sources: ["customId"],
                }),
                expect.objectContaining({
                  userId: String(memberNumberOwnerId),
                  memberNumber: 952,
                  sources: ["memberNumber"],
                }),
              ]),
            },
          ],
        },
      ],
    });

    await expect(
      migrateUserMemberNumbers({ apply: true }),
    ).rejects.toMatchObject({
      name: UserMemberNumberMigrationConflictError.name,
      summary: {
        apply: true,
        refused: true,
        totals: { assigned: 0, conflicts: 1 },
      },
    });

    expect(await UserMemberNumberCounterModel.countDocuments()).toBe(0);
    expect(
      await UserModel.countDocuments({
        _id: { $in: [paddedLegacyOwnerId, legacyOwnerId] },
        memberNumber: null,
      }),
    ).toBe(2);
  });

  it("adopts unique numeric legacy IDs and allocates all others above their high-water mark", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const legacySevenId = new mongoose.Types.ObjectId();
    const paddedLegacyHighId = new mongoose.Types.ObjectId();
    const allocatedId = new mongoose.Types.ObjectId();
    const guestId = new mongoose.Types.ObjectId();
    const alreadyNumberedId = new mongoose.Types.ObjectId();

    await UserModel.collection.insertMany([
      {
        _id: legacySevenId,
        tenant: tenantId,
        firstname: "Seven",
        lastname: "Legacy",
        customId: "7",
        isAccessGranted: true,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        _id: paddedLegacyHighId,
        tenant: tenantId,
        firstname: "High",
        lastname: "Legacy",
        customId: "001675",
        isAccessGranted: true,
        createdAt: new Date("2020-01-02T00:00:00.000Z"),
        updatedAt: new Date("2020-01-02T00:00:00.000Z"),
      },
      {
        _id: allocatedId,
        tenant: tenantId,
        firstname: "New",
        lastname: "Number",
        customId: "U-NONNUMERIC",
        isAccessGranted: true,
        createdAt: new Date("2020-01-03T00:00:00.000Z"),
        updatedAt: new Date("2020-01-03T00:00:00.000Z"),
      },
      {
        _id: guestId,
        tenant: tenantId,
        firstname: "Guest",
        lastname: "",
        customId: "G-0123456789abcdefabcd",
        isAccessGranted: false,
        createdAt: new Date("2020-01-04T00:00:00.000Z"),
        updatedAt: new Date("2020-01-04T00:00:00.000Z"),
      },
      {
        _id: alreadyNumberedId,
        tenant: tenantId,
        firstname: "Existing",
        lastname: "Number",
        customId: "2000",
        memberNumber: 1_800,
        isAccessGranted: true,
        createdAt: new Date("2020-01-05T00:00:00.000Z"),
        updatedAt: new Date("2020-01-05T00:00:00.000Z"),
      },
    ]);

    await expect(migrateUserMemberNumbers()).resolves.toMatchObject({
      totals: {
        eligible: 3,
        assigned: 0,
        skippedGeneratedGuests: 1,
        conflicts: 0,
      },
      tenants: [
        {
          existingMemberNumberHighWaterMark: 1_800,
          legacyCustomIdHighWaterMark: 2_000,
          existingHighWaterMark: 2_000,
        },
      ],
    });

    await expect(
      migrateUserMemberNumbers({ apply: true }),
    ).resolves.toMatchObject({
      refused: false,
      totals: {
        eligible: 3,
        assigned: 3,
        adoptedLegacyCustomIds: 2,
        allocated: 1,
        skippedGeneratedGuests: 1,
        conflicts: 0,
      },
      tenants: [{ counterAfter: 2_001 }],
    });

    const migratedUsers = await UserModel.find({ tenant: tenantId })
      .select("customId memberNumber")
      .lean()
      .exec();
    const memberNumberByCustomId = new Map(
      migratedUsers.map((user) => [user.customId, user.memberNumber]),
    );

    expect(memberNumberByCustomId.get("7")).toBe(7);
    expect(memberNumberByCustomId.get("001675")).toBe(1_675);
    expect(memberNumberByCustomId.get("U-NONNUMERIC")).toBe(2_001);
    expect(memberNumberByCustomId.get("2000")).toBe(1_800);
    expect(
      memberNumberByCustomId.get("G-0123456789abcdefabcd"),
    ).toBeUndefined();

    await expect(
      migrateUserMemberNumbers({ apply: true }),
    ).resolves.toMatchObject({
      totals: {
        eligible: 0,
        assigned: 0,
        adoptedLegacyCustomIds: 0,
        allocated: 0,
        skippedGeneratedGuests: 1,
        conflicts: 0,
      },
      tenants: [{ counterAfter: 2_001 }],
    });
  });
});
