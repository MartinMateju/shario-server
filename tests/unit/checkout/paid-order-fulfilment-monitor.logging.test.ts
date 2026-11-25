import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("paid-order alert logging", () => {
  it("preserves the alert event in the production logger's serialized output", () => {
    // A fresh process uses the actual production logger and its redaction
    // pipeline. Spying on logger.error only observes the pre-redaction input.
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import Order from "./src/modules/order/order.model.ts";
          import { reportPaidUnfulfilledOrders } from "./src/modules/checkout/services/paid-order-fulfilment-monitor.service.ts";
          const query = {
            select() { return this; },
            sort() { return this; },
            limit() { return this; },
            lean() { return this; },
            async exec() {
              return [{ _id: "stuck-order", tenant: "studio-a", updatedAt: new Date("2027-01-10T11:00:00Z") }];
            },
          };
          Order.find = () => query;
          await reportPaidUnfulfilledOrders({ now: new Date("2027-01-10T12:00:00Z") });
        `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "error" },
        encoding: "utf8",
        timeout: 15_000,
      },
    );

    const logs = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(logs).toEqual([
      expect.objectContaining({
        level: 50,
        event: "PAID_ORDER_NOT_FULFILLED",
        count: 1,
        orders: [expect.objectContaining({ orderId: "stuck-order", tenantId: "studio-a" })],
      }),
    ]);
  });
});
