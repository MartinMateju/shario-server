import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisSet = vi.hoisted(() => vi.fn());
const logWarning = vi.hoisted(() => vi.fn());
vi.mock("@/config/logger.js", () => ({ logger: { warn: logWarning } }));
vi.mock("@/infrastructure/redis/redis.js", () => ({
  redisConnection: { status: "ready", set: redisSet },
}));
const SECRET = "proxy-secret-with-at-least-thirty-two-bytes";
const ORIGIN = "https://booking.commonground.example";
const CONFIG = "/public/tenants/common-ground/config";

describe("public SSR lookup rate limiting", () => {
  let app: ReturnType<typeof express>;
  let proxy: typeof import("@/modules/auth/auth-first-party-proxy.js");
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("AUTH_FIRST_PARTY_PROXY_SECRET", SECRET);
    logWarning.mockReset();
    const claimed = new Set<string>();
    redisSet.mockReset().mockImplementation(async (key: string) => {
      if (claimed.has(key)) return null;
      claimed.add(key);
      return "OK";
    });
    proxy = await import("@/modules/auth/auth-first-party-proxy.js");
    const { publicTenantLookupLimiter } =
      await import("@/modules/checkout/checkout.public-limiter.js");
    app = express();
    app.use(express.json());
    app.use(publicTenantLookupLimiter);
    app.get(
      "/public/tenants/:tenantSlug/products/not-a-valid-id",
      (_req, res) => res.status(400).json({ code: "INVALID_ID" }),
    );
    app.use((_req, res) => res.json({ ok: true }));
    app.use(
      (
        error: { statusCode?: number; code?: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(error.statusCode || 500).json({ code: error.code });
      },
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  const signedHeaders = (
    path = CONFIG,
    clientIp: string | undefined = "203.0.113.42",
    extra: { cookieHeader?: string; body?: unknown; method?: string } = {},
  ) => {
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(24).toString("base64url");
    const headers: Record<string, string> = {
      origin: ORIGIN,
      [proxy.AUTH_PROXY_HEADERS.ORIGIN]: ORIGIN,
      [proxy.AUTH_PROXY_HEADERS.TIMESTAMP]: timestamp,
      [proxy.AUTH_PROXY_HEADERS.NONCE]: nonce,
      [proxy.AUTH_PROXY_HEADERS.SIGNATURE]: proxy.createAuthProxySignature({
        secret: SECRET,
        timestamp,
        nonce,
        method: extra.method || "GET",
        path,
        origin: ORIGIN,
        clientIp,
        cookieHeader: extra.cookieHeader,
        body: extra.body,
      }),
    };
    if (clientIp) headers[proxy.AUTH_PROXY_HEADERS.CLIENT_IP] = clientIp;
    if (extra.cookieHeader) headers.cookie = extra.cookieHeader;
    return headers;
  };

  it.each([
    CONFIG,
    "/public/tenants/common-ground/memberships",
    "/public/tenants/common-ground/vouchers/products",
    "/public/tenants/common-ground/products/courses/overview?location=vaclavska",
    "/public/tenants/common-ground/products/courses/locations",
    "/public/tenants/common-ground/products/courses?locationId=507f1f77bcf86cd799439011&page=1&limit=100",
    "/public/tenants/common-ground/products/507f1f77bcf86cd799439012?locationId=507f1f77bcf86cd799439011",
  ])("accepts only a bound anonymous GET lookup: %s", async (path) => {
    expect((await request(app).get(path).set(signedHeaders(path))).status).toBe(
      200,
    );
    expect(redisSet).toHaveBeenCalledTimes(1);
  });

  it("keeps 120 configuration requests per visitor without pooling the Vercel server IP", async () => {
    for (let index = 0; index < 120; index += 1) {
      expect((await request(app).get(CONFIG).set(signedHeaders())).status).toBe(
        200,
      );
    }
    expect((await request(app).get(CONFIG).set(signedHeaders())).status).toBe(
      429,
    );
    const catalogue = "/public/tenants/common-ground/products/courses";
    expect((await request(app).get(catalogue).set(signedHeaders(catalogue))).status).toBe(200);
    expect(
      (
        await request(app)
          .get(CONFIG)
          .set(signedHeaders(CONFIG, "198.51.100.7"))
      ).status,
    ).toBe(200);
  });

  it.each([
    ["get", CONFIG, "configuration", 120],
    ["get", `${CONFIG}/?source=marketing`, "configuration", 120],
    ["get", "/public/tenants/common-ground/products", "catalogue", 600],
    ["get", "/public/tenants/common-ground/products/courses", "catalogue", 600],
    ["get", "/public/tenants/common-ground/products/courses/locations", "catalogue", 600],
    ["get", "/public/tenants/common-ground/products/courses/overview", "catalogue", 600],
    ["get", "/public/tenants/common-ground/products/507f1f77bcf86cd799439012/sessions", "catalogue", 600],
    ["get", "/public/tenants/common-ground/booking/availability", "catalogue", 600],
    ["get", "/public/tenants/common-ground/booking/occupancy", "catalogue", 600],
    ["get", "/public/tenants/common-ground/memberships", "catalogue", 600],
    ["get", "/public/tenants/common-ground/vouchers/products", "catalogue", 600],
    ["get", "/public/tenants/common-ground/knowledge/article-id", "catalogue", 600],
    ["post", CONFIG, "lookup", 120],
    ["post", "/public/tenants/common-ground/products/courses", "lookup", 120],
    ["get", "/public/tenants/common-ground/config/private", "lookup", 120],
    ["get", "/public/tenants/common-ground/products/product/orders", "lookup", 120],
    ["get", "/public/tenants/common-ground/checkout/guest/orders/order-id/status", "lookup", 120],
    ["post", "/public/tenants/common-ground/waitlist/manage", "lookup", 120],
    ["post", "/public/tenants/common-ground/booking-intents", "lookup", 120],
    ["get", "/auth/customer/social/providers", "lookup", 120],
  ] as const)("assigns %s %s to the bounded %s budget", async (method, path, budget, limit) => {
    const response = await request(app)[method](path);
    expect(response.status).toBe(200);
    expect(response.headers["x-shario-public-lookup-budget"]).toBe(budget);
    expect(response.headers["ratelimit-limit"]).toBe(String(limit));
    expect(response.headers["ratelimit-remaining"]).toBe(String(limit - 1));
  });

  it("keeps branding and sensitive lookups available when catalogue browsing reaches its limit", async () => {
    const paths = [
      "/public/tenants/common-ground/products/courses",
      "/public/tenants/common-ground/products/courses/locations",
      "/public/tenants/another-studio/products/507f1f77bcf86cd799439012",
    ];
    for (let index = 0; index < 600; index += 1) {
      const path = paths[index % paths.length];
      expect((await request(app).get(path).set(signedHeaders(path))).status).toBe(200);
    }
    const limited = await request(app).get(paths[0]).set(signedHeaders(paths[0]));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("PUBLIC_TENANT_LOOKUP_RATE_LIMITED");
    expect(limited.headers["ratelimit-limit"]).toBe("600");
    expect(limited.headers["ratelimit-remaining"]).toBe("0");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(600);
    const config = await request(app).get(CONFIG).set(signedHeaders());
    expect(config.status).toBe(200);
    expect(config.headers["ratelimit-remaining"]).toBe("119");
    expect((await request(app).get("/auth/customer/social/providers")).status).toBe(200);
    expect((await request(app).get(paths[0]).set(signedHeaders(paths[0], "198.51.100.7"))).status).toBe(200);
  });

  it("keeps catalogue/configuration separate from sensitive lookup saturation", async () => {
    const lookup = "/public/tenants/common-ground/booking-intents";
    for (let index = 0; index < 120; index += 1) {
      expect((await request(app).post(lookup)).status).toBe(200);
    }
    expect((await request(app).post(lookup)).status).toBe(429);
    // A different lookup route still shares the existing lower allowance.
    expect((await request(app).get("/auth/customer/social/providers")).status).toBe(429);
    expect((await request(app).get(CONFIG)).status).toBe(200);
    expect((await request(app).get("/public/tenants/common-ground/booking/availability")).status).toBe(200);
  });

  it("logs saturation once without leaking URLs, queries, visitor IPs or proof headers", async () => {
    vi.stubEnv("OPS_MONITOR_NAMESPACE", "isolated");
    vi.stubEnv("OPS_MONITOR_TOKEN", "a".repeat(32));
    const path = `${CONFIG}?opaque=private-query-value`;
    for (let index = 0; index < 122; index += 1) {
      await request(app).get(path).set(signedHeaders(path));
    }
    expect(redisSet).toHaveBeenCalledWith("shario:operations:v1:isolated:public-site:configuration-throttled", "1", "EX", 900);
    expect(logWarning).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith({
      event: "public_lookup.rate_limited", budget: "configuration", limit: 120,
      windowSeconds: 600, retryAfterSeconds: expect.any(Number), verifiedProxy: true,
    }, "Public lookup budget exhausted.");
    expect(JSON.stringify(logWarning.mock.calls)).not.toMatch(/private-query-value|203\.0\.113|common-ground|signature|nonce|secret/);
  });

  it("lets the product handler validate an invalid ID rather than turning it into a proxy failure", async () => {
    const path = "/public/tenants/common-ground/products/not-a-valid-id";
    const result = await request(app).get(path).set(signedHeaders(path));
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INVALID_ID");
    expect(redisSet).toHaveBeenCalledTimes(1);
  });

  it.each([
    "/public/tenants/common-ground/products/507f1f77bcf86cd799439012/sessions",
    "/public/tenants/common-ground/checkout/guest/orders/507f1f77bcf86cd799439012/status",
    "/public/tenants/common-ground/memberships/current",
    "/public/tenants/common-ground/vouchers/orders",
    "/public/tenants/common-ground/products/courses/overview/private",
    "/auth/customer/google/start",
  ])(
    "rejects proof on a non-SSR route before claiming the nonce: %s",
    async (path) => {
      expect(
        (await request(app).get(path).set(signedHeaders(path))).status,
      ).toBe(403);
      expect(redisSet).not.toHaveBeenCalled();
    },
  );

  it("rejects signed cookies, authorization, body and mutations", async () => {
    expect(
      (
        await request(app)
          .get(CONFIG)
          .set(
            signedHeaders(CONFIG, "203.0.113.42", {
              cookieHeader: "customer_jwt=opaque",
            }),
          )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(CONFIG)
          .set(signedHeaders())
          .set("authorization", "Bearer opaque")
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(CONFIG)
          .set(signedHeaders(CONFIG, "203.0.113.42", { body: {} }))
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(CONFIG)
          .set(signedHeaders(CONFIG, "203.0.113.42", { method: "POST" }))
      ).status,
    ).toBe(403);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it("rejects forged IP, query tampering, partial proof and v1 instead of allocating a new budget", async () => {
    const modified = signedHeaders();
    modified[proxy.AUTH_PROXY_HEADERS.CLIENT_IP] = "198.51.100.7";
    expect((await request(app).get(CONFIG).set(modified)).status).toBe(403);
    expect(
      (await request(app).get(`${CONFIG}?changed=true`).set(signedHeaders()))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(CONFIG)
          .set(proxy.AUTH_PROXY_HEADERS.CLIENT_IP, "198.51.100.7")
      ).status,
    ).toBe(403);
    const v1 = signedHeaders(CONFIG, "");
    expect((await request(app).get(CONFIG).set(v1)).status).toBe(403);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it("rejects signed replay on a second request", async () => {
    const headers = signedHeaders();
    expect((await request(app).get(CONFIG).set(headers)).status).toBe(200);
    expect((await request(app).get(CONFIG).set(headers)).status).toBe(403);
  });

  it("keeps unsigned direct requests in their old budget despite arbitrary XFF", async () => {
    for (let index = 0; index < 120; index += 1) {
      expect(
        (
          await request(app)
            .get(CONFIG)
            .set("x-forwarded-for", `203.0.113.${index + 1}`)
        ).status,
      ).toBe(200);
    }
    expect(
      (await request(app).get(CONFIG).set("x-forwarded-for", "198.51.100.7"))
        .status,
    ).toBe(429);
    expect(redisSet).not.toHaveBeenCalled();
  });
});
