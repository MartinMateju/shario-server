import mongoose from "mongoose";

import { getRuntimeReadiness } from "./runtime-readiness.js";

export const MONGO_READINESS_TIMEOUT_MS = 1_000;

type Database = NonNullable<typeof mongoose.connection.db>;

let pendingMongoProbe: {
  database: Database;
  result: Promise<boolean>;
} | null = null;

const probeMongo = async (database: Database): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      database.command(
        { ping: 1 },
        {
          readPreference: "primary",
          // Bound server selection, pool checkout and the operation itself.
          timeoutMS: MONGO_READINESS_TIMEOUT_MS,
        },
      ).then((result) => result.ok === 1),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), MONGO_READINESS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // A public readiness response must never include driver errors or a URI.
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const isMongoReady = async (): Promise<boolean> => {
  const database = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !database) return false;

  // Concurrent health requests share one bounded probe instead of filling the
  // connection pool during an outage. Do not cache successful probe results.
  if (pendingMongoProbe?.database !== database) {
    const probe = { database, result: probeMongo(database) };
    pendingMongoProbe = probe;
    void probe.result.finally(() => {
      if (pendingMongoProbe === probe) pendingMongoProbe = null;
    });
  }

  const available = await pendingMongoProbe.result;
  return available && mongoose.connection.readyState === 1 &&
    mongoose.connection.db === database;
};

export const getServiceReadiness = async () => {
  const initialRuntime = getRuntimeReadiness();
  if (!initialRuntime.ready) return initialRuntime;

  const mongoReady = await isMongoReady();
  // Shutdown or a reconnect can begin while the dependency probe is in flight.
  const runtime = getRuntimeReadiness();
  return { ready: runtime.ready && mongoReady, state: runtime.state };
};

// Redis cache failures deliberately fall back to MongoDB. Do not make this
// optional optimization an API traffic gate; queue health needs its own alarm.
