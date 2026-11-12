import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest();

const safeEqual = (left: string, right: string) =>
  timingSafeEqual(digest(left), digest(right));

export const isValidPostmarkWebhookAuthorization = (
  authorization: string | undefined,
  expectedUsername = String(
    process.env.POSTMARK_OUTBOUND_WEBHOOK_USERNAME || "",
  ).trim(),
  expectedPassword = String(
    process.env.POSTMARK_OUTBOUND_WEBHOOK_PASSWORD || "",
  ),
): boolean => {
  if (!expectedUsername || !expectedPassword || !authorization) return false;
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization.trim());
  if (!match) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return (
    safeEqual(username, expectedUsername) &&
    safeEqual(password, expectedPassword)
  );
};
