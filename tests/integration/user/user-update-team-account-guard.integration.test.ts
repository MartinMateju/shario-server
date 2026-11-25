import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import User from "@/modules/user/user.model.js";
import Booking from "@/modules/booking/booking.model.js";
import {
  deleteUser,
  updateUser,
} from "@/modules/user/services/user.write.service.js";
import {
  clearTestDatabase,
} from "../../helpers/mongoMemory.js";

let replica: MongoMemoryReplSet;
const connectTestDatabase = async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
};
const disconnectTestDatabase = async () => {
  await mongoose.disconnect();
  await replica.stop();
};

const tenant = new mongoose.Types.ObjectId();
const tenantId = String(tenant);

const insertUser = async (
  email: string,
  overrides: Record<string, unknown> = {},
) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    tenant,
    tenantRole: "customer",
    platformRole: "none",
    firstname: "Test",
    lastname: "User",
    email,
    active: true,
    customId: `C-${String(_id).slice(-6)}`,
    memberNumber: Math.floor(Math.random() * 1e6),
    ...overrides,
  });
  return _id;
};

const emailOf = async (id: mongoose.Types.ObjectId) =>
  (await User.collection.findOne({ _id: id }))?.email;

describe("PATCH /users service guard for team and platform accounts", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  beforeEach(clearTestDatabase);

  it("refuses to change the login email of a workspace member", async () => {
    const ownerId = await insertUser("owner@example.test", {
      tenantRole: "customer",
    });
    await TenantMembershipModel.collection.insertOne({
      tenant,
      user: ownerId,
      role: "owner",
      status: "active",
    });

    await expect(
      updateUser({
        tenantId,
        input: { id: String(ownerId), email: "attacker@example.test" },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "WORKSPACE_MEMBER_PROFILE_NOT_EDITABLE",
    });
    expect(await emailOf(ownerId)).toBe("owner@example.test");
  });

  it.each([
    ["an owner role without a membership row", { tenantRole: "owner" }],
    ["a staff role without a membership row", { tenantRole: "staff" }],
    ["a platform role", { platformRole: "support" }],
  ])("refuses to edit an account with %s", async (_label, overrides) => {
    const id = await insertUser("team@example.test", overrides);

    await expect(
      updateUser({
        tenantId,
        input: { id: String(id), email: "attacker@example.test" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await emailOf(id)).toBe("team@example.test");
  });

  it("still lets staff edit a plain customer", async () => {
    const id = await insertUser("customer@example.test");

    await updateUser({
      tenantId,
      input: {
        id: String(id),
        email: "new-customer@example.test",
        firstname: "Renamed",
      },
    });

    const stored = await User.collection.findOne({ _id: id });
    expect(stored?.email).toBe("new-customer@example.test");
    expect(stored?.firstname).toBe("Renamed");
    expect(stored?.tenantRole).toBe("customer");
  });
});

describe("DELETE /users service safeguards", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  beforeEach(clearTestDatabase);

  it("refuses to delete a customer with studio credit", async () => {
    const id = await insertUser("credit@example.test", {
      moneyCredits: 12,
      moneyCreditsMinor: 1200,
    });

    await expect(
      deleteUser({ tenantId, id: String(id) }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "CUSTOMER_HAS_OPEN_COMMITMENTS",
    });
    expect(await emailOf(id)).toBe("credit@example.test");
  });

  it("refuses to delete a customer with an upcoming booking", async () => {
    const id = await insertUser("booked@example.test");
    await Booking.collection.insertOne({
      tenant,
      createdBy: id,
      start: new Date(Date.now() + 86_400_000),
      end: new Date(Date.now() + 90_000_000),
      status: "processed",
    });

    await expect(
      deleteUser({ tenantId, id: String(id) }),
    ).rejects.toMatchObject({ code: "CUSTOMER_HAS_OPEN_COMMITMENTS" });
  });

  it("deletes a customer with nothing outstanding", async () => {
    const id = await insertUser("gone@example.test");

    await deleteUser({ tenantId, id: String(id) });

    expect(await User.collection.findOne({ _id: id })).toBeNull();
  });
});
