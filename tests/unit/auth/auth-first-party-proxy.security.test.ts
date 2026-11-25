import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisSet = vi.hoisted(() => vi.fn());

vi.mock("@/infrastructure/redis/redis.js", () => ({
  redisConnection: {
    set: redisSet,
  },
}));

import {
  AUTH_PROXY_HEADERS,
  claimAuthProxyNonce,
  createAuthProxySignature,
  resolveAuthRequestContext,
} from "@/modules/auth/auth-first-party-proxy.js";

const NOW = 1_786_000_000_000;
const SECRET = "proxy-secret-with-at-least-thirty-two-bytes";
const ORIGIN = "https://studio.example";

type RequestInput = {
  method?: string;
  target?: string;
  origin?: string;
  ordinaryOrigin?: string;
  cookie?: string;
  body?: unknown;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  clientIp?: string;
};

const createSignedRequest = ({
  method = "POST",
  target = "/auth/customer/refresh",
  origin = ORIGIN,
  ordinaryOrigin = origin,
  cookie = "customer_jwt=opaque-cookie",
  body = { tenantSlug: "studio", value: 1 },
  timestamp = String(NOW),
  nonce = "0123456789abcdefABCDEF",
  signature,
  clientIp,
}: RequestInput = {}): Request => {
  const headers: Record<string, string> = {
    [AUTH_PROXY_HEADERS.ORIGIN]: origin,
    [AUTH_PROXY_HEADERS.TIMESTAMP]: timestamp,
    [AUTH_PROXY_HEADERS.NONCE]: nonce,
    [AUTH_PROXY_HEADERS.SIGNATURE]:
      signature ??
      createAuthProxySignature({
        secret: SECRET,
        timestamp,
        nonce,
        method,
        path: target,
        origin,
        clientIp,
        cookieHeader: cookie,
        body,
      }),
  };

  if (ordinaryOrigin) headers.origin = ordinaryOrigin;
  if (cookie) headers.cookie = cookie;
  if (clientIp !== undefined) headers[AUTH_PROXY_HEADERS.CLIENT_IP] = clientIp;

  return {
    method,
    originalUrl: target,
    url: target,
    body,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
};

const acceptNonce = vi.fn(async () => true);

const resolve = (
  request: Request,
  claimNonce: (nonce: string, ttlMs: number) => Promise<boolean> = acceptNonce,
) => resolveAuthRequestContext(request, NOW, claimNonce);

describe("signed first-party authentication proxy", () => {
  it("matches the IP-bound frontend v2 interoperability vector", () => {
    expect(
      createAuthProxySignature({
        secret: "test-proxy-secret-with-at-least-32-bytes",
        timestamp: "1795000000000",
        nonce: "fixed-nonce-with-24-bytes-12345678",
        method: "POST",
        path: "/auth/customer/refresh?source=booking",
        origin: "https://booking.example-space.com",
        clientIp: "203.0.113.42",
        cookieHeader: "customerRefreshToken=opaque; preference=cs",
        body: { nested: { z: 1, a: true }, list: [{ b: "two", a: "one" }] },
      }),
    ).toBe("4e8d628e4e709d3ce8f885164949e368edb0bc6d3221b302ba5f12c9d18b6f52");
  });
  it("matches the custom-domain frontend HMAC interoperability vector", () => {
    expect(
      createAuthProxySignature({
        secret: "test-proxy-secret-with-at-least-32-bytes",
        timestamp: "1795000000000",
        nonce: "fixed-nonce-with-24-bytes-12345678",
        method: "POST",
        path: "/auth/customer/refresh?source=booking",
        origin: "https://booking.example-space.com",
        cookieHeader: "customerRefreshToken=opaque; preference=cs",
        body: { nested: { z: 1, a: true }, list: [{ b: "two", a: "one" }] },
      }),
    ).toBe("2bf05245181811adfd0e6289110ca142040c1d44fbd2231c28f1157c6c2f8989");
  });
  beforeEach(() => {
    acceptNonce.mockClear();
    redisSet.mockReset();
    process.env.NODE_ENV = "production";
    process.env.AUTH_FIRST_PARTY_PROXY_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.AUTH_FIRST_PARTY_PROXY_SECRET;
  });

  it("accepts a body-, cookie-, target- and origin-bound proxy request", async () => {
    await expect(resolve(createSignedRequest())).resolves.toEqual({
      origin: ORIGIN,
      firstPartyProxy: true,
    });
    expect(acceptNonce).toHaveBeenCalledWith("0123456789abcdefABCDEF", 61_000);
  });

  it.each(["203.0.113.42", "2001:db8:0:0:0:0:0:1"])(
    "accepts the signed client IP %s without rewriting its representation",
    async (clientIp) => {
      await expect(resolve(createSignedRequest({ clientIp }))).resolves.toEqual(
        {
          origin: ORIGIN,
          firstPartyProxy: true,
          clientIp,
        },
      );
    },
  );

  it.each([
    "",
    "203.0.113.42, 198.51.100.1",
    "unknown",
    "https://studio.example",
  ])(
    "rejects malformed proxy client IP %j before claiming a nonce",
    async (clientIp) => {
      await expect(
        resolve(createSignedRequest({ clientIp })),
      ).rejects.toMatchObject({ code: "AUTH_FIRST_PARTY_PROXY_INVALID" });
      expect(acceptNonce).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["203.0.113.42", "198.51.100.2"],
    ["203.0.113.42", undefined],
    [undefined, "203.0.113.42"],
  ])(
    "rejects replacing the signed client IP %s with %s",
    async (signedIp, forwardedIp) => {
      const req = createSignedRequest({ clientIp: signedIp });
      const originalGet = req.get.bind(req);
      req.get = ((name: string) =>
        name === AUTH_PROXY_HEADERS.CLIENT_IP
          ? forwardedIp
          : originalGet(name)) as Request["get"];
      await expect(resolve(req)).rejects.toMatchObject({
        code: "AUTH_FIRST_PARTY_PROXY_INVALID",
      });
      expect(acceptNonce).not.toHaveBeenCalled();
    },
  );

  it("rejects an unsigned client IP header on a direct request", async () => {
    const req = {
      get: (name: string) =>
        name === AUTH_PROXY_HEADERS.CLIENT_IP ? "203.0.113.42" : undefined,
    } as unknown as Request;
    await expect(resolve(req)).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
    expect(acceptNonce).not.toHaveBeenCalled();
  });

  it("durably claims a hashed nonce with Redis NX and the caller TTL", async () => {
    redisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await expect(
      claimAuthProxyNonce("0123456789abcdefABCDEF", 61_000),
    ).resolves.toBe(true);
    await expect(
      claimAuthProxyNonce("0123456789abcdefABCDEF", 61_000),
    ).resolves.toBe(false);

    expect(redisSet).toHaveBeenCalledTimes(2);
    expect(redisSet).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^shario:auth-proxy:nonce:[a-f\d]{64}$/),
      "1",
      "PX",
      61_000,
      "NX",
    );
    expect(redisSet.mock.calls[1]).toEqual(redisSet.mock.calls[0]);
  });

  it("keeps an ordinary request in direct mode when no internal header is present", async () => {
    const req = {
      get: (name: string) =>
        name.toLowerCase() === "origin" ? ORIGIN : undefined,
    } as unknown as Request;

    await expect(resolve(req)).resolves.toEqual({
      origin: ORIGIN,
      firstPartyProxy: false,
    });
    expect(acceptNonce).not.toHaveBeenCalled();
  });

  it("rejects partial or forged internal headers", async () => {
    const partial = createSignedRequest() as Request & {
      get: (name: string) => string | undefined;
    };
    const originalGet = partial.get.bind(partial);

    partial.get = (name: string) =>
      name.toLowerCase() === AUTH_PROXY_HEADERS.SIGNATURE
        ? undefined
        : originalGet(name);

    await expect(resolve(partial)).rejects.toMatchObject({
      statusCode: 403,
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
    await expect(
      resolve(createSignedRequest({ signature: "a".repeat(64) })),
    ).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
    expect(acceptNonce).not.toHaveBeenCalled();
  });

  it.each([
    ["stale", NOW - 60_001],
    ["too far in the future", NOW + 60_001],
  ])("rejects a %s signature", async (_label, timestamp) => {
    await expect(
      resolve(createSignedRequest({ timestamp: String(timestamp) })),
    ).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
  });

  it("rejects a signature replayed against a different path or query", async () => {
    const req = createSignedRequest({
      target: "/auth/customer/refresh?mode=customer",
    }) as Request & { originalUrl: string; url: string };

    req.originalUrl = "/auth/refresh?mode=workspace";
    req.url = req.originalUrl;

    await expect(resolve(req)).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
  });

  it("rejects a signature replayed with a modified parsed body", async () => {
    const req = createSignedRequest({
      body: { tenantSlug: "studio", password: "original" },
    }) as Request & { body: unknown };

    req.body = { tenantSlug: "other-studio", password: "changed" };

    await expect(resolve(req)).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
  });

  it("uses stable key ordering when binding JSON request bodies", async () => {
    const req = createSignedRequest({
      body: { z: 1, nested: { b: 2, a: 1 }, a: 3 },
    }) as Request & { body: unknown };

    req.body = { a: 3, nested: { a: 1, b: 2 }, z: 1 };

    await expect(resolve(req)).resolves.toMatchObject({
      firstPartyProxy: true,
    });
  });

  it("rejects a signature replayed with a different forwarded cookie", async () => {
    const signed = createSignedRequest() as Request & {
      get: (name: string) => string | undefined;
    };
    const originalGet = signed.get.bind(signed);

    signed.get = (name: string) =>
      name.toLowerCase() === "cookie"
        ? "customer_jwt=another-cookie"
        : originalGet(name);

    await expect(resolve(signed)).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
  });

  it("rejects an ordinary Origin that disagrees with the signed browser origin", async () => {
    await expect(
      resolve(createSignedRequest({ ordinaryOrigin: "https://other.example" })),
    ).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
  });

  it("requires HTTPS origins without ports in production", async () => {
    await expect(
      resolve(
        createSignedRequest({
          origin: "http://studio.example:3000",
          ordinaryOrigin: "http://studio.example:3000",
        }),
      ),
    ).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
  });

  it("fails closed when the shared server-side secret is missing or too short", async () => {
    process.env.AUTH_FIRST_PARTY_PROXY_SECRET = "short";

    await expect(resolve(createSignedRequest())).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
  });

  it("rejects an invalid nonce before attempting the replay claim", async () => {
    await expect(
      resolve(createSignedRequest({ nonce: "short" })),
    ).rejects.toMatchObject({
      code: "AUTH_FIRST_PARTY_PROXY_INVALID",
    });
    expect(acceptNonce).not.toHaveBeenCalled();
  });

  it("allows exactly one concurrent request for the same signed nonce", async () => {
    const claimed = new Set<string>();
    const claimNonce = vi.fn(async (nonce: string) => {
      if (claimed.has(nonce)) return false;
      claimed.add(nonce);
      await Promise.resolve();
      return true;
    });
    const request = createSignedRequest();
    const outcomes = await Promise.allSettled([
      resolve(request, claimNonce),
      resolve(request, claimNonce),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        code: "AUTH_FIRST_PARTY_PROXY_INVALID",
      }),
    });
  });

  it("fails closed when the durable replay claim is unavailable", async () => {
    await expect(
      resolve(createSignedRequest(), async () => {
        throw new Error("redis unavailable");
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "AUTH_FIRST_PARTY_PROXY_UNAVAILABLE",
    });
  });
});
