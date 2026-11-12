export const normalizeOrigin = (origin?: string | null): string => {
  if (!origin) return "";
  return origin.trim().replace(/\/+$/, "");
};

const configuredOrigins = [
  process.env.PUBLIC_APP_URL,
  process.env.CLIENT_URL,
  ...(process.env.ALLOWED_ORIGINS || "").split(","),
]
  .map(normalizeOrigin)
  .filter(Boolean);

const allowedOrigins = new Set<string>([
  "https://app.shario.io",
  "http://localhost:4310",
  "http://localhost:3001",
  ...configuredOrigins,
]);

export const isOriginAllowed = (origin?: string | null): boolean =>
  allowedOrigins.has(normalizeOrigin(origin));

export default allowedOrigins;
