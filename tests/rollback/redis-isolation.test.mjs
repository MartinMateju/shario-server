import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertDedicatedRedis,
  assertOwnedEmptyRedis,
  REDIS_OWNER_KEY,
} from "./redis-isolation.mjs";

const url = "redis://127.0.0.1:6379/15";
function fixture() {
  const keys = new Map();
  const commands = [];
  const connections = [];
  const factory = (destination) => {
    assert.equal(destination, url);
    const client = {
      closed: false,
      on: () => {},
      connect: async () => {},
      ping: async () => "PONG",
      eval: async (script, count, key, owner) => {
        commands.push(script);
        assert.equal(count, 1);
        assert.equal(key, REDIS_OWNER_KEY);
        assert.ok(!/FLUSH/i.test(script), "never flush a database");
        // Redis executes the script atomically; model each command as one
        // synchronous state transition so competing claims cannot both win.
        if (script.includes("'SET'")) {
          if (keys.size !== 0) return 0;
          keys.set(key, owner);
          return 1;
        }
        if (keys.get(key) !== owner || keys.size !== 1) return 0;
        if (script.includes("'DEL'")) keys.delete(key);
        return 1;
      },
      disconnect: () => {
        client.closed = true;
      },
    };
    connections.push(client);
    return client;
  };
  return { factory, keys, commands, connections };
}

test("requires explicit dedicated ownership and a credential-free loopback database 15", async () => {
  const factory = () => {
    throw new Error("must not connect");
  };
  await assert.rejects(
    assertDedicatedRedis({ url }, factory),
    /explicit dedicated ownership/,
  );
  for (const destination of [
    "redis://production.example:6379/15",
    "redis://localhost:6379/15",
    "redis://127.0.0.1:6379/0",
    "redis://127.0.0.1/15",
    "redis://user:password@127.0.0.1:6379/15",
    "redis://127.0.0.1:6379/15?db=0",
    "redis://127.0.0.1:6379/15#other",
    "not-a-url",
  ]) {
    await assert.rejects(
      assertDedicatedRedis(
        { url: destination, ownership: "isolated-rehearsal" },
        factory,
      ),
      /Redis isolation refused/,
    );
  }
});

test("claims empty Redis atomically and permits only the winning owner to seed", async () => {
  const { factory, keys, connections } = fixture();
  const results = await Promise.allSettled([
    assertDedicatedRedis({ url, ownership: "isolated-rehearsal" }, factory),
    assertDedicatedRedis({ url, ownership: "isolated-rehearsal" }, factory),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const claim = results.find((result) => result.status === "fulfilled").value;
  assert.equal(keys.get(REDIS_OWNER_KEY), claim.owner);
  await assertOwnedEmptyRedis({ url, owner: claim.owner }, factory);
  await assert.rejects(
    assertOwnedEmptyRedis({ url, owner: "f".repeat(36) }, factory),
    /not exclusively owned/,
  );
  assert.ok(connections.every((client) => client.closed));
});

test("nonempty databases and foreign jobs remain untouched", async () => {
  const { factory, keys } = fixture();
  keys.set("bull:communication-emails:foreign-job", "preserve-me");
  await assert.rejects(
    assertDedicatedRedis({ url, ownership: "isolated-rehearsal" }, factory),
    /database is not empty/,
  );
  assert.deepEqual(
    [...keys],
    [["bull:communication-emails:foreign-job", "preserve-me"]],
  );
});

test("cleanup removes only an otherwise-unused own marker, preserving foreign markers and all job data", async () => {
  const { factory, keys } = fixture();
  const claim = await assertDedicatedRedis(
    { url, ownership: "isolated-rehearsal" },
    factory,
  );
  keys.set("bull:communication-emails:job", "preserve-job");
  await assert.rejects(
    assertOwnedEmptyRedis({ url, owner: claim.owner }, factory),
    /not exclusively owned/,
  );
  assert.equal(await claim.release(), false);
  assert.equal(keys.get("bull:communication-emails:job"), "preserve-job");
  keys.delete("bull:communication-emails:job");
  keys.set(REDIS_OWNER_KEY, "different-owner");
  assert.equal(await claim.release(), false);
  assert.equal(keys.get(REDIS_OWNER_KEY), "different-owner");
  keys.set(REDIS_OWNER_KEY, claim.owner);
  assert.equal(await claim.release(), true);
  assert.equal(keys.size, 0);
});

test("connection failures close the client and expose no endpoint credentials or provider details", async () => {
  let closed = false;
  await assert.rejects(
    assertDedicatedRedis({ url, ownership: "isolated-rehearsal" }, () => ({
      on: () => {},
      connect: async () => {
        throw new Error("private-provider-message");
      },
      disconnect: () => {
        closed = true;
      },
    })),
    (error) =>
      error.message.includes("server unavailable") &&
      !error.message.includes("private-provider-message"),
  );
  assert.equal(closed, true);
});
