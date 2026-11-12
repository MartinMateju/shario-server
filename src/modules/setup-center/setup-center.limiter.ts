import rateLimit from "express-rate-limit";

/**
 * The Setup Assistant is deterministic and read-only, but building its
 * authoritative snapshot still performs several workspace reads.
 */
export const setupAssistantLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many setup help requests. Please wait one minute.",
    code: "SETUP_ASSISTANT_RATE_LIMITED",
  },
});

export const setupLaunchEventLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many Launch Center events. Please wait one minute.",
    code: "SETUP_EVENT_RATE_LIMITED",
  },
});
