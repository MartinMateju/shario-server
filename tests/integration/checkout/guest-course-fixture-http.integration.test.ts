import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../e2e/support/e2e-redis.js", () => ({ resetE2ERedis: vi.fn() }));
vi.mock("@/infrastructure/redis/cache.js", () => ({
  getOrSetCache: (_key: string, _ttl: number, load: () => unknown) => load(),
  invalidateCache: vi.fn(), deleteCache: vi.fn(), deleteCacheKeys: vi.fn(),
}));
vi.mock("@/infrastructure/queues/data-import.queue.js", () => ({ dataImportQueueName: "data-imports", dataImportQueue: {} }));
vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  communicationEmailQueueName: "communication-emails", communicationEmailQueue: {}, enqueueCommunicationEmail: vi.fn(),
}));
vi.mock("@/infrastructure/queues/notification.queue.js", () => ({ notificationQueueName: "notifications", notificationQueue: {} }));
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => { throw new Error("Full voucher checkout must not contact Stripe"); },
  getConnectedAccountRequestOptions: vi.fn(),
}));

import { createE2EControlRouter, E2E_CONTROL_KEY, resetE2EFixtures } from "../../e2e/support/e2e-fixtures.js";
import { publicCommerceMutationLimiter, publicTenantLookupLimiter, resetPublicCommerceRateLimitsForE2E } from "@/modules/checkout/checkout.public-limiter.js";
import { publicProductRouter } from "@/modules/product/routes/product.public.routes.js";
import { publicTenantCommerceRouter } from "@/modules/checkout/checkout.public.routes.js";
import { publicTenantRouter } from "@/modules/tenants/public-tenant.routes.js";
import { publicMembershipRouter } from "@/modules/membership/routes/membership.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

describe("browser guest voucher fixture through public HTTP routes", () => {
  let replica: MongoMemoryReplSet;
  let fixtures: Awaited<ReturnType<typeof resetE2EFixtures>>;
  const app = express();
  app.use(express.json());
  app.get("/probe/public-lookup", publicTenantLookupLimiter, (_req, res) => { res.sendStatus(200); });
  app.post("/probe/public-mutation", publicCommerceMutationLimiter, (_req, res) => { res.sendStatus(200); });
  app.use("/public", publicTenantRouter, publicProductRouter, publicTenantCommerceRouter, publicMembershipRouter);
  beforeAll(async () => {
    vi.stubEnv("E2E_TEST_MODE", "true");
    vi.stubEnv("ACCESS_TOKEN_SECRET", "local-fixture-http-secret-".repeat(3));
    vi.stubEnv("CLIENT_URL", "http://shario.localhost:3000");
    vi.stubEnv("DEVELOPMENT_ROOT_DOMAIN", "shario.localhost");
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri("shario-e2e-http-test"));
    fixtures = await resetE2EFixtures();
    app.use("/__e2e", createE2EControlRouter());
    app.use(errorHandler);
  }, 60000);
  afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); vi.unstubAllEnvs(); });

  it("resets exhausted public limits only through authorized hermetic fixture reset", async () => {
    for (let count = 0; count < 120; count += 1) {
      expect((await request(app).get("/probe/public-lookup")).status).toBe(200);
    }
    for (let count = 0; count < 30; count += 1) {
      expect((await request(app).post("/probe/public-mutation")).status).toBe(200);
    }
    const expectLimited = async () => {
      expect((await request(app).get("/probe/public-lookup")).body.code).toBe("PUBLIC_TENANT_LOOKUP_RATE_LIMITED");
      expect((await request(app).post("/probe/public-mutation")).body.code).toBe("PUBLIC_COMMERCE_RATE_LIMITED");
    };
    await expectLimited();
    expect((await request(app).post("/__e2e/reset")).status).toBe(403);
    expect((await request(app).post("/__e2e/reset").set("x-e2e-key", "wrong-key")).status).toBe(403);
    await expectLimited();
    for (const [key, value] of [["NODE_ENV", "production"], ["NODE_ENV", "development"], ["E2E_TEST_MODE", "false"]]) {
      vi.stubEnv(key, value);
      expect((await request(app).post("/__e2e/reset").set("x-e2e-key", E2E_CONTROL_KEY)).status).toBe(404);
      await expect(resetPublicCommerceRateLimitsForE2E()).rejects.toThrow("E2E test controls");
      await expectLimited();
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("E2E_TEST_MODE", "true");
    }
    const reset = await request(app).post("/__e2e/reset").set("x-e2e-key", E2E_CONTROL_KEY);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    fixtures = reset.body;
    expect((await request(app).get("/probe/public-lookup")).status).toBe(200);
    expect((await request(app).post("/probe/public-mutation")).status).toBe(200);
  });

  it("serves the same published location and course data for initial rendering and later browser reads", async () => {
    const path = `/public/tenants/${fixtures.tenants.alpha.slug}/products/courses`;
    const { alpha, beta } = fixtures.locations;
    const overview = await request(app).get(`${path}/overview`).query({ location: alpha.slug }).expect(200);
    const locations = await request(app).get(`${path}/locations`).expect(200);
    const products = await request(app).get(path).query({ locationId: alpha.id, page: 1, limit: 100 }).expect(200);
    expect(overview.body).toEqual({ locations: locations.body.locations, locationId: alpha.id, products: products.body });
    expect(overview.body.products).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixtures.products.alpha.id, nextSession: expect.objectContaining({ id: fixtures.courseSessions.alpha.id }) }),
    ]));
    const otherStudio = await request(app).get(`${path}/overview`).query({ location: beta.id }).expect(200);
    expect(otherStudio.body).toEqual({ locations: locations.body.locations, locationId: "", products: [] });
  });

  it("quotes without reserving, fulfills without Stripe, replays and requires guest proof", async () => {
    const product = fixtures.products.alpha, slot = fixtures.courseSessions.alpha;
    const base = `/public/tenants/${fixtures.tenants.alpha.slug}`;
    const config = await request(app).get(`${base}/config`);
    expect(config.status, JSON.stringify(config.body)).toBe(200);
    expect(config.body.tenant.publicCapabilities).toMatchObject({ courses: true, guestCourseCheckout: true });
    expect(config.body.tenant.publicSite.footer.legal).toMatchObject({
      terms: "https://studio-alpha.example.test/terms", cancellation: "https://studio-alpha.example.test/cancellation",
    });
    const sessionsUrl = `${base}/products/${product.id}/sessions?locationId=${slot.locationId}`;
    const readSession = async () => {
      const response = await request(app).get(sessionsUrl);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const rows = Array.isArray(response.body) ? response.body : response.body.sessions;
      return rows.find((row: any) => (row.id || row._id) === slot.id);
    };
    const before = await readSession();
    expect(before.remainingCapacity).toBeGreaterThan(0);
    const quoteBody = { locale: "en", promoCode: fixtures.vouchers.alphaGuest.code, cart: [{
      product: { _id: product.id, type: product.type, kind: "class" }, bookingCourse: slot.id,
      locationId: slot.locationId, quantity: 1, numberOfGuests: 1, guests: [],
    }] };
    const quote = await request(app).post(`${base}/checkout/guest/voucher/quote`).send(quoteBody);
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body).toMatchObject({ voucherAppliedMinor: 4500, remainingToPayMinor: 0 });
    expect((await readSession()).remainingCapacity).toBe(before.remainingCapacity);
    const checkoutBody = { ...quoteBody,
      expectedVoucherQuote: { currency: quote.body.currency, totalAmountMinor: quote.body.totalAmountMinor,
        voucherAppliedMinor: quote.body.voucherAppliedMinor, remainingToPayMinor: quote.body.remainingToPayMinor },
      guestInfo: { firstName: "Guest", lastName: "Voucher", email: "guest-voucher@shario-e2e.test" }, acceptedTerms: true,
    };
    const key = randomUUID();
    const withoutConsent = await request(app).post(`${base}/checkout/guest`)
      .set("Origin", "http://studio-alpha.shario.localhost:3000").set("Idempotency-Key", randomUUID())
      .send({ ...checkoutBody, acceptedTerms: undefined });
    expect(withoutConsent.status, JSON.stringify(withoutConsent.body)).toBe(400);
    expect(withoutConsent.body.code).toBe("GUEST_COURSE_TERMS_REQUIRED");
    expect((await readSession()).remainingCapacity).toBe(before.remainingCapacity);
    const purchase = () => request(app).post(`${base}/checkout/guest`)
      .set("Origin", "http://studio-alpha.shario.localhost:3000").set("Idempotency-Key", key).send(checkoutBody);
    const purchased = await purchase();
    expect(purchased.status, JSON.stringify(purchased.body)).toBe(200);
    expect(purchased.body.status).toBe("confirmed");
    expect((await readSession()).remainingCapacity).toBe(before.remainingCapacity - 1);
    expect((await purchase()).body).toEqual(purchased.body);
    expect((await readSession()).remainingCapacity).toBe(before.remainingCapacity - 1);
    const statusUrl = `${base}/checkout/guest/orders/${purchased.body.orderId}/status`;
    const status = await request(app).post(statusUrl).send({ accessToken: purchased.body.accessToken });
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body).toMatchObject({ isPaid: true, status: "processed_order", terminal: true });
    expect((await request(app).post(statusUrl).send({})).status).toBe(404);
    const remaining = await request(app).post(`${base}/checkout/guest/voucher/quote`).send(quoteBody);
    expect(remaining.status, JSON.stringify(remaining.body)).toBe(200);
    expect(remaining.body).toMatchObject({ voucherAppliedMinor: 500, remainingToPayMinor: 4000 });
  });

  it("charges real catalogue routes once across commerce-router fallthrough, separately from configuration", async () => {
    await resetPublicCommerceRateLimitsForE2E();
    try {
      const base = `/public/tenants/${fixtures.tenants.alpha.slug}`;
      const config = await request(app).get(`${base}/config`).expect(200);
      expect(config.headers["x-shario-public-lookup-budget"]).toBe("configuration");
      expect(config.headers["ratelimit-remaining"]).toBe("119");
      const courses = await request(app).get(`${base}/products/courses`).expect(200);
      expect(courses.headers["ratelimit-limit"]).toBe("600");
      expect(courses.headers["ratelimit-remaining"]).toBe("599");
      // In production this route passes both the commerce router's .use()
      // limiter and the membership router's own limiter.
      const memberships = await request(app).get(`${base}/memberships`).expect(200);
      expect(memberships.headers["x-shario-public-lookup-budget"]).toBe("catalogue");
      expect(memberships.headers["ratelimit-remaining"]).toBe("598");
      const nextConfig = await request(app).get(`${base}/config`).expect(200);
      expect(nextConfig.headers["ratelimit-remaining"]).toBe("118");
    } finally {
      await resetPublicCommerceRateLimitsForE2E();
    }
  });

  it("retains 120 sensitive lookups and 30 mutation attempts on the real public routes", async () => {
    await resetPublicCommerceRateLimitsForE2E();
    try {
      const base = `/public/tenants/${fixtures.tenants.alpha.slug}`;
      const order = `${base}/vouchers/orders/507f1f77bcf86cd799439099`;
      // Missing access proofs must neither disclose an order nor send email.
      for (let index = 0; index < 120; index += 1) {
        await request(app).post(`${order}/status`).send({}).expect(404);
      }
      const limited = await request(app).post(`${order}/status`).send({}).expect(429);
      expect(limited.body.code).toBe("PUBLIC_TENANT_LOOKUP_RATE_LIMITED");
      expect(limited.headers["ratelimit-limit"]).toBe("120");
      expect(limited.headers["x-shario-public-lookup-budget"]).toBe("lookup");
      await request(app).get(`${base}/config`).expect(200);
      await request(app).get(`${base}/products/courses`).expect(200);

      await resetPublicCommerceRateLimitsForE2E();
      for (let index = 0; index < 30; index += 1) {
        await request(app).post(`${order}/resend`).send({}).expect(404);
      }
      const mutation = await request(app).post(`${order}/resend`).send({}).expect(429);
      expect(mutation.body.code).toBe("PUBLIC_COMMERCE_RATE_LIMITED");
      expect(mutation.headers["ratelimit-limit"]).toBe("30");
      expect(mutation.headers["ratelimit-remaining"]).toBe("0");
      await request(app).get(`${base}/config`).expect(200);
    } finally {
      await resetPublicCommerceRateLimitsForE2E();
    }
  });
});
