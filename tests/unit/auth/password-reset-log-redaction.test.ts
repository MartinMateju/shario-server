import { describe, expect, it } from "vitest";

import {
  REDACTED_LOG_VALUE,
  SENSITIVE_LOG_REDACTION_PATHS,
  sanitizeLogText,
} from "@/shared/logging/request-log-sanitization.js";

describe("password reset log redaction", () => {
  it("treats OTP values as credentials in structured and text logs", () => {
    expect(SENSITIVE_LOG_REDACTION_PATHS).toContain("otp");
    expect(SENSITIVE_LOG_REDACTION_PATHS).toContain("*.otp");
    expect(sanitizeLogText("otp=123456")).toBe(`otp=${REDACTED_LOG_VALUE}`);
    expect(sanitizeLogText("/verify?otp=123456")).toBe(
      `/verify?otp=${REDACTED_LOG_VALUE}`,
    );
  });
});
