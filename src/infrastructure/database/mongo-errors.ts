/** Match server error codes across Mongoose and independently installed drivers. */
export const isMongoDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null &&
  "code" in error && error.code === 11000;
