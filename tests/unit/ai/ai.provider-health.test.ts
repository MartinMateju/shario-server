import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  isConfigured: vi.fn(),
}));

vi.mock("@/modules/ai/ai.models.js", () => ({
  AiRunModel: { aggregate: mocks.aggregate },
}));
vi.mock("@/modules/ai/services/openai.provider.js", () => ({
  isOpenAiConfigured: mocks.isConfigured,
}));

import { getAiProviderHealth } from "@/modules/ai/services/ai-provider-health.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const NOW = new Date("2026-08-13T12:00:00.000Z");

describe("AI provider health service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aggregate.mockResolvedValue([]);
    mocks.isConfigured.mockReturnValue(true);
  });

  it("reports healthy when no provider failures were observed", async () => {
    await expect(
      getAiProviderHealth(TENANT_ID, { now: NOW, windowMinutes: 15 }),
    ).resolves.toMatchObject({
      state: "healthy",
      configured: true,
      windowMinutes: 15,
      terminalAttempts: 0,
      failed: 0,
      refused: 0,
      failureRate: 0,
    });

    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({
      tenant: expect.objectContaining({ _bsontype: "ObjectId" }),
      feature: "studio_assistant",
      completedAt: {
        $gte: new Date("2026-08-13T11:45:00.000Z"),
        $lte: NOW,
      },
    });
    expect(JSON.stringify(pipeline)).not.toContain("structuredResult");
    expect(JSON.stringify(pipeline)).not.toContain("errorMessage");
  });

  it("marks schema and authentication failures unavailable", async () => {
    mocks.aggregate.mockResolvedValueOnce([
      {
        terminalAttempts: 2,
        refused: 0,
        succeeded: 0,
        failed: 2,
        schemaInvalid: 1,
        authenticationFailed: 1,
        rateLimited: 0,
        timedOut: 0,
        upstreamFailed: 0,
        lastFailureAt: NOW,
      },
    ]);

    await expect(
      getAiProviderHealth(TENANT_ID, { now: NOW }),
    ).resolves.toEqual({
      state: "unavailable",
      configured: true,
      windowMinutes: 15,
      since: new Date("2026-08-13T11:45:00.000Z"),
      terminalAttempts: 2,
      succeeded: 0,
      failed: 2,
      refused: 0,
      failureRate: 1,
      failures: {
        schemaInvalid: 1,
        rateLimited: 0,
        timedOut: 0,
        authentication: 1,
        upstream: 0,
      },
      lastFailureAt: NOW,
    });
  });

  it("keeps refusal-only traffic technically healthy", async () => {
    mocks.aggregate.mockResolvedValueOnce([
      {
        terminalAttempts: 3,
        succeeded: 0,
        failed: 0,
        refused: 3,
      },
    ]);

    await expect(
      getAiProviderHealth(TENANT_ID, { now: NOW }),
    ).resolves.toMatchObject({
      state: "healthy",
      configured: true,
      terminalAttempts: 3,
      refused: 3,
      failureRate: 0,
    });
  });

  it("reports an unconfigured provider as unavailable", async () => {
    mocks.isConfigured.mockReturnValue(false);

    await expect(
      getAiProviderHealth(TENANT_ID, { now: NOW }),
    ).resolves.toMatchObject({
      state: "unavailable",
      configured: false,
      terminalAttempts: 0,
    });
  });

  it("does not count healthy deterministic fact answers as provider attempts", async () => {
    await getAiProviderHealth(TENANT_ID, { now: NOW });
    const match = mocks.aggregate.mock.calls[0][0][0].$match;

    expect(match.$or).toEqual([
      {
        provider: "openai",
        status: { $in: ["completed", "refused"] },
      },
      {
        errorCode: {
          $in: [
            "AI_PROVIDER_SCHEMA_INVALID",
            "AI_PROVIDER_RATE_LIMITED",
            "AI_PROVIDER_TIMEOUT",
            "AI_PROVIDER_AUTHENTICATION",
            "AI_PROVIDER_UPSTREAM",
          ],
        },
      },
    ]);
  });
});
