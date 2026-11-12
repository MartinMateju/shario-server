import { createHash, randomBytes } from "node:crypto";

export const validateSatisfactionScore = (score: unknown): number => {
  if (
    typeof score === "boolean" ||
    score === null ||
    score === undefined ||
    (typeof score === "string" && !score.trim())
  ) {
    throw new RangeError("Satisfaction score must be an integer from 1 to 5.");
  }
  const normalized = Number(score);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 5) {
    throw new RangeError("Satisfaction score must be an integer from 1 to 5.");
  }
  return normalized;
};

export const calculateSatisfactionSummary = (
  responses: readonly { score?: unknown }[],
): {
  responses: number;
  average: number | null;
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
  positiveRate: number | null;
} => {
  const scores = responses
    .map((response) => Number(response.score))
    .filter((score) => Number.isInteger(score) && score >= 1 && score <= 5);
  const distribution = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const score of scores) distribution[String(score) as keyof typeof distribution] += 1;
  return {
    responses: scores.length,
    average: scores.length
      ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(2))
      : null,
    distribution,
    positiveRate: scores.length
      ? Number((scores.filter((score) => score >= 4).length / scores.length).toFixed(4))
      : null,
  };
};

export const createSatisfactionToken = () => {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSatisfactionToken(token) };
};

export const hashSatisfactionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
