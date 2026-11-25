import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export const REDIS_OWNER_KEY = "shario:rollback-rehearsal:owner";
const CLAIM = `
if redis.call('DBSIZE') ~= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;
const VERIFY_EMPTY = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('DBSIZE') ~= 1 then return 0 end
return 1
`;
const RELEASE_EMPTY = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('DBSIZE') ~= 1 then return 0 end
return redis.call('DEL', KEYS[1])
`;

export class RedisIsolationError extends Error {
  constructor(reason) {
    super(`Rollback Redis isolation refused: ${reason}.`);
  }
}

function validateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RedisIsolationError("invalid URL");
  }
  if (
    url.protocol !== "redis:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    Number(url.port) < 1 ||
    Number(url.port) > 65535 ||
    url.pathname !== "/15" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RedisIsolationError(
      "requires an explicit loopback port and database 15",
    );
  }
  return url.href;
}

const createRedis = (url) =>
  new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 1500,
    commandTimeout: 1500,
  });

async function execute(url, script, owner, factory) {
  let client;
  try {
    client = factory(url);
    client.on("error", () => {});
    await client.connect();
    if ((await client.ping()) !== "PONG")
      throw new RedisIsolationError("invalid server response");
    return await client.eval(script, 1, REDIS_OWNER_KEY, owner);
  } catch (error) {
    if (error instanceof RedisIsolationError) throw error;
    throw new RedisIsolationError("server unavailable");
  } finally {
    client?.disconnect();
  }
}

/** Claim an explicitly dedicated, empty database before any fixture or worker starts. */
export async function assertDedicatedRedis(
  { url, ownership },
  factory = createRedis,
) {
  if (ownership !== "isolated-rehearsal")
    throw new RedisIsolationError("explicit dedicated ownership is required");
  const destination = validateUrl(url);
  const owner = randomUUID();
  if ((await execute(destination, CLAIM, owner, factory)) !== 1) {
    throw new RedisIsolationError(
      "database is not empty or belongs to another run; recreate the dedicated Redis instance",
    );
  }
  return {
    owner,
    // Never clear application keys. CI destroys its dedicated service; local
    // operators recreate theirs. Only an otherwise-unused own marker is removed.
    release: async () =>
      (await execute(destination, RELEASE_EMPTY, owner, factory)) === 1,
  };
}

/** Rehearsal fixture reset must verify this condition and skip ordinary FLUSHDB. */
export async function assertOwnedEmptyRedis(
  { url, owner },
  factory = createRedis,
) {
  const destination = validateUrl(url);
  if (typeof owner !== "string" || !/^[a-f0-9-]{36}$/.test(owner))
    throw new RedisIsolationError("invalid owner");
  if ((await execute(destination, VERIFY_EMPTY, owner, factory)) !== 1) {
    throw new RedisIsolationError(
      "fixture database is not exclusively owned and empty",
    );
  }
}
