import rateLimit from "express-rate-limit";

export const workspaceAiMessageLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userInfo = (req as any).userInfo;
    const tenantId = String(userInfo?.tenant || "unknown-tenant");
    const userId = String(
      userInfo?.id || userInfo?.userId || userInfo?._id || "unknown-user",
    );
    return `${tenantId}:${userId}`;
  },
  message: {
    message: "Too many AI assistant messages. Please try again shortly.",
  },
});

export const workspaceAiBriefingLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userInfo = (req as any).userInfo;
    const tenantId = String(userInfo?.tenant || "unknown-tenant");
    const userId = String(
      userInfo?.id || userInfo?.userId || userInfo?._id || "unknown-user",
    );
    return `${tenantId}:${userId}`;
  },
  message: {
    message: "Too many briefing refreshes. Please try again shortly.",
    code: "AI_BRIEFING_RATE_LIMITED",
  },
});

export const publicAiLookupLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many concierge requests. Please try again shortly." },
});

export const publicAiMessageLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many concierge requests. Please try again shortly." },
});
