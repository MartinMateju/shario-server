import type { Request } from "express";

export const REDACTED_LOG_VALUE = "[REDACTED]";

const SENSITIVE_REQUEST_FIELD =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|passphrase|secret|signature|client[_-]?secret|(?:voucher|promo)[_-]?codes?(?:[_-]?snapshot)?|code|otp|state|token|access[_-]?token|refresh[_-]?token|id[_-]?token|verify[_-]?token|session[_-]?handoff|challenge|hub\.(?:verify_token|challenge)|x-shario-auth-proxy-(?:origin|timestamp|signature|nonce)|x-shario-postmark-provisioning-token)$/i;

const SENSITIVE_PATH_PARENT =
  /^(?:satisfaction|unsubscribe|verification|verify|activation|activate|password-reset|reset-password|invitation|invite|token)$/i;

const HIGH_ENTROPY_PATH_SEGMENT = /^(?=.{32,}$)[A-Za-z0-9._~-]+$/;

const SENSITIVE_LOG_REDACTION_FIELDS = [
  "authorization",
  "Authorization",
  "proxyAuthorization",
  "ProxyAuthorization",
  "cookie",
  "Cookie",
  "setCookie",
  "SetCookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "signature",
  "clientSecret",
  "client_secret",
  "voucherCode",
  "voucher_code",
  "promoCode",
  "promo_code",
  "promoCodesSnapshot",
  "code",
  "otp",
  "state",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "sessionHandoff",
  "session_handoff",
  "verifyToken",
  "verify_token",
  "challenge",
] as const;

const REQUEST_CONTAINER_PATHS = ["req", "request"] as const;

const REQUEST_VALUE_PATHS = ["query", "body", "params"] as const;

const URL_LOG_FIELDS = [
  "url",
  "originalUrl",
  "callbackUrl",
  "requestUrl",
  "returnUrl",
  "verificationUrl",
  "authorizationUrl",
  "redirectUrl",
] as const;

const SENSITIVE_LOG_CONTAINERS = [
  "headers",
  "rawHeaders",
  "cookies",
  "signedCookies",
] as const;

/**
 * Pino's redaction is a final defence for structured logging calls outside the
 * HTTP boundary. Request serializers below intentionally omit headers, query,
 * params and bodies altogether; these paths cover the common standalone and
 * nested shapes used by application services.
 */
export const SENSITIVE_LOG_REDACTION_PATHS: string[] = [
  ...SENSITIVE_LOG_REDACTION_FIELDS,
  ...[
    "x-shario-postmark-provisioning-token",
    "X-Shario-Postmark-Provisioning-Token",
  ].flatMap((field) => [
    `["${field}"]`,
    `*["${field}"]`,
    `*.*["${field}"]`,
    `*.*.*["${field}"]`,
    `*.*.*.*["${field}"]`,
  ]),
  ...SENSITIVE_LOG_CONTAINERS.flatMap((field) => [
    field,
    `*.${field}`,
    `*.*.${field}`,
    `*.*.*.${field}`,
  ]),
  'headers["proxy-authorization"]',
  'headers["Proxy-Authorization"]',
  'headers["set-cookie"]',
  'headers["Set-Cookie"]',
  'headers["x-shario-auth-proxy-origin"]',
  'headers["x-shario-auth-proxy-timestamp"]',
  'headers["x-shario-auth-proxy-signature"]',
  'headers["x-shario-auth-proxy-nonce"]',
  '*.headers["x-shario-auth-proxy-origin"]',
  '*.headers["x-shario-auth-proxy-timestamp"]',
  '*.headers["x-shario-auth-proxy-signature"]',
  '*.headers["x-shario-auth-proxy-nonce"]',
  '*.*.headers["x-shario-auth-proxy-origin"]',
  '*.*.headers["x-shario-auth-proxy-timestamp"]',
  '*.*.headers["x-shario-auth-proxy-signature"]',
  '*.*.headers["x-shario-auth-proxy-nonce"]',
  ...SENSITIVE_LOG_REDACTION_FIELDS.flatMap((field) => [
    `headers.${field}`,
    `credentials.${field}`,
    `oauth.${field}`,
    `auth.${field}`,
    `*.${field}`,
    `*.*.${field}`,
    `*.*.*.${field}`,
    `*.*.*.*.${field}`,
  ]),
  ...REQUEST_CONTAINER_PATHS.flatMap((container) => [
    `${container}.headers.authorization`,
    `${container}.headers.proxy-authorization`,
    `${container}.headers.cookie`,
    `${container}.headers[\"set-cookie\"]`,
    `${container}.headers[\"x-shario-auth-proxy-origin\"]`,
    `${container}.headers[\"x-shario-auth-proxy-timestamp\"]`,
    `${container}.headers[\"x-shario-auth-proxy-signature\"]`,
    `${container}.headers[\"x-shario-auth-proxy-nonce\"]`,
    `${container}.originalUrl`,
    `${container}.url`,
    ...REQUEST_VALUE_PATHS.map((part) => `${container}.${part}`),
  ]),
  ...URL_LOG_FIELDS.flatMap((field) => [
    `*.${field}`,
    `*.*.${field}`,
    `*.*.*.${field}`,
  ]),
  ...REQUEST_VALUE_PATHS,
];

type RequestLike = Partial<
  Pick<
    Request,
    "method" | "originalUrl" | "url" | "path" | "params" | "query" | "body"
  >
> &
  Partial<Pick<Request, "ip">> & {
    id?: unknown;
    headers?: Record<string, unknown>;
    get?: (name: string) => string | undefined;
  };

const getPathname = (rawUrl: unknown): string => {
  const raw = typeof rawUrl === "string" && rawUrl ? rawUrl : "/";

  try {
    return new URL(raw, "http://request.local").pathname || "/";
  } catch {
    return raw.split(/[?#]/, 1)[0] || "/";
  }
};

const decodePathSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const parameterEntries = (
  params: RequestLike["params"],
): Array<[string, string]> => {
  if (!params || typeof params !== "object") {
    return [];
  }

  return Object.entries(params)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    )
    .sort((left, right) => right[1].length - left[1].length);
};

const templatePathParameters = (
  pathname: string,
  params: RequestLike["params"],
): string => {
  const entries = parameterEntries(params);
  if (!entries.length) {
    return pathname;
  }

  return pathname
    .split("/")
    .map((segment) => {
      const decoded = decodePathSegment(segment);
      const parameter = entries.find(([, value]) => decoded === value);
      return parameter ? `:${parameter[0]}` : segment;
    })
    .join("/");
};

const redactUnmatchedBearerSegments = (pathname: string): string => {
  const segments = pathname.split("/");

  return segments
    .map((segment, index) => {
      if (!segment) {
        return segment;
      }

      if (segment.startsWith(":")) {
        return segment;
      }

      const decoded = decodePathSegment(segment);
      const previous = decodePathSegment(segments[index - 1] ?? "");
      if (
        SENSITIVE_PATH_PARENT.test(previous) ||
        HIGH_ENTROPY_PATH_SEGMENT.test(decoded) ||
        /^eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}$/.test(decoded)
      ) {
        return REDACTED_LOG_VALUE;
      }

      return segment;
    })
    .join("/");
};

export const sanitizeUrlForLog = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  return redactUnmatchedBearerSegments(getPathname(value));
};

/**
 * Returns a query-free path and replaces every resolved Express parameter
 * with its route placeholder. The high-entropy fallback protects bearer-token
 * paths even when no route matched (for example, an unsupported HTTP method).
 */
export const getRequestLogPath = (request: RequestLike): string => {
  const pathname = getPathname(
    request.originalUrl || request.url || request.path,
  );

  return redactUnmatchedBearerSegments(
    templatePathParameters(pathname, request.params),
  );
};

const visitSensitiveValues = (
  value: unknown,
  output: Set<string>,
  depth = 0,
): void => {
  if (!value || typeof value !== "object" || depth > 5) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_REQUEST_FIELD.test(key)) {
      if (typeof nested === "string" && nested.length >= 4) {
        output.add(nested);
      } else if (Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === "string" && item.length >= 4) {
            output.add(item);
          }
        }
      }
      continue;
    }

    visitSensitiveValues(nested, output, depth + 1);
  }
};

const collectSensitiveRequestValues = (request?: RequestLike): string[] => {
  if (!request) {
    return [];
  }

  const values = new Set<string>();
  visitSensitiveValues(request.headers, values);
  visitSensitiveValues(request.query, values);
  visitSensitiveValues(request.params, values);
  visitSensitiveValues(request.body, values);

  return [...values].sort((left, right) => right.length - left.length);
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes common credential forms from error messages and stacks. Exact
 * values found in the current request are removed as an additional safeguard.
 */
export const sanitizeLogText = (
  value: unknown,
  request?: RequestLike,
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  let sanitized = value
    .replace(
      /\b((?:https?|mongodb(?:\+srv)?|redis(?:s)?|smtp):\/\/)[^\s/@:]+:[^\s/@]+@/gi,
      `$1${REDACTED_LOG_VALUE}@`,
    )
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      `$1 ${REDACTED_LOG_VALUE}`,
    )
    .replace(
      /\b((?:authorization|proxy-authorization|x-shario-auth-proxy-(?:origin|timestamp|signature|nonce)|x-shario-postmark-provisioning-token)\s*[:=]\s*)[^\s,;}]+/gi,
      `$1${REDACTED_LOG_VALUE}`,
    )
    .replace(
      /\b((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi,
      `$1${REDACTED_LOG_VALUE}`,
    )
    .replace(
      /([?#&](?:(?:voucher|promo)[_-]?codes?(?:[_-]?snapshot)?|code|otp|state|token|access_token|refresh_token|id_token|verify_token|challenge|client_secret|session(?:_|%5f)?handoff|signature|password|hub(?:\.|%2e)(?:verify_token|challenge))=)[^&#\s"'<>]*/gi,
      `$1${REDACTED_LOG_VALUE}`,
    )
    .replace(
      /((?:password|passwd|passphrase|secret|signature|client[_-]?secret|(?:voucher|promo)[_-]?codes?(?:[_-]?snapshot)?|code|otp|state|token|access[_-]?token|refresh[_-]?token|id[_-]?token|verify[_-]?token|session[_-]?handoff|challenge)\s*[:=]\s*["']?)[^"'\s,}&]+/gi,
      `$1${REDACTED_LOG_VALUE}`,
    )
    .replace(
      /(\/(?:satisfaction|unsubscribe|verification|verify|activation|activate|password-reset|reset-password|invitation|invite|token)\/)[^/?#\s"']+/gi,
      `$1${REDACTED_LOG_VALUE}`,
    );

  for (const secret of collectSensitiveRequestValues(request)) {
    sanitized = sanitized.replace(
      new RegExp(escapeRegExp(secret), "g"),
      REDACTED_LOG_VALUE,
    );
  }

  return sanitized;
};

const POSTMARK_VERIFICATION_TRIGGER_TYPES = [
  "Delivery",
  "Bounce",
  "SpamComplaint",
  "Open",
  "Click",
  "SubscriptionChange",
] as const;

type SafePostmarkVerificationResult = {
  triggerType: (typeof POSTMARK_VERIFICATION_TRIGGER_TYPES)[number];
  success: boolean;
  statusCode: number;
};

const isSafeHttpStatus = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  (value === 0 || (value >= 100 && value <= 599));

const sanitizePostmarkVerificationResults = (
  value: unknown,
): SafePostmarkVerificationResult[] => {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 6).flatMap((result: unknown) => {
    if (!result || typeof result !== "object") return [];
    const candidate = result as Record<string, unknown>;
    const triggerType = POSTMARK_VERIFICATION_TRIGGER_TYPES.find(
      (trigger) => trigger === candidate.triggerType,
    );
    if (
      !triggerType ||
      typeof candidate.success !== "boolean" ||
      !isSafeHttpStatus(candidate.statusCode)
    ) {
      return [];
    }

    return [
      { triggerType, success: candidate.success, statusCode: candidate.statusCode },
    ];
  });
};

export type SafeErrorLog = {
  type: string;
  message: string;
  stack?: string;
  errorCode?: string;
  statusCode?: number;
  isOperational?: boolean;
  httpStatus?: number;
  verificationResults?: SafePostmarkVerificationResult[];
};

/**
 * Deliberately allow-lists error metadata. Provider payloads and validation
 * details are excluded because they may echo credentials supplied by clients.
 */
export const serializeErrorForLog = (
  error: unknown,
  request?: RequestLike,
): SafeErrorLog => {
  const candidate =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  const constructorName = candidate?.constructor;
  const candidateType =
    typeof candidate?.type === "string" && candidate.type
      ? candidate.type
      : typeof constructorName === "function" && constructorName.name
        ? constructorName.name
        : error instanceof Error
          ? error.name
          : typeof error;
  const type = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(candidateType)
    ? candidateType
    : typeof error;
  const message =
    sanitizeLogText(candidate?.message, request) ??
    (typeof error === "string" ? sanitizeLogText(error, request) : undefined) ??
    "Non-Error value thrown.";
  const stack = sanitizeLogText(candidate?.stack, request);
  const rawCode = candidate?.errorCode ?? candidate?.code;
  const rawStatusCode = candidate?.statusCode;
  const isPostmarkError =
    type === "PostmarkRequestError" ||
    (typeof rawCode === "string" && /^POSTMARK_[A-Z0-9_]{1,111}$/.test(rawCode));
  const verificationResults = isPostmarkError
    ? sanitizePostmarkVerificationResults(candidate?.verificationResults)
    : [];

  return {
    type,
    message,
    ...(stack ? { stack } : {}),
    ...(typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{1,119}$/.test(rawCode)
      ? { errorCode: rawCode }
      : {}),
    ...(typeof rawStatusCode === "number" ? { statusCode: rawStatusCode } : {}),
    ...(typeof candidate?.isOperational === "boolean"
      ? { isOperational: candidate.isOperational }
      : {}),
    ...(isPostmarkError && isSafeHttpStatus(candidate?.httpStatus)
      ? { httpStatus: candidate.httpStatus }
      : {}),
    ...(verificationResults.length ? { verificationResults } : {}),
  };
};

/**
 * Pino serializer for callers that pass an Express request directly. Only
 * operational metadata is retained; URL queries, params, bodies and cookies
 * are never copied into the log record.
 */
export const serializeRequestForLog = (
  value: unknown,
): Record<string, unknown> => {
  const request =
    value && typeof value === "object" ? (value as RequestLike) : {};
  const userAgent =
    typeof request.get === "function" ? request.get("user-agent") : undefined;

  return {
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    path: getRequestLogPath(request),
    ...(typeof request.id === "string" || typeof request.id === "number"
      ? { id: request.id }
      : {}),
    ...(typeof request.ip === "string" ? { ip: request.ip } : {}),
    ...(userAgent ? { userAgent: sanitizeLogText(userAgent, request) } : {}),
  };
};

/**
 * Sanitizes the arguments before Pino chooses an implicit message. Pino uses
 * `err.message` as the record message when callers omit a second argument;
 * doing this in a serializer is too late and would leave that implicit copy
 * unredacted.
 */
export const sanitizeLogArguments = (args: unknown[]): unknown[] => {
  const sanitized = [...args];
  const first = sanitized[0];

  if (first instanceof Error) {
    sanitized[0] = serializeErrorForLog(first);
  } else if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    const sanitizedRecord: Record<string, unknown> = {
      ...record,
    };

    if ("err" in record && record.err !== undefined) {
      sanitizedRecord.err = serializeErrorForLog(record.err);
    }

    for (const field of ["msg", "message", "errorMessage"] as const) {
      if (typeof sanitizedRecord[field] === "string") {
        sanitizedRecord[field] = sanitizeLogText(sanitizedRecord[field]);
      }
    }

    sanitized[0] = sanitizedRecord;
  }

  for (let index = 0; index < sanitized.length; index += 1) {
    if (typeof sanitized[index] === "string") {
      sanitized[index] = sanitizeLogText(sanitized[index]);
    }
  }

  return sanitized;
};
