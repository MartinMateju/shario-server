import crypto from "node:crypto";

import {
  resolveRolloutEligibleAppLocale,
  type RolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

const SAFE_NEXT_PREFIXES = [
  "/portal",
  "/book",
  "/courses",
  "/memberships",
  "/help",
] as const;

export const createVerificationToken =
  (): string =>
    crypto
      .randomBytes(32)
      .toString("hex");

export const hashVerificationToken = (
  token: string,
): Promise<string> =>
  Promise.resolve(
    crypto
      .createHash("sha256")
      .update(token, "utf8")
      .digest("hex"),
  );

export const verifyTokenHash = async (
  token: string,
  hashedToken: string,
): Promise<boolean> => {
  const actual = Buffer.from(
    await hashVerificationToken(
      token,
    ),
    "hex",
  );
  const expected = Buffer.from(
    String(hashedToken || ""),
    "hex",
  );

  return (
    actual.length ===
      expected.length &&
    crypto.timingSafeEqual(
      actual,
      expected,
    )
  );
};

export const addMilliseconds = (
  date: Date,
  milliseconds: number,
): Date =>
  new Date(
    date.getTime() + milliseconds,
  );

export const normalizeBaseUrl = (
  value?: string | null,
): string =>
  String(value || "")
    .trim()
    .replace(/\/+$/, "");

export const normalizeVerificationLocale =
  (value: unknown): RolloutEligibleAppLocale =>
    resolveRolloutEligibleAppLocale(
      value,
    );

export const getSafeVerificationNext = (
  value: unknown,
): string => {
  const raw = String(value || "").trim();

  if (
    !raw ||
    raw.length > 2_000 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(
      raw,
    )
  ) {
    return "/portal";
  }

  let decoded: string;

  try {
    decoded =
      decodeURIComponent(raw);
  } catch {
    return "/portal";
  }

  if (
    decoded.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(
      decoded,
    )
  ) {
    return "/portal";
  }

  try {
    const parsed = new URL(
      raw,
      "https://tenant.invalid",
    );
    const allowed =
      SAFE_NEXT_PREFIXES.some(
        (prefix) =>
          parsed.pathname ===
            prefix ||
          parsed.pathname.startsWith(
            `${prefix}/`,
          ),
      );

    if (
      parsed.origin !==
        "https://tenant.invalid" ||
      !allowed
    ) {
      return "/portal";
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/portal";
  }
};

export const buildEmailVerificationUrl =
  ({
    baseUrl,
    token,
    locale,
    next,
  }: {
    baseUrl: string;
    token: string;
    locale?: unknown;
    next?: unknown;
  }): string => {
    const url = new URL(
      `/${normalizeVerificationLocale(locale)}/verify-email`,
      normalizeBaseUrl(baseUrl),
    );

    url.searchParams.set(
      "token",
      token,
    );
    url.searchParams.set(
      "next",
      getSafeVerificationNext(
        next,
      ),
    );

    return url.toString();
  };
