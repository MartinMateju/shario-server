import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  consumeSessionHandoff,
  createSessionHandoff,
  isSessionHandoffConfigured,
} from "@/modules/auth/auth-session-handoff.js";

const NOW = 1_786_000_000_000;
const SECRET = "handoff-secret-with-at-least-thirty-two-bytes";
const REFRESH_TOKEN = `refresh.${"sensitive".repeat(16)}.token`;

describe("sealed custom-domain session handoffs", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_SESSION_HANDOFF_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.AUTH_SESSION_HANDOFF_SECRET;
  });

  it("round-trips an origin-bound customer refresh credential without exposing it", () => {
    const handoff = createSessionHandoff({
      refreshToken: REFRESH_TOKEN,
      authContext: "customer",
      origin: "https://studio.example",
      now: NOW,
    });

    expect(handoff).toMatch(
      /^v1\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+$/,
    );
    expect(handoff).not.toContain(REFRESH_TOKEN);
    expect(consumeSessionHandoff(handoff, NOW + 1_000)).toEqual({
      refreshToken: REFRESH_TOKEN,
      authContext: "customer",
      origin: "https://studio.example",
    });
  });

  it("creates different ciphertext for identical session inputs", () => {
    const input = {
      refreshToken: REFRESH_TOKEN,
      authContext: "customer" as const,
      origin: "https://studio.example",
      now: NOW,
    };

    expect(createSessionHandoff(input)).not.toBe(createSessionHandoff(input));
  });

  it("rejects an expired handoff", () => {
    const handoff = createSessionHandoff({
      refreshToken: REFRESH_TOKEN,
      authContext: "workspace",
      origin: "https://studio.example",
      now: NOW,
    });

    expect(() => consumeSessionHandoff(handoff, NOW + 120_000)).toThrowError(
      expect.objectContaining({
        statusCode: 401,
        code: "AUTH_SESSION_HANDOFF_INVALID",
      }),
    );
  });

  it("rejects ciphertext or authentication-tag tampering", () => {
    const handoff = createSessionHandoff({
      refreshToken: REFRESH_TOKEN,
      authContext: "customer",
      origin: "https://studio.example",
      now: NOW,
    });
    const parts = handoff.split(".");
    const mutationIndex = Math.floor(parts[2].length / 2);
    const character = parts[2][mutationIndex];

    parts[2] = `${parts[2].slice(0, mutationIndex)}${
      character === "A" ? "B" : "A"
    }${parts[2].slice(mutationIndex + 1)}`;

    expect(() => consumeSessionHandoff(parts.join("."), NOW + 1)).toThrowError(
      expect.objectContaining({
        code: "AUTH_SESSION_HANDOFF_INVALID",
      }),
    );
  });

  it("rejects a handoff after the encryption secret changes", () => {
    const handoff = createSessionHandoff({
      refreshToken: REFRESH_TOKEN,
      authContext: "customer",
      origin: "https://studio.example",
      now: NOW,
    });

    process.env.AUTH_SESSION_HANDOFF_SECRET =
      "a-different-handoff-secret-with-thirty-two-bytes";

    expect(() => consumeSessionHandoff(handoff, NOW + 1)).toThrowError(
      expect.objectContaining({
        code: "AUTH_SESSION_HANDOFF_INVALID",
      }),
    );
  });

  it("requires production handoffs to target a canonical HTTPS origin", () => {
    expect(() =>
      createSessionHandoff({
        refreshToken: REFRESH_TOKEN,
        authContext: "customer",
        origin: "http://studio.example:3000/path",
        now: NOW,
      }),
    ).toThrowError("valid origin");
  });

  it("reports configuration only for a secret of at least 32 bytes", () => {
    expect(isSessionHandoffConfigured()).toBe(true);
    process.env.AUTH_SESSION_HANDOFF_SECRET = "short";
    expect(isSessionHandoffConfigured()).toBe(false);
  });
});
