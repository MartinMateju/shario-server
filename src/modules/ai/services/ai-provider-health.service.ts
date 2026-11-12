import { Types } from "mongoose";

import { AI_FEATURE } from "../ai.constants.js";
import { AiRunModel } from "../ai.models.js";
import { isOpenAiConfigured } from "./openai.provider.js";

export const AI_PROVIDER_FAILURE_CODES = [
  "AI_PROVIDER_SCHEMA_INVALID",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_PROVIDER_TIMEOUT",
  "AI_PROVIDER_AUTHENTICATION",
  "AI_PROVIDER_UPSTREAM",
] as const;

type ProviderHealthState = "healthy" | "degraded" | "unavailable";

export const getAiProviderHealth = async (
  tenantId: string,
  { now = new Date(), windowMinutes = 15 } = {},
) => {
  const boundedWindowMinutes = Math.min(Math.max(windowMinutes, 5), 60);
  const configured = isOpenAiConfigured();
  const since = new Date(now.getTime() - boundedWindowMinutes * 60_000);
  const rows = await AiRunModel.aggregate([
    {
      $match: {
        tenant: new Types.ObjectId(tenantId),
        feature: AI_FEATURE.STUDIO_ASSISTANT,
        completedAt: { $gte: since, $lte: now },
        $or: [
          {
            provider: "openai",
            status: { $in: ["completed", "refused"] },
          },
          { errorCode: { $in: AI_PROVIDER_FAILURE_CODES } },
        ],
      },
    },
    {
      $group: {
        _id: null,
        terminalAttempts: {
          $sum: {
            $cond: [
              {
                $or: [
                  {
                    $and: [
                      { $eq: ["$provider", "openai"] },
                      {
                        $in: [
                          "$status",
                          ["completed", "refused", "fallback", "failed"],
                        ],
                      },
                    ],
                  },
                  { $in: ["$errorCode", AI_PROVIDER_FAILURE_CODES] },
                ],
              },
              1,
              0,
            ],
          },
        },
        succeeded: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$provider", "openai"] },
                  { $eq: ["$status", "completed"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        failed: {
          $sum: {
            $cond: [
              { $in: ["$errorCode", AI_PROVIDER_FAILURE_CODES] },
              1,
              0,
            ],
          },
        },
        refused: {
          $sum: {
            $cond: [{ $eq: ["$status", "refused"] }, 1, 0],
          },
        },
        schemaInvalid: {
          $sum: {
            $cond: [{ $eq: ["$errorCode", "AI_PROVIDER_SCHEMA_INVALID"] }, 1, 0],
          },
        },
        rateLimited: {
          $sum: {
            $cond: [{ $eq: ["$errorCode", "AI_PROVIDER_RATE_LIMITED"] }, 1, 0],
          },
        },
        timedOut: {
          $sum: {
            $cond: [{ $eq: ["$errorCode", "AI_PROVIDER_TIMEOUT"] }, 1, 0],
          },
        },
        authenticationFailed: {
          $sum: {
            $cond: [
              { $eq: ["$errorCode", "AI_PROVIDER_AUTHENTICATION"] },
              1,
              0,
            ],
          },
        },
        upstreamFailed: {
          $sum: {
            $cond: [{ $eq: ["$errorCode", "AI_PROVIDER_UPSTREAM"] }, 1, 0],
          },
        },
        lastFailureAt: {
          $max: {
            $cond: [
              { $in: ["$errorCode", AI_PROVIDER_FAILURE_CODES] },
              "$completedAt",
              null,
            ],
          },
        },
      },
    },
  ]);

  const counts = rows[0] || {};
  const terminalAttempts = Number(counts.terminalAttempts || 0);
  const failed = Number(counts.failed || 0);
  const refused = Number(counts.refused || 0);
  const failureRate =
    terminalAttempts > 0 ? failed / terminalAttempts : 0;
  const hardFailure =
    Number(counts.schemaInvalid || 0) > 0 ||
    Number(counts.authenticationFailed || 0) > 0;
  const state: ProviderHealthState = !configured
    ? "unavailable"
    : hardFailure || (terminalAttempts >= 3 && failureRate >= 0.8)
      ? "unavailable"
      : failed > 0
        ? "degraded"
        : "healthy";

  return {
    state,
    configured,
    windowMinutes: boundedWindowMinutes,
    since,
    terminalAttempts,
    succeeded: Number(counts.succeeded || 0),
    failed,
    refused,
    failureRate: Number(failureRate.toFixed(4)),
    failures: {
      schemaInvalid: Number(counts.schemaInvalid || 0),
      rateLimited: Number(counts.rateLimited || 0),
      timedOut: Number(counts.timedOut || 0),
      authentication: Number(counts.authenticationFailed || 0),
      upstream: Number(counts.upstreamFailed || 0),
    },
    lastFailureAt: counts.lastFailureAt || null,
  };
};

export const aiProviderHealthService = {
  get: getAiProviderHealth,
};
