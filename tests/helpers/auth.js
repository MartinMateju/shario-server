import jwt from "jsonwebtoken";

export function createTestAccessToken(payload = {}) {
  return jwt.sign(
    {
      id: payload.id || payload._id || "000000000000000000000001",
      email: payload.email || "test@example.com",
      roles: payload.roles || [],
      tenant: payload.tenant,
      ...payload,
      authContext: payload.authContext ?? "workspace",
    },
    process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET || "test-secret",
    { expiresIn: "15m" },
  );
}

export function authHeader(payload = {}) {
  return `Bearer ${createTestAccessToken(payload)}`;
}
