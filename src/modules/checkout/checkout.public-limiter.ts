import rateLimit, { MemoryStore } from "express-rate-limit";

import { assertE2ETestMode } from "@/config/e2e-mode.js";

const publicCommerceMutationStore = new MemoryStore();
const publicTenantLookupStore = new MemoryStore();

/**
 * Protects unauthenticated tenant-commerce mutations. The default IP key
 * generator is IPv6-safe and respects Express's configured trust proxy.
 */
export const publicCommerceMutationLimiter = rateLimit({
  store: publicCommerceMutationStore,
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many checkout requests. Please try again shortly.",
    code: "PUBLIC_COMMERCE_RATE_LIMITED",
  },
});

export const publicTenantLookupLimiter = rateLimit({
  store: publicTenantLookupStore,
  windowMs: 10 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many public workspace requests. Please try again shortly.",
    code: "PUBLIC_TENANT_LOOKUP_RATE_LIMITED",
  },
});

/** Clear these in-memory counters only when the hermetic harness resets its fixtures. */
export const resetPublicCommerceRateLimitsForE2E = async (): Promise<void> => {
  assertE2ETestMode();
  await Promise.all([
    publicCommerceMutationStore.resetAll(),
    publicTenantLookupStore.resetAll(),
  ]);
};
