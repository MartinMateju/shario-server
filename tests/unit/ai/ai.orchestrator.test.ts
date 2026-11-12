import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEntitlement: vi.fn(),
  isConfigured: vi.fn(),
  createStructuredResponse: vi.fn(),
  reserveCredits: vi.fn(),
  settleCredits: vi.fn(),
  releaseCredits: vi.fn(),
  runFindOne: vi.fn(),
  runFindOneAndUpdate: vi.fn(),
  runCreate: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/modules/ai/services/ai-access.service.js", () => ({
  requireAiEntitlement: mocks.requireEntitlement,
}));

vi.mock("@/modules/ai/services/openai.provider.js", () => ({
  isOpenAiConfigured: mocks.isConfigured,
  createStructuredResponse: mocks.createStructuredResponse,
}));

vi.mock("@/modules/ai/services/ai-usage.service.js", () => ({
  reserveAiCredits: mocks.reserveCredits,
  settleAiCredits: mocks.settleCredits,
  releaseAiCredits: mocks.releaseCredits,
}));

vi.mock("@/modules/ai/ai.models.js", () => ({
  AiRunModel: {
    findOne: mocks.runFindOne,
    findOneAndUpdate: mocks.runFindOneAndUpdate,
    create: mocks.runCreate,
  },
}));

vi.mock("@/config/logger.js", () => ({
  logger: { warn: mocks.loggerWarn, error: mocks.loggerError },
}));

import {
  classifyAiProviderFailure,
  createAiIdempotencyKey,
  executeStructuredAi,
} from "@/modules/ai/services/ai-orchestrator.service.js";
import {
  AI_AUDIENCE,
  AI_FEATURE,
  AI_RUN_STATUS,
} from "@/modules/ai/ai.constants.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";
const RUN_ID = "507f1f77bcf86cd799439014";
const RESERVATION_ID = "507f1f77bcf86cd799439015";

const schema = z.object({ answer: z.string() }).strict();
const context = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  audience: AI_AUDIENCE.WORKSPACE,
  locationId: LOCATION_ID,
  locale: "en",
};

const findQuery = (value: unknown) => ({
  select: vi.fn().mockResolvedValue(value),
});

const buildRun = (overrides: Record<string, any> = {}) => {
  const run: Record<string, any> = {
    _id: RUN_ID,
    tenant: TENANT_ID,
    actor: USER_ID,
    audience: AI_AUDIENCE.WORKSPACE,
    feature: AI_FEATURE.STUDIO_ASSISTANT,
    status: AI_RUN_STATUS.PENDING,
    promptVersion: "assistant-v1",
    provider: "openai",
    model: "test-model",
    idempotencyKey: "assistant:request-1",
    structuredResult: null,
    usage: {},
    save: vi.fn(),
    ...overrides,
  };
  run.save.mockImplementation(async () => run);
  return run;
};

const execute = (overrides: Record<string, unknown> = {}) =>
  executeStructuredAi({
    context,
    feature: AI_FEATURE.STUDIO_ASSISTANT,
    promptVersion: "assistant-v1",
    idempotencyKey: "assistant:request-1",
    instructions: "Answer from trusted tools and untrusted studio context.",
    input: "What needs attention today?",
    schema,
    schemaName: "assistant_output",
    fallback: () => ({ answer: "Assistant is temporarily unavailable." }),
    sourceIds: ["article-1"],
    ...overrides,
  });

describe("AI structured orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireEntitlement.mockResolvedValue({ canUseAi: true });
    mocks.isConfigured.mockReturnValue(false);
    mocks.runFindOne.mockReturnValue(findQuery(null));
    mocks.runFindOneAndUpdate.mockReturnValue(findQuery(null));
    mocks.reserveCredits.mockResolvedValue({
      _id: RESERVATION_ID,
      reservedCredits: 10,
    });
    mocks.settleCredits.mockResolvedValue({ settledCredits: 2 });
    mocks.releaseCredits.mockResolvedValue({ status: "released" });
  });

  it("builds bounded idempotency keys", () => {
    expect(createAiIdempotencyKey("assistant", "stable")).toBe(
      "assistant:stable",
    );
    expect(
      createAiIdempotencyKey("x".repeat(250), "y".repeat(250)),
    ).toHaveLength(300);
  });

  it.each([
    ["OpenAI status 400 (code=invalid_json_schema, param=text.format.schema)", "AI_PROVIDER_SCHEMA_INVALID"],
    ["OpenAI strict JSON schema must have an object at its root.", "AI_PROVIDER_SCHEMA_INVALID"],
    ["OpenAI request failed with status 429", "AI_PROVIDER_RATE_LIMITED"],
    ["The provider request timed out", "AI_PROVIDER_TIMEOUT"],
    ["OpenAI request failed with status 401", "AI_PROVIDER_AUTHENTICATION"],
    ["socket closed unexpectedly", "AI_PROVIDER_UPSTREAM"],
  ])("classifies provider failures without exposing raw errors", (message, expected) => {
    expect(classifyAiProviderFailure(new Error(message))).toBe(expected);
  });

  it("prefers typed provider metadata when classifying failures", () => {
    expect(
      classifyAiProviderFailure(
        Object.assign(new Error("request failed"), { status: 429 }),
      ),
    ).toBe("AI_PROVIDER_RATE_LIMITED");
    expect(
      classifyAiProviderFailure(
        Object.assign(new Error("request failed"), {
          providerCode: "invalid_json_schema",
        }),
      ),
    ).toBe("AI_PROVIDER_SCHEMA_INVALID");
  });

  it("checks feature entitlement before reading or creating a run", async () => {
    const denied = Object.assign(new Error("disabled"), {
      statusCode: 403,
      code: "AI_FEATURE_DISABLED",
    });
    mocks.requireEntitlement.mockRejectedValueOnce(denied);

    await expect(execute()).rejects.toBe(denied);
    expect(mocks.requireEntitlement).toHaveBeenCalledWith(
      TENANT_ID,
      "assistantEnabled",
    );
    expect(mocks.runFindOne).not.toHaveBeenCalled();
    expect(mocks.reserveCredits).not.toHaveBeenCalled();
  });

  it("uses and persists deterministic fallback without spending credits when OpenAI is absent", async () => {
    const run = buildRun();
    mocks.runCreate.mockResolvedValueOnce(run);

    await expect(execute()).resolves.toEqual({
      value: { answer: "Assistant is temporarily unavailable." },
      runId: RUN_ID,
      provider: "deterministic",
      model: "deterministic-v1",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      credits: 0,
    });

    expect(mocks.runCreate).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      actor: USER_ID,
      audience: AI_AUDIENCE.WORKSPACE,
      feature: AI_FEATURE.STUDIO_ASSISTANT,
      promptVersion: "assistant-v1",
      provider: "deterministic",
      model: expect.any(String),
      idempotencyKey: "assistant:request-1",
      locationId: LOCATION_ID,
      sourceIds: ["article-1"],
    });
    expect(run).toMatchObject({
      status: AI_RUN_STATUS.FALLBACK,
      provider: "deterministic",
      model: "deterministic-v1",
      structuredResult: { answer: "Assistant is temporarily unavailable." },
      completedAt: expect.any(Date),
    });
    expect(mocks.reserveCredits).not.toHaveBeenCalled();
  });

  it("returns a verified workspace fact without asking the model or spending credits", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    mocks.runCreate.mockResolvedValueOnce(run);

    await expect(
      execute({
        deterministicValue: { answer: "There are 4 bookings tomorrow." },
        metadata: {
          studioContext: {
            version: "studio-context-v1",
            profile: "full",
            availableSources: ["studio", "operations"],
          },
        },
      }),
    ).resolves.toMatchObject({
      value: { answer: "There are 4 bookings tomorrow." },
      provider: "deterministic",
      model: "verified-workspace-facts-v1",
      credits: 0,
    });

    expect(mocks.createStructuredResponse).not.toHaveBeenCalled();
    expect(mocks.reserveCredits).not.toHaveBeenCalled();
    expect(mocks.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          studioContext: {
            version: "studio-context-v1",
            profile: "full",
            availableSources: ["studio", "operations"],
          },
        },
      }),
    );
    expect(run).toMatchObject({
      status: AI_RUN_STATUS.FALLBACK,
      provider: "deterministic",
      model: "verified-workspace-facts-v1",
      structuredResult: { answer: "There are 4 bookings tomorrow." },
    });
  });

  it.each([
    AI_RUN_STATUS.FALLBACK,
    AI_RUN_STATUS.REFUSED,
  ])("reclaims an incomplete %s run instead of poisoning its idempotency key", async (status) => {
    mocks.isConfigured.mockReturnValue(false);
    const incomplete = buildRun({
      status,
      structuredResult: null,
      completedAt: new Date(),
    });
    const reclaimed = buildRun({ status: AI_RUN_STATUS.PENDING });
    mocks.runFindOne.mockReturnValueOnce(findQuery(incomplete));
    mocks.runFindOneAndUpdate.mockReturnValueOnce(findQuery(reclaimed));

    await expect(execute()).resolves.toMatchObject({
      value: { answer: "Assistant is temporarily unavailable." },
      provider: "deterministic",
    });

    expect(mocks.runFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: RUN_ID,
        tenant: TENANT_ID,
        status,
        structuredResult: { $in: [null, undefined] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AI_RUN_STATUS.PENDING,
          errorCode: "",
          errorMessage: "",
          providerResponseId: "",
          outputSummary: "",
          usage: {},
        }),
        $unset: { completedAt: 1, structuredResult: 1 },
      }),
      { returnDocument: "after" },
    );
  });

  it("replays a completed tenant-scoped run without another provider call or charge", async () => {
    const run = buildRun({
      status: AI_RUN_STATUS.COMPLETED,
      provider: "openai",
      structuredResult: { answer: "Stored answer" },
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        settledCredits: 1,
      },
    });
    mocks.runFindOne.mockReturnValueOnce(findQuery(run));

    await expect(execute()).resolves.toMatchObject({
      value: { answer: "Stored answer" },
      runId: RUN_ID,
      provider: "openai",
      credits: 1,
    });
    expect(mocks.runFindOne).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      idempotencyKey: "assistant:request-1",
    });
    expect(mocks.runCreate).not.toHaveBeenCalled();
    expect(mocks.createStructuredResponse).not.toHaveBeenCalled();
    expect(mocks.reserveCredits).not.toHaveBeenCalled();
  });

  it("rejects a duplicate request whose canonical run is still pending", async () => {
    mocks.runFindOne.mockReturnValueOnce(findQuery(buildRun()));

    await expect(execute()).rejects.toMatchObject({
      statusCode: 409,
      code: "AI_REQUEST_IN_PROGRESS",
      details: { runId: RUN_ID },
    });
    expect(mocks.reserveCredits).not.toHaveBeenCalled();
  });

  it("refreshes Studio Context provenance when reclaiming a stale run", async () => {
    const staleRun = buildRun({ updatedAt: new Date("2026-01-01T00:00:00Z") });
    const reclaimedRun = buildRun({ updatedAt: new Date() });
    const metadata = {
      studioContext: {
        version: "studio-context-v1",
        profile: "full",
        availableSources: ["studio", "operations"],
      },
    };
    mocks.runFindOne.mockReturnValueOnce(findQuery(staleRun));
    mocks.runFindOneAndUpdate.mockReturnValueOnce(findQuery(reclaimedRun));

    await expect(execute({ metadata })).resolves.toMatchObject({
      provider: "deterministic",
    });

    expect(mocks.runFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: RUN_ID,
        tenant: TENANT_ID,
        status: AI_RUN_STATUS.PENDING,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ metadata }),
      }),
      { returnDocument: "after" },
    );
  });

  it("reserves, invokes, persists and settles one successful provider run", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    mocks.runCreate.mockResolvedValueOnce(run);
    mocks.createStructuredResponse.mockResolvedValueOnce({
      value: { answer: "Provider answer" },
      model: "provider-model",
      responseId: "resp_123",
      usage: { inputTokens: 1_100, outputTokens: 200, totalTokens: 1_300 },
      refusal: null,
    });

    await expect(execute()).resolves.toMatchObject({
      value: { answer: "Provider answer" },
      provider: "openai",
      model: "provider-model",
      credits: 2,
    });

    expect(mocks.reserveCredits).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      actorId: USER_ID,
      feature: AI_FEATURE.STUDIO_ASSISTANT,
      idempotencyKey: "usage:assistant:request-1",
      credits: 10,
    });
    expect(mocks.createStructuredResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: expect.any(String),
        input: "What needs attention today?",
        schema,
        schemaName: "assistant_output",
      }),
    );
    expect(mocks.settleCredits).toHaveBeenCalledWith({
      reservationId: RESERVATION_ID,
      usage: { inputTokens: 1_100, outputTokens: 200, totalTokens: 1_300 },
      model: "provider-model",
      runId: RUN_ID,
    });
    expect(mocks.releaseCredits).not.toHaveBeenCalled();
    expect(run).toMatchObject({
      status: AI_RUN_STATUS.COMPLETED,
      provider: "openai",
      model: "provider-model",
      providerResponseId: "resp_123",
      structuredResult: { answer: "Provider answer" },
      usage: expect.objectContaining({ settledCredits: 2 }),
    });
  });

  it("settles refused provider usage and returns a safe deterministic value", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    mocks.runCreate.mockResolvedValueOnce(run);
    mocks.createStructuredResponse.mockResolvedValueOnce({
      value: null,
      model: "provider-model",
      responseId: "resp_refused",
      usage: { inputTokens: 300, outputTokens: 0, totalTokens: 300 },
      refusal: "Request refused.",
    });

    await expect(execute()).resolves.toMatchObject({
      value: { answer: "Assistant is temporarily unavailable." },
      provider: "deterministic",
      credits: 2,
    });
    expect(run).toMatchObject({
      status: AI_RUN_STATUS.REFUSED,
      refusal: "Request refused.",
      structuredResult: { answer: "Assistant is temporarily unavailable." },
    });
    expect(mocks.settleCredits).toHaveBeenCalledTimes(1);
    expect(mocks.releaseCredits).not.toHaveBeenCalled();
  });

  it("does not misclassify persistence failures after a successful provider response", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    run.save.mockRejectedValueOnce(new Error("database unavailable"));
    mocks.runCreate.mockResolvedValueOnce(run);
    mocks.createStructuredResponse.mockResolvedValueOnce({
      value: { answer: "Provider answer" },
      model: "provider-model",
      responseId: "resp_123",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      refusal: null,
    });

    await expect(execute()).rejects.toThrow("database unavailable");

    expect(run.errorCode).toBeUndefined();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        feature: AI_FEATURE.STUDIO_ASSISTANT,
        runId: RUN_ID,
      }),
      "AI orchestration failed after a provider response.",
    );
  });

  it("releases reserved credits when provider failure persistence fails", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    run.save.mockRejectedValueOnce(new Error("database unavailable"));
    mocks.runCreate.mockResolvedValueOnce(run);
    mocks.createStructuredResponse.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );

    await expect(execute()).rejects.toThrow("database unavailable");

    expect(mocks.releaseCredits).toHaveBeenCalledWith(RESERVATION_ID);
    expect(run).toMatchObject({
      status: AI_RUN_STATUS.FALLBACK,
      errorCode: "AI_PROVIDER_UPSTREAM",
    });
  });

  it("records provider failure even when credit cleanup fails", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    mocks.runCreate.mockResolvedValueOnce(run);
    mocks.createStructuredResponse.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    mocks.releaseCredits.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(execute()).resolves.toMatchObject({
      fallbackReason: "AI_PROVIDER_UPSTREAM",
    });
    expect(run).toMatchObject({
      status: AI_RUN_STATUS.FALLBACK,
      errorCode: "AI_PROVIDER_UPSTREAM",
      completedAt: expect.any(Date),
    });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        feature: AI_FEATURE.STUDIO_ASSISTANT,
        runId: RUN_ID,
      }),
      "AI credit reservation cleanup failed.",
    );
  });

  it("records provider failure before a fallback construction error", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    mocks.runCreate.mockResolvedValueOnce(run);
    mocks.createStructuredResponse.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );

    await expect(
      execute({
        fallback: async () => {
          throw new Error("fallback failed");
        },
      }),
    ).rejects.toThrow("fallback failed");

    expect(run).toMatchObject({
      status: AI_RUN_STATUS.FALLBACK,
      errorCode: "AI_PROVIDER_UPSTREAM",
      completedAt: expect.any(Date),
    });
    expect(run.save).toHaveBeenCalled();
  });

  it("emits a high-severity structured alert for schema failures", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    mocks.runCreate.mockResolvedValueOnce(run);
    mocks.createStructuredResponse.mockRejectedValueOnce(
      new Error("OpenAI status 400 (code=invalid_json_schema, param=text.format.schema)"),
    );

    await expect(execute()).resolves.toMatchObject({
      fallbackReason: "AI_PROVIDER_SCHEMA_INVALID",
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        feature: AI_FEATURE.STUDIO_ASSISTANT,
        runId: RUN_ID,
        failureCode: "AI_PROVIDER_SCHEMA_INVALID",
      }),
      "AI provider request failed; deterministic fallback used.",
    );
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("releases credits and records a bounded provider failure before fallback", async () => {
    mocks.isConfigured.mockReturnValue(true);
    const run = buildRun();
    mocks.runCreate.mockResolvedValueOnce(run);
    mocks.createStructuredResponse.mockRejectedValueOnce(
      new Error(`provider unavailable\n${"x".repeat(3_000)}`),
    );

    await expect(execute()).resolves.toMatchObject({
      value: { answer: "Assistant is temporarily unavailable." },
      provider: "deterministic",
      credits: 0,
      fallbackReason: "AI_PROVIDER_UPSTREAM",
    });
    expect(mocks.releaseCredits).toHaveBeenCalledWith(RESERVATION_ID);
    expect(mocks.settleCredits).not.toHaveBeenCalled();
    expect(run).toMatchObject({
      status: AI_RUN_STATUS.FALLBACK,
      provider: "deterministic",
      errorCode: "AI_PROVIDER_UPSTREAM",
      completedAt: expect.any(Date),
    });
    expect(run.errorMessage.length).toBeLessThanOrEqual(2_000);
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
  });
});
