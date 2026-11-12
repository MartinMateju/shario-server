import { describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  verifyJWT: vi.fn((_req, _res, next) => next()),
  requireCustomerSession: vi.fn((_req, _res, next) => next()),
  handler: vi.fn(),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: routeMocks.verifyJWT,
}));
vi.mock("@/modules/auth/middleware/requireAuthContext.js", () => ({
  requireCustomerSession: routeMocks.requireCustomerSession,
}));
vi.mock(
  "@/modules/customer-notifications/controllers/customer-notification.controller.js",
  () => ({
    getCustomerNotificationSummary: routeMocks.handler,
    listCustomerNotifications: routeMocks.handler,
    markAllCustomerNotificationsRead: routeMocks.handler,
    markCustomerNotificationRead: routeMocks.handler,
  }),
);

import { customerNotificationRouter } from "@/modules/customer-notifications/routes/customer-notification.routes.js";

type RouterLayer = {
  handle: unknown;
  route?: { path: string; methods: Record<string, boolean> };
};

const stack = customerNotificationRouter.stack as unknown as RouterLayer[];

describe("customer notification routes", () => {
  it("requires customer authentication without workspace membership", () => {
    expect(stack[0]?.handle).toBe(routeMocks.verifyJWT);
    expect(stack[1]?.handle).toBe(routeMocks.requireCustomerSession);
    expect(stack[2]?.route).toBeDefined();
  });

  it.each([
    ["/", "get"],
    ["/summary", "get"],
    ["/read-all", "post"],
    ["/:id/read", "patch"],
  ] as const)("registers %s %s", (path, method) => {
    expect(
      stack.some(
        (layer) =>
          layer.route?.path === path && layer.route.methods[method] === true,
      ),
    ).toBe(true);
  });
});
