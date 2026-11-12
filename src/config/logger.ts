import pino from "pino";

import {
  REDACTED_LOG_VALUE,
  SENSITIVE_LOG_REDACTION_PATHS,
  serializeErrorForLog,
  serializeRequestForLog,
  sanitizeLogArguments,
  sanitizeUrlForLog,
} from "@/shared/logging/request-log-sanitization.js";

// Pretty-printing colorizes and reformats every log line for a human
// terminal — real production log aggregators expect plain structured JSON,
// and pino-pretty's own docs say not to use it in production. Defaulting
// this off in production (rather than requiring an env var to opt out)
// means a deploy that forgets to set anything still ships JSON logs.
const usePrettyLogs = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",

  redact: {
    paths: SENSITIVE_LOG_REDACTION_PATHS,
    censor: REDACTED_LOG_VALUE,
  },

  serializers: {
    req: serializeRequestForLog,
    request: serializeRequestForLog,
    err: serializeErrorForLog,
    url: sanitizeUrlForLog,
    originalUrl: sanitizeUrlForLog,
    path: sanitizeUrlForLog,
    callbackUrl: sanitizeUrlForLog,
    requestUrl: sanitizeUrlForLog,
    returnUrl: sanitizeUrlForLog,
    verificationUrl: sanitizeUrlForLog,
    authorizationUrl: sanitizeUrlForLog,
    redirectUrl: sanitizeUrlForLog,
  },

  hooks: {
    logMethod(args, method) {
      method.apply(this, sanitizeLogArguments(args));
    },
  },

  transport: usePrettyLogs
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
          singleLine: false,
        },
      }
    : undefined,

  base: {
    env: process.env.NODE_ENV ?? "development",
  },
});
