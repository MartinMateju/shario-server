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

const customerAiKey = (req: unknown) => {
  const userInfo = (req as any).userInfo;
  const tenantId = String(userInfo?.tenant || "unknown-tenant");
  const userId = String(
    userInfo?.id || userInfo?.userId || userInfo?._id || "unknown-user",
  );
  return `${tenantId}:${userId}`;
};

// Customer accounts are self-registered and every concierge turn spends the
// studio's shared monthly AI credits, so cap each customer per minute and per
// day.
export const customerAiMessageLimiter = rateLimit({
  windowMs: 60_000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: customerAiKey,
  message: {
    message: "Too many concierge requests. Please try again shortly.",
    code: "AI_CONCIERGE_RATE_LIMITED",
  },
});

export const customerAiDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60_000,
  limit: 60,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: customerAiKey,
  message: {
    message: "Daily concierge limit reached. Please try again tomorrow.",
    code: "AI_CONCIERGE_DAILY_LIMIT_REACHED",
  },
});
