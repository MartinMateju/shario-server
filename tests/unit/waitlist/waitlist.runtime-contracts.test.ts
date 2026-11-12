import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("waitlist runtime contracts", () => {
  it("fails startup before accepting traffic when the token pepper is invalid", () => {
    const server = source("src/server.ts");
    expect(server).toContain("assertWaitlistTokenConfiguration();");
    expect(server.indexOf("assertWaitlistTokenConfiguration();")).toBeLessThan(
      server.indexOf("await connectDB();"),
    );
    expect(server.indexOf("assertWaitlistTokenConfiguration();")).toBeLessThan(
      server.indexOf("app.listen(PORT)"),
    );
  });

  it("registers both waitlist reconciliation and its email outbox every minute", () => {
    const server = source("src/server.ts");
    expect(server).toMatch(
      /supervisor\.schedule\(\s*"processWaitlistEmailOutbox",\s*"\* \* \* \* \*",\s*processWaitlistEmailOutbox/,
    );
    expect(server).toMatch(
      /supervisor\.schedule\(\s*"reconcileCourseWaitlists",\s*"\* \* \* \* \*",\s*reconcileCourseWaitlists/,
    );
  });

  it("keeps customer history and withdrawal outside new-commerce gates", () => {
    const routes = source("src/modules/waitlist/waitlist.customer.routes.ts");
    expect(routes).toContain(
      'customerWaitlistRouter.get("/mine", requireCustomerAccount, getMyWaitlist)',
    );
    expect(routes).toContain(
      'customerWaitlistRouter.delete("/entries/:entryId", requireCustomerAccount, withdrawMyWaitlistEntry)',
    );
    expect(routes).toMatch(
      /post\(\s*"\/entries",\s*requireVerifiedCustomer,\s*\.\.\.newWaitlistCommerce,\s*joinWaitlistAsCustomer/,
    );
    expect(routes).toMatch(
      /post\(\s*"\/entries\/:entryId\/checkout",\s*requireCustomerAccount,\s*\.\.\.newWaitlistCommerce/,
    );
  });

  it("allows opaque recovery links for unpublished studios while gating new joins and checkout", () => {
    const routes = source("src/modules/waitlist/waitlist.public.routes.ts");
    for (const recoveryPath of [
      "/waitlist/verify",
      "/waitlist/manage",
      "/waitlist/withdraw",
      "/waitlist/offers/inspect",
    ]) {
      const routeStart = routes.indexOf(recoveryPath);
      const nextRoute = routes.indexOf("publicWaitlistRouter.post", routeStart);
      const block = routes.slice(
        routeStart,
        nextRoute === -1 ? routes.length : nextRoute,
      );
      expect(block).toContain("loadTenantForHistoricalOrderStatus");
      expect(block).not.toContain("requirePublicProductSubscription");
      expect(block).not.toContain("loadPublishedTenant");
    }
    for (const mutationPath of [
      "/waitlist/entries",
      "/waitlist/offers/checkout",
    ]) {
      const routeStart = routes.indexOf(mutationPath);
      const nextRoute = routes.indexOf("publicWaitlistRouter.post", routeStart);
      const block = routes.slice(
        routeStart,
        nextRoute === -1 ? routes.length : nextRoute,
      );
      expect(block).toContain("loadPublishedTenant");
      expect(block).toContain("requirePublicProductSubscription");
      expect(block).toContain("TENANT_MODULE.PAYMENTS");
      expect(block).toContain("TENANT_MODULE.COURSES");
    }
  });

  it("tenant-scopes admin actions through the session location and separates permissions", () => {
    const routes = source("src/modules/booking/booking.routes.ts");
    expect(routes).toMatch(
      /if \(!mongoose\.isValidObjectId\(req\.params\.sessionId\)\) return null/,
    );
    expect(routes).toMatch(/tenant: requireTenantId\(req\)/);
    expect(routes).toMatch(
      /"\/:sessionId\/waitlist"[\s\S]*?viewBookings[\s\S]*?waitlistLocationAccess/,
    );
    expect(routes).toMatch(
      /"\/:sessionId\/waitlist\/:entryId\/promote"[\s\S]*?paymentsModule[\s\S]*?updateBookings[\s\S]*?waitlistLocationAccess/,
    );
    expect(routes).toMatch(
      /"\/:sessionId\/waitlist\/:entryId"[\s\S]*?cancelBookings[\s\S]*?waitlistLocationAccess/,
    );
    expect(routes).toMatch(
      /"\/:sessionId\/participants\/:orderId"[\s\S]*?cancelBookings[\s\S]*?refundBookings[\s\S]*?waitlistLocationAccess/,
    );
  });

  it("exposes a safe dry-run index plan and an explicit additive apply command", () => {
    const pkg = JSON.parse(source("package.json"));
    expect(pkg.scripts["indexes:waitlist:plan"]).not.toContain("--apply");
    expect(pkg.scripts["indexes:waitlist"]).toContain("--apply");

    const script = source(
      "src/modules/waitlist/scripts/sync-waitlist-indexes.ts",
    );
    expect(script).toContain('process.argv.includes("--apply")');
    expect(script).toContain(
      'import Booking from "@/modules/booking/booking.model.js"',
    );
    expect(script).toMatch(/const models = \[[\s\S]*?Booking,[\s\S]*?Order,/);
    expect(script).toContain("if (apply)");
    expect(script).toContain("await model.createIndexes()");
    expect(script).not.toMatch(/dropIndex|syncIndexes/);
  });

  it("reuses a committed waitlist Cart and Order before retrying Stripe without duplicate inserts", () => {
    const checkout = source(
      "src/modules/checkout/services/checkout.service.ts",
    );
    const start = checkout.indexOf("if (isRecoverableWaitlistOrder) {");
    const end = checkout.indexOf("} else {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const recovery = checkout.slice(start, end);
    expect(recovery).toContain("findCardCartRecovery");
    expect(recovery).toContain("assertPersistedCardCartSnapshot");
    expect(recovery).toContain("assertPersistedCardOrderSnapshot");
    expect(recovery).toContain(
      "persistedWaitlistOrder = persistedCardCheckout",
    );
    expect(recovery).toContain("transferWaitlistHoldToOrder");
    expect(recovery).not.toContain("createCart(");
    expect(recovery).not.toContain("createOrder(");
    expect(recovery).not.toContain("startSession(");
  });
});
