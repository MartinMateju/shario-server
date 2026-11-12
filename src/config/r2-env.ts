import { z } from "zod";

const R2_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;

export const R2_JURISDICTIONS = ["eu", "fedramp"] as const;
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

type R2ConfigurationField =
  | "R2_ACCOUNT_ID"
  | "R2_ENDPOINT"
  | "R2_JURISDICTION"
  | "R2_ACCESS_KEY_ID"
  | "R2_SECRET_ACCESS_KEY"
  | "R2_BUCKET"
  | "R2_PUBLIC_URL";

export class R2ConfigurationError extends Error {
  readonly field: R2ConfigurationField;

  constructor(field: R2ConfigurationField, message: string) {
    super(`R2: ${message.replace(/^R2:\s*/i, "")}`);
    this.name = "R2ConfigurationError";
    this.field = field;
  }
}

export const isR2ConfigurationError = (
  error: unknown,
): error is R2ConfigurationError =>
  error instanceof R2ConfigurationError ||
  (error instanceof Error && error.name === "R2ConfigurationError");

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const normalizeJurisdiction = (
  jurisdiction: string | undefined,
): R2Jurisdiction | undefined => {
  const normalized = jurisdiction?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!R2_JURISDICTIONS.includes(normalized as R2Jurisdiction)) {
    throw new R2ConfigurationError(
      "R2_JURISDICTION",
      `unsupported R2_JURISDICTION "${normalized}".`,
    );
  }
  return normalized as R2Jurisdiction;
};

export const buildR2Endpoint = ({
  accountId,
  jurisdiction,
  endpoint,
}: {
  accountId: string;
  jurisdiction?: string;
  endpoint?: string;
}): string => {
  const normalizedAccountId = accountId.trim().toLowerCase();
  const normalizedJurisdiction = normalizeJurisdiction(jurisdiction);

  if (!R2_ACCOUNT_ID_PATTERN.test(normalizedAccountId)) {
    throw new R2ConfigurationError(
      "R2_ACCOUNT_ID",
      "R2_ACCOUNT_ID must be the 32-character Cloudflare account ID.",
    );
  }

  const endpointFor = (value: R2Jurisdiction | undefined): string =>
    `https://${normalizedAccountId}${value ? `.${value}` : ""}.r2.cloudflarestorage.com`;

  const configured = endpoint?.trim();
  if (!configured) return endpointFor(normalizedJurisdiction);

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new R2ConfigurationError(
      "R2_ENDPOINT",
      "R2_ENDPOINT must be a valid HTTPS URL.",
    );
  }

  const jurisdictionByHost = new Map<string, R2Jurisdiction | undefined>([
    [`${normalizedAccountId}.r2.cloudflarestorage.com`, undefined],
    ...R2_JURISDICTIONS.map(
      (value) =>
        [
          `${normalizedAccountId}.${value}.r2.cloudflarestorage.com`,
          value,
        ] as const,
    ),
  ]);
  const endpointJurisdiction = jurisdictionByHost.get(
    parsed.hostname.toLowerCase(),
  );
  const hostIsAllowed = jurisdictionByHost.has(parsed.hostname.toLowerCase());
  const hasQueryOrFragment =
    configured.includes("?") || configured.includes("#");
  const invalidUrl =
    parsed.protocol !== "https:" ||
    !hostIsAllowed ||
    Boolean(parsed.username) ||
    Boolean(parsed.password) ||
    Boolean(parsed.port && parsed.port !== "443") ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    hasQueryOrFragment;

  if (invalidUrl) {
    throw new R2ConfigurationError(
      "R2_ENDPOINT",
      "R2_ENDPOINT must be the credential-free Cloudflare endpoint for R2_ACCOUNT_ID.",
    );
  }

  if (
    normalizedJurisdiction !== undefined &&
    endpointJurisdiction !== normalizedJurisdiction
  ) {
    throw new R2ConfigurationError(
      "R2_ENDPOINT",
      "R2_ENDPOINT and R2_JURISDICTION do not match.",
    );
  }

  return endpointFor(endpointJurisdiction);
};

export const normalizeR2PublicBaseUrl = (value: string): string => {
  const configured = value.trim();
  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    throw new R2ConfigurationError(
      "R2_PUBLIC_URL",
      "R2_PUBLIC_URL must be a valid HTTPS URL.",
    );
  }

  const invalidUrl =
    parsed.protocol !== "https:" ||
    Boolean(parsed.username) ||
    Boolean(parsed.password) ||
    Boolean(parsed.port && parsed.port !== "443") ||
    configured.includes("?") ||
    configured.includes("#");

  if (invalidUrl) {
    throw new R2ConfigurationError(
      "R2_PUBLIC_URL",
      "R2_PUBLIC_URL must be a credential-free HTTPS URL without a query or fragment.",
    );
  }

  const pathPrefix = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathPrefix === "/" ? "" : pathPrefix}`;
};

export const buildR2PublicUrl = (baseUrl: string, key: string): string => {
  const normalizedBaseUrl = normalizeR2PublicBaseUrl(baseUrl);
  const segments = key.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new R2ConfigurationError(
      "R2_PUBLIC_URL",
      "the public object key must contain safe, non-empty path segments.",
    );
  }

  const encodedKey = segments
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${normalizedBaseUrl}/${encodedKey}`;
};

const jurisdictionSchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(R2_JURISDICTIONS))
    .optional(),
);

const publicUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    try {
      return normalizeR2PublicBaseUrl(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message.replace(/^R2:\s*/i, "")
            : "R2_PUBLIC_URL is invalid.",
      });
      return z.NEVER;
    }
  });

export const r2EnvironmentShape = {
  R2_ACCOUNT_ID: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .refine((value) => R2_ACCOUNT_ID_PATTERN.test(value), {
      message: "R2_ACCOUNT_ID must be the 32-character Cloudflare account ID.",
    }),
  R2_ENDPOINT: z.preprocess(
    emptyStringToUndefined,
    z.string().trim().url().optional(),
  ),
  R2_JURISDICTION: jurisdictionSchema,
  R2_ACCESS_KEY_ID: z.string().trim().min(1),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1),
  R2_BUCKET: z.string().trim().min(1),
  R2_PUBLIC_URL: publicUrlSchema,
} as const;

type R2CrossFieldValues = {
  R2_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;
  R2_JURISDICTION?: string;
};

export const addR2EnvironmentIssues = (
  value: R2CrossFieldValues,
  context: z.RefinementCtx,
): void => {
  if (!value.R2_ACCOUNT_ID) return;

  try {
    buildR2Endpoint({
      accountId: value.R2_ACCOUNT_ID,
      endpoint: value.R2_ENDPOINT,
      jurisdiction: value.R2_JURISDICTION,
    });
  } catch (error) {
    const configurationError = error as R2ConfigurationError;
    context.addIssue({
      code: "custom",
      path: [configurationError.field ?? "R2_ENDPOINT"],
      message:
        error instanceof Error
          ? error.message.replace(/^R2:\s*/i, "")
          : "R2 endpoint configuration is invalid.",
    });
  }
};

export const r2EnvironmentSchema = z
  .object(r2EnvironmentShape)
  .superRefine(addR2EnvironmentIssues);

export type R2Environment = {
  R2_ACCOUNT_ID: string;
  R2_ENDPOINT?: string;
  R2_JURISDICTION?: R2Jurisdiction;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  R2_PUBLIC_URL: string;
};

export const parseR2Environment = (
  input: NodeJS.ProcessEnv | Record<string, unknown>,
): R2Environment => {
  const result = r2EnvironmentSchema.safeParse(input);
  if (result.success) return result.data as R2Environment;

  const issue = result.error.issues[0];
  const field = String(issue?.path[0] ?? "R2_ENDPOINT") as R2ConfigurationField;
  throw new R2ConfigurationError(
    field,
    issue?.message ?? "R2 configuration is invalid.",
  );
};
