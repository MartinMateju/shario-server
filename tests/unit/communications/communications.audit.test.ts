import { describe, expect, it } from "vitest";

import {
  buildRetentionCutoff,
  redactAuditPayload,
} from "@/modules/communications/services/audit.service.js";

describe("communications audit privacy and retention", () => {
  it("redacts credentials and message content recursively", () => {
    const payload = {
      status: "sent",
      authorization: "Bearer secret",
      nested: {
        accessToken: "access-secret",
        refresh_token: "refresh-secret",
        apiKey: "api-secret",
        cookie: "session=secret",
        html: "<p>Private customer message</p>",
        transcript: "Private voice transcript",
        text: "Private customer message",
        body: "Private raw body",
      },
      recipients: [
        { email: "anna@example.com", password: "password-secret" },
      ],
    };

    expect(redactAuditPayload(payload)).toEqual({
      status: "sent",
      authorization: "[REDACTED]",
      nested: {
        accessToken: "[REDACTED]",
        refresh_token: "[REDACTED]",
        apiKey: "[REDACTED]",
        cookie: "[REDACTED]",
        html: "[REDACTED]",
        transcript: "[REDACTED]",
        text: "[REDACTED]",
        body: "[REDACTED]",
      },
      recipients: [
        { email: "anna@example.com", password: "[REDACTED]" },
      ],
    });
  });

  it("does not mutate the source audit payload", () => {
    const source = {
      token: "still-present-in-source",
      nested: { summary: "safe summary" },
    };

    redactAuditPayload(source);

    expect(source).toEqual({
      token: "still-present-in-source",
      nested: { summary: "safe summary" },
    });
  });

  it("serializes dates predictably and handles circular metadata", () => {
    const circular: Record<string, unknown> = {
      at: new Date("2026-07-22T12:00:00.000Z"),
    };
    circular.self = circular;

    expect(redactAuditPayload(circular)).toEqual({
      at: "2026-07-22T12:00:00.000Z",
      self: "[Circular]",
    });
  });

  it("builds an exact UTC retention cutoff without changing the supplied clock", () => {
    const now = new Date("2026-07-22T12:00:00.000Z");

    expect(buildRetentionCutoff(30, now)).toEqual(
      new Date("2026-06-22T12:00:00.000Z"),
    );
    expect(now).toEqual(new Date("2026-07-22T12:00:00.000Z"));
  });

  it("truncates fractional retention days and fails safe for non-positive input", () => {
    const now = new Date("2026-07-22T12:00:00.000Z");

    expect(buildRetentionCutoff(2.9, now)).toEqual(
      new Date("2026-07-20T12:00:00.000Z"),
    );
    expect(buildRetentionCutoff(0, now)).toEqual(
      new Date("2026-07-21T12:00:00.000Z"),
    );
  });
});
