import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisSet = vi.hoisted(() => vi.fn());
vi.mock("@/infrastructure/redis/redis.js", () => ({
  redisConnection: { set: redisSet },
}));
vi.mock("@/config/logger.js", () => ({ logger: { warn: vi.fn() } }));

const SECRET = "proxy-secret-with-at-least-thirty-two-bytes";
const ORIGIN = "https://booking.commonground.example";
const BODY = { tenantSlug: "common-ground", email: "customer@example.test" };

describe("login rate limiting through the first-party BFF", () => {
  let app: ReturnType<typeof express>;
  let proxy: typeof import("@/modules/auth/auth-first-party-proxy.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("AUTH_FIRST_PARTY_PROXY_SECRET", SECRET);
    vi.stubEnv("E2E_TEST_MODE", "false");
    const claimed = new Set<string>();
    redisSet.mockReset().mockImplementation(async (key: string) => {
      if (claimed.has(key)) return null;
      claimed.add(key);
      return "OK";
    });
    proxy = await import("@/modules/auth/auth-first-party-proxy.js");
    const { loginLimiter } =
      await import("@/shared/middleware/loginLimiter.js");
    app = express();
    app.use(express.json());
    app.post("/auth/customer", loginLimiter, async (req, res, next) => {
      try {
        // The real controller reads this again after the limiter. Verification
        // must not claim the same nonce twice within the same HTTP request.
        res.json(await proxy.resolveAuthRequestContext(req));
      } catch (error) {
        next(error);
      }
    });
    app.use(
      (
        error: { statusCode?: number; code?: string; message?: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res
          .status(error.statusCode || 500)
          .json({ code: error.code, message: error.message });
      },
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  const signedHeaders = (clientIp?: string) => {
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(24).toString("base64url");
    const headers = {
      origin: ORIGIN,
      [proxy.AUTH_PROXY_HEADERS.ORIGIN]: ORIGIN,
      [proxy.AUTH_PROXY_HEADERS.TIMESTAMP]: timestamp,
      [proxy.AUTH_PROXY_HEADERS.NONCE]: nonce,
      [proxy.AUTH_PROXY_HEADERS.SIGNATURE]: proxy.createAuthProxySignature({
        secret: SECRET,
        timestamp,
        nonce,
        method: "POST",
        path: "/auth/customer",
        origin: ORIGIN,
        body: BODY,
        clientIp,
      }),
    };
    if (clientIp) headers[proxy.AUTH_PROXY_HEADERS.CLIENT_IP] = clientIp;
    return headers;
  };

  it("gives separate customers independent budgets behind the same BFF and claims each nonce once", async () => {
    for (let index = 0; index < 5; index += 1) {
      const result = await request(app)
        .post("/auth/customer")
        .set(signedHeaders("203.0.113.42"))
        .send(BODY);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.clientIp).toBe("203.0.113.42");
    }
    expect(redisSet).toHaveBeenCalledTimes(5);
    expect(
      (
        await request(app)
          .post("/auth/customer")
          .set(signedHeaders("203.0.113.42"))
          .send(BODY)
      ).status,
    ).toBe(429);
    expect(
      (
        await request(app)
          .post("/auth/customer")
          .set(signedHeaders("198.51.100.7"))
          .send(BODY)
      ).status,
    ).toBe(200);
  });

  it("groups IPv6 privacy addresses into one rate-limit subnet", async () => {
    for (let index = 1; index <= 5; index += 1) {
      expect(
        (
          await request(app)
            .post("/auth/customer")
            .set(signedHeaders(`2001:db8:abcd:1200::${index}`))
            .send(BODY)
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await request(app)
          .post("/auth/customer")
          .set(signedHeaders("2001:db8:abcd:1200::6"))
          .send(BODY)
      ).status,
    ).toBe(429);
    expect(
      (
        await request(app)
          .post("/auth/customer")
          .set(signedHeaders("2001:db8:ffff::1"))
          .send(BODY)
      ).status,
    ).toBe(200);
  });

  it("rejects forged IP proofs before granting a limiter budget or claiming Redis", async () => {
    for (let index = 1; index <= 6; index += 1) {
      const headers = signedHeaders("203.0.113.42");
      headers[proxy.AUTH_PROXY_HEADERS.CLIENT_IP] = `198.51.100.${index}`;
      const result = await request(app)
        .post("/auth/customer")
        .set(headers)
        .send(BODY);
      expect(result.status).toBe(403);
      expect(result.body.code).toBe("AUTH_FIRST_PARTY_PROXY_INVALID");
    }
    expect(redisSet).not.toHaveBeenCalled();
    expect(
      (
        await request(app)
          .post("/auth/customer")
          .set(signedHeaders("203.0.113.42"))
          .send(BODY)
      ).status,
    ).toBe(200);
  });

  it("rejects nonce replay on another HTTP request despite the controller context cache", async () => {
    const headers = signedHeaders("203.0.113.42");
    expect(
      (await request(app).post("/auth/customer").set(headers).send(BODY))
        .status,
    ).toBe(200);
    const replay = await request(app)
      .post("/auth/customer")
      .set(headers)
      .send(BODY);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe("AUTH_FIRST_PARTY_PROXY_INVALID");
  });

  it("retains the ordinary IP budget and ignores unsigned X-Forwarded-For", async () => {
    for (let index = 1; index <= 5; index += 1) {
      expect(
        (
          await request(app)
            .post("/auth/customer")
            .set("x-forwarded-for", `203.0.113.${index}`)
            .send(BODY)
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await request(app)
          .post("/auth/customer")
          .set("x-forwarded-for", "198.51.100.7")
          .send(BODY)
      ).status,
    ).toBe(429);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it("preserves v1 compatibility without granting client-supplied IP overrides", async () => {
    expect(
      (
        await request(app)
          .post("/auth/customer")
          .set(signedHeaders())
          .send(BODY)
      ).status,
    ).toBe(200);
    const headers = signedHeaders();
    headers[proxy.AUTH_PROXY_HEADERS.CLIENT_IP] = "203.0.113.42";
    expect(
      (await request(app).post("/auth/customer").set(headers).send(BODY))
        .status,
    ).toBe(403);
  });
});
