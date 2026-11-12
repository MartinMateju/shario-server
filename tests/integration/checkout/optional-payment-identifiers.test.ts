import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Order } from "@/modules/order/order.model.js";
import { WaitlistEntryModel } from "@/modules/waitlist/waitlist.model.js";

let mongo: MongoMemoryServer;
const tenant = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const courseSession = new mongoose.Types.ObjectId();

describe("Optional payment identifier MongoDB indexes", () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    // Building the real models catches unsupported partial-index expressions.
    await Promise.all([Order.init(), WaitlistEntryModel.init()]);
  }, 60_000);

  beforeEach(async () => {
    await Promise.all([
      Order.collection.deleteMany({}),
      WaitlistEntryModel.collection.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it("allows multiple orders without a usable Stripe session identifier", async () => {
    await Order.collection.insertMany([
      { tenant },
      { tenant },
      { tenant, stripe: { sessionId: null } },
      { tenant, stripe: { sessionId: null } },
      { tenant, stripe: { sessionId: "" } },
      { tenant, stripe: { sessionId: "" } },
    ]);
    expect(await Order.collection.countDocuments()).toBe(6);
  });

  it("rejects a reused Stripe session in the same tenant but allows another tenant", async () => {
    const stripe = { sessionId: "cs_test_index_contract" };
    await Order.collection.insertOne({ tenant, stripe });
    await expect(
      Order.collection.insertOne({ tenant, stripe }),
    ).rejects.toMatchObject({ code: 11000 });
    await Order.collection.insertOne({ tenant: otherTenant, stripe });
    expect(await Order.collection.countDocuments()).toBe(2);
  });

  it("indexes only nonempty offer tokens without imposing an unintended uniqueness rule", async () => {
    const tokens = [undefined, null, "", "offer-token", "offer-token"];
    await WaitlistEntryModel.collection.insertMany(
      tokens.map((token, sequence) => ({
        tenant,
        courseSession,
        sequence,
        isLive: false,
        ...(token === undefined ? {} : { offerTokenHash: token }),
      })),
    );
    const index = (await WaitlistEntryModel.collection.indexes()).find(
      (entry) => entry.name === "waitlist_offer_token_lookup",
    );
    expect(index?.partialFilterExpression).toEqual({
      offerTokenHash: { $type: "string", $gt: "" },
    });
    expect(index?.unique).not.toBe(true);
    const indexed = await WaitlistEntryModel.collection
      .find({ tenant, offerTokenHash: "offer-token" })
      .hint("waitlist_offer_token_lookup")
      .toArray();
    expect(indexed).toHaveLength(2);
  });
});
