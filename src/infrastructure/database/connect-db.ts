import { setServers } from "node:dns";

import mongoose from "mongoose";

import { logger } from "@/config/logger.js";

const CONNECTION_LISTENERS_REGISTERED = Symbol.for(
  "shario.database.connection-listeners-registered",
);

let connectionPromise: Promise<void> | null = null;

const configureDnsServers = (): void => {
  const configuredDnsServers = process.env.DNS_SERVERS
    ?.split(",")
    .map((server) => server.trim())
    .filter(Boolean);

  if (configuredDnsServers?.length) {
    setServers(configuredDnsServers);
  }
};

const registerConnectionListenersOnce = (): void => {
  const connection = mongoose.connection as typeof mongoose.connection & {
    [CONNECTION_LISTENERS_REGISTERED]?: boolean;
  };

  if (connection[CONNECTION_LISTENERS_REGISTERED]) {
    return;
  }

  Object.defineProperty(connection, CONNECTION_LISTENERS_REGISTERED, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  connection.on("connected", () => {
    logger.info("Successfully connected to MongoDB.");
  });

  connection.on("error", (error: NodeJS.ErrnoException) => {
    logger.error(
      {
        err: error,
        errno: error?.errno,
        code: error?.code,
        syscall: error?.syscall,
      },
      "MongoDB connection error.",
    );
  });

  connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected.");
  });
};

export const connectDB = async (): Promise<void> => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error("MONGO_URI environment variable is not defined.");
  }

  registerConnectionListenersOnce();

  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  if (mongoose.connection.readyState !== 2) {
    configureDnsServers();
  }

  const pendingConnection =
    mongoose.connection.readyState === 2
      ? mongoose.connection.asPromise()
      : mongoose.connect(uri, {
          maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
          minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 2),
          serverSelectionTimeoutMS: 10000,
          socketTimeoutMS: 45000,
        });

  connectionPromise = pendingConnection
    .then(() => undefined)
    .catch((error) => {
      logger.fatal({ err: error }, "Failed to connect to MongoDB.");
      throw error;
    })
    .finally(() => {
      connectionPromise = null;
    });

  return connectionPromise;
};

export const closeDatabaseConnection = async (): Promise<void> => {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.connection.close();
};

export default connectDB;
