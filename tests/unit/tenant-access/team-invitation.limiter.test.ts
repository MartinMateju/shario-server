import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTeamInvitationSendLimiter } from "@/modules/tenant-access/team-invitation.limiter.js";

describe("team invitation send budget", () => {
  it("shares one budget across send actions while separating authenticated tenant and actor", async () => {
    const app = express();
    app.use((req, _res, next) => {
      // These headers model the preceding verified authentication middleware;
      // the production limiter does not consume headers or request-body IDs.
      Object.assign(req, {
        userInfo: {
          id: req.get("test-actor") ?? "actor-a",
          tenant: req.get("test-tenant") ?? "507f1f77bcf86cd799439011",
        },
      });
      next();
    });
    const limiter = createTeamInvitationSendLimiter();
    for (const path of ["/create", "/resend", "/sign-in"])
      app.post(path, limiter, (_req, res) => res.status(204).end());
    for (let index = 0; index < 20; index++) {
      await request(app)
        .post(["/create", "/resend", "/sign-in"][index % 3])
        .expect(204);
    }
    const denied = await request(app).post("/sign-in").expect(429);
    expect(denied.body.code).toBe("TEAM_INVITATION_RATE_LIMITED");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
    await request(app).post("/create").set("test-actor", "actor-b").expect(204);
    await request(app)
      .post("/create")
      .set("test-tenant", "507f1f77bcf86cd799439012")
      .expect(204);
  });
});
