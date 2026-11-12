import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmbedding,
  createStructuredResponse,
  isOpenAiConfigured,
  moderateText,
} from "@/modules/ai/services/openai.provider.js";

const outputSchema = z.object({
  answer: z.string().min(1),
  count: z.number().int().nonnegative(),
}).strict();

const responseBody = (overrides: Record<string, unknown> = {}) => ({
  id: "resp_123",
  model: "test-model-2026-07-23",
  status: "completed",
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({ answer: "Everything is ready.", count: 2 }),
        },
      ],
    },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    total_tokens: 150,
  },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("OpenAI provider adapter", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://openai.example.test/v1/");
    vi.stubEnv("OPENAI_MAX_RETRIES", "0");
    vi.stubEnv("OPENAI_TIMEOUT_MS", "3000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fails before network access when the API key is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(isOpenAiConfigured()).toBe(false);
    await expect(
      createStructuredResponse({
        instructions: "Return a bounded result.",
        input: "Hello",
        schema: outputSchema,
        schemaName: "test-output",
      }),
    ).rejects.toThrow("OPENAI_API_KEY is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a non-stored strict Responses API request and parses usage", async () => {
    vi.stubEnv("OPENAI_PROJECT", "project-test");
    vi.stubEnv("OPENAI_ORGANIZATION", "org-test");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(responseBody()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createStructuredResponse({
        instructions: "Return studio status.",
        input: "Summarize today.",
        schema: outputSchema,
        schemaName: "studio status / unsafe chars",
        model: "test-model",
        maxOutputTokens: 500,
      }),
    ).resolves.toEqual({
      value: { answer: "Everything is ready.", count: 2 },
      model: "test-model-2026-07-23",
      responseId: "resp_123",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      refusal: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openai.example.test/v1/responses");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-openai-key",
      "content-type": "application/json",
      "openai-project": "project-test",
      "openai-organization": "org-test",
    });

    const request = JSON.parse(String(init.body));
    expect(request).toMatchObject({
      model: "test-model",
      instructions: "Return studio status.",
      input: "Summarize today.",
      max_output_tokens: 500,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "studio_status___unsafe_chars",
          strict: true,
        },
      },
    });
    expect(request.text.format.schema).toBeDefined();
  });

  it("rejects optional strict-schema fields before making a provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalidSchema = z.object({
      answer: z.string(),
      optionalNote: z.string().optional(),
    }).strict();

    await expect(
      createStructuredResponse({
        instructions: "Return output.",
        input: "Input",
        schema: invalidSchema,
        schemaName: "invalid-test",
      }),
    ).rejects.toThrow(
      "every property must be required; missing optionalNote",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported schema composition before making a provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalidSchema = z
      .object({
        action: z.discriminatedUnion("key", [
          z.object({ key: z.literal("create"), title: z.string() }).strict(),
          z.object({ key: z.literal("complete"), id: z.string() }).strict(),
        ]),
      })
      .strict();

    await expect(
      createStructuredResponse({
        instructions: "Return output.",
        input: "Input",
        schema: invalidSchema,
        schemaName: "invalid-composition-test",
      }),
    ).rejects.toThrow("unsupported keyword oneOf");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a provider refusal without trying to parse an answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        responseBody({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "refusal",
                  refusal: "I cannot assist with that request.",
                },
              ],
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createStructuredResponse({
        instructions: "Return output.",
        input: "Unsafe request",
        schema: outputSchema,
        schemaName: "test",
      }),
    ).resolves.toMatchObject({
      value: null,
      refusal: "I cannot assist with that request.",
      usage: { totalTokens: 150 },
    });
  });

  it("rejects incomplete, empty, malformed JSON and schema-invalid output", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        responseBody({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    );
    await expect(
      createStructuredResponse({
        instructions: "Return output.",
        input: "Input",
        schema: outputSchema,
        schemaName: "test",
      }),
    ).rejects.toThrow("OpenAI response was incomplete: max_output_tokens");

    fetchMock.mockResolvedValueOnce(
      jsonResponse(responseBody({ output: [] })),
    );
    await expect(
      createStructuredResponse({
        instructions: "Return output.",
        input: "Input",
        schema: outputSchema,
        schemaName: "test",
      }),
    ).rejects.toThrow("did not contain output text");

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        responseBody({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "not-json" }],
            },
          ],
        }),
      ),
    );
    await expect(
      createStructuredResponse({
        instructions: "Return output.",
        input: "Input",
        schema: outputSchema,
        schemaName: "test",
      }),
    ).rejects.toThrow("structured response was not valid JSON");

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        responseBody({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ answer: "Missing count" }),
                },
              ],
            },
          ],
        }),
      ),
    );
    const schemaError = await createStructuredResponse({
      instructions: "Return output.",
      input: "Input",
      schema: outputSchema,
      schemaName: "test",
    }).catch((error) => error);
    expect(schemaError).toBeInstanceOf(Error);
    expect(schemaError).not.toBeInstanceOf(z.ZodError);
    expect(schemaError.message).toBe(
      "OpenAI structured response did not match the required schema.",
    );
    expect(JSON.stringify(schemaError)).not.toContain("Missing count");
  });

  it("does not retry a permanent provider rejection", async () => {
    vi.stubEnv("OPENAI_MAX_RETRIES", "4");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "Invalid schema containing sensitive echoed input.",
            type: "invalid_request_error",
            code: "invalid_json_schema",
            param: "text.format.schema",
          },
        },
        400,
        { "x-request-id": "req_bad_schema" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const providerError = await createStructuredResponse({
        instructions: "Return output.",
        input: "Input",
        schema: outputSchema,
        schemaName: "test",
      }).catch((error) => error);

    expect(providerError).toMatchObject({
      status: 400,
      providerType: "invalid_request_error",
      providerCode: "invalid_json_schema",
      providerParam: "text.format.schema",
    });
    expect(providerError.message).toContain("request=req_bad_schema");
    expect(providerError.message).not.toContain("sensitive echoed input");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient provider response and then succeeds", async () => {
    vi.stubEnv("OPENAI_MAX_RETRIES", "1");
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503))
      .mockResolvedValueOnce(jsonResponse(responseBody()));
    vi.stubGlobal("fetch", fetchMock);

    const result = createStructuredResponse({
      instructions: "Return output.",
      input: "Input",
      schema: outputSchema,
      schemaName: "test",
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      value: { answer: "Everything is ready.", count: 2 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a malformed embedding vector", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "embedding-model",
        data: [{ embedding: [0.2, "bad", 0.4] }],
        usage: { prompt_tokens: 4 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createEmbedding("Studio policy")).rejects.toThrow(
      "embedding response was invalid",
    );
  });

  it("does not call moderation when OpenAI is intentionally unconfigured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(moderateText("A normal studio question")).resolves.toEqual({
      flagged: false,
      categories: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes malformed usage counters to finite non-negative values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        responseBody({
          usage: {
            input_tokens: "invalid",
            output_tokens: -10,
            total_tokens: "also-invalid",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createStructuredResponse({
      instructions: "Return output.",
      input: "Input",
      schema: outputSchema,
      schemaName: "test",
    });

    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(Object.values(result.usage).every(Number.isFinite)).toBe(true);
  });
});
